//! The export's audio, produced one window at a time instead of as one buffer.
//!
//! `audio.rs` builds the programme the way the format reads it: every clip decoded whole,
//! stretched whole, concatenated, mixed, limited, then encoded. Each of those steps held the
//! entire timeline as planar f32 — 1.4 GB per hour of stereo 48 kHz — and several held it
//! twice (the decoded clip next to its stretched copy, the per-clip results next to the
//! assembled programme). A one- or two-hour export could take the Electron main process,
//! which hosts the addon, down with it.
//!
//! This module computes the same programme in order, keeping only what the next window
//! needs:
//!
//! - `ClipAudioReader` decodes a clip's source window sequentially (every audio track, mixed
//!   and aligned exactly as `decode_clip_audio` does), handing out samples as asked.
//! - `SpeedStretchStream` applies the clip's speed segments with the same quantisation as
//!   `stretch_clip_pcm_by_speed`. A segment that plays at 1x is copied through; a stretched
//!   one goes through `stretch_pcm_to_length` whole when it is under `STRETCH_CHUNK` samples,
//!   and in overlapping chunks, crossfaded, when it is longer.
//! - `ProgrammeAudio` lays the clips end to end with the equal-power boundary fades, sums the
//!   voiceovers, ducks and sums the music beds, applies the output trim and the look-ahead
//!   limiter, and hands finished samples to the encoder — while the video is still being
//!   encoded, so the two streams interleave in the file.
//!
//! Everything below the chunk size is the same arithmetic as the whole-buffer path, sample
//! for sample; the tests at the bottom hold the two against each other. What is bounded is
//! what stays in memory: a few seconds per stage, plus one stretch chunk.

use crate::audio::{
    averr, duck_gain_at, fade_envelope, gain_to_ceiling, loudness_gain_db, resolve_fade_samples,
    stretch_pcm_to_length, AudioResampler, PlanarPcm, AUDIO_BOUNDARY_FADE_SAMPLES,
    AUDIO_OUTPUT_CHANNELS, AUDIO_OUTPUT_SAMPLE_RATE, DUCK_ATTACK_SEC, DUCK_BLOCK, DUCK_DEPTH_DB,
    DUCK_HOLD_SEC, DUCK_RELEASE_SEC, DUCK_THRESHOLD_DBFS, LIMITER_LOOKAHEAD, LIMITER_RELEASE_SEC,
};
use crate::ffi::*;
use crate::ffi::{AVERROR_EAGAIN, AVERROR_EOF};
use crate::regions::SpeedSegment;
use crate::scene::{SceneAudio, SceneAudioTrack, SceneAudioTrackKind};
use anyhow::{bail, Result};
use std::collections::VecDeque;
use std::f32::consts::PI;
use std::ffi::CString;
use std::ptr;

const RATE: f64 = AUDIO_OUTPUT_SAMPLE_RATE as f64;
const CHANNELS: usize = AUDIO_OUTPUT_CHANNELS;
const AVSEEK_FLAG_BACKWARD: i32 = 1;

/// Longest stretched segment handed to `stretch_pcm_to_length` in one piece: 30 s, input or
/// output. 11 MB of stereo f32 each way. Longer segments are split (see `StretchState`).
pub const STRETCH_CHUNK: usize = 30 * AUDIO_OUTPUT_SAMPLE_RATE as usize;
/// Input shared by two neighbouring stretch chunks, crossfaded in the output: 43 ms. Each
/// chunk is its own `atempo` run, so the two renderings of the shared input are not sample
/// aligned; a linear crossfade over it is what keeps the junction from clicking.
const STRETCH_OVERLAP: usize = 2048;

/// A sequential source of 48 kHz stereo planar f32.
///
/// `pull` appends exactly `n` samples to each of the `AUDIO_OUTPUT_CHANNELS` planes of `out`.
/// Past its end a source yields silence, and a source that fails logs once and goes silent:
/// that is how the whole-buffer path treated a clip whose decode failed, and an export does not
/// stop for its audio.
pub trait PcmStream {
    fn pull(&mut self, n: usize, out: &mut PlanarPcm);
}

fn planes(capacity: usize) -> PlanarPcm {
    (0..CHANNELS).map(|_| Vec::with_capacity(capacity)).collect()
}

fn push_silence(n: usize, out: &mut PlanarPcm) {
    for plane in out.iter_mut() {
        plane.resize(plane.len() + n, 0.0);
    }
}

/// Discards `n` samples of `source`, a block at a time.
fn skip_source(source: &mut dyn PcmStream, mut n: usize) {
    let mut scratch = planes(0);
    while n > 0 {
        let step = n.min(1 << 16);
        for plane in scratch.iter_mut() {
            plane.clear();
        }
        source.pull(step, &mut scratch);
        n -= step;
    }
}

/// An in-memory source. The tests feed the stream from it; nothing in production needs it.
pub struct MemoryPcm {
    pcm: PlanarPcm,
    cursor: usize,
}

impl MemoryPcm {
    pub fn new(pcm: PlanarPcm) -> Self {
        Self { pcm, cursor: 0 }
    }
}

impl PcmStream for MemoryPcm {
    fn pull(&mut self, n: usize, out: &mut PlanarPcm) {
        for (channel, plane) in out.iter_mut().enumerate().take(CHANNELS) {
            let source = self.pcm.get(channel).map(Vec::as_slice).unwrap_or(&[]);
            let start = self.cursor.min(source.len());
            let end = (self.cursor + n).min(source.len());
            plane.extend_from_slice(&source[start..end]);
            plane.resize(plane.len() + n - (end - start), 0.0);
        }
        self.cursor += n;
    }
}

/// Streams added sample for sample: a take's voice and computer stems, played as one.
pub struct SumStream {
    inputs: Vec<Box<dyn PcmStream>>,
    scratch: PlanarPcm,
}

impl SumStream {
    pub fn new(inputs: Vec<Box<dyn PcmStream>>) -> Self {
        Self { inputs, scratch: planes(0) }
    }
}

impl PcmStream for SumStream {
    fn pull(&mut self, n: usize, out: &mut PlanarPcm) {
        let starts: Vec<usize> = out.iter().map(Vec::len).collect();
        push_silence(n, out);
        for input in &mut self.inputs {
            for plane in self.scratch.iter_mut() {
                plane.clear();
            }
            input.pull(n, &mut self.scratch);
            for ((plane, start), source) in out.iter_mut().zip(&starts).zip(&self.scratch) {
                for (i, sample) in source.iter().take(n).enumerate() {
                    plane[start + i] += *sample;
                }
            }
        }
    }
}

/// A clip's two stems, opened and levelled for `clip_source`: the voice normalised like any
/// voice file plus its volume, the computer sound at its volume alone (normalising it would
/// boost a quiet desktop by up to 12 dB).
pub struct ClipStems<'a> {
    pub voice_path: &'a str,
    pub voice_gain_db: f32,
    pub system_path: &'a str,
    pub system_gain_db: f32,
}

/// `apply_gain_db` on a stream: the per-file loudness normalisation of a clip.
pub struct GainStream<S> {
    inner: S,
    gain: Option<f32>,
}

impl<S> GainStream<S> {
    pub fn new(inner: S, gain_db: f32) -> Self {
        // Same expression and the same 0 dB no-op as `apply_gain_db`.
        let gain = (gain_db != 0.0).then(|| 10.0f32.powf(gain_db / 20.0));
        Self { inner, gain }
    }
}

impl<S: PcmStream> PcmStream for GainStream<S> {
    fn pull(&mut self, n: usize, out: &mut PlanarPcm) {
        let starts: Vec<usize> = out.iter().map(Vec::len).collect();
        self.inner.pull(n, out);
        if let Some(gain) = self.gain {
            for (plane, start) in out.iter_mut().zip(starts) {
                for sample in &mut plane[start..] {
                    *sample *= gain;
                }
            }
        }
    }
}

// --------------------------------------------------------------------------------------------
// Decoding
// --------------------------------------------------------------------------------------------

extern "C" {
    fn sn_fmt_stream(s: *mut AVFormatContext, i: i32) -> *mut AVStream;
    fn sn_fmt_nb_streams(s: *mut AVFormatContext) -> u32;
}

/// One audio track of the file: its decoder, its resampler, and the decoded samples nobody
/// has asked for yet.
struct ReaderTrack {
    stream_index: i32,
    dctx: *mut AVCodecContext,
    tb_sec: f64,
    resampler: Option<AudioResampler>,
    /// Decoded samples from track index `buf_start` on.
    buf: PlanarPcm,
    buf_start: usize,
    origin_sec: Option<f64>,
    reached_end: bool,
    decoder_eof: bool,
    flushed: bool,
}

