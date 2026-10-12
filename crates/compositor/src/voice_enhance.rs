//! "Melhorar a voz": on-device voice enhancement, the same in the preview and the export.
//!
//! Three stages, all sample-accurate and causal, run per channel at 48 kHz:
//!
//! 1. **Noise reduction** by RNNoise (`nnnoiseless`, a pure-Rust port, BSD-3-Clause, its model
//!    built in). It works on 480-sample frames and its output lags its input by exactly one frame
//!    (`DENOISE_DELAY`): that lag is taken off here, so the enhanced voice lands on the same
//!    samples as the original and the stems stay locked to the picture. The strength mixes the
//!    denoised signal with the original, delayed by the same frame: 0 is the original, 1 the
//!    denoised voice alone.
//! 2. **High-pass** at 80 Hz (2nd-order Butterworth): rumble, desk knocks, the fan's hum.
//! 3. **Presence** boost, a peaking band at 3.5 kHz, up to +3 dB at full strength: the
//!    consonants a laptop microphone loses.
//!
//! What follows them is what the voice already had: the loudness gain measured on the ORIGINAL
//! file (`loudness_gain_db`), which the preview applies to the enhanced file too, and the
//! export's look-ahead limiter. So the enhancement changes the colour and the noise floor, never
//! where a word sits or how loud the programme is mastered.
//!
//! `EnhanceStream` is the export's form (a `PcmStream` wrapping a clip's voice before its speed
//! stretch); `enhance_pcm` the whole-buffer form of the macOS and Linux exports; `enhance_file`
//! writes the preview's copy, a WAV the editor plays in place of the voice.

use crate::audio::{PlanarPcm, AUDIO_OUTPUT_CHANNELS, AUDIO_OUTPUT_SAMPLE_RATE};
use crate::audio_stream::{ClipAudioReader, PcmStream};
use anyhow::{Context, Result};
use nnnoiseless::DenoiseState;
use std::collections::VecDeque;
use std::io::Write;

/// RNNoise's frame.
pub const FRAME: usize = DenoiseState::FRAME_SIZE;
/// How far RNNoise's output lags its input, in samples: one frame (its analysis window overlaps
/// the previous frame; `denoise_lag_is_one_frame` measures it).
pub const DENOISE_DELAY: usize = FRAME;
/// RNNoise expects 16-bit PCM scale in `f32`.
const I16_SCALE: f32 = 32768.0;
const HIGH_PASS_HZ: f64 = 80.0;
const PRESENCE_HZ: f64 = 3500.0;
const PRESENCE_Q: f64 = 0.9;
/// Presence gain at full strength.
pub const PRESENCE_MAX_DB: f64 = 3.0;

/// One RBJ biquad, transposed direct form II, in f64: at 80 Hz on 48 kHz an f32 state drifts.
#[derive(Clone, Copy, Debug)]
struct Biquad {
    b0: f64,
    b1: f64,
    b2: f64,
    a1: f64,
    a2: f64,
    z1: f64,
    z2: f64,
}

impl Biquad {
    fn new(b: [f64; 3], a: [f64; 3]) -> Self {
        Self {
            b0: b[0] / a[0],
            b1: b[1] / a[0],
            b2: b[2] / a[0],
            a1: a[1] / a[0],
            a2: a[2] / a[0],
            z1: 0.0,
            z2: 0.0,
        }
    }

    fn high_pass(freq: f64, rate: f64) -> Self {
        let w0 = std::f64::consts::TAU * freq / rate;
        let (sin, cos) = w0.sin_cos();
        let alpha = sin / (2.0 * std::f64::consts::FRAC_1_SQRT_2);
        Self::new(
            [(1.0 + cos) / 2.0, -(1.0 + cos), (1.0 + cos) / 2.0],
            [1.0 + alpha, -2.0 * cos, 1.0 - alpha],
        )
    }

    fn peaking(freq: f64, q: f64, gain_db: f64, rate: f64) -> Self {
        let a = 10f64.powf(gain_db / 40.0);
        let w0 = std::f64::consts::TAU * freq / rate;
        let (sin, cos) = w0.sin_cos();
        let alpha = sin / (2.0 * q);
        Self::new(
            [1.0 + alpha * a, -2.0 * cos, 1.0 - alpha * a],
            [1.0 + alpha / a, -2.0 * cos, 1.0 - alpha / a],
        )
    }

    #[inline]
    fn process(&mut self, x: f64) -> f64 {
        let y = self.b0 * x + self.z1;
        self.z1 = self.b1 * x - self.a1 * y + self.z2;
        self.z2 = self.b2 * x - self.a2 * y;
        y
    }
}

