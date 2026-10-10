//! The MP4 export's failure modes, end to end on the D3D11 pipeline: cancellation, the
//! staging file, an empty timeline, a damaged recording, and the audio that now streams
//! beside the video.
//!
//! Self-contained: the media is generated with the vendored ffmpeg (`crates/thirdparty`, or
//! `FFMPEG_DIR`), so these run wherever the crate builds. A host without a hardware D3D11
//! device skips them.

#![cfg(windows)]

use openscreen_compositor::compositor::Compositor;
use openscreen_compositor::config::Cfg;
use openscreen_compositor::d3d::Gpu;
use openscreen_compositor::pipeline::{
    self, ClipSource, ExportCodec, ExportControl, ExportParams, ExportProgress,
};
use std::path::{Path, PathBuf};
use std::process::Command;
use std::sync::atomic::{AtomicU64, Ordering};

fn ffmpeg_bin(name: &str) -> PathBuf {
    let dir = std::env::var("FFMPEG_DIR")
        .map(PathBuf::from)
        .unwrap_or_else(|_| {
            Path::new(env!("CARGO_MANIFEST_DIR"))
                .join("..")
                .join("thirdparty")
                .join("ffmpeg-n8.1.2-win64-lgpl-shared")
        });
    dir.join("bin").join(name)
}

struct Scratch(PathBuf);

impl Scratch {
    fn new(name: &str) -> Self {
        static NEXT: AtomicU64 = AtomicU64::new(0);
        let dir = std::env::temp_dir().join(format!(
            "openscreen-export-robustness-{name}-{}-{}",
            std::process::id(),
            NEXT.fetch_add(1, Ordering::Relaxed)
        ));
        std::fs::create_dir_all(&dir).unwrap();
        Self(dir)
    }

    fn path(&self, name: &str) -> PathBuf {
        self.0.join(name)
    }

    fn names(&self) -> Vec<String> {
        let mut names: Vec<String> = std::fs::read_dir(&self.0)
            .unwrap()
            .map(|entry| entry.unwrap().file_name().to_string_lossy().into_owned())
            .collect();
        names.sort();
        names
    }
}

impl Drop for Scratch {
    fn drop(&mut self) {
        let _ = std::fs::remove_dir_all(&self.0);
    }
}

/// A `seconds`-long 320x180 30 fps H.264 recording with a 440 Hz AAC track.
fn make_recording(path: &Path, seconds: u32, fragmented: bool) {
    let mut command = Command::new(ffmpeg_bin("ffmpeg.exe"));
    command.args(["-v", "error", "-y", "-f", "lavfi", "-i"]);
    command.arg(format!("testsrc2=size=320x180:rate=30:duration={seconds}"));
    command.args(["-f", "lavfi", "-i"]);
    command.arg(format!("sine=frequency=440:sample_rate=48000:duration={seconds}"));
    command.args([
        "-c:v", "libopenh264", "-g", "30", "-pix_fmt", "yuv420p", "-c:a", "aac", "-shortest",
    ]);
    if fragmented {
        command.args(["-movflags", "frag_keyframe+empty_moov+default_base_moof"]);
    }
    command.arg(path);
    let status = command.status().expect("run ffmpeg");
    assert!(status.success(), "ffmpeg could not make the test recording");
}

fn clip(path: &Path, start: f64, end: f64) -> ClipSource {
    ClipSource {
        screen: path.to_string_lossy().into_owned(),
        webcam: String::new(),
        source_start_sec: start,
        source_end_sec: end,
        webcam_offset_sec: 0.0,
        has_audio: true,
    }
}

fn params() -> ExportParams {
    ExportParams { width: 320, height: 180, fps: Some(30), codec: ExportCodec::H264, bit_rate: None }
}

fn hardware() -> Option<Gpu> {
    match Gpu::create(false) {
        Ok(gpu) => Some(gpu),
        Err(error) => {
            eprintln!("skip: no hardware D3D11 device ({error:#})");
            None
        }
    }
}

fn export(
    gpu: &Gpu,
    clips: &[ClipSource],
    out: &Path,
    params: &ExportParams,
    control: &ExportControl,
    on_progress: &mut dyn FnMut(ExportProgress),
) -> anyhow::Result<pipeline::Stats> {
    let comp = Compositor::new_sized(gpu, params.width, params.height).expect("compositor");
    pipeline::run_composited_multi_controlled(
        clips,
        &out.to_string_lossy(),
        gpu,
        &comp,
        &Cfg::c8(),
        params,
        on_progress,
        control,
    )
}

/// `ffprobe` of one stream: (packet count, duration in seconds, byte offsets of its packets).
fn probe_stream(path: &Path, stream: &str) -> (usize, f64, Vec<u64>) {
    let output = Command::new(ffmpeg_bin("ffprobe.exe"))
        .args(["-v", "error", "-select_streams", stream, "-show_entries", "packet=pts_time,pos"])
        .args(["-of", "csv=p=0"])
        .arg(path)
        .output()
        .expect("run ffprobe");
    let text = String::from_utf8_lossy(&output.stdout);
    let mut last = 0.0f64;
    let mut positions = Vec::new();
    for line in text.lines() {
        let mut fields = line.split(',');
        if let Some(t) = fields.next().and_then(|t| t.parse::<f64>().ok()) {
            last = last.max(t);
        }
        if let Some(p) = fields.next().and_then(|p| p.parse::<u64>().ok()) {
            positions.push(p);
        }
    }
    (positions.len(), last, positions)
}