impl ReaderTrack {
    fn finished(&self) -> bool {
        self.reached_end || self.decoder_eof
    }

    /// Track index of window sample 0 — `mix_aligned_tracks`'s `relative_start`.
    fn relative_start(&self, source_start_sec: f64) -> i64 {
        let origin = self.origin_sec.unwrap_or(source_start_sec);
        ((source_start_sec - origin) * RATE).round() as i64
    }

    fn decoded_end(&self) -> usize {
        self.buf_start + self.buf[0].len()
    }
}

impl Drop for ReaderTrack {
    fn drop(&mut self) {
        unsafe { avcodec_free_context(&mut self.dctx) };
    }
}

/// `decode_clip_audio`, as a stream: the same window, the same tracks, the same alignment and
/// sum, handed out in order.
///
/// The decode loop is the whole-buffer one, stopped as soon as every track holds the samples
/// the caller asked for, so each track decodes the exact sample sequence it decoded there.
/// Two departures, both on damaged input, where the whole-buffer path threw the entire clip's
/// audio away: a read error after audio has been decoded ends the input (a recovered recording
/// ends on a partial fragment), and a packet the decoder rejects is skipped.
pub struct ClipAudioReader {
    fmt: *mut AVFormatContext,
    packet: *mut AVPacket,
    frame: *mut AVFrame,
    tracks: Vec<ReaderTrack>,
    input_eof: bool,
    source_start_sec: f64,
    source_end_sec: f64,
    /// Window length in samples: what `decode_clip_audio` would have returned.
    total: usize,
    /// Window samples handed out so far.
    cursor: usize,
    failed: bool,
    label: String,
    decoded_any: bool,
}

impl Drop for ClipAudioReader {
    fn drop(&mut self) {
        // Decoders first: they hold no reference into the demuxer, but freeing the format
        // context last is the order every other owner in this crate uses.
        self.tracks.clear();
        unsafe {
            av_frame_free(&mut self.frame);
            av_packet_free(&mut self.packet);
            avformat_close_input(&mut self.fmt);
        }
    }
}

impl ClipAudioReader {
    /// `Ok(None)`: the file has no audio stream at all. An error: it has some, and none of
    /// them decodes — the same two outcomes as `decode_clip_audio`.
    pub fn open(path: &str, source_start_sec: f64, source_end_sec: f64) -> Result<Option<Self>> {
        unsafe { Self::open_inner(path, source_start_sec, source_end_sec) }
    }

    unsafe fn open_inner(
        path: &str,
        source_start_sec: f64,
        source_end_sec: f64,
    ) -> Result<Option<Self>> {
        let mut fmt: *mut AVFormatContext = ptr::null_mut();
        let cpath = CString::new(path)?;
        averr(
            avformat_open_input(&mut fmt, cpath.as_ptr(), ptr::null_mut(), ptr::null_mut()),
            "audio open_input",
        )?;
        // From here the reader owns `fmt`, so every early return closes it.
        let mut reader = ClipAudioReader {
            fmt,
            packet: ptr::null_mut(),
            frame: ptr::null_mut(),
            tracks: Vec::new(),
            input_eof: false,
            source_start_sec,
            source_end_sec,
            total: (((source_end_sec - source_start_sec).max(0.0) * RATE).round()) as usize,
            cursor: 0,
            failed: false,
            label: path.to_string(),
            decoded_any: false,
        };
        averr(avformat_find_stream_info(fmt, ptr::null_mut()), "audio find_stream_info")?;
        let mut audio_stream_count = 0usize;
        for index in 0..sn_fmt_nb_streams(fmt) as i32 {
            let stream = sn_fmt_stream(fmt, index);
            let codecpar = (*stream).codecpar;
            if (*codecpar).codec_type != AVMediaType::AVMEDIA_TYPE_AUDIO {
                continue;
            }
            audio_stream_count += 1;
            let decoder = avcodec_find_decoder((*codecpar).codec_id);
            if decoder.is_null() {
                continue;
            }
            let mut dctx = avcodec_alloc_context3(decoder);
            if dctx.is_null() {
                bail!("audio avcodec_alloc_context3");
            }
            if avcodec_parameters_to_context(dctx, codecpar) < 0
                || avcodec_open2(dctx, decoder, ptr::null_mut()) < 0
            {
                avcodec_free_context(&mut dctx);
                continue;
            }
            let time_base = (*stream).time_base;
            reader.tracks.push(ReaderTrack {
                stream_index: index,
                dctx,
                tb_sec: if time_base.den != 0 {
                    time_base.num as f64 / time_base.den as f64
                } else {
                    0.0
                },
                resampler: None,
                buf: vec![Vec::new(); CHANNELS],
                buf_start: 0,
                origin_sec: None,
                reached_end: false,
                decoder_eof: false,
                flushed: false,
            });
        }
        if reader.tracks.is_empty() {
            if audio_stream_count > 0 {
                bail!("audio : {audio_stream_count} piste(s) présentes, aucune décodable");
            }
            return Ok(None);
        }
        let seek_tb_sec = reader.tracks[0].tb_sec;
        let seek_stream_index = reader.tracks[0].stream_index;
        if seek_tb_sec > 0.0 {
            let target = (source_start_sec / seek_tb_sec).floor() as i64;
            if av_seek_frame(fmt, seek_stream_index, target, AVSEEK_FLAG_BACKWARD) >= 0 {
                for track in reader.tracks.iter_mut() {
                    avcodec_flush_buffers(track.dctx);
                }
            }
        }
        reader.packet = av_packet_alloc();
        reader.frame = av_frame_alloc();
        if reader.packet.is_null() || reader.frame.is_null() {
            bail!("audio packet/frame alloc");
        }
        Ok(Some(reader))
    }

    /// Window length in samples.
    pub fn len(&self) -> usize {
        self.total
    }

    pub fn is_empty(&self) -> bool {
        self.total == 0
    }

    /// Does some track still have to decode before window sample `upto` (exclusive) can be
    /// mixed?
    fn needs_more(&self, upto: usize) -> bool {
        self.tracks.iter().any(|track| {
            if track.finished() {
                return false;
            }
            if track.origin_sec.is_none() {
                return true;
            }
            let needed = upto as i64 + track.relative_start(self.source_start_sec);
            needed > track.decoded_end() as i64
        })
    }

    /// One turn of `decode_clip_audio_inner`'s loop: read one packet, route it, drain every
    /// unfinished decoder. Damaged input is tolerated as described on the type.
    unsafe fn decode_step(&mut self) -> Result<()> {
        if !self.input_eof {
            let read = av_read_frame(self.fmt, self.packet);
            if read == AVERROR_EOF || (read < 0 && self.decoded_any) {
                if read != AVERROR_EOF {
                    eprintln!(
                        "[audio] {}: read error {read} after the last good packet; treated as the end of the file",
                        self.label
                    );
                }
                for track in self.tracks.iter_mut() {
                    avcodec_send_packet(track.dctx, ptr::null());
                }
                self.input_eof = true;
            } else {
                averr(read, "audio av_read_frame")?;
                let packet_stream = (*self.packet).stream_index;
                if let Some(track) = self
                    .tracks
                    .iter_mut()
                    .find(|t| t.stream_index == packet_stream && !t.reached_end)
                {
                    let sent = avcodec_send_packet(track.dctx, self.packet);
                    if sent == AVERROR_INVALIDDATA {
                        eprintln!("[audio] {}: corrupt audio packet skipped", self.label);
                    } else {
                        averr(sent, "audio send_packet")?;
                    }
                }
                av_packet_unref(self.packet);
            }
        }

        for track in self.tracks.iter_mut() {
            if track.finished() {
                continue;
            }
            loop {
                let ret = avcodec_receive_frame(track.dctx, self.frame);
                if ret == AVERROR_EOF {
                    track.decoder_eof = true;
                    break;
                }
                if ret == AVERROR_EAGAIN {
                    if self.input_eof {
                        track.decoder_eof = true;
                    }
                    break;
                }
                if ret == AVERROR_INVALIDDATA {
                    // Same tolerance as a rejected packet: keep what decoded, carry on.
                    continue;
                }
                averr(ret, "audio receive_frame")?;
                self.decoded_any = true;

                let pts = (*self.frame).best_effort_timestamp;
                let frame_sec = if pts != i64::MIN && track.tb_sec > 0.0 {
                    pts as f64 * track.tb_sec
                } else {
                    track.origin_sec.unwrap_or(self.source_start_sec)
                };
                if frame_sec >= self.source_end_sec {
                    track.reached_end = true;
                    av_frame_unref(self.frame);
                    break;
                }
                if track.origin_sec.is_none() {
                    track.origin_sec = Some(frame_sec);
                }
                if track.resampler.is_none() {
                    track.resampler = Some(AudioResampler::from_frame(self.frame, track.dctx)?);
                }
                if let Some(resampler) = track.resampler.as_mut() {
                    resampler.push(self.frame, &mut track.buf)?;
                }
                av_frame_unref(self.frame);
            }
        }
        // The whole-buffer path flushes every resampler after its loop. A finished track
        // receives nothing more, so flushing it as soon as it finishes appends the same
        // samples at the same place.
        for track in self.tracks.iter_mut() {
            if track.finished() && !track.flushed {
                track.flushed = true;
                if let Some(resampler) = track.resampler.as_mut() {
                    resampler.flush(&mut track.buf)?;
                }
            }
        }
        Ok(())
    }