/// One channel's chain.
struct Channel {
    denoise: Box<DenoiseState<'static>>,
    /// The input of the frame before, for the dry half of the mix (the same one-frame lag).
    previous: Vec<f32>,
    high_pass: Biquad,
    presence: Biquad,
}

/// The enhancer, for `channels` planes. Frame by frame: `process` takes `FRAME` samples per
/// plane and gives back `FRAME`, one frame late (`DENOISE_DELAY`).
pub struct VoiceEnhancer {
    channels: Vec<Channel>,
    wet: f32,
    scratch_in: Vec<f32>,
    scratch_out: Vec<f32>,
}

impl VoiceEnhancer {
    pub fn new(channels: usize, strength: f32) -> Self {
        let strength = strength.clamp(0.0, 1.0);
        let rate = AUDIO_OUTPUT_SAMPLE_RATE as f64;
        let presence_db = PRESENCE_MAX_DB * strength as f64;
        Self {
            channels: (0..channels)
                .map(|_| Channel {
                    denoise: DenoiseState::new(),
                    previous: vec![0.0; FRAME],
                    high_pass: Biquad::high_pass(HIGH_PASS_HZ, rate),
                    presence: Biquad::peaking(PRESENCE_HZ, PRESENCE_Q, presence_db, rate),
                })
                .collect(),
            // Eased so the middle of the slider already removes most of the noise: the dry half
            // of a linear mix keeps its noise at -6 dB, this at -12 dB.
            wet: 1.0 - (1.0 - strength) * (1.0 - strength),
            scratch_in: vec![0.0; FRAME],
            scratch_out: vec![0.0; FRAME],
        }
    }

    /// Enhances one frame of every plane in place (`frame[c].len() == FRAME`). The result is the
    /// frame BEFORE this one: the lag of `DENOISE_DELAY`.
    pub fn process(&mut self, frame: &mut [Vec<f32>]) {
        for (channel, plane) in self.channels.iter_mut().zip(frame.iter_mut()) {
            for (dst, src) in self.scratch_in.iter_mut().zip(plane.iter()) {
                *dst = src * I16_SCALE;
            }
            channel.denoise.process_frame(&mut self.scratch_out, &self.scratch_in);
            for i in 0..FRAME {
                let dry = channel.previous[i] as f64;
                let wet = (self.scratch_out[i] / I16_SCALE) as f64;
                let mixed = dry + (wet - dry) * self.wet as f64;
                let filtered = channel.presence.process(channel.high_pass.process(mixed));
                channel.previous[i] = plane[i];
                plane[i] = filtered as f32;
            }
        }
    }
}

/// `inner`, enhanced, sample for sample aligned with it (the lag taken off).
pub struct EnhanceStream<S> {
    inner: S,
    enhancer: VoiceEnhancer,
    /// Enhanced samples ready to hand out, per plane.
    ready: Vec<VecDeque<f32>>,
    /// Output samples still to drop: the lag, once, at the start.
    to_drop: usize,
    frame: PlanarPcm,
}

impl<S: PcmStream> EnhanceStream<S> {
    pub fn new(inner: S, strength: f32) -> Self {
        Self {
            inner,
            enhancer: VoiceEnhancer::new(AUDIO_OUTPUT_CHANNELS, strength),
            ready: (0..AUDIO_OUTPUT_CHANNELS).map(|_| VecDeque::new()).collect(),
            to_drop: DENOISE_DELAY,
            frame: (0..AUDIO_OUTPUT_CHANNELS).map(|_| Vec::with_capacity(FRAME)).collect(),
        }
    }

    /// The source's samples still in an `inner` stream of known length, for callers that read
    /// it (`ClipAudioReader::len` through `SpeedStretchStream`): unchanged, the stream is aligned.
    pub fn inner(&self) -> &S {
        &self.inner
    }
}

impl<S: PcmStream> PcmStream for EnhanceStream<S> {
    fn pull(&mut self, n: usize, out: &mut PlanarPcm) {
        while self.ready[0].len() < n {
            for plane in self.frame.iter_mut() {
                plane.clear();
            }
            // Past its end a source yields silence: that flushes the last frame.
            self.inner.pull(FRAME, &mut self.frame);
            self.enhancer.process(&mut self.frame);
            let skip = self.to_drop.min(FRAME);
            self.to_drop -= skip;
            for (ready, plane) in self.ready.iter_mut().zip(&self.frame) {
                ready.extend(&plane[skip..]);
            }
        }
        for (plane, ready) in out.iter_mut().zip(self.ready.iter_mut()) {
            plane.extend(ready.drain(..n));
        }
    }
}