#[test]
fn a_finished_export_has_interleaved_audio_and_reports_its_last_phase() {
    let Some(gpu) = hardware() else { return };
    let scratch = Scratch::new("finished");
    let source = scratch.path("source.mp4");
    make_recording(&source, 3, false);
    let out = scratch.path("out.mp4");

    let mut steps = Vec::new();
    let stats = export(
        &gpu,
        &[clip(&source, 0.0, 3.0)],
        &out,
        &params(),
        &ExportControl::default(),
        &mut |step| steps.push(step),
    )
    .expect("export");
    assert_eq!(stats.frames, 90);
    assert_eq!(steps.last(), Some(&ExportProgress::Finalizing));
    assert_eq!(steps.iter().filter(|s| **s == ExportProgress::Finalizing).count(), 1);
    assert_eq!(scratch.names(), ["out.mp4", "source.mp4"], "no staging file left behind");

    let (video_packets, _, video_pos) = probe_stream(&out, "v:0");
    let (audio_packets, audio_end, audio_pos) = probe_stream(&out, "a:0");
    assert_eq!(video_packets, 90);
    assert!(audio_packets > 100, "{audio_packets} AAC packets for 3 s");
    assert!((audio_end - 3.0).abs() < 0.1, "audio ends at {audio_end}s for 3 s of video");
    // Interleaved: audio is not all written after the last video packet any more.
    let last_video = *video_pos.iter().max().unwrap();
    let first_audio = *audio_pos.iter().min().unwrap();
    assert!(
        first_audio < last_video,
        "the first audio packet sits at {first_audio}, after the last video one ({last_video})"
    );
}

#[test]
fn a_cancelled_export_keeps_the_previous_file_and_leaves_no_partial() {
    let Some(gpu) = hardware() else { return };
    let scratch = Scratch::new("cancel");
    let source = scratch.path("source.mp4");
    make_recording(&source, 3, false);
    let out = scratch.path("out.mp4");
    std::fs::write(&out, b"the export from yesterday").unwrap();

    let control = ExportControl::default();
    let canceller = control.clone();
    let result = export(
        &gpu,
        &[clip(&source, 0.0, 3.0)],
        &out,
        &params(),
        &control,
        &mut |step| {
            if step == ExportProgress::Frames(20) {
                assert!(canceller.cancel());
            }
        },
    );
    let error = result.expect_err("a cancelled export fails");
    assert!(
        error.is::<openscreen_compositor::gif_export_control::ExportCancelled>(),
        "{error:#}"
    );
    assert_eq!(std::fs::read(&out).unwrap(), b"the export from yesterday");
    assert_eq!(scratch.names(), ["out.mp4", "source.mp4"]);
}

#[test]
fn an_empty_timeline_is_an_error_not_an_empty_file() {
    let Some(gpu) = hardware() else { return };
    let scratch = Scratch::new("empty");
    let source = scratch.path("source.mp4");
    make_recording(&source, 1, false);
    let out = scratch.path("out.mp4");
    // The clip starts past the end of its recording: the walk renders nothing.
    let error = export(
        &gpu,
        &[clip(&source, 5.0, 6.0)],
        &out,
        &params(),
        &ExportControl::default(),
        &mut |_| {},
    )
    .expect_err("zero frames");
    assert!(format!("{error:#}").contains("no video frames"), "{error:#}");
    assert_eq!(scratch.names(), ["source.mp4"]);
}

#[test]
fn a_zero_frame_rate_is_refused() {
    let Some(gpu) = hardware() else { return };
    let scratch = Scratch::new("fps0");
    let source = scratch.path("source.mp4");
    make_recording(&source, 1, false);
    let out = scratch.path("out.mp4");
    let error = export(
        &gpu,
        &[clip(&source, 0.0, 1.0)],
        &out,
        &ExportParams { fps: Some(0), ..params() },
        &ExportControl::default(),
        &mut |_| {},
    )
    .expect_err("fps 0");
    assert!(format!("{error:#}").contains("frame rate"), "{error:#}");
    assert_eq!(scratch.names(), ["source.mp4"]);
}

/// A recording recovered after a crash ends on a partial fragment. Its good frames export;
/// the damaged tail is the end of the file.
#[test]
fn a_recording_cut_mid_fragment_still_exports() {
    let Some(gpu) = hardware() else { return };
    let scratch = Scratch::new("truncated");
    let source = scratch.path("source.mp4");
    make_recording(&source, 3, true);
    let bytes = std::fs::read(&source).unwrap();
    std::fs::write(&source, &bytes[..bytes.len() * 3 / 4]).unwrap();
    let out = scratch.path("out.mp4");
    let stats = export(
        &gpu,
        &[clip(&source, 0.0, 3.0)],
        &out,
        &params(),
        &ExportControl::default(),
        &mut |_| {},
    )
    .expect("a damaged tail must not fail the export");
    assert!(stats.frames > 30, "only {} frames", stats.frames);
    assert!(out.exists());
}