    unsafe fn fill(&mut self, upto: usize) -> Result<()> {
        while self.needs_more(upto) {
            self.decode_step()?;
        }
        Ok(())
    }

    /// Sums window samples `[cursor, cursor + n)` of every track into `out`, then forgets
    /// what no later call can need.
    fn mix_into(&mut self, n: usize, out: &mut PlanarPcm) {
        let start_len: Vec<usize> = out.iter().map(Vec::len).collect();
        for (plane, start) in out.iter_mut().zip(&start_len) {
            plane.resize(start + n, 0.0);
        }
        let window_end = (self.cursor + n).min(self.total);
        for track in self.tracks.iter_mut() {
            let relative = track.relative_start(self.source_start_sec);
            if self.cursor < window_end {
                for channel in 0..CHANNELS {
                    let plane = &track.buf[channel];
                    let destination = &mut out[channel][start_len[channel]..];
                    for k in 0..(window_end - self.cursor) {
                        let index = (self.cursor + k) as i64 + relative;
                        if index < track.buf_start as i64 {
                            continue;
                        }
                        let local = index as usize - track.buf_start;
                        if let Some(&sample) = plane.get(local) {
                            destination[k] += sample;
                        }
                    }
                }
            }
            // Everything below the next window sample is consumed.
            let keep_from = (self.cursor + n) as i64 + relative;
            if keep_from > track.buf_start as i64 {
                let drop = ((keep_from as usize) - track.buf_start).min(track.buf[0].len());
                if drop > 0 {
                    for plane in track.buf.iter_mut() {
                        plane.drain(..drop.min(plane.len()));
                    }
                    track.buf_start += drop;
                }
            }
        }
        self.cursor += n;
    }

    /// Samples held in decode buffers — what the bounded-memory tests read.
    pub fn buffered_samples(&self) -> usize {
        self.tracks.iter().map(|track| track.buf[0].len()).sum()
    }
}

impl PcmStream for ClipAudioReader {
    fn pull(&mut self, n: usize, out: &mut PlanarPcm) {
        if !self.failed && self.cursor < self.total {
            let upto = (self.cursor + n).min(self.total);
            if let Err(error) = unsafe { self.fill(upto) } {
                eprintln!(
                    "[audio] {}: decoding stopped ({error:#}); the rest of this clip is silent",
                    self.label
                );
                self.failed = true;
            }
        }
        if self.failed {
            push_silence(n, out);
            self.cursor += n;
            return;
        }
        self.mix_into(n, out);
    }
}

// --------------------------------------------------------------------------------------------
// Speed segments
// --------------------------------------------------------------------------------------------

/// One speed segment as `stretch_clip_pcm_by_speed` quantises it.
#[derive(Clone, Copy, Debug)]
struct SegmentPlan {
    /// Source samples this segment reads (already clamped to the window).
    input: usize,
    /// Samples it renders.
    output: usize,
}

fn plan_segments(
    speed_segments: &[SpeedSegment],
    output_fps: f64,
    total_source_samples: usize,
) -> Vec<SegmentPlan> {
    let mut source_cursor = 0usize;
    speed_segments
        .iter()
        .map(|segment| {
            let input_samples = ((segment.end_sec - segment.start_sec) * RATE).round().max(0.0)
                as usize;
            let input_start = source_cursor;
            let input_end = (input_start + input_samples).min(total_source_samples);
            source_cursor = input_start + input_samples;
            let output = ((segment.frame_count as f64 / output_fps) * RATE).round().max(0.0)
                as usize;
            SegmentPlan { input: input_end.saturating_sub(input_start), output }
        })
        .collect()
}

fn mul_div(value: usize, numerator: usize, denominator: usize) -> usize {
    ((value as u128 * numerator as u128) / denominator.max(1) as u128) as usize
}

/// A stretched segment, rendered one chunk at a time.
///
/// Up to `STRETCH_CHUNK` (input and output) the segment is one chunk and the call is exactly
/// `stretch_pcm_to_length(segment, output)`. Past it, chunk `i` covers input
/// `[len·i/n, len·(i+1)/n)` and output `[out·i/n, out·(i+1)/n)`, so the chunks add up to the
/// segment exactly; each also renders `STRETCH_OVERLAP` input past its end, and that tail is
/// crossfaded linearly into the head of the next chunk, which renders the same input.
struct StretchState {
    plan: SegmentPlan,
    chunks: usize,
    next_chunk: usize,
    read: usize,
    carry: PlanarPcm,
    tail: PlanarPcm,
    ready: PlanarPcm,
    ready_pos: usize,
}

impl StretchState {
    fn new(plan: SegmentPlan) -> Self {
        let chunks = plan
            .input
            .div_ceil(STRETCH_CHUNK)
            .max(plan.output.div_ceil(STRETCH_CHUNK))
            .max(1);
        Self {
            plan,
            chunks,
            next_chunk: 0,
            read: 0,
            carry: planes(0),
            tail: planes(0),
            ready: planes(0),
            ready_pos: 0,
        }
    }

    fn ready_left(&self) -> usize {
        self.ready[0].len() - self.ready_pos
    }

    fn render_next(&mut self, source: &mut dyn PcmStream) {
        let (len, out, n, i) = (self.plan.input, self.plan.output, self.chunks, self.next_chunk);
        let in_b = mul_div(len, i + 1, n);
        let (out_a, out_b) = (mul_div(out, i, n), mul_div(out, i + 1, n));
        let last = i + 1 == n;
        let overlap_in = if last { 0 } else { STRETCH_OVERLAP.min(len - in_b) };
        let overlap_out = if overlap_in == 0 {
            0
        } else {
            (overlap_in as f64 * out as f64 / len as f64).round() as usize
        };
        let read_to = in_b + overlap_in;
        let mut input = std::mem::replace(&mut self.carry, planes(0));
        source.pull(read_to - self.read, &mut input);
        self.read = read_to;
        let main_in = input[0].len() - overlap_in;
        self.carry = input.iter().map(|plane| plane[main_in..].to_vec()).collect();

        let main_out = out_b - out_a;
        let mut stretched = stretch_pcm_to_length(&input, main_out + overlap_out);
        drop(input);
        let fade = self.tail[0].len().min(stretched[0].len());
        for (plane, tail) in stretched.iter_mut().zip(&self.tail) {
            for k in 0..fade {
                let w = (k as f32 + 0.5) / fade as f32;
                plane[k] = tail[k] * (1.0 - w) + plane[k] * w;
            }
        }
        self.tail = stretched
            .iter_mut()
            .map(|plane| plane.split_off(main_out.min(plane.len())))
            .collect();
        self.ready = stretched;
        self.ready_pos = 0;
        self.next_chunk += 1;
    }
}

enum SegmentState {
    Silence { left: usize },
    Copy { emit: usize, skip: usize, pad: usize },
    Stretch(Box<StretchState>),
}

/// `stretch_clip_pcm_by_speed`, as a stream over a clip's source window.
pub struct SpeedStretchStream<S> {
    source: S,
    plans: Vec<SegmentPlan>,
    next_plan: usize,
    state: Option<SegmentState>,
}

impl<S: PcmStream> SpeedStretchStream<S> {
    /// `total_source_samples`: the window length the source yields (`ClipAudioReader::len`).
    pub fn new(
        source: S,
        speed_segments: &[SpeedSegment],
        output_fps: f64,
        total_source_samples: usize,
    ) -> Self {
        Self {
            source,
            plans: plan_segments(speed_segments, output_fps, total_source_samples),
            next_plan: 0,
            state: None,
        }
    }