/// Whole-buffer form, for the exports that decode a clip at once (macOS, Linux).
pub fn enhance_pcm(pcm: &PlanarPcm, strength: f32) -> PlanarPcm {
    let len = pcm.first().map(Vec::len).unwrap_or(0);
    let mut stream = EnhanceStream::new(crate::audio_stream::MemoryPcm::new(pcm.clone()), strength);
    let mut out: PlanarPcm = (0..AUDIO_OUTPUT_CHANNELS).map(|_| Vec::with_capacity(len)).collect();
    stream.pull(len, &mut out);
    out.truncate(pcm.len().max(1).min(AUDIO_OUTPUT_CHANNELS));
    out
}

/// The preview's copy: `input`'s audio (every track mixed, 48 kHz stereo), enhanced, written to
/// `output` as a 16-bit WAV of the same length, sample for sample aligned with it. Streams: a
/// long take is never held in memory. Returns the number of samples per channel written.
pub fn enhance_file(input: &str, output: &str, strength: f32) -> Result<usize> {
    let duration = crate::audio_stream::audio_duration_sec(input)
        .with_context(|| format!("{input}: no audio duration"))?;
    let reader = ClipAudioReader::open(input, 0.0, duration)
        .with_context(|| format!("opening {input}"))?
        .with_context(|| format!("{input} has no audio"))?;
    let total = reader.len();
    let mut stream = EnhanceStream::new(reader, strength);
    let partial = format!("{output}.partial");
    let mut file = std::io::BufWriter::new(
        std::fs::File::create(&partial).with_context(|| format!("creating {partial}"))?,
    );
    let channels = AUDIO_OUTPUT_CHANNELS as u32;
    let rate = AUDIO_OUTPUT_SAMPLE_RATE as u32;
    let data_bytes = (total as u64 * channels as u64 * 2).min(u32::MAX as u64 - 36) as u32;
    file.write_all(b"RIFF")?;
    file.write_all(&(36 + data_bytes).to_le_bytes())?;
    file.write_all(b"WAVEfmt ")?;
    file.write_all(&16u32.to_le_bytes())?;
    file.write_all(&1u16.to_le_bytes())?;
    file.write_all(&(channels as u16).to_le_bytes())?;
    file.write_all(&rate.to_le_bytes())?;
    file.write_all(&(rate * channels * 2).to_le_bytes())?;
    file.write_all(&((channels * 2) as u16).to_le_bytes())?;
    file.write_all(&16u16.to_le_bytes())?;
    file.write_all(b"data")?;
    file.write_all(&data_bytes.to_le_bytes())?;
    let block = 1 << 15;
    let mut done = 0;
    let mut buf: PlanarPcm = (0..AUDIO_OUTPUT_CHANNELS).map(|_| Vec::with_capacity(block)).collect();
    let mut bytes = Vec::with_capacity(block * AUDIO_OUTPUT_CHANNELS * 2);
    while done < total {
        let step = block.min(total - done);
        for plane in buf.iter_mut() {
            plane.clear();
        }
        stream.pull(step, &mut buf);
        bytes.clear();
        for i in 0..step {
            for plane in &buf {
                let s = (plane[i].clamp(-1.0, 1.0) * 32767.0).round() as i16;
                bytes.extend_from_slice(&s.to_le_bytes());
            }
        }
        file.write_all(&bytes)?;
        done += step;
    }
    file.flush()?;
    drop(file);
    std::fs::rename(&partial, output).with_context(|| format!("renaming {partial}"))?;
    Ok(total)
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::audio_stream::MemoryPcm;

    const RATE: f32 = AUDIO_OUTPUT_SAMPLE_RATE as f32;

    /// A deterministic pseudo-random sequence in [-1, 1).
    fn noise(len: usize, seed: u32) -> Vec<f32> {
        let mut state = seed.max(1);
        (0..len)
            .map(|_| {
                state ^= state << 13;
                state ^= state >> 17;
                state ^= state << 5;
                (state as f32 / u32::MAX as f32) * 2.0 - 1.0
            })
            .collect()
    }

    /// A voice-like test signal: a 140 Hz buzz with harmonics, in syllables of 180 ms on, 120
    /// off, the way RNNoise's network expects speech to come and go.
    fn voice(len: usize) -> Vec<f32> {
        (0..len)
            .map(|i| {
                let t = i as f32 / RATE;
                let syllable = (t * 1000.0) % 300.0 < 180.0;
                if !syllable {
                    return 0.0;
                }
                let f0 = 140.0 + 20.0 * (t * 3.0).sin();
                (1..12)
                    .map(|h| (std::f32::consts::TAU * f0 * h as f32 * t).sin() / h as f32)
                    .sum::<f32>()
                    * 0.12
            })
            .collect()
    }

    fn power(x: &[f32]) -> f64 {
        x.iter().map(|v| (*v as f64).powi(2)).sum::<f64>() / x.len().max(1) as f64
    }

    fn stereo(x: &[f32]) -> PlanarPcm {
        vec![x.to_vec(), x.to_vec()]
    }

    /// The streamed form, pulled in uneven blocks.
    fn run(pcm: &PlanarPcm, strength: f32, step: usize) -> PlanarPcm {
        let len = pcm[0].len();
        let mut stream = EnhanceStream::new(MemoryPcm::new(pcm.clone()), strength);
        let mut out: PlanarPcm = vec![Vec::new(), Vec::new()];
        let mut done = 0;
        while done < len {
            let n = step.min(len - done);
            stream.pull(n, &mut out);
            done += n;
        }
        out
    }

    /// Lag of `y` against `x` that maximises their correlation, over ±`range` samples.
    fn best_lag(x: &[f32], y: &[f32], range: i64) -> i64 {
        let mut best = (0i64, f64::MIN);
        for lag in -range..=range {
            let mut c = 0.0f64;
            for i in 0..x.len() {
                let j = i as i64 + lag;
                if j >= 0 && (j as usize) < y.len() {
                    c += x[i] as f64 * y[j as usize] as f64;
                }
            }
            if c > best.1 {
                best = (lag, c);
            }
        }
        best.0
    }

    /// What the chain does at strength 0: the high-pass alone (the presence band is flat).
    fn eq_only(x: &[f32]) -> Vec<f32> {
        let mut hp = Biquad::high_pass(HIGH_PASS_HZ, RATE as f64);
        x.iter().map(|v| hp.process(*v as f64) as f32).collect()
    }

    #[test]
    fn strength_zero_is_the_original_through_the_high_pass_on_the_same_samples() {
        let len = 48_000;
        let x: Vec<f32> = voice(len);
        let out = run(&stereo(&x), 0.0, 4096);
        assert_eq!(out[0].len(), len, "same length");
        let reference = eq_only(&x);
        let worst = out[0].iter().zip(&reference).map(|(a, b)| (a - b).abs()).fold(0.0f32, f32::max);
        assert!(worst < 1e-5, "the dry path moved or changed: {worst}");
    }

    #[test]
    fn the_enhanced_voice_is_sample_aligned_with_the_original() {
        let len = 48_000 * 2;
        let x = voice(len);
        let out = run(&stereo(&x), 1.0, 1000);
        assert_eq!(out[0].len(), len, "same length");
        let reference = eq_only(&x);
        let lag = best_lag(&reference[24_000..72_000], &out[0][24_000..72_000], 2 * FRAME as i64);
        println!("denoised voice lag: {lag} samples");
        // The network is not linear-phase: a sample or two either way is its, not a lag.
        assert!(lag.abs() <= 4, "the lag of the denoiser was not taken off: {lag}");
    }

    #[test]
    fn noise_between_words_is_reduced_and_the_voice_kept() {
        let len = 48_000 * 4;
        let clean = voice(len);
        let hiss: Vec<f32> = noise(len, 7).iter().map(|v| v * 0.02).collect();
        let noisy: Vec<f32> = clean.iter().zip(&hiss).map(|(a, b)| a + b).collect();
        let out = run(&stereo(&noisy), 1.0, 2048);
        // Measured after the first second, once the network has settled.
        let gaps = |x: &[f32]| -> f64 {
            let v: Vec<f32> = (48_000..len)
                .filter(|&i| clean[i] == 0.0)
                .map(|i| x[i])
                .collect();
            power(&v)
        };
        let reference = eq_only(&noisy);
        let reduction_db = 10.0 * (gaps(&reference) / gaps(&out[0]).max(1e-20)).log10();
        let kept_db = 10.0 * (power(&out[0][48_000..]) / power(&eq_only(&clean)[48_000..])).log10();
        println!("noise in the gaps -{reduction_db:.1} dB, voice level {kept_db:+.1} dB");
        // A synthetic buzz is not speech to RNNoise, so it keeps more noise than on a voice
        // (17 -> 41 dB SNR on a recorded one, `a_noisy_recorded_voice_gains_snr_and_stays_aligned`).
        assert!(reduction_db > 3.0, "only -{reduction_db:.1} dB of noise");
        assert!(kept_db > -6.0, "the voice lost {kept_db:.1} dB");
    }

    /// Gated SNR of `x` against the clean voice it carries: power in the 20 ms frames where the
    /// clean voice speaks, over the power in those where it is silent (the noise floor).
    fn gated_snr_db(clean: &[f32], x: &[f32]) -> f64 {
        let frame = 960;
        let powers: Vec<(f64, f64)> = clean
            .chunks(frame)
            .zip(x.chunks(frame))
            .map(|(c, y)| (power(c), power(y)))
            .collect();
        let peak = powers.iter().map(|p| p.0).fold(0.0, f64::max);
        let speech: Vec<f64> = powers.iter().filter(|p| p.0 > peak * 1e-3).map(|p| p.1).collect();
        let silence: Vec<f64> = powers.iter().filter(|p| p.0 < peak * 1e-6).map(|p| p.1).collect();
        let mean = |v: &[f64]| v.iter().sum::<f64>() / v.len().max(1) as f64;
        let noise = mean(&silence);
        10.0 * ((mean(&speech) - noise).max(1e-20) / noise.max(1e-20)).log10()
    }

    /// A real voice (`VOICE_CLEAN`) and the same with noise (`VOICE_NOISY`), 48 kHz WAVs: the SNR
    /// before and after, and the alignment. Skipped without them (see docs/HANDOFF.md).
    #[test]
    fn a_noisy_recorded_voice_gains_snr_and_stays_aligned() {
        let (Ok(clean_path), Ok(noisy_path)) = (std::env::var("VOICE_CLEAN"), std::env::var("VOICE_NOISY")) else {
            println!("SKIP: VOICE_CLEAN / VOICE_NOISY");
            return;
        };
        let out_path = std::env::temp_dir().join(format!("voice-enhance-{}.wav", std::process::id()));
        let out_str = out_path.to_str().unwrap().to_string();
        let started = std::time::Instant::now();
        let written = enhance_file(&noisy_path, &out_str, 1.0).expect("enhance");
        let elapsed = started.elapsed().as_secs_f64();
        let dur = written as f64 / RATE as f64;
        let read = |p: &str| crate::audio::decode_clip_audio(p, 0.0, dur).unwrap().unwrap();
        let (clean, noisy, out) = (read(&clean_path), read(&noisy_path), read(&out_str));
        let _ = std::fs::remove_file(&out_path);
        for strength in [0.5f32, 1.0] {
            let enhanced = if strength == 1.0 { out[0].clone() } else { enhance_pcm(&noisy, strength)[0].clone() };
            println!(
                "strength {strength}: SNR {:.1} dB -> {:.1} dB",
                gated_snr_db(&clean[0], &noisy[0]),
                gated_snr_db(&clean[0], &enhanced)
            );
        }
        let reference = eq_only(&clean[0]);
        let mid = clean[0].len() / 2;
        let lag = best_lag(&reference[mid..mid + 48_000], &out[0][mid..mid + 48_000], 2 * FRAME as i64);
        println!("{dur:.1} s enhanced in {elapsed:.2} s ({:.0}x real time), lag {lag} samples", dur / elapsed);
        assert_eq!(out[0].len(), noisy[0].len());
        assert!(lag.abs() <= 4, "lag {lag}");
        assert!(gated_snr_db(&clean[0], &out[0]) > gated_snr_db(&clean[0], &noisy[0]) + 6.0);
    }

    #[test]
    fn rumble_under_80_hz_is_cut() {
        let len = 48_000;
        let hum: Vec<f32> = (0..len).map(|i| (std::f32::consts::TAU * 30.0 * i as f32 / RATE).sin() * 0.2).collect();
        let out = run(&stereo(&hum), 0.0, 4800);
        let db = 10.0 * (power(&out[0][24_000..]) / power(&hum[24_000..])).log10();
        assert!(db < -8.0, "30 Hz only {db:.1} dB down");
    }

    #[test]
    fn the_stream_does_not_depend_on_how_it_is_pulled() {
        let len = 30_000;
        let x: Vec<f32> = voice(len).iter().zip(noise(len, 3)).map(|(a, b)| a + b * 0.01).collect();
        let a = run(&stereo(&x), 0.7, 333);
        let b = run(&stereo(&x), 0.7, 30_000);
        assert_eq!(a, b);
        assert_eq!(enhance_pcm(&stereo(&x), 0.7), b);
    }
}