    /// `stretch_pcm_to_length`'s dispatch, decided from the lengths alone.
    fn start_segment(&mut self, plan: SegmentPlan) -> Option<SegmentState> {
        let (len, out) = (plan.input, plan.output);
        if len == 0 {
            return (out > 0).then_some(SegmentState::Silence { left: out });
        }
        if out == 0 {
            skip_source(&mut self.source, len);
            return None;
        }
        if len.abs_diff(out) <= 1 {
            let emit = len.min(out);
            return Some(SegmentState::Copy { emit, skip: len - emit, pad: out - emit });
        }
        Some(SegmentState::Stretch(Box::new(StretchState::new(plan))))
    }
}

impl<S: PcmStream> PcmStream for SpeedStretchStream<S> {
    fn pull(&mut self, n: usize, out: &mut PlanarPcm) {
        let mut need = n;
        while need > 0 {
            let Some(state) = self.state.as_mut() else {
                match self.plans.get(self.next_plan).copied() {
                    Some(plan) => {
                        self.next_plan += 1;
                        self.state = self.start_segment(plan);
                    }
                    None => {
                        push_silence(need, out);
                        return;
                    }
                }
                continue;
            };
            let done = match state {
                SegmentState::Silence { left } => {
                    let step = need.min(*left);
                    push_silence(step, out);
                    *left -= step;
                    need -= step;
                    *left == 0
                }
                SegmentState::Copy { emit, skip, pad } => {
                    if *emit > 0 {
                        let step = need.min(*emit);
                        self.source.pull(step, out);
                        *emit -= step;
                        need -= step;
                    } else if *skip > 0 {
                        skip_source(&mut self.source, *skip);
                        *skip = 0;
                    } else {
                        let step = need.min(*pad);
                        push_silence(step, out);
                        *pad -= step;
                        need -= step;
                    }
                    *emit == 0 && *skip == 0 && *pad == 0
                }
                SegmentState::Stretch(stretch) => {
                    if stretch.ready_left() == 0 {
                        if stretch.next_chunk == stretch.chunks {
                            self.state = None;
                            continue;
                        }
                        stretch.render_next(&mut self.source);
                    }
                    let step = need.min(stretch.ready_left());
                    for (plane, ready) in out.iter_mut().zip(&stretch.ready) {
                        plane.extend_from_slice(&ready[stretch.ready_pos..stretch.ready_pos + step]);
                    }
                    stretch.ready_pos += step;
                    need -= step;
                    false
                }
            };
            if done {
                self.state = None;
            }
        }
    }
}

// --------------------------------------------------------------------------------------------
// Limiter
// --------------------------------------------------------------------------------------------

/// `limit_peaks`, fed in order. Identical arithmetic in the identical order, so the output is
/// the same to the bit; the only difference is that a sample leaves as soon as the
/// `LIMITER_LOOKAHEAD` samples after it have arrived, instead of once the whole programme has.
pub(crate) struct StreamingLimiter {
    buf: PlanarPcm,
    base: usize,
    pushed: usize,
    index: isize,
    next: usize,
    held: VecDeque<(usize, f32)>,
    ring: Vec<f32>,
    ring_sum: f64,
    gain: f32,
    release: f32,
}

impl StreamingLimiter {
    pub(crate) fn new() -> Self {
        Self {
            buf: planes(0),
            base: 0,
            pushed: 0,
            index: 1 - LIMITER_LOOKAHEAD as isize,
            next: 0,
            held: VecDeque::new(),
            ring: vec![1.0f32; LIMITER_LOOKAHEAD],
            ring_sum: LIMITER_LOOKAHEAD as f64,
            gain: 1.0,
            release: 1.0
                - (-1.0 / (LIMITER_RELEASE_SEC * AUDIO_OUTPUT_SAMPLE_RATE as f32)).exp(),
        }
    }

    pub(crate) fn push(&mut self, pcm: &[Vec<f32>], range: std::ops::Range<usize>) {
        for (plane, source) in self.buf.iter_mut().zip(pcm) {
            plane.extend_from_slice(&source[range.clone()]);
        }
        self.pushed += range.len();
    }

    /// Limits every sample whose look-ahead is complete (all of them once `final_len` is
    /// known) and appends them to `out`.
    pub(crate) fn drain(&mut self, final_len: Option<usize>, out: &mut PlanarPcm) {
        let window = LIMITER_LOOKAHEAD as isize;
        loop {
            let horizon = match final_len {
                Some(len) => {
                    if self.index >= len as isize {
                        break;
                    }
                    ((self.index + window) as usize).min(len)
                }
                None => {
                    let horizon = (self.index + window) as usize;
                    if horizon > self.pushed {
                        break;
                    }
                    horizon
                }
            };
            while self.next < horizon {
                let needed = gain_to_ceiling(&self.buf, self.next - self.base);
                while self.held.back().is_some_and(|&(_, g)| g >= needed) {
                    self.held.pop_back();
                }
                self.held.push_back((self.next, needed));
                self.next += 1;
            }
            let first = self.index.max(0) as usize;
            while self.held.front().is_some_and(|&(i, _)| i < first) {
                self.held.pop_front();
            }
            let minimum = self.held.front().map_or(1.0, |&(_, g)| g);
            let slot = (self.index + window) as usize % LIMITER_LOOKAHEAD;
            self.ring_sum += f64::from(minimum - self.ring[slot]);
            self.ring[slot] = minimum;
            if self.index >= 0 {
                let sample = self.index as usize;
                let local = sample - self.base;
                self.gain = ((self.ring_sum / LIMITER_LOOKAHEAD as f64) as f32)
                    .min(self.gain + (1.0 - self.gain) * self.release)
                    .min(gain_to_ceiling(&self.buf, local));
                for (plane, destination) in self.buf.iter_mut().zip(out.iter_mut()) {
                    if self.gain < 1.0 {
                        plane[local] *= self.gain;
                    }
                    destination.push(plane[local]);
                }
            }
            self.index += 1;
        }
        // Samples below the next one to limit are out; keep the buffer from growing.
        let done = (self.index.max(0) as usize).min(self.next).saturating_sub(self.base);
        if done >= 1 << 14 || (final_len.is_some() && done > 0) {
            for plane in self.buf.iter_mut() {
                plane.drain(..done.min(plane.len()));
            }
            self.base += done;
        }
    }

    fn buffered(&self) -> usize {
        self.buf[0].len()
    }
}

// --------------------------------------------------------------------------------------------
// The programme
// --------------------------------------------------------------------------------------------

#[derive(Clone, Copy, Debug)]
enum Slot {
    Unbegun,
    Open { start: usize, frames_at_begin: u64 },
    Closed { start: usize, count: usize },
}

/// Opens an imported track's window `[trim_start, trim_end)` as a stream, `None` when the file
/// has no decodable audio. Injected so the tests can run without ffmpeg.
pub type TrackOpener = Box<dyn Fn(&str, f64, f64) -> Option<Box<dyn PcmStream>>>;
/// `loudness_gain_db`, injected for the same reason.
pub type LoudnessFn = Box<dyn Fn(&str) -> f32>;

enum OverlayState {
    Pending,
    Active { source: Box<dyn PcmStream>, gain: f32, fade_in: usize, fade_out: usize, envelope: usize },
    Done,
}

/// One imported track (`mix_external_tracks`'s `overlay_external_track`), summed in as the
/// programme reaches it.
struct Overlay {
    track: SceneAudioTrack,
    offset: usize,
    /// Samples the decode window holds: `round((trim_end - trim_start) · rate)`.
    len: usize,
    trim_start: f64,
    trim_end: f64,
    /// Samples summed so far.
    pos: usize,
    state: OverlayState,
}

impl Overlay {
    fn new(track: &SceneAudioTrack) -> Option<Self> {
        // `trim_end_sec` must be concrete; the renderer always resolves one.
        let trim_end = track.trim_end_sec?;
        let trim_start = track.trim_start_sec.max(0.0);
        if trim_end <= trim_start {
            return None;
        }
        Some(Self {
            track: track.clone(),
            offset: (track.start_sec.max(0.0) * RATE).round() as usize,
            len: (((trim_end - trim_start) * RATE).round()) as usize,
            trim_start,
            trim_end,
            pos: 0,
            state: OverlayState::Pending,
        })
    }

    /// Sums this track into `programme[range]`, where `programme[0]` is sample `base`.
    fn add(
        &mut self,
        programme: &mut PlanarPcm,
        base: usize,
        range: std::ops::Range<usize>,
        duck: &[f32],
        open: &TrackOpener,
        loudness: &LoudnessFn,
    ) {
        let start = range.start.max(self.offset + self.pos);
        let end = range.end.min(self.offset + self.len);
        if start >= end || matches!(self.state, OverlayState::Done) {
            return;
        }
        if matches!(self.state, OverlayState::Pending) {
            let Some(source) = open(&self.track.path, self.trim_start, self.trim_end) else {
                self.state = OverlayState::Done;
                return;
            };
            let normalisation = match self.track.kind {
                SceneAudioTrackKind::Voiceover => loudness(&self.track.path),
                SceneAudioTrackKind::Music => 0.0,
            };
            let gain =
                10.0f32.powf((self.track.gain_db.clamp(-60.0, 12.0) + normalisation) / 20.0);
            // The track's own length before any cap at the programme's end (see
            // `overlay_track_pcm`): the ramps belong to the track.
            let full_len = ((self.trim_end - self.trim_start).max(0.0) * RATE) as usize;
            let envelope = full_len.max(self.len);
            let (fade_in, fade_out) = resolve_fade_samples(
                envelope,
                self.track.fade_in_sec.max(0.0),
                self.track.fade_out_sec.max(0.0),
            );
            self.state = OverlayState::Active { source, gain, fade_in, fade_out, envelope };
        }
        let OverlayState::Active { source, gain, fade_in, fade_out, envelope } = &mut self.state
        else {
            return;
        };
        // The stream starts at track sample 0 = programme `offset`; the programme is walked
        // in order, so `start` is always the next sample this track has to give.
        debug_assert_eq!(start, self.offset + self.pos);
        let count = end - start;
        let mut decoded = planes(count);
        source.pull(count, &mut decoded);
        for channel in 0..CHANNELS {
            let destination = &mut programme[channel];
            for i in 0..count {
                let k = self.pos + i;
                let sample = start + i;
                destination[sample - base] += decoded[channel][i]
                    * *gain
                    * fade_envelope(k, *envelope, *fade_in, *fade_out)
                    * duck_gain_at(duck, sample);
            }
        }
        self.pos += count;
        if self.pos >= self.len {
            self.state = OverlayState::Done;
        }
    }
}

/// The export's audio programme, produced as the video advances.
///
/// The pipeline calls `begin_clip` / `end_clip` around each clip of the walk and `produce`
/// as frames go out; `finish` once the walk is over. Finished samples go to `sink` in order.
/// What `produce` may emit is limited by what is already decided: a clip's last
/// `AUDIO_BOUNDARY_FADE_SAMPLES` wait for its length and its neighbour's, the music's duck
/// looks `DUCK_ATTACK_SEC` ahead into the voice, and the limiter `LIMITER_LOOKAHEAD` samples
/// ahead into the mix. So the audio trails the video by about a quarter of a second, and
/// nothing larger than that and one stretch chunk is ever held.
pub struct ProgrammeAudio {
    fps: f64,
    slots: Vec<Slot>,
    sources: Vec<Option<Box<dyn PcmStream>>>,
    finished: bool,
    video_pos: usize,
    voice_pos: usize,
    voice_base: usize,
    voice: PlanarPcm,
    voice_slot: usize,
    voiceovers: Vec<Overlay>,
    music: Vec<Overlay>,
    speaking: Vec<bool>,
    curve: Vec<f32>,
    duck_last: Option<usize>,
    duck_db: f32,
    mix_pos: usize,
    trim: f32,
    limiter: StreamingLimiter,
    opener: TrackOpener,
    loudness: LoudnessFn,
    emitted: usize,
    peak_buffered: usize,
}

impl ProgrammeAudio {
    pub fn new(
        clip_count: usize,
        output_fps: f64,
        settings: SceneAudio,
        tracks: &[SceneAudioTrack],
        opener: TrackOpener,
        loudness: LoudnessFn,
    ) -> Self {
        let (voiceovers, music): (Vec<Overlay>, Vec<Overlay>) = tracks
            .iter()
            .filter_map(Overlay::new)
            .partition(|overlay| overlay.track.kind == SceneAudioTrackKind::Voiceover);
        Self {
            fps: output_fps,
            slots: vec![Slot::Unbegun; clip_count],
            sources: (0..clip_count).map(|_| None).collect(),
            finished: false,
            video_pos: 0,
            voice_pos: 0,
            voice_base: 0,
            voice: planes(0),
            voice_slot: 0,
            voiceovers,
            music,
            speaking: Vec::new(),
            curve: Vec::new(),
            duck_last: None,
            duck_db: 0.0,
            mix_pos: 0,
            trim: 10.0f32.powf(settings.gain_db.clamp(-12.0, 12.0) / 20.0),
            limiter: StreamingLimiter::new(),
            opener,
            loudness,
            emitted: 0,
            peak_buffered: 0,
        }
    }

    /// The production configuration: imported tracks decoded with `ClipAudioReader`, voice
    /// levelled with `loudness_gain_db`.
    pub fn for_export(
        clip_count: usize,
        output_fps: f64,
        settings: SceneAudio,
        tracks: &[SceneAudioTrack],
    ) -> Self {
        Self::new(
            clip_count,
            output_fps,
            settings,
            tracks,
            Box::new(|path, start, end| match ClipAudioReader::open(path, start, end) {
                Ok(Some(reader)) => Some(Box::new(reader) as Box<dyn PcmStream>),
                Ok(None) => None,
                Err(error) => {
                    eprintln!("[audio] imported track {path} skipped ({error:#})");
                    None
                }
            }),
            Box::new(|path| loudness_gain_db(path)),
        )
    }

    /// The clip's audio, ready to stream: decoded, stretched over its speed segments, and
    /// levelled with its file's loudness gain — `decode_and_stretch_clip_audio`, streamed.
    /// `None` (silence) for a clip without a decodable audio stream, with the same warnings.
    pub fn clip_source(
        clip_index: usize,
        screen_path: &str,
        stems: Option<ClipStems<'_>>,
        source_start_sec: f64,
        source_end_sec: f64,
        speed_segments: &[SpeedSegment],
        output_fps: f64,
    ) -> Option<Box<dyn PcmStream>> {
        if let Some(stems) = stems {
            let open = |path: &str, gain_db: f32| -> Option<Box<dyn PcmStream>> {
                match ClipAudioReader::open(path, source_start_sec, source_end_sec) {
                    Ok(Some(reader)) => {
                        let total = reader.len();
                        let stretched = SpeedStretchStream::new(reader, speed_segments, output_fps, total);
                        Some(Box::new(GainStream::new(stretched, gain_db)))
                    }
                    _ => None,
                }
            };
            let voice = open(stems.voice_path, loudness_gain_db(stems.voice_path) + stems.voice_gain_db);
            let system = open(stems.system_path, stems.system_gain_db);
            if let (Some(voice), Some(system)) = (voice, system) {
                return Some(Box::new(SumStream::new(vec![voice, system])));
            }
            eprintln!(
                "[pipeline] warning: clip #{clip_index}: audio stems unreadable, using the video's own track"
            );
        }
        match ClipAudioReader::open(screen_path, source_start_sec, source_end_sec) {
            Ok(Some(reader)) => {
                let total = reader.len();
                let stretched = SpeedStretchStream::new(reader, speed_segments, output_fps, total);
                Some(Box::new(GainStream::new(stretched, loudness_gain_db(screen_path))))
            }
            Ok(None) => {
                eprintln!(
                    "[pipeline] warning: clip #{clip_index} déclaré audio mais sans flux décodable; silence conservé"
                );
                None
            }
            Err(error) => {
                eprintln!(
                    "[pipeline] warning: décodage audio du clip #{clip_index} échoué ({error:#}); silence conservé"
                );
                None
            }
        }
    }

    /// End of every closed slot so far: where the next clip starts.
    fn closed_end(&self) -> usize {
        self.slots
            .iter()
            .rev()
            .find_map(|slot| match *slot {
                Slot::Closed { start, count } => Some(start + count),
                _ => None,
            })
            .unwrap_or(0)
    }

    /// Clip `clip_index` starts at the current end of the programme, `frames_so_far` frames
    /// into the video. Clips the walk skipped before it get no audio (a zero-length slot,
    /// exactly as an unvisited clip had in `build_audio_concat_plan`).
    pub fn begin_clip(
        &mut self,
        clip_index: usize,
        frames_so_far: u64,
        source: Option<Box<dyn PcmStream>>,
    ) {
        let start = self.closed_end();
        for slot in self.slots.iter_mut().take(clip_index) {
            if matches!(slot, Slot::Unbegun) {
                *slot = Slot::Closed { start, count: 0 };
            }
        }
        if let Some(slot) = self.slots.get_mut(clip_index) {
            *slot = Slot::Open { start, frames_at_begin: frames_so_far };
            self.sources[clip_index] = source;
        }
        self.video_pos = start;
    }

    /// The clip ends after `frames` frames: its slot is `round(frames / fps · rate)` samples,
    /// the integer accumulation `build_audio_concat_plan` makes.
    pub fn end_clip(&mut self, clip_index: usize, frames: u64) {
        if let Some(Slot::Open { start, .. }) = self.slots.get(clip_index).copied() {
            let count = if self.fps > 0.0 {
                ((frames as f64 / self.fps) * RATE).round().max(0.0) as usize
            } else {
                0
            };
            self.slots[clip_index] = Slot::Closed { start, count };
            self.video_pos = start + count;
        }
    }

    /// The video has produced `frames_so_far` frames in total; emit what that decides.
    pub fn produce(
        &mut self,
        frames_so_far: u64,
        sink: &mut dyn FnMut(&PlanarPcm) -> Result<()>,
    ) -> Result<()> {
        if let Some(Slot::Open { start, frames_at_begin }) =
            self.slots.iter().find(|slot| matches!(slot, Slot::Open { .. })).copied()
        {
            let frames = frames_so_far.saturating_sub(frames_at_begin);
            self.video_pos = start + ((frames as f64 / self.fps) * RATE).round() as usize;
        }
        self.advance(sink)
    }

    /// The walk is over: every length is known, emit everything left.
    pub fn finish(&mut self, sink: &mut dyn FnMut(&PlanarPcm) -> Result<()>) -> Result<()> {
        let end = self.closed_end();
        for slot in self.slots.iter_mut() {
            match *slot {
                Slot::Unbegun => *slot = Slot::Closed { start: end, count: 0 },
                // A clip begun and never ended has produced nothing the pipeline counted.
                Slot::Open { start, .. } => *slot = Slot::Closed { start, count: 0 },
                Slot::Closed { .. } => {}
            }
        }
        self.finished = true;
        self.advance(sink)
    }

    /// Total programme length, once `finish` has run.
    pub fn total_samples(&self) -> Option<usize> {
        self.finished.then(|| self.closed_end())
    }

    /// Samples handed to the sink so far.
    pub fn emitted_samples(&self) -> usize {
        self.emitted
    }

    /// Largest number of samples this programme ever held across its buffers.
    pub fn peak_buffered_samples(&self) -> usize {
        self.peak_buffered
    }

    /// `min(240, c_j/2, c_{j+1}/2)` for the boundary after slot `j`, when it is decided.
    fn fade_after(&self, j: usize) -> Option<usize> {
        let Slot::Closed { count, .. } = self.slots[j] else {
            return None;
        };
        let own = AUDIO_BOUNDARY_FADE_SAMPLES.min(count / 2);
        match self.slots.get(j + 1) {
            None => Some(0),
            Some(Slot::Closed { count: next, .. }) => Some(own.min(next / 2)),
            // The open clip is at least as long as what the video has shown of it.
            Some(Slot::Open { start, .. }) => {
                let shown = self.video_pos.saturating_sub(*start);
                (own <= shown / 2).then_some(own)
            }
            Some(Slot::Unbegun) => None,
        }
    }

    /// How far the clip audio (with its boundary fades) is decided.
    fn voice_limit(&self) -> usize {
        let mut limit = 0;
        for (j, slot) in self.slots.iter().enumerate() {
            match *slot {
                Slot::Closed { start, count } => {
                    let end = start + count;
                    if self.fade_after(j).is_some() {
                        limit = end;
                    } else {
                        limit = end - AUDIO_BOUNDARY_FADE_SAMPLES.min(count / 2);
                        break;
                    }
                }
                Slot::Open { start, .. } => {
                    // Its tail fade starts at least `AUDIO_BOUNDARY_FADE_SAMPLES` before its end,
                    // which is at or after the video's position.
                    limit = start.max(self.video_pos.saturating_sub(AUDIO_BOUNDARY_FADE_SAMPLES));
                    break;
                }
                Slot::Unbegun => break,
            }
        }
        limit
    }

    fn produce_voice(&mut self, limit: usize) {
        while self.voice_pos < limit {
            // The slot holding `voice_pos`; empty and finished slots are stepped over.
            while let Some(Slot::Closed { start, count }) = self.slots.get(self.voice_slot).copied()
            {
                if self.voice_pos < start + count {
                    break;
                }
                self.sources[self.voice_slot] = None;
                self.voice_slot += 1;
            }
            let j = self.voice_slot;
            let (start, end) = match self.slots.get(j).copied() {
                Some(Slot::Closed { start, count }) => (start, start + count),
                Some(Slot::Open { start, .. }) => (start, usize::MAX),
                _ => break,
            };
            let run_end = limit.min(end);
            let n = run_end - self.voice_pos;
            let from = self.voice.iter().map(Vec::len).collect::<Vec<_>>();
            match self.sources[j].as_mut() {
                Some(source) => source.pull(n, &mut self.voice),
                None => push_silence(n, &mut self.voice),
            }
            // Boundary fades, as `assemble_concatenated_pcm` applies them.
            let head = if j > 0 { self.fade_after(j - 1).unwrap_or(0) } else { 0 };
            let (count, tail) = match self.slots[j] {
                Slot::Closed { count, .. } => (count, self.fade_after(j).unwrap_or(0)),
                _ => (usize::MAX, 0),
            };
            for (plane, &from) in self.voice.iter_mut().zip(&from) {
                for k in 0..n {
                    let i = self.voice_pos + k - start;
                    let sample = &mut plane[from + k];
                    if i < head {
                        let phase = (i as f32 / head as f32) * PI * 0.5;
                        *sample *= phase.sin();
                    }
                    if tail > 0 && i >= count - tail {
                        let phase = ((i - (count - tail)) as f32 / tail as f32) * PI * 0.5;
                        *sample *= phase.cos();
                    }
                }
            }
            let range = self.voice_pos..run_end;
            for overlay in self.voiceovers.iter_mut() {
                overlay.add(
                    &mut self.voice,
                    self.voice_base,
                    range.clone(),
                    &[],
                    &self.opener,
                    &self.loudness,
                );
            }
            self.voice_pos = run_end;
        }
    }

    /// `duck_curve`, as far as the voice decides it.
    fn update_duck(&mut self, total: Option<usize>) {
        let threshold = 10.0f32.powf(DUCK_THRESHOLD_DBFS / 10.0);
        let complete_blocks = match total {
            Some(len) => len.div_ceil(DUCK_BLOCK),
            None => self.voice_pos / DUCK_BLOCK,
        };
        while self.speaking.len() < complete_blocks {
            let block = self.speaking.len();
            let len = total.unwrap_or(usize::MAX);
            let range = block * DUCK_BLOCK..((block + 1) * DUCK_BLOCK).min(len);
            let samples = (range.len() * self.voice.len()) as f32;
            let local = range.start - self.voice_base..range.end - self.voice_base;
            let energy: f32 = self
                .voice
                .iter()
                .map(|channel| channel[local.clone()].iter().map(|s| s * s).sum::<f32>())
                .sum();
            self.speaking.push(energy / samples > threshold);
        }
        let blocks_of = |sec: f64| (sec * 100.0).round() as usize;
        let (attack, hold, release) = (
            blocks_of(DUCK_ATTACK_SEC),
            blocks_of(DUCK_HOLD_SEC),
            blocks_of(DUCK_RELEASE_SEC),
        );
        let (down, up) = (DUCK_DEPTH_DB / attack as f32, -DUCK_DEPTH_DB / release as f32);
        while self.curve.len() < self.speaking.len()
            && (total.is_some() || self.curve.len() + attack < self.speaking.len())
        {
            let block = self.curve.len();
            if self.speaking[block] {
                self.duck_last = Some(block);
            }
            let held = self.duck_last.is_some_and(|spoken| block - spoken <= hold);
            let ahead_end = (block + attack).min(self.speaking.len() - 1);
            let ahead = self.speaking[block..=ahead_end].iter().any(|&s| s);
            self.duck_db = if held || ahead {
                (self.duck_db + down).max(DUCK_DEPTH_DB)
            } else {
                (self.duck_db + up).min(0.0)
            };
            self.curve.push(10.0f32.powf(self.duck_db / 20.0));
        }
    }

    fn advance(&mut self, sink: &mut dyn FnMut(&PlanarPcm) -> Result<()>) -> Result<()> {
        let total = self.total_samples();
        let limit = total.unwrap_or_else(|| self.voice_limit());
        self.produce_voice(limit);

        let mix_to = if self.music.is_empty() {
            self.voice_pos
        } else {
            self.update_duck(total);
            match total {
                Some(len) => len,
                None => self
                    .voice_pos
                    .min(self.curve.len().saturating_sub(1) * DUCK_BLOCK),
            }
        };
        if mix_to > self.mix_pos {
            let range = self.mix_pos..mix_to;
            for overlay in self.music.iter_mut() {
                overlay.add(
                    &mut self.voice,
                    self.voice_base,
                    range.clone(),
                    &self.curve,
                    &self.opener,
                    &self.loudness,
                );
            }
            let local = range.start - self.voice_base..range.end - self.voice_base;
            for plane in self.voice.iter_mut() {
                for sample in &mut plane[local.clone()] {
                    *sample *= self.trim;
                }
            }
            self.limiter.push(&self.voice, local.clone());
            for plane in self.voice.iter_mut() {
                plane.drain(..local.end);
            }
            self.voice_base = mix_to;
            self.mix_pos = mix_to;
        }

        let buffered = self.voice[0].len() + self.limiter.buffered();
        self.peak_buffered = self.peak_buffered.max(buffered);

        let mut out = planes(0);
        self.limiter.drain(total, &mut out);
        if !out[0].is_empty() {
            self.emitted += out[0].len();
            sink(&out)?;
        }
        Ok(())
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::audio::{
        assemble_concatenated_pcm, build_audio_concat_plan, finish_audio, limit_peaks,
        mix_external_tracks_with, stretch_clip_pcm_by_speed,
    };
    use std::collections::HashMap;
    use std::rc::Rc;

    #[test]
    fn sum_stream_adds_the_stems_sample_for_sample_and_pads_the_shorter() {
        let voice: PlanarPcm = (0..CHANNELS).map(|_| vec![0.25, 0.25, 0.25]).collect();
        let system: PlanarPcm = (0..CHANNELS).map(|_| vec![0.5, -0.5]).collect();
        let mut sum = SumStream::new(vec![
            Box::new(MemoryPcm::new(voice)),
            Box::new(GainStream::new(MemoryPcm::new(system), -6.0206)),
        ]);
        let mut out = planes(0);
        sum.pull(2, &mut out);
        sum.pull(2, &mut out);
        for plane in &out {
            assert_eq!(plane.len(), 4);
            assert!((plane[0] - 0.5).abs() < 1e-4 && (plane[1] - 0.0).abs() < 1e-4);
            assert!((plane[2] - 0.25).abs() < 1e-6 && plane[3].abs() < 1e-6);
        }
    }

    /// Deterministic, busy, and loud enough in places to make the limiter work.
    fn signal(len: usize, seed: u32) -> PlanarPcm {
        let mut state = seed.wrapping_mul(747_796_405).wrapping_add(1);
        let mut next = move || {
            state = state.wrapping_mul(1_664_525).wrapping_add(1_013_904_223);
            (state >> 8) as f32 / (1u32 << 24) as f32 * 2.0 - 1.0
        };
        (0..CHANNELS)
            .map(|channel| {
                (0..len)
                    .map(|i| {
                        let t = i as f32 / RATE as f32;
                        let tone = (2.0 * PI * (220.0 + 110.0 * channel as f32) * t).sin();
                        // Bursts past full scale every ~0.3 s, quiet passages between.
                        let envelope = if (i / 7_000) % 3 == 0 { 1.4 } else { 0.05 };
                        tone * envelope + next() * 0.02
                    })
                    .collect()
            })
            .collect()
    }

    fn assert_same(streamed: &PlanarPcm, reference: &PlanarPcm, what: &str) {
        assert_eq!(streamed.len(), reference.len(), "{what}: channel count");
        for (channel, (a, b)) in streamed.iter().zip(reference).enumerate() {
            assert_eq!(a.len(), b.len(), "{what}: length of channel {channel}");
            if let Some(index) = a.iter().zip(b).position(|(x, y)| x.to_bits() != y.to_bits()) {
                panic!(
                    "{what}: channel {channel} differs at sample {index}: {} vs {}",
                    a[index], b[index]
                );
            }
        }
    }

    fn pull_all(stream: &mut dyn PcmStream, len: usize, step: usize) -> PlanarPcm {
        let mut out = planes(len);
        let mut done = 0;
        while done < len {
            let n = step.min(len - done);
            stream.pull(n, &mut out);
            done += n;
        }
        out
    }

    #[test]
    fn the_streamed_limiter_is_limit_peaks_to_the_bit() {
        for (len, step) in [(0usize, 7usize), (100, 13), (5_000, 1), (48_000, 997), (48_000, 48_000)] {
            let input = signal(len, len as u32);
            let mut reference = input.clone();
            limit_peaks(&mut reference);
            let mut limiter = StreamingLimiter::new();
            let mut out = planes(len);
            let mut fed = 0;
            while fed < len {
                let n = step.min(len - fed);
                limiter.push(&input, fed..fed + n);
                fed += n;
                limiter.drain(None, &mut out);
            }
            limiter.drain(Some(len), &mut out);
            assert_same(&out, &reference, &format!("limiter len={len} step={step}"));
        }
    }

    fn segments(spec: &[(f64, f64, u64, f64)]) -> Vec<SpeedSegment> {
        spec.iter()
            .map(|&(start_sec, end_sec, frame_count, speed)| SpeedSegment {
                start_sec,
                end_sec,
                frame_count,
                speed,
            })
            .collect()
    }

    #[test]
    fn the_streamed_speed_stretch_matches_the_whole_buffer_one_under_the_chunk() {
        let fps = 60.0;
        // 1x, 2x, 0.5x and a 1x segment that rounds one sample long, as the walk emits them.
        let speed = segments(&[
            (0.0, 1.0, 60, 1.0),
            (1.0, 3.0, 60, 2.0),
            (3.0, 3.5, 60, 0.5),
            (3.5, 4.0, 30, 1.0),
        ]);
        let source = signal(4 * AUDIO_OUTPUT_SAMPLE_RATE as usize, 3);
        let reference = stretch_clip_pcm_by_speed(&source, &speed, fps);
        for step in [480usize, 4_096, 100_000] {
            let mut stream = SpeedStretchStream::new(
                MemoryPcm::new(source.clone()),
                &speed,
                fps,
                source[0].len(),
            );
            let streamed = pull_all(&mut stream, reference[0].len(), step);
            assert_same(&streamed, &reference, &format!("stretch step={step}"));
        }
    }

    #[test]
    fn a_short_source_pads_and_skips_like_the_whole_buffer_stretch() {
        let fps = 30.0;
        // The window is shorter than the segments claim: later segments read nothing.
        let speed = segments(&[(0.0, 0.5, 15, 1.0), (0.5, 1.5, 15, 2.0), (1.5, 2.0, 15, 1.0)]);
        let source = signal(30_000, 9);
        let reference = stretch_clip_pcm_by_speed(&source, &speed, fps);
        let mut stream =
            SpeedStretchStream::new(MemoryPcm::new(source.clone()), &speed, fps, source[0].len());
        let streamed = pull_all(&mut stream, reference[0].len(), 1_000);
        assert_same(&streamed, &reference, "short source");
    }

    #[test]
    fn a_long_stretched_segment_is_rendered_in_chunks_of_the_exact_total_length() {
        let fps = 60.0;
        // 75 s of source at 1.5x: three chunks, 50 s of output.
        let seconds = 75.0;
        let frames = (seconds / 1.5 * fps) as u64;
        let speed = segments(&[(0.0, seconds, frames, 1.5)]);
        let len = (seconds * RATE) as usize;
        let source = signal(len, 21);
        let expected_out = ((frames as f64 / fps) * RATE).round() as usize;
        let mut stream =
            SpeedStretchStream::new(MemoryPcm::new(source.clone()), &speed, fps, len);
        let out = pull_all(&mut stream, expected_out + 1_000, 48_000);
        // The rendered part has content all the way, and nothing past it.
        let rms = |slice: &[f32]| (slice.iter().map(|s| s * s).sum::<f32>() / slice.len() as f32).sqrt();
        for second in 0..(expected_out / AUDIO_OUTPUT_SAMPLE_RATE as usize) {
            let at = second * AUDIO_OUTPUT_SAMPLE_RATE as usize;
            assert!(
                rms(&out[0][at..at + 48_000]) > 0.01,
                "silent second {second} in a chunked stretch"
            );
        }
        assert!(out[0][expected_out..].iter().all(|&s| s == 0.0));
    }

    /// A `PcmStream` that generates its samples instead of storing them, so the memory a test
    /// measures is the programme's alone.
    struct Generated {
        cursor: usize,
        seed: u32,
    }

    impl PcmStream for Generated {
        fn pull(&mut self, n: usize, out: &mut PlanarPcm) {
            for (channel, plane) in out.iter_mut().enumerate() {
                for i in 0..n {
                    let k = (self.cursor + i) as f32;
                    plane.push(((k * 0.013 + channel as f32 + self.seed as f32).sin()) * 0.9);
                }
            }
            self.cursor += n;
        }
    }

    fn no_tracks() -> TrackOpener {
        Box::new(|_, _, _| None)
    }

    fn flat_loudness() -> LoudnessFn {
        Box::new(|_| 0.0)
    }

    #[test]
    fn a_long_programme_never_holds_more_than_a_few_seconds() {
        // Ten minutes, one clip at 1x, fed at the rate of a 60 fps export.
        let fps = 60.0;
        let frames = 10 * 60 * 60u64;
        let mut programme =
            ProgrammeAudio::new(1, fps, SceneAudio::default(), &[], no_tracks(), flat_loudness());
        programme.begin_clip(0, 0, Some(Box::new(Generated { cursor: 0, seed: 1 })));
        let mut emitted = 0usize;
        let mut sink = |pcm: &PlanarPcm| -> Result<()> {
            emitted += pcm[0].len();
            Ok(())
        };
        for frame in (0..=frames).step_by(30) {
            programme.produce(frame, &mut sink).unwrap();
        }
        programme.end_clip(0, frames);
        programme.finish(&mut sink).unwrap();
        let total = (frames as f64 / fps * RATE).round() as usize;
        assert_eq!(emitted, total);
        // Thirty frames of video between calls is 24 000 samples; the lag adds a fade and a
        // look-ahead. Nothing near the 28.8 M samples of the programme.
        assert!(
            programme.peak_buffered_samples() < 2 * 24_000,
            "held {} samples",
            programme.peak_buffered_samples()
        );
    }

    struct Fixture {
        files: HashMap<String, PlanarPcm>,
    }

    impl Fixture {
        fn window(&self, path: &str, start: f64, end: f64) -> Option<PlanarPcm> {
            let pcm = self.files.get(path)?;
            let from = (start * RATE).round() as usize;
            let len = ((end - start).max(0.0) * RATE).round() as usize;
            Some(
                pcm.iter()
                    .map(|plane| {
                        let mut out: Vec<f32> = plane.iter().skip(from).take(len).copied().collect();
                        out.resize(len, 0.0);
                        out
                    })
                    .collect(),
            )
        }
    }

    fn track(
        path: &str,
        kind: SceneAudioTrackKind,
        start_sec: f64,
        trim: (f64, f64),
        gain_db: f32,
        fades: (f64, f64),
    ) -> SceneAudioTrack {
        SceneAudioTrack {
            path: path.to_string(),
            start_sec,
            trim_start_sec: trim.0,
            trim_end_sec: Some(trim.1),
            gain_db,
            fade_in_sec: fades.0,
            fade_out_sec: fades.1,
            kind,
        }
    }

    /// The whole programme — clips with gaps and speed, boundary fades, a voiceover, a ducked
    /// music bed running past the end, the trim, the limiter — streamed in uneven steps, against
    /// the whole-buffer functions composed the way `run_multi_inner` used to compose them.
    #[test]
    fn the_streamed_programme_is_the_whole_buffer_programme() {
        let fps = 30.0;
        let rate = AUDIO_OUTPUT_SAMPLE_RATE as usize;
        // Clip 0: 2 s at 1x. Clip 1: skipped by the walk. Clip 2: 1 s at 1x then 2 s at 2x.
        // Clip 3: declared silent. Clip 4: 0.5 s whose video ran short of its plan.
        let clip_specs: Vec<(Vec<SpeedSegment>, u64, Option<PlanarPcm>)> = vec![
            (segments(&[(0.0, 2.0, 60, 1.0)]), 60, Some(signal(2 * rate, 1))),
            (Vec::new(), 0, None),
            (
                segments(&[(0.0, 1.0, 30, 1.0), (1.0, 3.0, 30, 2.0)]),
                60,
                Some(signal(3 * rate, 2)),
            ),
            (segments(&[(0.0, 1.0, 30, 1.0)]), 30, None),
            (segments(&[(0.0, 0.5, 15, 1.0)]), 11, Some(signal(rate / 2, 4))),
        ];
        let voice_take = signal(3 * rate, 7);
        let music_bed = signal(20 * rate, 8);
        let files: HashMap<String, PlanarPcm> = [
            ("voice.wav".to_string(), voice_take),
            ("music.wav".to_string(), music_bed),
        ]
        .into_iter()
        .collect();
        let fixture = Rc::new(Fixture { files });
        let tracks = vec![
            track("voice.wav", SceneAudioTrackKind::Voiceover, 0.7, (0.25, 2.5), -3.0, (0.2, 0.4)),
            track("music.wav", SceneAudioTrackKind::Music, 0.0, (1.0, 19.0), 2.0, (1.0, 2.0)),
        ];
        let settings = SceneAudio { gain_db: 4.0, ..SceneAudio::default() };
        let loudness = |path: &str| if path == "voice.wav" { 1.5 } else { 0.0 };
        let clip_gain = -2.0f32;

        // Reference: per-clip stretch + gain, plan, assemble, mix, finish.
        let frame_counts: Vec<u64> = clip_specs.iter().map(|spec| spec.1).collect();
        let declared: Vec<bool> = clip_specs.iter().map(|spec| spec.2.is_some()).collect();
        let clip_pcm: Vec<Option<PlanarPcm>> = clip_specs
            .iter()
            .map(|(speed, _, pcm)| {
                pcm.as_ref().map(|pcm| {
                    let mut stretched = stretch_clip_pcm_by_speed(pcm, speed, fps);
                    crate::audio::apply_gain_db(&mut stretched, clip_gain);
                    stretched
                })
            })
            .collect();
        let plan = build_audio_concat_plan(&frame_counts, &declared, fps);
        let reference_fixture = Rc::clone(&fixture);
        let reference = finish_audio(
            mix_external_tracks_with(
                assemble_concatenated_pcm(&clip_pcm, &plan),
                &tracks,
                &move |path, start, end| reference_fixture.window(path, start, end),
                &loudness,
            ),
            settings,
        );

        for step_frames in [1u64, 7, 45] {
            let opener_fixture = Rc::clone(&fixture);
            let mut programme = ProgrammeAudio::new(
                clip_specs.len(),
                fps,
                settings,
                &tracks,
                Box::new(move |path, start, end| {
                    opener_fixture
                        .window(path, start, end)
                        .map(|pcm| Box::new(MemoryPcm::new(pcm)) as Box<dyn PcmStream>)
                }),
                Box::new(loudness),
            );
            let mut streamed = planes(reference[0].len());
            let mut sink = |pcm: &PlanarPcm| -> Result<()> {
                for (plane, chunk) in streamed.iter_mut().zip(pcm) {
                    plane.extend_from_slice(chunk);
                }
                Ok(())
            };
            let mut frames_done = 0u64;
            for (index, (speed, frames, pcm)) in clip_specs.iter().enumerate() {
                if speed.is_empty() {
                    continue; // skipped by the walk: never begun
                }
                let source = pcm.as_ref().map(|pcm| {
                    Box::new(GainStream::new(
                        SpeedStretchStream::new(MemoryPcm::new(pcm.clone()), speed, fps, pcm[0].len()),
                        clip_gain,
                    )) as Box<dyn PcmStream>
                });
                programme.begin_clip(index, frames_done, source);
                let mut done = 0;
                while done < *frames {
                    done = (done + step_frames).min(*frames);
                    programme.produce(frames_done + done, &mut sink).unwrap();
                }
                frames_done += frames;
                programme.end_clip(index, *frames);
                programme.produce(frames_done, &mut sink).unwrap();
            }
            programme.finish(&mut sink).unwrap();
            assert_same(&streamed, &reference, &format!("programme, {step_frames} frame(s) per step"));
        }
    }

    #[test]
    fn an_empty_programme_emits_nothing() {
        let mut programme =
            ProgrammeAudio::new(2, 60.0, SceneAudio::default(), &[], no_tracks(), flat_loudness());
        let mut calls = 0;
        programme
            .finish(&mut |_| {
                calls += 1;
                Ok(())
            })
            .unwrap();
        assert_eq!(calls, 0);
        assert_eq!(programme.total_samples(), Some(0));
    }
}
