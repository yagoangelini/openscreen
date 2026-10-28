//! "Remover eco do alto-falante": offline acoustic echo cancellation of a take's voice stem,
//! with the take's computer stem as the far-end reference.
//!
//! A take recorded with the computer's sound on the laptop speakers (no headphones) has that
//! sound twice: clean in the computer stem, and again in the microphone, a couple of hundred
//! milliseconds later and coloured by the room. Played together they comb and smear. The
//! computer stem is the exact signal the speakers played, already time-aligned with the voice by
//! the recorder, so the echo can be modelled and subtracted after the fact — no capture-time
//! processing, nothing changed in the recording itself.
//!
//! Four stages, all offline and in order:
//!
//! 1. **Bleed estimation** (`DelayTracker`, `fit_delay_line`). Both stems, mono and decimated to
//!    16 kHz, are cross-correlated (GCC-PHAT) in windows of 4 s where the computer is playing. A
//!    window with a clear peak gives one (time, lag) point. The microphone and the loopback run
//!    on two clocks, so the lag drifts (21 ppm, 180 → 207 ms over the 22 min take this was built
//!    on), and a room gives several strong paths, so a window's peak lands on one or another of
//!    them: the drift is the one under which most points fall on a single path. Fewer than three
//!    consistent windows means no bleed: nothing is processed, the voice is left as recorded.
//! 2. **Linear cancellation** (`EchoCanceller`). The reference is re-timed onto the voice by that
//!    line (fractional, cubic), minus a margin, so the adaptive filter only has to model the
//!    room: a subband filter in the STFT domain (1024-point frames, hop 256 — 75 % overlap, which
//!    a subband filter without cross-band terms needs to model paths that fall between frames —
//!    sqrt-Hann), one complex NLMS filter of `TAPS` frames per bin, 32 ms before the estimated
//!    delay to 160 ms after it. Adaptation is gated by double-talk detection: the power-weighted
//!    coherence between the microphone and the echo estimate is high when the microphone hears
//!    only the speakers and low when the user talks too, so the user's voice never trains the
//!    filter. Before the filter has learned anything (its first ~2 s of adaptation) the aligned
//!    reference stands in, with a looser bar.
//! 3. **Residual echo suppression**: per bin, the echo left after the filter is estimated two
//!    ways — the filter's own estimate scaled by what it misses, and a level model (echo power
//!    per unit of reference power, learned on frames of the speakers alone, slow to rise so a
//!    slip of the detector cannot teach it the voice) — and the larger is subtracted from the
//!    error power, over-estimated ×4 where the speakers are heard alone and ×1 where the user
//!    talks too. The gain never goes under the microphone's own noise floor (no pumping room
//!    tone), nor under −40 dB, and falls at most ~4 dB per frame.
//! 4. **Near-end gate** (`NearEndGate`, "Silêncio quando só o outro fala"). On the take of 27/10
//!    the speakers' own processing (Nahimic on the Realtek output, Intel's effects on the
//!    microphone) compresses the echo by up to 10 dB with the playback level and changes its
//!    phase, so the linear stage removes only ~7 dB and stage 3 leaves the guest's words some
//!    15 dB under the guest — faint, and audible. The gate hears whether the user is talking by
//!    spectral tilt, which no level change on the path moves: a laptop speaker plays next to
//!    nothing under ~250 Hz, where a male voice has its fundamental (details on the struct).
//!    Where they are not, every bin goes down to the microphone's noise floor; where they are,
//!    stage 3 takes its double-talk setting. Offline, so it hears ahead: frames wait 80 ms in a
//!    queue, the gate opens that far before the user's first detected frame and holds 300 ms
//!    after their last. It learns its thresholds per take and stays open until it has (≈10 s of
//!    the speakers alone and 3 s of the user alone), and for good on a take without a band the
//!    speakers spare: there the canceller is stages 1–3, as in 2.8.0.
//!
//! The strengths ("Intensidade", `Strength`) share stages 1–3 and differ in the gate and in how
//! hard stage 3 works while both talk: Suave closes the gate 6 dB at most and keeps 2.8.0's
//! suppressor; Normal closes it to the noise floor and backs the suppressor off while the user
//! talks (×0.5), for an untouched voice; Forte closes it too and pushes the suppressor (×3).
//!
//! Frames whose reference has been silent for the whole filter length are passed through
//! untouched: a stretch where only the user talks comes out sample for sample as recorded.
//! The first `WARM_UP_SEC` are run twice — once to train the filter, once for real — so the
//! start of the take is cancelled as well as the rest.
//!
//! Measured on the take of 27/10 (`docs/HANDOFF.md`, "Remover eco do alto-falante"; 15 s for
//! the 22 min in a release build). Where only the guest plays (62–72 s, the guest at −19 dBFS),
//! what is left of the echo: 2.8.0 −34.4 dBFS, Suave −40.2, Normal −68.0, Forte −69.3 (the
//! microphone's floor is about −76). Where only the user talks: −0.15 dB (2.8.0) and −0.25 dB
//! (Normal) on average. The user's real voice put over a real guest-only stretch at its natural
//! level (7 dB over the echo): Normal keeps it at −0.74 dB (2.8.0: −0.88) and takes 60 ms of the
//! 200 after an onset more than 3 dB down (2.8.0: 153 ms); Forte −1.53 dB, at a log-spectral
//! distance of 5.0 dB from the voice against Normal's 2.7 and 2.8.0's 2.6.
//!
//! Pure Rust, MIT like the rest of the crate; its only dependency is `realfft` (MIT/Apache-2.0,
//! already in the tree through `nnnoiseless`). `cancel_echo_file` writes the cleaned voice as a
//! 16-bit 48 kHz WAV (the voice on both channels), aligned sample for sample with the stem: the
//! editor plays it in place of the voice and the export reads it in place of the voice stem.

use crate::audio::{PlanarPcm, AUDIO_OUTPUT_SAMPLE_RATE};
use crate::audio_stream::{ClipAudioReader, PcmStream};
use anyhow::{Context, Result};
use realfft::num_complex::Complex;
use realfft::{ComplexToReal, RealFftPlanner, RealToComplex};
use serde::Serialize;
use std::collections::VecDeque;
use std::io::Write;
use std::sync::Arc;

const RATE: usize = AUDIO_OUTPUT_SAMPLE_RATE as usize;
/// STFT frame and hop at 48 kHz: 21.3 ms frames, 5.3 ms hop.
const FRAME: usize = 1024;
const HOP: usize = FRAME / 4;
/// Zeros in front of the first frame, so every sample is covered by `FRAME / HOP` frames.
const PAD: usize = FRAME - HOP;
const BINS: usize = FRAME / 2 + 1;
/// Bins the adaptive filter covers: all of them (a laptop's tweeter reaches past 12 kHz).
const ADAPT_BINS: usize = BINS;
/// How much of the reference before the estimated delay the filter sees, in frames (32 ms): the
/// estimate is the busiest path, and the direct one can be a little earlier.
const PRE_FRAMES: usize = 6;
/// Filter length in frames: 36 × 5.3 ms = 192 ms (32 before the delay, 160 after).
pub const TAPS: usize = 36;
/// The first seconds, run once to train the filter before the real pass.
pub const WARM_UP_SEC: f64 = 30.0;

/// Delay estimation: 16 kHz, 4 s windows (2^16 samples), lags from −50 ms to +1 s.
const EST_DECIM: usize = 3;
const EST_RATE: f64 = (RATE / EST_DECIM) as f64;
const EST_WINDOW: usize = 1 << 16;
const EST_MIN_LAG_SEC: f64 = -0.05;
const EST_MAX_LAG_SEC: f64 = 1.0;
/// A window counts when its PHAT peak stands this many times above the median of the lag range.
const EST_PEAK_TO_FLOOR: f32 = 7.0;
/// Consistent windows needed to call it a bleed.
const EST_MIN_WINDOWS: usize = 3;
/// Reference level under which a frame is silent (−65 dBFS, per-sample power).
const REF_SILENT_POWER: f32 = 3.2e-7;

/// What the estimation found, and what the cancellation did. Serialised as the report the app
/// caches beside the cleaned voice and shows on the microphone lane.
#[derive(Debug, Clone, Default, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct EchoReport {
    /// A consistent speaker echo was found in the voice stem.
    pub detected: bool,
    /// Echo delay at the start of the take, in ms (the microphone lags the computer stem).
    pub delay_ms: f64,
    /// Delay at the end of the take, in ms (the two clocks drift).
    pub delay_end_ms: f64,
    pub drift_ppm: f64,
    /// Windows where the computer was playing, and those with a consistent peak.
    pub windows: usize,
    pub consistent_windows: usize,
    /// Echo level in the microphone relative to the user's own voice, in dB (negative: quieter).
    pub echo_to_voice_db: f64,
    /// Echo return loss enhancement over the frames where only the speakers were heard, in dB:
    /// how much quieter they are after the cancellation.
    pub erle_db: f64,
    /// The same frames' level change from the linear filter alone, in dB.
    pub linear_erle_db: f64,
    /// Share of the frames processed (the rest passed through as recorded).
    pub processed_share: f64,
    /// Mean adaptation gate over the processed frames (1: speakers alone, 0: double-talk).
    pub adapt_share: f64,
    pub duration_sec: f64,
    /// How loud the speakers' sound reached the microphone, relative to the computer stem, in dB
    /// (K-weighted, frames where only the speakers were heard): the echo path's gain.
    pub echo_path_gain_db: f64,
    /// True peak of the computer stem (4× interpolated), in dBFS.
    pub system_true_peak_dbfs: f64,
    /// The gain the "Áudio do sistema" lane gets once the echo is gone, so the guest is heard at
    /// the level the microphone heard them, once and clean (`system_compensation_db`).
    pub system_compensation_db: f64,
    /// Share of the processed frames the near-end gate held closed (stage 4): where the computer
    /// played and the user did not talk.
    pub gate_closed_share: f64,
}

/// Most a compensation may add: past this a quiet stem is noise, not a guest.
pub const MAX_SYSTEM_COMPENSATION_DB: f64 = 30.0;

/// The computer lane's compensation for an echo path of `echo_path_gain_db`: that gain, but
/// never below 0 dB, never above `MAX_SYSTEM_COMPENSATION_DB`, and never past what keeps the
/// stem's true peak at −1 dBFS. `clampSystemCompensationDb` (`src/lib/ai-edition/echoCancel.ts`)
/// is the same function, with the same test points.
pub fn system_compensation_db(echo_path_gain_db: f64, system_true_peak_dbfs: f64) -> f64 {
    if !echo_path_gain_db.is_finite() {
        return 0.0;
    }
    let headroom = if system_true_peak_dbfs.is_finite() {
        -1.0 - system_true_peak_dbfs
    } else {
        0.0
    };
    echo_path_gain_db
        .min(MAX_SYSTEM_COMPENSATION_DB)
        .min(headroom)
        .max(0.0)
}

/// A true-peak meter: each channel's samples and three points between each pair, Catmull-Rom
/// (a 4× oversampling, close to BS.1770's for speech and music).
#[derive(Default)]
pub struct TruePeakMeter {
    history: Vec<[f32; 4]>,
    peak: f32,
}

impl TruePeakMeter {
    pub fn push(&mut self, planes: &[Vec<f32>]) {
        if self.history.len() < planes.len() {
            self.history.resize(planes.len(), [0.0; 4]);
        }
        for (plane, h) in planes.iter().zip(self.history.iter_mut()) {
            for &s in plane {
                h.rotate_left(1);
                h[3] = s;
                let [p0, p1, p2, p3] = *h;
                self.peak = self.peak.max(p2.abs());
                for t in [0.25f32, 0.5, 0.75] {
                    let t2 = t * t;
                    let t3 = t2 * t;
                    let v = 0.5
                        * ((2.0 * p1)
                            + (-p0 + p2) * t
                            + (2.0 * p0 - 5.0 * p1 + 4.0 * p2 - p3) * t2
                            + (-p0 + 3.0 * p1 - 3.0 * p2 + p3) * t3);
                    self.peak = self.peak.max(v.abs());
                }
            }
        }
    }

    pub fn dbfs(&self) -> f64 {
        if self.peak > 0.0 {
            20.0 * (self.peak as f64).log10()
        } else {
            f64::NEG_INFINITY
        }
    }
}

// --------------------------------------------------------------------------------------------
// Stage 1: delay and drift
// --------------------------------------------------------------------------------------------

/// A 48 → 16 kHz decimator: a 24-tap windowed-sinc low-pass at 7 kHz, every third sample.
struct Decimator {
    taps: Vec<f32>,
    history: VecDeque<f32>,
    phase: usize,
}

impl Decimator {
    fn new() -> Self {
        let n = 24;
        let cutoff = 7000.0 / RATE as f64;
        let mid = (n - 1) as f64 / 2.0;
        let mut taps: Vec<f32> = (0..n)
            .map(|i| {
                let x = i as f64 - mid;
                let sinc = if x == 0.0 {
                    2.0 * cutoff
                } else {
                    (std::f64::consts::TAU * cutoff * x).sin() / (std::f64::consts::PI * x)
                };
                let w = 0.5 - 0.5 * (std::f64::consts::TAU * i as f64 / (n - 1) as f64).cos();
                (sinc * w) as f32
            })
            .collect();
        let sum: f32 = taps.iter().sum();
        for t in &mut taps {
            *t /= sum;
        }
        Self {
            taps,
            history: VecDeque::from(vec![0.0; n]),
            phase: 0,
        }
    }

    fn push(&mut self, x: f32, out: &mut Vec<f32>) {
        self.history.pop_front();
        self.history.push_back(x);
        self.phase += 1;
        if self.phase == EST_DECIM {
            self.phase = 0;
            out.push(
                self.history
                    .iter()
                    .zip(&self.taps)
                    .map(|(h, t)| h * t)
                    .sum(),
            );
        }
    }
}

/// One estimation window's answer.
#[derive(Debug, Clone, Copy)]
struct LagPoint {
    t_sec: f64,
    lag_sec: f64,
}

/// Collects GCC-PHAT peaks over a take, a window at a time. Feed it both stems, mono, at 48 kHz,
/// in the same blocks; `finish` fits the delay line.
pub struct DelayTracker {
    ref_dec: Decimator,
    mic_dec: Decimator,
    ref_win: Vec<f32>,
    mic_win: Vec<f32>,
    windows_done: usize,
    active_windows: usize,
    points: Vec<LagPoint>,
    forward: Arc<dyn RealToComplex<f32>>,
    inverse: Arc<dyn ComplexToReal<f32>>,
    samples: usize,
}

impl Default for DelayTracker {
    fn default() -> Self {
        Self::new()
    }
}

impl DelayTracker {
    pub fn new() -> Self {
        let mut planner = RealFftPlanner::<f32>::new();
        Self {
            ref_dec: Decimator::new(),
            mic_dec: Decimator::new(),
            ref_win: Vec::with_capacity(EST_WINDOW),
            mic_win: Vec::with_capacity(EST_WINDOW),
            windows_done: 0,
            active_windows: 0,
            points: Vec::new(),
            forward: planner.plan_fft_forward(EST_WINDOW * 2),
            inverse: planner.plan_fft_inverse(EST_WINDOW * 2),
            samples: 0,
        }
    }

    pub fn push(&mut self, reference: &[f32], mic: &[f32]) {
        for (r, m) in reference.iter().zip(mic) {
            self.ref_dec.push(*r, &mut self.ref_win);
            self.mic_dec.push(*m, &mut self.mic_win);
            if self.ref_win.len() == EST_WINDOW {
                self.analyse_window();
            }
        }
        self.samples += reference.len().min(mic.len());
    }

    fn analyse_window(&mut self) {
        let start_sec = (self.windows_done * EST_WINDOW) as f64 / EST_RATE;
        self.windows_done += 1;
        // The computer must play for at least 30% of the window, or the peak is noise.
        let sub = 1600; // 100 ms
        let active = self
            .ref_win
            .chunks(sub)
            .filter(|c| {
                c.iter().map(|v| v * v).sum::<f32>() / c.len() as f32 > REF_SILENT_POWER * 10.0
            })
            .count();
        let total_sub = EST_WINDOW.div_ceil(sub);
        if active * 10 >= total_sub * 3 {
            self.active_windows += 1;
            if let Some(lag) = self.phat_peak() {
                self.points.push(LagPoint {
                    t_sec: start_sec,
                    lag_sec: lag,
                });
            }
        }
        self.ref_win.clear();
        self.mic_win.clear();
    }

    /// The lag (seconds, mic after reference) of the GCC-PHAT peak, when it is clear.
    fn phat_peak(&self) -> Option<f64> {
        let n = EST_WINDOW * 2;
        let mut a = vec![0.0f32; n];
        let mut b = vec![0.0f32; n];
        a[..EST_WINDOW].copy_from_slice(&self.ref_win);
        b[..EST_WINDOW].copy_from_slice(&self.mic_win);
        let mut sa = self.forward.make_output_vec();
        let mut sb = self.forward.make_output_vec();
        self.forward.process(&mut a, &mut sa).ok()?;
        self.forward.process(&mut b, &mut sb).ok()?;
        for (x, y) in sa.iter_mut().zip(&sb) {
            let cross = y * x.conj();
            let mag = cross.norm();
            *x = if mag > 1e-20 {
                cross / mag
            } else {
                Complex::new(0.0, 0.0)
            };
        }
        sa[0].im = 0.0;
        if let Some(last) = sa.last_mut() {
            last.im = 0.0;
        }
        let mut corr = vec![0.0f32; n];
        self.inverse.process(&mut sa, &mut corr).ok()?;
        let min_lag = (EST_MIN_LAG_SEC * EST_RATE).round() as i64;
        let max_lag = (EST_MAX_LAG_SEC * EST_RATE).round() as i64;
        let at = |lag: i64| corr[((lag + n as i64) % n as i64) as usize];
        let (mut best, mut best_lag) = (f32::MIN, 0i64);
        let mut mags = Vec::with_capacity((max_lag - min_lag + 1) as usize);
        for lag in min_lag..=max_lag {
            let v = at(lag);
            mags.push(v.abs());
            if v > best {
                best = v;
                best_lag = lag;
            }
        }
        mags.sort_by(|x, y| x.total_cmp(y));
        let floor = mags[mags.len() / 2].max(1e-12);
        if best / floor < EST_PEAK_TO_FLOOR {
            return None;
        }
        // Parabolic refinement around the peak.
        let (l, c, r) = (at(best_lag - 1), at(best_lag), at(best_lag + 1));
        let denom = l - 2.0 * c + r;
        let frac = if denom.abs() > 1e-12 {
            (0.5 * (l - r) / denom).clamp(-0.5, 0.5)
        } else {
            0.0
        };
        Some((best_lag as f64 + frac as f64) / EST_RATE)
    }

    /// The delay line through the windows' peaks, or no bleed.
    pub fn finish(self) -> BleedEstimate {
        fit_delay_line(
            &self.points,
            self.active_windows,
            self.samples as f64 / RATE as f64,
        )
    }
}

/// The echo path's bulk delay over the take: `delay_sec + drift × t`.
#[derive(Debug, Clone, Copy, Default)]
pub struct BleedEstimate {
    pub detected: bool,
    pub delay_sec: f64,
    /// Seconds of extra delay per second of take.
    pub drift: f64,
    pub windows: usize,
    pub consistent_windows: usize,
    pub duration_sec: f64,
}

impl BleedEstimate {
    pub fn delay_at(&self, t_sec: f64) -> f64 {
        self.delay_sec + self.drift * t_sec
    }
}

/// The delay line through the windows' peaks. A room gives several strong paths (the take this
/// was built on: 172, 181 and 197 ms, each window's peak landing on one or another), so a plain
/// regression across them is wrong. Every pair of points far enough apart proposes a drift; the
/// one under which the most points fall on one path (within 0.6 ms) wins, and that path is the
/// delay. The points within 40 ms of it — any path — are the consistent ones: at least
/// `EST_MIN_WINDOWS` of them, a quarter of the windows where the computer played, and a positive
/// delay make a bleed.
fn fit_delay_line(points: &[LagPoint], active_windows: usize, duration_sec: f64) -> BleedEstimate {
    let none = BleedEstimate {
        windows: active_windows,
        duration_sec,
        ..Default::default()
    };
    if points.len() < EST_MIN_WINDOWS {
        return BleedEstimate {
            consistent_windows: points.len(),
            ..none
        };
    }
    // Two clocks on one machine drift by tens of ppm.
    const MAX_DRIFT: f64 = 150e-6;
    const PATH_WIDTH: f64 = 0.0006;
    let mut candidates = vec![0.0f64];
    for (i, a) in points.iter().enumerate() {
        for b in &points[i + 1..] {
            let dt = b.t_sec - a.t_sec;
            if dt.abs() >= 8.0 {
                let slope = (b.lag_sec - a.lag_sec) / dt;
                if slope.abs() <= MAX_DRIFT {
                    candidates.push(slope);
                }
            }
        }
    }
    // Bounded work on a long take: an even subsample of the candidates.
    let stride = candidates.len().div_ceil(3000).max(1);
    let mut best = (0usize, 0.0f64, 0.0f64); // (points on the path, drift, delay)
    let mut residuals = Vec::with_capacity(points.len());
    for &drift in candidates.iter().step_by(stride) {
        residuals.clear();
        residuals.extend(points.iter().map(|p| p.lag_sec - drift * p.t_sec));
        residuals.sort_by(|a, b| a.total_cmp(b));
        let mut start = 0;
        for end in 0..residuals.len() {
            while residuals[end] - residuals[start] > PATH_WIDTH {
                start += 1;
            }
            let count = end - start + 1;
            if count > best.0 || (count == best.0 && drift.abs() < best.1.abs()) {
                best = (count, drift, residuals[(start + end) / 2]);
            }
        }
    }
    let (_, drift, delay) = best;
    let consistent = points
        .iter()
        .filter(|p| (p.lag_sec - (delay + drift * p.t_sec)).abs() <= 0.04)
        .count();
    let detected = consistent >= EST_MIN_WINDOWS
        && consistent * 4 >= active_windows.max(1)
        && delay > 0.002
        && delay + drift * duration_sec > 0.002;
    BleedEstimate {
        detected,
        delay_sec: delay,
        drift,
        windows: active_windows,
        consistent_windows: consistent,
        duration_sec,
    }
}

// --------------------------------------------------------------------------------------------
// Stages 2 and 3: cancellation and suppression
// --------------------------------------------------------------------------------------------

/// BS.1770's K-weighting (its 48 kHz pre-filter and RLB high-pass) as a power gain per STFT bin.
fn k_weighting() -> Vec<f32> {
    let stages: [([f64; 3], [f64; 3]); 2] = [
        (
            [1.53512485958697, -2.69169618940638, 1.19839281085285],
            [1.0, -1.69065929318241, 0.73248077421585],
        ),
        ([1.0, -2.0, 1.0], [1.0, -1.99004745483398, 0.99007225036621]),
    ];
    (0..BINS)
        .map(|k| {
            let w = std::f64::consts::PI * k as f64 / (BINS - 1) as f64;
            let z1 = Complex::new(w.cos(), -w.sin());
            let z2 = z1 * z1;
            stages
                .iter()
                .map(|(b, a)| {
                    let num = Complex::new(b[0], 0.0) + z1 * b[1] + z2 * b[2];
                    let den = Complex::new(a[0], 0.0) + z1 * a[1] + z2 * a[2];
                    (num / den).norm_sqr()
                })
                .product::<f64>() as f32
        })
        .collect()
}

fn sqrt_hann() -> Vec<f32> {
    (0..FRAME)
        .map(|i| {
            (0.5 - 0.5 * (std::f64::consts::TAU * i as f64 / FRAME as f64).cos()).sqrt() as f32
        })
        .collect()
}

/// Running totals for the report.
#[derive(Debug, Default, Clone, Copy)]
struct Totals {
    frames: usize,
    processed: usize,
    echo_only_mic: f64,
    echo_only_linear: f64,
    echo_only_out: f64,
    echo_energy: f64,
    echo_frames: usize,
    voice_energy: f64,
    voice_frames: usize,
    gate_sum: f64,
    path_mic: f64,
    path_ref: f64,
    gate_frames: usize,
    gate_closed: f64,
}

/// The canceller's knobs. The defaults are what the app runs; tests may vary them.
#[derive(Debug, Clone, Copy)]
pub struct Tuning {
    /// NLMS step at full adaptation.
    pub mu: f32,
    /// Coherence below which the filter does not adapt, and above which it adapts fully.
    pub gate_lo: f32,
    pub gate_hi: f32,
    /// Least share of the step a bin keeps when its error is mostly not echo.
    pub ratio_floor: f32,
    /// Residual echo over-estimation of the suppressor, when the speakers are heard alone and
    /// when the user talks over them.
    pub over: f32,
    pub over_double_talk: f32,
    /// Suppression floor (linear gain).
    pub floor: f32,
    /// Filter length in frames, and how many of them come before the estimated delay.
    pub taps: usize,
    pub pre: usize,
    /// The near-end gate (stage 4). Off, the canceller is stages 1–3 alone (2.8.0).
    pub near_gate: bool,
    /// The suppressor takes its double-talk setting wherever the gate hears the user (from its
    /// lookahead to `PRESENCE_TAIL` frames after), instead of only where the coherence has
    /// dropped (which lags their first syllable).
    pub near_res: bool,
    /// How far the gate closes, in dB under the suppressor's output: `f32::INFINITY` takes each
    /// bin down to the microphone's noise floor.
    pub near_depth_db: f32,
    /// A band hears the user when it is this many dB over its noise floor ...
    pub near_noise_db: f32,
    /// ... and its share of the microphone's speech band is this many dB over the largest the
    /// echo was seen to have (quantile `near_quantile` on frames of the speakers alone) ...
    pub near_margin_db: f32,
    pub near_quantile: f32,
    /// ... in the one band, of those where the user's own share (median, on frames of them
    /// alone) is at least `near_contrast_db` over the echo's median (bands the speakers barely
    /// play), where it stands highest over the echo's quantile — at least
    /// `near_separation_db` over it. Without one the gate stays open.
    pub near_contrast_db: f32,
    pub near_separation_db: f32,
    /// Frames of the speakers alone and of the user alone before the gate trusts its thresholds
    /// (~10 s and ~3 s); until then it stays open and the canceller is stages 1–3 alone.
    pub near_calibration: (u32, u32),
    /// A frame has the user when at least this share of the last `near_density_frames` passed
    /// the band test (a voice is sustained, the echo's odd low burst is not).
    pub near_density: f32,
    pub near_density_frames: usize,
    /// The bands (`GATE_BANDS` indices, from..to) that listen for the user.
    pub near_bands: (usize, usize),
    /// Frames (5.3 ms): opened this far ahead of the user's first detected frame, held open this
    /// long after their last, with raised-cosine ramps this long.
    pub near_look: usize,
    pub near_hold: usize,
    pub near_attack: usize,
    pub near_release: usize,
}

impl Default for Tuning {
    fn default() -> Self {
        Strength::Normal.tuning()
    }
}

/// "Intensidade" in the Microfone panel. Stages 1–3 are the same for all three; they differ in
/// how far the near-end gate closes, how readily it opens, and how hard the suppressor works
/// while the user talks over the computer (`docs/HANDOFF.md`, "Remover eco do alto-falante").
#[derive(Debug, Clone, Copy, PartialEq, Eq, Default)]
pub enum Strength {
    /// Suave: the gate only lowers the echo where the user is silent, and opens at the faintest
    /// sign of them.
    Gentle,
    /// Normal: the voice untouched; the echo gone where only the computer plays, a faint trace
    /// left under the voice while both talk.
    #[default]
    Normal,
    /// Forte: also suppresses hard while both talk, at some colour on the voice.
    Strong,
}

impl Strength {
    /// `"gentle"`, `"normal"` or `"strong"` (the editor setting); anything else is Normal.
    pub fn parse(name: &str) -> Self {
        match name {
            "gentle" => Self::Gentle,
            "strong" => Self::Strong,
            _ => Self::Normal,
        }
    }

    pub fn tuning(self) -> Tuning {
        let base = Tuning {
            mu: 0.8,
            gate_lo: 0.45,
            gate_hi: 0.8,
            ratio_floor: 1.0,
            over: 4.0,
            over_double_talk: 1.0,
            floor: GAIN_FLOOR,
            taps: TAPS,
            pre: PRE_FRAMES,
            near_gate: true,
            near_res: true,
            near_depth_db: f32::INFINITY,
            near_noise_db: 10.0,
            near_margin_db: 0.0,
            near_quantile: 0.95,
            near_contrast_db: 20.0,
            near_separation_db: 0.0,
            near_calibration: (1800, 560),
            near_density: 0.3,
            near_density_frames: 19,
            near_bands: (1, 6),
            near_look: 15,
            near_hold: 56,
            near_attack: 4,
            near_release: 19,
        };
        match self {
            Self::Gentle => Tuning {
                near_res: false,
                near_depth_db: 6.0,
                near_look: 19,
                near_hold: 94,
                ..base
            },
            Self::Normal => Tuning {
                over_double_talk: 0.5,
                ..base
            },
            Self::Strong => Tuning {
                over_double_talk: 3.0,
                ..base
            },
        }
    }
}

impl Tuning {
    /// The preset of `AEC_STRENGTH` (Normal without it), with any `AEC_*` knob overriding it.
    #[cfg(test)]
    fn from_env() -> Self {
        let d = Strength::parse(&std::env::var("AEC_STRENGTH").unwrap_or_default()).tuning();
        let u = |k: &str, x: usize| {
            std::env::var(k)
                .ok()
                .and_then(|s| s.parse().ok())
                .unwrap_or(x)
        };
        let v = |k: &str, x: f32| {
            std::env::var(k)
                .ok()
                .and_then(|s| s.parse().ok())
                .unwrap_or(x)
        };
        Self {
            mu: v("AEC_MU", d.mu),
            gate_lo: v("AEC_GLO", d.gate_lo),
            gate_hi: v("AEC_GHI", d.gate_hi),
            ratio_floor: v("AEC_RF", d.ratio_floor),
            over: v("AEC_OVER", d.over),
            over_double_talk: v("AEC_OVERDT", d.over_double_talk),
            floor: v("AEC_FLOOR", d.floor),
            taps: v("AEC_TAPS", d.taps as f32) as usize,
            pre: v("AEC_PRE", d.pre as f32) as usize,
            near_gate: u("AEC_GATE", d.near_gate as usize) != 0,
            near_res: u("AEC_NEARRES", d.near_res as usize) != 0,
            near_depth_db: v("AEC_DEPTH", d.near_depth_db),
            near_noise_db: v("AEC_NOISE", d.near_noise_db),
            near_margin_db: v("AEC_MARGIN", d.near_margin_db),
            near_quantile: v("AEC_Q", d.near_quantile),
            near_contrast_db: v("AEC_CONTRAST", d.near_contrast_db),
            near_separation_db: v("AEC_SEP", d.near_separation_db),
            near_calibration: (
                u("AEC_CAL_ECHO", d.near_calibration.0 as usize) as u32,
                u("AEC_CAL_USER", d.near_calibration.1 as usize) as u32,
            ),
            near_density: v("AEC_DENS", d.near_density),
            near_density_frames: u("AEC_DENSW", d.near_density_frames),
            near_bands: (u("AEC_GB0", d.near_bands.0), u("AEC_GB1", d.near_bands.1)),
            near_look: u("AEC_LOOK", d.near_look),
            near_hold: u("AEC_HOLD", d.near_hold),
            near_attack: u("AEC_ATTACK", d.near_attack),
            near_release: u("AEC_RELEASE", d.near_release),
        }
    }
}

/// See `EchoCanceller::push_with_probe`.
struct Probe {
    buf: Vec<f32>,
    ola: Vec<f32>,
    out: Vec<f32>,
}

/// The streaming canceller. Push the voice and the reference (mono, 48 kHz) in equal blocks;
/// it returns exactly as many cleaned samples, in order, once `finish` has flushed the tail.
pub struct EchoCanceller {
    estimate: BleedEstimate,
    tuning: Tuning,
    probe: Option<Probe>,
    taps: usize,
    pre: usize,
    window: Vec<f32>,
    /// What the near-end gate listens to: the microphone's last `GATE_FRAME` samples through a
    /// Hann window — twice the resolution of the canceller's frames and sidelobes 8 dB lower than
    /// the sqrt-Hann's, so a guest's 200 Hz fundamental stays out of the band where a male voice
    /// has its own.
    gate_forward: Arc<dyn RealToComplex<f32>>,
    gate_window: Vec<f32>,
    gate_input: Vec<f32>,
    gate_time: Vec<f32>,
    spec_h: Vec<Complex<f32>>,
    forward: Arc<dyn RealToComplex<f32>>,
    inverse: Arc<dyn ComplexToReal<f32>>,
    // Reference re-timing.
    ref_ring: VecDeque<f32>,
    ref_base: usize,
    mic_pos: usize,
    // STFT input buffers (padded with HOP zeros at the start) and the overlap-add tail.
    mic_buf: Vec<f32>,
    ref_buf: Vec<f32>,
    ola: Vec<f32>,
    to_drop: usize,
    // Filter state.
    weights: Vec<Complex<f32>>,
    history: Vec<Vec<Complex<f32>>>,
    history_power: Vec<f32>,
    head: usize,
    frames_seen: usize,
    silent_run: usize,
    s_dd: Vec<f32>,
    s_yy: Vec<f32>,
    s_dy: Vec<Complex<f32>>,
    s_xx: Vec<f32>,
    s_dx: Vec<Complex<f32>>,
    s_ee: Vec<f32>,
    noise: Vec<f32>,
    adapted: f32,
    k_weights: Vec<f32>,
    path_gain: Vec<f32>,
    leak_bins: Vec<f32>,
    gain: Vec<f32>,
    leak: f32,
    main_tap: usize,
    /// The last processed frame's adaptation gate (1: the speakers alone).
    coherence_gate: f32,
    near: NearEndGate,
    totals: Totals,
    // Scratch.
    time: Vec<f32>,
    spec_d: Vec<Complex<f32>>,
    spec_x: Vec<Complex<f32>>,
}

impl EchoCanceller {
    pub fn new(estimate: BleedEstimate) -> Self {
        Self::with_tuning(estimate, Tuning::default())
    }

    pub fn with_tuning(estimate: BleedEstimate, tuning: Tuning) -> Self {
        let taps = tuning.taps.max(tuning.pre + 2);
        let pre = tuning.pre;
        let mut planner = RealFftPlanner::<f32>::new();
        let forward = planner.plan_fft_forward(FRAME);
        let inverse = planner.plan_fft_inverse(FRAME);
        let gate_forward = planner.plan_fft_forward(GATE_FRAME);
        let zero = Complex::new(0.0f32, 0.0);
        Self {
            estimate,
            tuning,
            probe: None,
            taps,
            pre,
            window: sqrt_hann(),
            gate_window: (0..GATE_FRAME)
                .map(|i| {
                    (0.5 - 0.5 * (std::f64::consts::TAU * i as f64 / GATE_FRAME as f64).cos())
                        as f32
                })
                .collect(),
            gate_input: vec![0.0; GATE_FRAME],
            gate_time: vec![0.0; GATE_FRAME],
            spec_h: gate_forward.make_output_vec(),
            gate_forward,
            spec_d: forward.make_output_vec(),
            spec_x: forward.make_output_vec(),
            forward,
            inverse,
            ref_ring: VecDeque::new(),
            ref_base: 0,
            mic_pos: 0,
            mic_buf: vec![0.0; PAD],
            ref_buf: vec![0.0; PAD],
            ola: vec![0.0; FRAME],
            to_drop: PAD,
            weights: vec![zero; taps * ADAPT_BINS],
            history: vec![vec![zero; ADAPT_BINS]; taps],
            history_power: vec![0.0; taps],
            head: 0,
            frames_seen: 0,
            silent_run: taps,
            s_dd: vec![0.0; ADAPT_BINS],
            s_yy: vec![0.0; ADAPT_BINS],
            s_dy: vec![zero; ADAPT_BINS],
            s_xx: vec![0.0; ADAPT_BINS],
            s_dx: vec![zero; ADAPT_BINS],
            s_ee: vec![0.0; BINS],
            noise: vec![0.0; BINS],
            adapted: 0.0,
            k_weights: k_weighting(),
            path_gain: vec![0.0; ADAPT_BINS],
            leak_bins: vec![1.0; ADAPT_BINS],
            gain: vec![1.0; BINS],
            leak: 0.5,
            main_tap: pre,
            coherence_gate: 0.0,
            near: NearEndGate::new(),
            totals: Totals::default(),
            time: vec![0.0; FRAME],
        }
    }

    /// Back to the start of the take with what the filter learned: the warm-up pass.
    pub fn rewind(&mut self) {
        let zero = Complex::new(0.0f32, 0.0);
        self.ref_ring.clear();
        self.probe = None;
        self.ref_base = 0;
        self.mic_pos = 0;
        self.mic_buf = vec![0.0; PAD];
        self.ref_buf = vec![0.0; PAD];
        self.ola = vec![0.0; FRAME];
        self.to_drop = PAD;
        for frame in &mut self.history {
            frame.fill(zero);
        }
        self.history_power.fill(0.0);
        self.silent_run = self.taps;
        self.frames_seen = 0;
        self.gain.fill(1.0);
        self.s_ee.fill(0.0);
        self.near.rewind();
        self.gate_input.fill(0.0);
        self.totals = Totals::default();
    }

    /// Samples of reference delay applied at voice sample `n`: the echo delay minus the margin.
    fn retime(&self, n: usize) -> f64 {
        let delay = self.estimate.delay_at(n as f64 / RATE as f64) * RATE as f64;
        (delay - (self.pre * HOP) as f64).max(2.0)
    }

    pub fn push(&mut self, mic: &[f32], reference: &[f32], out: &mut Vec<f32>) {
        self.push_inner(mic, reference, None, out)
    }

    /// The evaluation form: `probe` is one component of the microphone signal (the near end
    /// alone, in a test), sent through exactly the gains the microphone got, without the echo
    /// subtraction. Its output, read with `take_probe`, is what the processing did to that
    /// component; the microphone's output minus it is what is left of the rest.
    pub fn push_with_probe(
        &mut self,
        mic: &[f32],
        reference: &[f32],
        probe: &[f32],
        out: &mut Vec<f32>,
    ) {
        if self.probe.is_none() {
            self.probe = Some(Probe {
                buf: vec![0.0; PAD],
                ola: vec![0.0; FRAME],
                out: Vec::new(),
            });
        }
        self.push_inner(mic, reference, Some(probe), out)
    }

    pub fn take_probe(&mut self) -> Vec<f32> {
        self.probe
            .as_mut()
            .map(|p| std::mem::take(&mut p.out))
            .unwrap_or_default()
    }

    fn push_inner(
        &mut self,
        mic: &[f32],
        reference: &[f32],
        probe: Option<&[f32]>,
        out: &mut Vec<f32>,
    ) {
        debug_assert_eq!(mic.len(), reference.len());
        self.ref_ring.extend(reference.iter().copied());
        for (i, &m) in mic.iter().enumerate() {
            let aligned = self.aligned_reference(self.mic_pos);
            self.mic_pos += 1;
            self.mic_buf.push(m);
            self.ref_buf.push(aligned);
            if let (Some(state), Some(samples)) = (self.probe.as_mut(), probe) {
                state.buf.push(samples[i]);
            }
            if self.mic_buf.len() == FRAME {
                self.process_frame(out);
            }
        }
        // Keep only the reference still reachable: a few samples before the current read point.
        let keep_from = (self.mic_pos as f64 - self.retime(self.mic_pos)).floor() as i64 - 4;
        while (self.ref_base as i64) < keep_from && !self.ref_ring.is_empty() {
            self.ref_ring.pop_front();
            self.ref_base += 1;
        }
    }

    /// Flushes the last frames: `out` then holds as many samples as were pushed.
    pub fn finish(&mut self, out: &mut Vec<f32>) {
        let total = self.mic_pos;
        let mut emitted_target = total;
        // Zero-pad until every pushed sample has been covered by two frames.
        while self.emitted_upto() < emitted_target {
            self.mic_buf.push(0.0);
            self.ref_buf.push(0.0);
            if let Some(state) = self.probe.as_mut() {
                state.buf.push(0.0);
            }
            if self.mic_buf.len() == FRAME {
                self.process_frame(out);
            }
            emitted_target = total;
        }
        // The last frame may emit a little past the end: those are padding.
        let extra = self.emitted_upto().saturating_sub(total);
        out.truncate(out.len().saturating_sub(extra));
        if let Some(state) = self.probe.as_mut() {
            let keep = state.out.len().saturating_sub(extra);
            state.out.truncate(keep);
        }
    }

    /// Samples finalised so far (frames emitted × hop, minus the dropped head).
    fn emitted_upto(&self) -> usize {
        (self.near.emitted * HOP).saturating_sub(PAD)
    }

    /// The reference at `n − retime(n)`, cubic (Catmull-Rom) between samples.
    fn aligned_reference(&self, n: usize) -> f32 {
        let pos = n as f64 - self.retime(n);
        if pos < 1.0 {
            return 0.0;
        }
        let i = pos.floor() as usize;
        let frac = (pos - i as f64) as f32;
        let get = |k: usize| -> f32 {
            if k < self.ref_base {
                return 0.0;
            }
            self.ref_ring.get(k - self.ref_base).copied().unwrap_or(0.0)
        };
        let (p0, p1, p2, p3) = (get(i - 1), get(i), get(i + 1), get(i + 2));
        let t = frac;
        let t2 = t * t;
        let t3 = t2 * t;
        0.5 * ((2.0 * p1)
            + (-p0 + p2) * t
            + (2.0 * p0 - 5.0 * p1 + 4.0 * p2 - p3) * t2
            + (-p0 + 3.0 * p1 - 3.0 * p2 + p3) * t3)
    }

    fn process_frame(&mut self, out: &mut Vec<f32>) {
        self.frames_seen += 1;
        self.totals.frames += 1;
        // Analysis.
        for i in 0..FRAME {
            self.time[i] = self.mic_buf[i] * self.window[i];
        }
        let _ = self.forward.process(&mut self.time, &mut self.spec_d);
        for i in 0..FRAME {
            self.time[i] = self.ref_buf[i] * self.window[i];
        }
        let _ = self.forward.process(&mut self.time, &mut self.spec_x);
        // The microphone's noise floor per bin: follows a fall at once, a rise at ~1.6 dB/s.
        for (n, d) in self.noise.iter_mut().zip(&self.spec_d) {
            let p = d.norm_sqr();
            *n = if *n <= 0.0 {
                p
            } else if p < *n {
                0.7 * *n + 0.3 * p
            } else {
                *n * 1.002
            };
        }
        let ref_power: f32 = self.ref_buf.iter().map(|v| v * v).sum::<f32>() / FRAME as f32;
        let mic_power: f32 = self.mic_buf.iter().map(|v| v * v).sum::<f32>() / FRAME as f32;

        // History of the reference spectrum (newest at `head`).
        self.head = (self.head + self.taps - 1) % self.taps;
        self.history[self.head].copy_from_slice(&self.spec_x[..ADAPT_BINS]);
        self.history_power[self.head] = ref_power;
        if ref_power > REF_SILENT_POWER {
            self.silent_run = 0;
        } else {
            self.silent_run = (self.silent_run + 1).min(self.taps + 1);
        }

        let bypass = self.silent_run >= self.taps;
        let mut frame = self.near.take_frame();
        frame.bypass = bypass;
        if bypass {
            // Nothing the speakers played can be in this frame: the voice as recorded.
            frame.spec.copy_from_slice(&self.spec_d);
            frame.coherence = -1.0;
            if mic_power > 3.2e-5 {
                self.totals.voice_energy += mic_power as f64;
                self.totals.voice_frames += 1;
            }
        } else {
            self.totals.processed += 1;
            self.cancel(mic_power, &mut frame);
            frame.coherence = self.coherence_gate;
        }

        if self.tuning.near_gate {
            // The window ends where this frame does.
            self.gate_input.copy_within(HOP.., 0);
            self.gate_input[GATE_FRAME - HOP..].copy_from_slice(&self.mic_buf[FRAME - HOP..]);
            for i in 0..GATE_FRAME {
                self.gate_time[i] = self.gate_input[i] * self.gate_window[i];
            }
            let _ = self
                .gate_forward
                .process(&mut self.gate_time, &mut self.spec_h);
        }

        // Into the gate's queue, with the probe's spectrum taken now (its buffer moves on).
        frame.near = self.tuning.near_gate
            && self.near.detect(
                &mut frame,
                &self.spec_d,
                &self.spec_h,
                (!bypass).then_some(self.coherence_gate),
                &self.tuning,
            );
        frame.probed = false;
        if let Some(state) = self.probe.as_mut() {
            for i in 0..FRAME {
                self.time[i] = state.buf[i] * self.window[i];
            }
            let _ = self.forward.process(&mut self.time, &mut frame.probe);
            frame.probed = true;
            state.buf.drain(..HOP);
        }
        self.near.pending.push_back(frame);
        let look = if self.tuning.near_gate {
            self.tuning.near_look
        } else {
            0
        };
        if self.near.pending.len() > look {
            self.emit(out);
        }
        self.mic_buf.drain(..HOP);
        self.ref_buf.drain(..HOP);
    }

    /// The oldest queued frame, through the near-end gate, synthesised and overlap-added.
    fn emit(&mut self, out: &mut Vec<f32>) {
        let tuning = self.tuning;
        let ((open, present), listening) = if tuning.near_gate {
            self.near.learn(&tuning);
            (self.near.opening(&tuning), self.near.listening(&tuning))
        } else {
            ((1.0, 0.0), false)
        };
        let Some(mut frame) = self.near.pending.pop_front() else {
            return;
        };
        if frame.bypass {
            frame.gain.fill(1.0);
            self.gain.fill(1.0);
        } else {
            self.totals.gate_frames += 1;
            self.totals.gate_closed += (1.0 - open) as f64;
            // Residual echo suppression: hard where the speakers are heard alone, gentle where
            // the user talks too (there an over-estimated echo would take the voice with it).
            // Where the gate hears them, that is the user talking, whatever the coherence says.
            let alone = if listening && tuning.near_res {
                frame.coherence * (1.0 - present)
            } else {
                frame.coherence
            };
            let over = tuning.over_double_talk + (tuning.over - tuning.over_double_talk) * alone;
            for k in 0..BINS {
                let e = frame.spec[k];
                self.s_ee[k] = 0.5 * self.s_ee[k] + 0.5 * e.norm_sqr();
                let see = self.s_ee[k].max(1e-20);
                let target = (1.0 - over * frame.residual[k] / see).clamp(tuning.floor, 1.0);
                // Never below the microphone's own noise floor: suppressing the room tone along
                // with the echo would make it breathe in and out with the computer's sound.
                let target = target.max((frame.noise[k] / see).sqrt().min(1.0));
                // Fall at most ~4.4 dB per frame (no chopped onsets), rise at once.
                let g = target.max(self.gain[k] * 0.6);
                self.gain[k] = g;
                frame.gain[k] = g;
                frame.spec[k] = e * g;
            }
        }
        if open < 1.0 {
            // Each bin no louder than the microphone's own noise floor (and, with a finite depth,
            // no lower than that many dB under the suppressor's output), `open` of the way back.
            let depth = if tuning.near_depth_db.is_finite() {
                10f32.powf(-tuning.near_depth_db / 20.0)
            } else {
                0.0
            };
            let floor = &self.near.bin_floor.floor;
            for k in 0..BINS {
                let p = frame.spec[k].norm_sqr();
                let target = NEAR_FLOOR_BIAS * floor[k];
                let closed = if p > target {
                    (target / p).sqrt().max(depth)
                } else {
                    1.0
                };
                let g = if open <= 0.0 {
                    closed
                } else {
                    closed.powf(1.0 - open)
                };
                frame.spec[k] *= g;
                frame.gain[k] *= g;
            }
        }
        self.near.emitted += 1;
        // The report's frames of the speakers alone: coherent, and not where the gate hears the
        // user (the coherence lags their onsets, and there the suppressor backs off on purpose).
        if !frame.bypass && frame.coherence > 0.8 && (!listening || present < 0.5) {
            self.totals.echo_only_mic += frame.energy.0 as f64;
            self.totals.echo_only_linear += frame.energy.1 as f64;
            self.totals.echo_only_out +=
                frame.spec.iter().map(|c| c.norm_sqr()).sum::<f32>() as f64;
        }

        // Synthesis and overlap-add.
        frame.spec[0].im = 0.0;
        frame.spec[BINS - 1].im = 0.0;
        let _ = self.inverse.process(&mut frame.spec, &mut self.time);
        // Overlap-added squared sqrt-Hann windows sum to FRAME / (2 HOP).
        let scale = (2 * HOP) as f32 / (FRAME * FRAME) as f32;
        for i in 0..FRAME {
            self.ola[i] += self.time[i] * self.window[i] * scale;
        }
        let drop = self.to_drop.min(HOP);
        self.to_drop -= drop;
        out.extend_from_slice(&self.ola[drop..HOP]);
        if let (Some(state), true) = (self.probe.as_mut(), frame.probed) {
            for (s, g) in frame.probe.iter_mut().zip(&frame.gain) {
                *s *= *g;
            }
            frame.probe[0].im = 0.0;
            frame.probe[BINS - 1].im = 0.0;
            let _ = self.inverse.process(&mut frame.probe, &mut self.time);
            for i in 0..FRAME {
                state.ola[i] += self.time[i] * self.window[i] * scale;
            }
            state.out.extend_from_slice(&state.ola[drop..HOP]);
            state.ola.copy_within(HOP.., 0);
            state.ola[FRAME - HOP..].fill(0.0);
        }
        self.ola.copy_within(HOP.., 0);
        self.ola[FRAME - HOP..].fill(0.0);
        self.near.spare.push(frame);
    }

    fn cancel(&mut self, mic_power: f32, frame: &mut PendingFrame) {
        let zero = Complex::new(0.0f32, 0.0);
        // Echo estimate.
        let mut echo = [zero; ADAPT_BINS];
        for j in 0..self.taps {
            let frame = &self.history[(self.head + j) % self.taps];
            let w = &self.weights[j * ADAPT_BINS..(j + 1) * ADAPT_BINS];
            for k in 0..ADAPT_BINS {
                echo[k] += w[k] * frame[k];
            }
        }
        let mut error = [zero; ADAPT_BINS];
        let (mut band_d, mut band_e) = (0.0f32, 0.0f32);
        for k in 0..ADAPT_BINS {
            error[k] = self.spec_d[k] - echo[k];
            if (6..=170).contains(&k) {
                band_d += self.spec_d[k].norm_sqr();
                band_e += error[k].norm_sqr();
            }
        }
        // A filter that adds more than it removes is wrong here: subtract nothing and shrink it.
        let diverged = band_e > 2.0 * band_d && band_d > 0.0;
        if diverged {
            error.copy_from_slice(&self.spec_d[..ADAPT_BINS]);
            for w in &mut self.weights {
                *w *= 0.8;
            }
        }

        // Double-talk detection: coherence of the microphone with the echo estimate, and with the
        // aligned reference at the filter's main tap (what works before the filter has learned).
        let main = &self.history[(self.head + self.main_tap) % self.taps];
        let a = 0.85f32;
        // Power-weighted over the speech band: the bins that carry the echo decide.
        let (mut num_y, mut den_y, mut num_x, mut den_x) = (0.0f32, 0.0f32, 0.0f32, 0.0f32);
        for k in 0..ADAPT_BINS {
            let d = self.spec_d[k];
            let y = echo[k];
            let x = main[k];
            self.s_dd[k] = a * self.s_dd[k] + (1.0 - a) * d.norm_sqr();
            self.s_yy[k] = a * self.s_yy[k] + (1.0 - a) * y.norm_sqr();
            self.s_dy[k] = self.s_dy[k] * a + d * y.conj() * (1.0 - a);
            self.s_xx[k] = a * self.s_xx[k] + (1.0 - a) * x.norm_sqr();
            self.s_dx[k] = self.s_dx[k] * a + d * x.conj() * (1.0 - a);
            if (6..=170).contains(&k) {
                num_y += self.s_dy[k].norm_sqr();
                den_y += self.s_dd[k] * self.s_yy[k];
                num_x += self.s_dx[k].norm_sqr();
                den_x += self.s_dd[k] * self.s_xx[k];
            }
        }
        let coh_y = if den_y > 1e-30 {
            (num_y / den_y).min(1.0)
        } else {
            0.0
        };
        let coh_x = if den_x > 1e-30 {
            (num_x / den_x).min(1.0)
        } else {
            0.0
        };
        let tuning = self.tuning;
        let ramp = |c: f32, lo: f32, hi: f32| ((c - lo) / (hi - lo)).clamp(0.0, 1.0);
        // Once the filter has learned something, only its own estimate says "speakers alone", and
        // strictly. Before that (the first ~2 s of adaptation) the aligned reference stands in,
        // with a looser bar: the room spreads the echo over many taps, so it is never very coherent
        // with a single one.
        let mut gate = ramp(coh_y, tuning.gate_lo, tuning.gate_hi);
        if self.adapted < BOOTSTRAP_FRAMES {
            gate = gate.max(ramp(coh_x.max(coh_y), 0.2, 0.6));
        }
        self.adapted += gate;
        self.totals.gate_sum += gate as f64;
        self.coherence_gate = gate;

        // NLMS update, per bin, normalised by the reference power over the filter's taps.
        // The reference power over the filter's span, per bin.
        let delta = self.taps as f32 * (FRAME as f32 / 2.0) * 1e-8;
        let mut power = [0.0f32; ADAPT_BINS];
        for frame in &self.history {
            for k in 0..ADAPT_BINS {
                power[k] += frame[k].norm_sqr();
            }
        }
        // On frames where the speakers are heard alone, learn per bin how loud the echo is for
        // that much reference (a level, not a filter: it holds when the room or the
        // microphone's own processing moves faster than the filter follows), and how much of it
        // the filter leaves.
        if gate > 0.95 && !diverged {
            for k in 0..ADAPT_BINS {
                let d = self.spec_d[k].norm_sqr();
                let g = d / (power[k] + delta);
                let pg = self.path_gain[k];
                // Slow to rise and capped, quick to fall: a frame where the user's voice slipped
                // past the detector is far louder than the echo, and must not teach it.
                self.path_gain[k] = if self.adapted < BOOTSTRAP_FRAMES || pg <= 0.0 {
                    0.98 * pg + 0.02 * g
                } else if g > pg {
                    pg + 0.005 * (g.min(4.0 * pg) - pg)
                } else {
                    pg + 0.02 * (g - pg)
                };
                let l = (error[k].norm_sqr() / d.max(1e-20)).min(1.0);
                self.leak_bins[k] = 0.98 * self.leak_bins[k] + 0.02 * l;
            }
        }
        if gate > 0.0 && !diverged {
            let mu = tuning.mu * gate;
            let mut step = [zero; ADAPT_BINS];
            for k in 0..ADAPT_BINS {
                // A bin whose error is mostly not echo (the user, noise) takes a smaller step.
                let ratio = if tuning.ratio_floor < 1.0 {
                    (self.s_yy[k] / self.s_ee[k].max(1e-20)).clamp(tuning.ratio_floor, 1.0)
                } else {
                    1.0
                };
                step[k] = error[k] * (mu * ratio / (power[k] + delta));
            }
            for j in 0..self.taps {
                let frame = &self.history[(self.head + j) % self.taps];
                let w = &mut self.weights[j * ADAPT_BINS..(j + 1) * ADAPT_BINS];
                for k in 0..ADAPT_BINS {
                    w[k] += step[k] * frame[k].conj();
                }
            }
        }
        // The tap the echo mostly lives in, for the coherence above.
        if self.frames_seen % 64 == 0 {
            let mut best = (0.0f32, self.main_tap);
            for j in 0..self.taps {
                let e: f32 = self.weights[j * ADAPT_BINS..(j + 1) * ADAPT_BINS]
                    .iter()
                    .map(|w| w.norm_sqr())
                    .sum();
                if e > best.0 {
                    best = (e, j);
                }
            }
            self.main_tap = best.1;
        }

        // Residual echo suppression.
        let band_y: f32 = (6..=170).map(|k| echo[k].norm_sqr()).sum();
        let band_err: f32 = (6..=170).map(|k| error[k].norm_sqr()).sum();
        if gate > 0.7 && band_y > 0.0 {
            let ratio = (band_err / band_y).clamp(0.005, 1.0);
            self.leak = 0.95 * self.leak + 0.05 * ratio;
        }
        // What the suppressor works from (it runs in `emit`, once the gate has heard ahead): the
        // filter's error, the residual echo per bin — the larger of the filter's own estimate
        // scaled by what it misses and the level model — and the microphone's noise floor.
        frame.spec[..ADAPT_BINS].copy_from_slice(&error);
        frame.spec[ADAPT_BINS..].copy_from_slice(&self.spec_d[ADAPT_BINS..]);
        for k in 0..ADAPT_BINS {
            frame.residual[k] = (self.leak * echo[k].norm_sqr())
                .max(self.leak_bins[k] * self.path_gain[k] * power[k]);
        }
        frame.noise.copy_from_slice(&self.noise);

        // Report.
        let linear: f32 = error.iter().map(|e| e.norm_sqr()).sum::<f32>()
            + self.spec_d[ADAPT_BINS..]
                .iter()
                .map(|d| d.norm_sqr())
                .sum::<f32>();
        let mic: f32 = self.spec_d.iter().map(|d| d.norm_sqr()).sum();
        let echo_power: f32 = echo.iter().map(|y| y.norm_sqr()).sum();
        // Counted in `emit`, where the gate knows whether the user was there.
        frame.energy = (mic, linear);
        if gate > 0.8 {
            // The echo path's gain: the microphone against the reference at the filter's main tap
            // (where most of the echo lives), K-weighted like a loudness meter (a laptop speaker
            // drops the bass a loudness meter still counts), over frames of speakers alone.
            let main = &self.history[(self.head + self.main_tap) % self.taps];
            for (k, w) in self.k_weights.iter().enumerate() {
                self.totals.path_mic += (w * self.spec_d[k].norm_sqr()) as f64;
                self.totals.path_ref += (w * main[k].norm_sqr()) as f64;
            }
        }
        if mic_power > 0.0 {
            // Echo energy, in the same per-sample units as the voice level (Parseval, window).
            self.totals.echo_energy += echo_power as f64 / (FRAME as f64 * FRAME as f64 / 4.0);
            self.totals.echo_frames += 1;
        }
    }

    /// Energy of the filter per tap, oldest last (diagnostics).
    pub fn tap_profile(&self) -> Vec<f32> {
        (0..self.taps)
            .map(|j| {
                self.weights[j * ADAPT_BINS..(j + 1) * ADAPT_BINS]
                    .iter()
                    .map(|w| w.norm_sqr())
                    .sum()
            })
            .collect()
    }

    fn report(&self) -> EchoReport {
        let t = &self.totals;
        let db = |num: f64, den: f64| {
            if num > 0.0 && den > 0.0 {
                10.0 * (num / den).log10()
            } else {
                0.0
            }
        };
        let voice = if t.voice_frames > 0 {
            t.voice_energy / t.voice_frames as f64
        } else {
            0.0
        };
        let echo = if t.echo_frames > 0 {
            t.echo_energy / t.echo_frames as f64
        } else {
            0.0
        };
        EchoReport {
            detected: self.estimate.detected,
            delay_ms: self.estimate.delay_sec * 1000.0,
            delay_end_ms: self.estimate.delay_at(self.estimate.duration_sec) * 1000.0,
            drift_ppm: self.estimate.drift * 1e6,
            windows: self.estimate.windows,
            consistent_windows: self.estimate.consistent_windows,
            echo_to_voice_db: db(echo, voice),
            erle_db: db(t.echo_only_mic, t.echo_only_out),
            linear_erle_db: db(t.echo_only_mic, t.echo_only_linear),
            processed_share: if t.frames > 0 {
                t.processed as f64 / t.frames as f64
            } else {
                0.0
            },
            adapt_share: if t.processed > 0 {
                t.gate_sum / t.processed as f64
            } else {
                0.0
            },
            duration_sec: self.estimate.duration_sec,
            echo_path_gain_db: if t.path_mic > 0.0 && t.path_ref > 0.0 {
                10.0 * (t.path_mic / t.path_ref).log10()
            } else {
                0.0
            },
            system_true_peak_dbfs: 0.0,
            system_compensation_db: 0.0,
            gate_closed_share: if t.gate_frames > 0 {
                t.gate_closed / t.gate_frames as f64
            } else {
                0.0
            },
        }
    }

    /// The report, with the compensation for a computer stem of that true peak.
    pub fn report_for(&self, system_true_peak_dbfs: f64) -> EchoReport {
        let mut report = self.report();
        report.system_true_peak_dbfs = system_true_peak_dbfs;
        report.system_compensation_db =
            system_compensation_db(report.echo_path_gain_db, system_true_peak_dbfs);
        report
    }
}

/// Floor of the residual suppression: −40 dB (the microphone's noise floor usually comes first).
const GAIN_FLOOR: f32 = 0.01;
/// Frames of full adaptation (~2 s) before the double-talk detector stops trusting the reference.
const BOOTSTRAP_FRAMES: f32 = 400.0;

// --------------------------------------------------------------------------------------------
// Stage 4: the near-end gate
// --------------------------------------------------------------------------------------------

/// The near-end gate's analysis frame (43 ms).
const GATE_FRAME: usize = 2 * FRAME;
/// Bands (edges in the canceller's 1024-point bins; twice that in the gate's) the near-end gate
/// listens in: 0 to 4.8 kHz.
const GATE_BANDS: [usize; 18] = [
    0, 2, 4, 6, 8, 10, 13, 16, 20, 24, 29, 35, 42, 50, 60, 72, 86, 103,
];
const GATE_NB: usize = GATE_BANDS.len() - 1;
/// The speech band a band's share is measured against: 281 Hz – 4.8 kHz.
const GATE_SPEECH_FROM: usize = 3;
/// Share histograms: 0.5 dB steps over ±80 dB.
const LEAK_STEPS: usize = 320;
/// Frames (53 ms) the user still counts as present after their last detected frame, for the
/// suppressor (the gate itself holds longer).
const PRESENCE_TAIL: usize = 10;
/// The closed gate's target over the floor tracker's minimum (the minimum of a smoothed power
/// sits under its mean).
const NEAR_FLOOR_BIAS: f32 = 2.0;

/// A noise floor per value: the minimum of its recursive mean (~50 ms) over the last `keep`
/// blocks of `len` frames and the current one.
struct FloorTracker {
    len: usize,
    keep: usize,
    count: usize,
    started: bool,
    mean: Vec<f32>,
    current: Vec<f32>,
    blocks: VecDeque<Vec<f32>>,
    blocks_min: Vec<f32>,
    floor: Vec<f32>,
}

impl FloorTracker {
    fn new(width: usize, len: usize, keep: usize) -> Self {
        Self {
            len,
            keep,
            count: 0,
            started: false,
            mean: vec![0.0; width],
            current: vec![f32::INFINITY; width],
            blocks: VecDeque::new(),
            blocks_min: vec![f32::INFINITY; width],
            floor: vec![0.0; width],
        }
    }

    fn push(&mut self, values: impl Iterator<Item = f32>) {
        for (i, v) in values.enumerate() {
            let m = if self.started {
                0.9 * self.mean[i] + 0.1 * v
            } else {
                v
            };
            self.mean[i] = m;
            self.current[i] = self.current[i].min(m);
            self.floor[i] = self.current[i].min(self.blocks_min[i]);
        }
        self.started = true;
        self.count += 1;
        if self.count == self.len {
            self.count = 0;
            let width = self.current.len();
            let done = std::mem::replace(&mut self.current, vec![f32::INFINITY; width]);
            self.blocks.push_back(done);
            while self.blocks.len() > self.keep {
                self.blocks.pop_front();
            }
            self.blocks_min.fill(f32::INFINITY);
            for block in &self.blocks {
                for (m, b) in self.blocks_min.iter_mut().zip(block) {
                    *m = m.min(*b);
                }
            }
        }
    }
}

/// Adds each band's share of the speech band (dB, 0.5 dB steps) to a histogram.
fn add_shares(hist: &mut [u32], band: &[f32; GATE_NB], speech: f32) {
    for (b, v) in band.iter().enumerate() {
        let db = 10.0 * (v / speech).max(1e-12).log10();
        let step = ((db + 80.0) * 2.0).clamp(0.0, (LEAK_STEPS - 1) as f32) as usize;
        hist[b * LEAK_STEPS + step] += 1;
    }
}

/// Band `b`'s share (dB) at quantile `q` of a histogram of `frames` frames.
fn share_quantile(hist: &[u32], b: usize, frames: u32, q: f32) -> f32 {
    let want = (q.clamp(0.0, 1.0) * frames as f32) as u32;
    let mut seen = 0u32;
    for (i, c) in hist[b * LEAK_STEPS..(b + 1) * LEAK_STEPS]
        .iter()
        .enumerate()
    {
        seen += c;
        if seen >= want {
            return i as f32 * 0.5 + 0.5 - 80.0;
        }
    }
    80.0
}

/// A frame waiting for its future: the suppressor's output and gains, the probe's spectrum.
struct PendingFrame {
    spec: Vec<Complex<f32>>,
    gain: Vec<f32>,
    probe: Vec<Complex<f32>>,
    probed: bool,
    bypass: bool,
    near: bool,
    /// The microphone per gate band, its speech band, whether that is well over its floor, and
    /// the adaptation gate (negative on a bypassed frame).
    bands: [f32; GATE_NB],
    speech: f32,
    loud: bool,
    coherence: f32,
    /// The suppressor's inputs: residual echo and noise floor per bin.
    residual: Vec<f32>,
    noise: Vec<f32>,
    /// The microphone's energy and the linear filter's output energy, for the report.
    energy: (f32, f32),
}

/// "Silêncio quando só o outro fala": where the computer plays and the user does not talk, what
/// the suppressor leaves of the echo is taken down to the microphone's own noise floor.
///
/// The user is heard by spectral tilt, which no level change on the echo path moves: each band's
/// share of the microphone's speech band is learned per take on frames of the speakers alone (a
/// high quantile) and of the user alone (the median); a band whose share now stands over the
/// echo's, and over its noise floor, has the user in it. Only bands where the user's share is far
/// over the echo's count — a laptop speaker plays next to nothing under ~250 Hz, where a male
/// voice has its fundamental: there the echo's share sits some 30 dB under the user's. A take
/// without such a band (speakers with bass) keeps the gate open.
/// Offline, so non-causal: frames wait `near_look` frames in a queue, and the gate opens that
/// far ahead of the user's first detected frame (no clipped first syllable), holds `near_hold`
/// after the last, and ramps both ways.
struct NearEndGate {
    pending: VecDeque<PendingFrame>,
    spare: Vec<PendingFrame>,
    band_floor: FloorTracker,
    bin_floor: FloorTracker,
    hist: Vec<u32>,
    hist_frames: u32,
    user_hist: Vec<u32>,
    user_frames: u32,
    share: [f32; GATE_NB],
    usable: [bool; GATE_NB],
    calibrated: bool,
    emitted: usize,
    last_near: Option<usize>,
    /// The last frame not of the speakers alone.
    last_unsure: Option<usize>,
    /// The band test's last results, for the density test.
    passed: VecDeque<bool>,
}

impl NearEndGate {
    fn new() -> Self {
        Self {
            pending: VecDeque::new(),
            spare: Vec::new(),
            // Bands: 2 s (4 blocks of 0.5 s); bins, the closed target: 8 s.
            band_floor: FloorTracker::new(GATE_NB, 94, 4),
            bin_floor: FloorTracker::new(BINS, 375, 4),
            hist: vec![0; GATE_NB * LEAK_STEPS],
            hist_frames: 0,
            user_hist: vec![0; GATE_NB * LEAK_STEPS],
            user_frames: 0,
            share: [0.0; GATE_NB],
            usable: [false; GATE_NB],
            calibrated: false,
            emitted: 0,
            last_near: None,
            last_unsure: None,
            passed: VecDeque::new(),
        }
    }

    /// Back to the start of the take, keeping the floors and the leak learned.
    fn rewind(&mut self) {
        while let Some(frame) = self.pending.pop_front() {
            self.spare.push(frame);
        }
        self.emitted = 0;
        self.last_near = None;
        self.last_unsure = None;
        self.passed.clear();
    }

    fn take_frame(&mut self) -> PendingFrame {
        self.spare.pop().unwrap_or_else(|| PendingFrame {
            spec: vec![Complex::new(0.0, 0.0); BINS],
            gain: vec![0.0; BINS],
            probe: vec![Complex::new(0.0, 0.0); BINS],
            probed: false,
            bypass: false,
            near: false,
            bands: [0.0; GATE_NB],
            speech: 0.0,
            loud: false,
            coherence: -1.0,
            residual: vec![0.0; BINS],
            noise: vec![0.0; BINS],
            energy: (0.0, 0.0),
        })
    }

    /// Whether `frame` has the user in it, its bands kept for `learn`. `coherence`: the
    /// adaptation gate on a processed frame; none on a bypassed one (no echo possible: any usable
    /// band over its floor).
    fn detect(
        &mut self,
        frame: &mut PendingFrame,
        mic: &[Complex<f32>],
        mic_hann: &[Complex<f32>],
        coherence: Option<f32>,
        tuning: &Tuning,
    ) -> bool {
        self.bin_floor.push(mic.iter().map(|c| c.norm_sqr()));
        for (b, v) in frame.bands.iter_mut().enumerate() {
            *v = mic_hann[GATE_BANDS[b] * 2..GATE_BANDS[b + 1] * 2]
                .iter()
                .map(|c| c.norm_sqr())
                .sum();
        }
        self.band_floor.push(frame.bands.iter().copied());
        let band = &frame.bands;
        let floor = &self.band_floor.floor;
        let speech: f32 = band[GATE_SPEECH_FROM..].iter().sum();
        let speech_floor: f32 = floor[GATE_SPEECH_FROM..].iter().sum();
        frame.speech = speech;
        frame.loud = speech > 10.0 * speech_floor && speech > 0.0;
        let noise = 10f32.powf(tuning.near_noise_db / 10.0);
        let (from, to) = (tuning.near_bands.0, tuning.near_bands.1.min(GATE_NB));
        // Before calibration, or with no band the speakers spare: open.
        if !self.calibrated || !(from..to).any(|b| self.usable[b]) {
            return true;
        }
        let margin = 10f32.powf(tuning.near_margin_db / 10.0);
        let pass = (from..to).any(|b| {
            self.usable[b]
                && band[b] > noise * floor[b]
                && (coherence.is_none() || band[b] > margin * self.share[b] * speech)
        });
        self.passed.push_back(pass);
        while self.passed.len() > tuning.near_density_frames.max(1) {
            self.passed.pop_front();
        }
        let count = self.passed.iter().filter(|p| **p).count();
        count as f32 >= tuning.near_density * tuning.near_density_frames.max(1) as f32
    }

    /// Learns the tilts from the oldest queued frame, now that the frames after it are known:
    /// the user's from bypassed frames where the microphone is up, the echo's from frames of the
    /// speakers alone with only the speakers for `near_look` frames either side (the coherence
    /// lags the user's onsets and ends: frames right next to them are not the echo's).
    fn learn(&mut self, tuning: &Tuning) {
        let index = self.emitted;
        let window = tuning.near_look.max(8);
        let Some(front) = self.pending.front() else {
            return;
        };
        if front.coherence <= 0.95 {
            self.last_unsure = Some(index);
        }
        if !front.loud {
            return;
        }
        if front.coherence < 0.0 {
            add_shares(&mut self.user_hist, &front.bands, front.speech);
            self.user_frames += 1;
            return;
        }
        let sure_before = match self.last_unsure {
            Some(last) => index - last > window,
            None => true,
        };
        let sure_after = self
            .pending
            .iter()
            .take(window + 1)
            .all(|f| f.coherence > 0.95);
        if !sure_before || !sure_after {
            return;
        }
        add_shares(&mut self.hist, &front.bands, front.speech);
        self.hist_frames += 1;
        if self.hist_frames >= tuning.near_calibration.0
            && self.user_frames >= tuning.near_calibration.1
            && self.hist_frames % 64 == 0
        {
            let (from, to) = (tuning.near_bands.0, tuning.near_bands.1.min(GATE_NB));
            let mut best: Option<(f32, usize)> = None;
            for b in 0..GATE_NB {
                let echo = share_quantile(&self.hist, b, self.hist_frames, tuning.near_quantile);
                let echo_median = share_quantile(&self.hist, b, self.hist_frames, 0.5);
                let user = share_quantile(&self.user_hist, b, self.user_frames, 0.5);
                self.share[b] = 10f32.powf(echo / 10.0);
                let separation = user - echo;
                if (from..to).contains(&b)
                    && user - echo_median >= tuning.near_contrast_db
                    && separation >= tuning.near_separation_db
                    && best.is_none_or(|(s, _)| separation > s)
                {
                    best = Some((separation, b));
                }
            }
            self.usable = [false; GATE_NB];
            if let Some((_, b)) = best {
                self.usable[b] = true;
            }
            self.calibrated = true;
        }
    }

    /// Whether the gate can hear the user in this take: calibrated, with a band the speakers
    /// spare.
    fn listening(&self, tuning: &Tuning) -> bool {
        let (from, to) = (tuning.near_bands.0, tuning.near_bands.1.min(GATE_NB));
        self.calibrated && (from..to).any(|b| self.usable[b])
    }

    /// How open the gate is for the oldest queued frame (1 open, 0 closed), and how present the
    /// user is there (the same, with a `PRESENCE_TAIL` hold).
    fn opening(&mut self, tuning: &Tuning) -> (f32, f32) {
        let Some(front) = self.pending.front() else {
            return (1.0, 0.0);
        };
        let index = self.emitted;
        if front.near {
            self.last_near = Some(index);
        }
        if front.bypass {
            return (1.0, 1.0);
        }
        let ramp = |x: usize, len: usize| {
            if x >= len {
                1.0
            } else {
                0.5 - 0.5 * (std::f32::consts::PI * x as f32 / len as f32).cos()
            }
        };
        let release = |hold: usize| match self.last_near {
            Some(last) if index - last <= hold => 1.0,
            Some(last) => 1.0 - ramp(index - last - hold, tuning.near_release),
            None => 0.0,
        };
        let attack = match self.pending.iter().position(|f| f.near) {
            Some(ahead) if ahead <= tuning.near_look => {
                ramp(tuning.near_look - ahead, tuning.near_attack)
            }
            _ => 0.0,
        };
        (
            release(tuning.near_hold).max(attack),
            release(PRESENCE_TAIL.min(tuning.near_hold)).max(attack),
        )
    }
}

fn report_without_bleed(estimate: &BleedEstimate) -> EchoReport {
    EchoReport {
        detected: false,
        delay_ms: estimate.delay_sec * 1000.0,
        delay_end_ms: estimate.delay_at(estimate.duration_sec) * 1000.0,
        drift_ppm: estimate.drift * 1e6,
        windows: estimate.windows,
        consistent_windows: estimate.consistent_windows,
        duration_sec: estimate.duration_sec,
        ..Default::default()
    }
}

/// Whole-buffer form, for tests and short signals: the voice (mono, 48 kHz) with the reference's
/// echo removed, the same length, plus the report. Without a bleed the voice comes back as it was.
pub fn cancel_echo_pcm(mic: &[f32], reference: &[f32]) -> (Vec<f32>, EchoReport) {
    let len = mic.len().min(reference.len());
    let (mic, reference) = (&mic[..len], &reference[..len]);
    let mut tracker = DelayTracker::new();
    tracker.push(reference, mic);
    let estimate = tracker.finish();
    if !estimate.detected {
        return (mic.to_vec(), report_without_bleed(&estimate));
    }
    #[cfg(test)]
    let tuning = Tuning::from_env();
    #[cfg(not(test))]
    let tuning = Tuning::default();
    let mut canceller = EchoCanceller::with_tuning(estimate, tuning);
    let warm = len.min((WARM_UP_SEC * RATE as f64) as usize);
    let mut scratch = Vec::with_capacity(warm);
    canceller.push(&mic[..warm], &reference[..warm], &mut scratch);
    canceller.rewind();
    let mut out = Vec::with_capacity(len);
    canceller.push(mic, reference, &mut out);
    canceller.finish(&mut out);
    let mut meter = TruePeakMeter::default();
    meter.push(&[reference.to_vec()]);
    (out, canceller.report_for(meter.dbfs()))
}

/// Opens a stem for the whole of its length.
fn open_stem(path: &str) -> Result<ClipAudioReader> {
    let duration = crate::audio_stream::audio_duration_sec(path)
        .with_context(|| format!("{path}: no audio duration"))?;
    ClipAudioReader::open(path, 0.0, duration)
        .with_context(|| format!("opening {path}"))?
        .with_context(|| format!("{path} has no audio"))
}

/// Pulls both stems in lockstep, mono, a block at a time, until the shorter ends.
fn for_each_block(
    voice_path: &str,
    system_path: &str,
    limit: Option<usize>,
    mut each: impl FnMut(&[f32], &[f32], &PlanarPcm),
) -> Result<usize> {
    let mut voice = open_stem(voice_path)?;
    let mut system = open_stem(system_path)?;
    let total = voice
        .len()
        .min(system.len())
        .min(limit.unwrap_or(usize::MAX));
    let block = 1 << 15;
    let mut vbuf: PlanarPcm = vec![Vec::with_capacity(block), Vec::with_capacity(block)];
    let mut sbuf: PlanarPcm = vec![Vec::with_capacity(block), Vec::with_capacity(block)];
    let mut vm = Vec::with_capacity(block);
    let mut sm = Vec::with_capacity(block);
    let mut done = 0;
    while done < total {
        let step = block.min(total - done);
        for plane in vbuf.iter_mut().chain(sbuf.iter_mut()) {
            plane.clear();
        }
        voice.pull(step, &mut vbuf);
        system.pull(step, &mut sbuf);
        vm.clear();
        sm.clear();
        vm.extend(vbuf[0].iter().zip(&vbuf[1]).map(|(l, r)| 0.5 * (l + r)));
        sm.extend(sbuf[0].iter().zip(&sbuf[1]).map(|(l, r)| 0.5 * (l + r)));
        each(&vm, &sm, &sbuf);
        done += step;
    }
    Ok(total)
}

/// The header of a 16-bit stereo 48 kHz WAV of `samples` frames. Stereo, the mono signal on both
/// channels: ffmpeg upmixes a mono file at −3 dB per channel, and the cleaned voice must play at
/// the stem's level.
pub(crate) fn wav_header(file: &mut impl Write, samples: usize) -> std::io::Result<()> {
    let rate = RATE as u32;
    let data_bytes = (samples as u64 * 4).min(u32::MAX as u64 - 36) as u32;
    file.write_all(b"RIFF")?;
    file.write_all(&(36 + data_bytes).to_le_bytes())?;
    file.write_all(b"WAVEfmt ")?;
    file.write_all(&16u32.to_le_bytes())?;
    file.write_all(&1u16.to_le_bytes())?;
    file.write_all(&2u16.to_le_bytes())?;
    file.write_all(&rate.to_le_bytes())?;
    file.write_all(&(rate * 4).to_le_bytes())?;
    file.write_all(&4u16.to_le_bytes())?;
    file.write_all(&16u16.to_le_bytes())?;
    file.write_all(b"data")?;
    file.write_all(&data_bytes.to_le_bytes())
}

/// The take's voice with the speaker echo removed, written to `output` as a 16-bit 48 kHz (both channels)
/// WAV of the voice stem's length, aligned sample for sample. Streams (three passes over the
/// stems: estimate, warm-up, cancel); a long take is never held in memory. Without a bleed no
/// file is written and the report says `detected: false`.
pub fn cancel_echo_file(
    voice_path: &str,
    system_path: &str,
    output: &str,
    strength: Strength,
) -> Result<EchoReport> {
    let mut tracker = DelayTracker::new();
    let mut meter = TruePeakMeter::default();
    for_each_block(voice_path, system_path, None, |mic, reference, system| {
        tracker.push(reference, mic);
        meter.push(system);
    })?;
    let estimate = tracker.finish();
    if !estimate.detected {
        return Ok(report_without_bleed(&estimate));
    }
    let mut canceller = EchoCanceller::with_tuning(estimate, strength.tuning());
    let mut scratch = Vec::new();
    for_each_block(
        voice_path,
        system_path,
        Some((WARM_UP_SEC * RATE as f64) as usize),
        |mic, reference, _| {
            scratch.clear();
            canceller.push(mic, reference, &mut scratch);
        },
    )?;
    canceller.rewind();

    let voice_len = open_stem(voice_path)?.len();
    let partial = format!("{output}.partial");
    let mut file = std::io::BufWriter::new(
        std::fs::File::create(&partial).with_context(|| format!("creating {partial}"))?,
    );
    wav_header(&mut file, voice_len)?;
    let mut written = 0usize;
    let mut out = Vec::new();
    let mut bytes = Vec::new();
    let mut write =
        |samples: &[f32], file: &mut std::io::BufWriter<std::fs::File>| -> std::io::Result<()> {
            bytes.clear();
            for s in samples {
                let pcm = ((s.clamp(-1.0, 1.0) * 32767.0).round() as i16).to_le_bytes();
                bytes.extend_from_slice(&pcm);
                bytes.extend_from_slice(&pcm);
            }
            file.write_all(&bytes)
        };
    let mut io_error = None;
    let processed = for_each_block(voice_path, system_path, None, |mic, reference, _| {
        out.clear();
        canceller.push(mic, reference, &mut out);
        if io_error.is_none() {
            if let Err(error) = write(&out, &mut file) {
                io_error = Some(error);
            }
            written += out.len();
        }
    })?;
    if let Some(error) = io_error {
        return Err(error.into());
    }
    out.clear();
    canceller.finish(&mut out);
    write(&out, &mut file)?;
    written += out.len();
    // A voice stem longer than the computer one keeps its tail as recorded.
    if voice_len > processed {
        let mut voice = open_stem(voice_path)?;
        let mut skip: PlanarPcm = vec![Vec::new(), Vec::new()];
        let mut left = processed;
        while left > 0 {
            let step = left.min(1 << 15);
            for p in skip.iter_mut() {
                p.clear();
            }
            voice.pull(step, &mut skip);
            left -= step;
        }
        let mut tail: PlanarPcm = vec![Vec::new(), Vec::new()];
        voice.pull(voice_len - processed, &mut tail);
        let mono: Vec<f32> = tail[0]
            .iter()
            .zip(&tail[1])
            .map(|(l, r)| 0.5 * (l + r))
            .collect();
        write(&mono, &mut file)?;
        written += mono.len();
    }
    debug_assert_eq!(written, voice_len);
    file.flush()?;
    drop(file);
    std::fs::rename(&partial, output).with_context(|| format!("renaming {partial}"))?;
    Ok(canceller.report_for(meter.dbfs()))
}

#[cfg(test)]
mod tests {
    use super::*;

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

    /// Speech-like: coloured noise and a pitched buzz in syllables, `on_ms` of `period_ms`,
    /// starting at `phase_ms`, at `level`.
    pub(super) fn talker(
        len: usize,
        seed: u32,
        f0: f32,
        period_ms: f32,
        on_ms: f32,
        phase_ms: f32,
        level: f32,
    ) -> Vec<f32> {
        let n = noise(len, seed);
        let mut lp = 0.0f32;
        (0..len)
            .map(|i| {
                let t = i as f32 / RATE as f32;
                let ms = (t * 1000.0 + phase_ms) % period_ms;
                lp = 0.7 * lp + 0.3 * n[i];
                if ms >= on_ms {
                    return 0.0;
                }
                let env = (std::f32::consts::PI * ms / on_ms).sin();
                let f = f0 * (1.0 + 0.08 * (t * 2.1 + seed as f32).sin());
                let buzz: f32 = (1..10)
                    .map(|h| (std::f32::consts::TAU * f * h as f32 * t).sin() / h as f32)
                    .sum();
                level * env * (0.6 * buzz + 0.8 * lp)
            })
            .collect()
    }

    /// A room: a direct path at `delay` samples and a few decaying reflections, at `gain`.
    pub(super) fn room_echo(x: &[f32], delay: usize, gain: f32) -> Vec<f32> {
        let paths = [
            (0usize, 1.0f32),
            (37, -0.5),
            (211, 0.35),
            (420, 0.2),
            (977, -0.12),
            (1800, 0.06),
        ];
        let mut y = vec![0.0f32; x.len()];
        for (offset, g) in paths {
            let d = delay + offset;
            for i in d..x.len() {
                y[i] += gain * g * x[i - d];
            }
        }
        y
    }

    fn power(x: &[f32]) -> f64 {
        x.iter().map(|v| (*v as f64).powi(2)).sum::<f64>() / x.len().max(1) as f64
    }

    fn db(a: f64, b: f64) -> f64 {
        10.0 * (a / b).log10()
    }

    #[test]
    fn the_delay_line_is_found_with_its_drift() {
        // 24 s of a far-end talker, played back 180 ms later and drifting by 40 ppm.
        let len = 24 * RATE;
        let far = talker(len, 7, 210.0, 400.0, 320.0, 0.0, 0.3);
        let mut mic = vec![0.0f32; len];
        for (i, m) in mic.iter_mut().enumerate() {
            let d = 0.180 * RATE as f64 + 40e-6 * i as f64;
            let src = i as f64 - d;
            if src >= 0.0 {
                *m = 0.2 * far[src as usize];
            }
        }
        let near = noise(len, 3);
        for (m, n) in mic.iter_mut().zip(&near) {
            *m += 0.003 * n;
        }
        let mut tracker = DelayTracker::new();
        tracker.push(&far, &mic);
        let estimate = tracker.finish();
        assert!(estimate.detected, "{estimate:?}");
        assert!((estimate.delay_sec - 0.180).abs() < 0.002, "{estimate:?}");
        assert!((estimate.drift - 40e-6).abs() < 15e-6, "{estimate:?}");
    }

    #[test]
    fn no_echo_means_nothing_is_detected_and_the_voice_is_untouched() {
        let len = 20 * RATE;
        let far = talker(len, 7, 210.0, 400.0, 320.0, 0.0, 0.3);
        let near = talker(len, 11, 120.0, 500.0, 300.0, 120.0, 0.3);
        let (out, report) = cancel_echo_pcm(&near, &far);
        assert!(!report.detected, "{report:?}");
        assert_eq!(out, near);
    }

    /// The synthetic proof: a known room (180 ms, six paths) and drift, a far-end talker, and a
    /// near-end talker who also talks over it (double-talk) in the second half.
    #[test]
    fn echo_is_cancelled_and_the_near_end_kept_through_double_talk() {
        let len = 40 * RATE;
        let far = talker(len, 7, 210.0, 400.0, 320.0, 0.0, 0.25);
        // The speakers play the far end; the mic hears it 180 ms later through the room, with a
        // 25 ppm clock drift (re-timed with linear interpolation).
        let mut played = vec![0.0f32; len];
        for (i, p) in played.iter_mut().enumerate() {
            let src = i as f64 - 25e-6 * i as f64;
            let k = src.floor() as usize;
            let f = (src - k as f64) as f32;
            if k + 1 < len {
                *p = far[k] * (1.0 - f) + far[k + 1] * f;
            }
        }
        let echo = room_echo(&played, (0.180 * RATE as f64) as usize, 0.5);
        // The user talks only in the second half, over the far end, about 6 dB above its echo.
        let mut near = talker(len, 11, 120.0, 700.0, 380.0, 90.0, 0.4);
        for v in near[..len / 2].iter_mut() {
            *v = 0.0;
        }
        let floor = noise(len, 5);
        let mic: Vec<f32> = (0..len)
            .map(|i| near[i] + echo[i] + 0.0005 * floor[i])
            .collect();

        // No frame here has the user alone, so the near-end gate never calibrates: this is
        // stages 1–3, and the strengths differ only in how hard the suppressor works in
        // double-talk. Suave is 2.8.0's; Normal backs off further for the voice; Forte pushes.
        for (strength, min_reduction, max_change) in [
            (Strength::Gentle, 2.0, 1.0),
            (Strength::Normal, 1.0, 1.0),
            (Strength::Strong, 3.0, 2.0),
        ] {
            let (out, near_out, report) =
                run_with_probe_tuned(&mic, &far, &near, strength.tuning());
            assert!(report.detected, "{report:?}");
            assert_eq!(report.gate_closed_share, 0.0, "{strength:?}");
            // The room's direct path is 0.5 (−6 dB) and its reflections add about 1.5 dB of
            // energy: the measured echo path gain is that, within a couple of dB.
            let expected = 10.0 * (0.25f64 * 1.4325).log10();
            assert!(
                (report.echo_path_gain_db - expected).abs() < 2.5,
                "echo path {:.1} dB, expected {expected:.1}",
                report.echo_path_gain_db
            );
            assert_eq!(out.len(), mic.len());
            assert_eq!(near_out.len(), mic.len());

            // ERLE over the echo-only half (after the first 2 s).
            let a = 2 * RATE;
            let b = len / 2;
            let erle = db(power(&mic[a..b]), power(&out[a..b]));
            assert!(erle > 15.0, "{strength:?}: ERLE {erle:.1} dB, {report:?}");

            // Double-talk half, split exactly: `near_out` is the near end through the same
            // gains, and the output minus it is what is left of the echo.
            let c = len / 2 + RATE;
            let left: Vec<f32> = (c..len).map(|i| out[i] - near_out[i]).collect();
            let echo_reduction = db(power(&echo[c..]), power(&left));
            let kept_db = db(power(&near_out[c..]), power(&near[c..]));
            eprintln!(
                "{strength:?}: echo-only ERLE {erle:.1} dB; double-talk: echo reduced \
                 {echo_reduction:.1} dB, near end kept at {kept_db:.2} dB"
            );
            assert!(
                echo_reduction > min_reduction,
                "{strength:?}: echo reduced only {echo_reduction:.1} dB during double-talk"
            );
            assert!(
                kept_db.abs() < max_change,
                "{strength:?}: near end changed by {kept_db:.2} dB"
            );
        }
    }

    /// Like `talker`, with a pitch that only drifts ±8 % around `f0` (the phase integrates it).
    fn voiced(
        len: usize,
        seed: u32,
        f0: f32,
        period_ms: f32,
        on_ms: f32,
        phase_ms: f32,
        level: f32,
    ) -> Vec<f32> {
        let n = noise(len, seed);
        let mut lp = 0.0f32;
        let mut phase = 0.0f64;
        (0..len)
            .map(|i| {
                let t = i as f32 / RATE as f32;
                let f = f0 as f64 * (1.0 + 0.08 * (t as f64 * 2.1 + seed as f64).sin());
                phase = (phase + std::f64::consts::TAU * f / RATE as f64) % std::f64::consts::TAU;
                lp = 0.7 * lp + 0.3 * n[i];
                let ms = (t * 1000.0 + phase_ms) % period_ms;
                if ms >= on_ms {
                    return 0.0;
                }
                let env = (std::f32::consts::PI * ms / on_ms).sin();
                let buzz: f32 = (1..10)
                    .map(|h| ((h as f64 * phase).sin() / h as f64) as f32)
                    .sum();
                level * env * (0.6 * buzz + 0.8 * lp)
            })
            .collect()
    }

    /// A second-order high-pass (RBJ), for a laptop speaker that plays nothing low.
    fn high_pass(x: &[f32], hz: f64) -> Vec<f32> {
        let w = std::f64::consts::TAU * hz / RATE as f64;
        let alpha = w.sin() / std::f64::consts::SQRT_2;
        let (b0, b1, b2) = (
            (1.0 + w.cos()) / 2.0,
            -(1.0 + w.cos()),
            (1.0 + w.cos()) / 2.0,
        );
        let (a0, a1, a2) = (1.0 + alpha, -2.0 * w.cos(), 1.0 - alpha);
        let (mut x1, mut x2, mut y1, mut y2) = (0.0f64, 0.0, 0.0, 0.0);
        x.iter()
            .map(|&v| {
                let v = v as f64;
                let y = (b0 * v + b1 * x1 + b2 * x2 - a1 * y1 - a2 * y2) / a0;
                (x2, x1, y2, y1) = (x1, v, y1, y);
                y as f32
            })
            .collect()
    }

    /// The near-end gate's proof. A laptop-like path (nothing under ~300 Hz), a far-end talker
    /// alone for 14 s, the near end alone for 6 s (the computer silent: both tilts learned), then
    /// 1.5 s turns: the speakers alone, then both. Where the speakers play alone the gate takes
    /// the output down near the noise floor; where the user talks it opens ahead of them and their
    /// voice comes through as stages 1–3 leave it.
    #[test]
    fn the_near_end_gate_silences_the_echo_alone_and_opens_for_the_user() {
        let len = 34 * RATE;
        let turn = RATE * 3 / 2;
        let mut far = voiced(len, 7, 210.0, 400.0, 320.0, 0.0, 0.25);
        let mut near = voiced(len, 11, 120.0, 700.0, 380.0, 90.0, 0.3);
        let starts: Vec<usize> = (0..)
            .map(|i| 20 * RATE + (2 * i + 1) * turn)
            .take_while(|s| s + turn <= len)
            .collect();
        for i in 0..len {
            let alone_far = i < 14 * RATE;
            let alone_near = (14 * RATE..20 * RATE).contains(&i);
            let talking = starts.iter().any(|s| (*s..s + turn).contains(&i));
            if alone_near {
                far[i] = 0.0;
            }
            if alone_far || !(alone_near || talking) {
                near[i] = 0.0;
            }
        }
        let echo = room_echo(&high_pass(&far, 300.0), (0.150 * RATE as f64) as usize, 0.5);
        let floor = noise(len, 5);
        let mic: Vec<f32> = (0..len)
            .map(|i| near[i] + echo[i] + 0.0005 * floor[i])
            .collect();

        let gate_off = Tuning {
            near_gate: false,
            ..Strength::Normal.tuning()
        };
        let (plain, plain_near, _) = run_with_probe_tuned(&mic, &far, &near, gate_off);
        let normal = Tuning {
            near_calibration: (600, 300),
            ..Strength::Normal.tuning()
        };
        let (out, near_out, report) = run_with_probe_tuned(&mic, &far, &near, normal);
        assert!(report.gate_closed_share > 0.2, "{report:?}");

        // The speakers alone, from 300 ms after each turn of the user (the gate's hold) to the
        // next: at least 20 dB under what stages 1–3 leave, within 15 dB of the noise floor (the
        // floor tracker reads what is left of the echo in its short pauses as floor too).
        let noise_floor = power(&floor) * 0.0005f64.powi(2);
        let mut echo_alone = Vec::new();
        let mut gated = Vec::new();
        for s in &starts {
            let from = s - turn + RATE * 2 / 5;
            echo_alone.extend_from_slice(&plain[from..*s - RATE / 10]);
            gated.extend_from_slice(&out[from..*s - RATE / 10]);
        }
        let reduction = db(power(&echo_alone), power(&gated));
        let over_floor = db(power(&gated), noise_floor);
        eprintln!(
            "speakers alone: {reduction:.1} dB under stages 1–3, {over_floor:.1} dB over the floor"
        );
        assert!(reduction > 20.0, "only {reduction:.1} dB under stages 1–3");
        assert!(over_floor < 15.0, "{over_floor:.1} dB over the noise floor");

        // The user's turns: their voice through the gate no worse than through stages 1–3 alone
        // (better: there the suppressor knows they are talking), its first 50 ms included (the
        // gate opened ahead).
        let gate_kept = |range: std::ops::Range<usize>| {
            db(power(&near_out[range.clone()]), power(&near[range]))
        };
        let mut worst_onset = 0.0f64;
        let mut kept = Vec::new();
        let mut kept_plain = Vec::new();
        let mut voice = Vec::new();
        for s in &starts {
            // The talker's first syllable starts where its own cycle does: find it.
            let onset = (*s..s + turn).find(|i| near[*i].abs() > 1e-3).unwrap();
            worst_onset = worst_onset.min(gate_kept(onset..onset + RATE / 20));
            kept.extend_from_slice(&near_out[*s..s + turn]);
            kept_plain.extend_from_slice(&plain_near[*s..s + turn]);
            voice.extend_from_slice(&near[*s..s + turn]);
        }
        let kept_db = db(power(&kept), power(&voice));
        let plain_db = db(power(&kept_plain), power(&voice));
        eprintln!(
            "user's turns kept at {kept_db:.2} dB (stages 1–3: {plain_db:.2} dB), worst first 50 ms {worst_onset:.2} dB"
        );
        assert!(
            kept_db > plain_db - 0.25,
            "the gate took {:.2} dB of the user's turns",
            plain_db - kept_db
        );
        assert!(kept_db > -2.0, "the user's turns lost {kept_db:.2} dB");
        assert!(worst_onset > -3.0, "an onset lost {worst_onset:.2} dB");
    }

    #[test]
    fn the_strength_names_are_the_editor_setting() {
        assert_eq!(Strength::parse("gentle"), Strength::Gentle);
        assert_eq!(Strength::parse("normal"), Strength::Normal);
        assert_eq!(Strength::parse("strong"), Strength::Strong);
        assert_eq!(Strength::parse(""), Strength::Normal);
        assert_eq!(Strength::parse("loud"), Strength::Normal);
        assert_eq!(
            Tuning::default().over_double_talk,
            Strength::Normal.tuning().over_double_talk
        );
        // Suave keeps 2.8.0's suppressor; the gate's depth orders the three.
        assert!(!Strength::Gentle.tuning().near_res);
        assert!(Strength::Gentle.tuning().near_depth_db.is_finite());
        assert!(Strength::Normal.tuning().near_depth_db.is_infinite());
        assert!(
            Strength::Strong.tuning().over_double_talk > Strength::Normal.tuning().over_double_talk
        );
    }

    /// `cancel_echo_pcm` with the near end as a probe (see `push_with_probe`).
    pub(super) fn run_with_probe(
        mic: &[f32],
        far: &[f32],
        near: &[f32],
    ) -> (Vec<f32>, Vec<f32>, EchoReport) {
        run_with_probe_tuned(mic, far, near, Tuning::from_env())
    }

    fn run_with_probe_tuned(
        mic: &[f32],
        far: &[f32],
        near: &[f32],
        tuning: Tuning,
    ) -> (Vec<f32>, Vec<f32>, EchoReport) {
        let len = mic.len();
        let mut tracker = DelayTracker::new();
        tracker.push(far, mic);
        let estimate = tracker.finish();
        let mut canceller = EchoCanceller::with_tuning(estimate, tuning);
        let warm = len.min((WARM_UP_SEC * RATE as f64) as usize);
        let mut scratch = Vec::new();
        canceller.push(&mic[..warm], &far[..warm], &mut scratch);
        canceller.rewind();
        let mut out = Vec::new();
        canceller.push_with_probe(mic, far, near, &mut out);
        canceller.finish(&mut out);
        let near_out = canceller.take_probe();
        let report = canceller.report_for(0.0);
        (out, near_out, report)
    }

    /// The same points as `clampSystemCompensationDb`'s test in `echoCancel.test.ts`.
    #[test]
    fn the_compensation_is_the_echo_path_gain_within_its_bounds() {
        // The take of 27/10: system stem at −26.1 dBTP, so at most +25.1 dB.
        assert!((system_compensation_db(25.3, -26.1) - 25.1).abs() < 1e-9);
        assert!((system_compensation_db(18.0, -26.1) - 18.0).abs() < 1e-9);
        assert!((system_compensation_db(40.0, -60.0) - 30.0).abs() < 1e-9);
        assert_eq!(system_compensation_db(-3.0, -20.0), 0.0);
        assert_eq!(system_compensation_db(10.0, 0.5), 0.0);
        assert_eq!(system_compensation_db(f64::NAN, -20.0), 0.0);
    }

    #[test]
    fn the_true_peak_meter_sees_between_samples() {
        // A sine at an eighth of the rate, sampled half-way off its crests: the samples peak at
        // cos(π/8) (−0.69 dBFS), the wave at 0 dBFS.
        let x: Vec<f32> = (0..4800)
            .map(|i| (std::f32::consts::TAU * 0.125 * i as f32 + std::f32::consts::PI / 8.0).sin())
            .collect();
        let samples = 20.0 * (x.iter().fold(0.0f32, |m, v| m.max(v.abs())) as f64).log10();
        let mut meter = TruePeakMeter::default();
        meter.push(&[x]);
        assert!(samples < -0.6);
        assert!(
            meter.dbfs() > -0.2 && meter.dbfs() <= 0.1,
            "{}",
            meter.dbfs()
        );
    }

    #[test]
    fn a_voice_alone_passes_through_sample_for_sample() {
        // Far end only in the first 10 s; then 10 s of near end alone must be unchanged.
        let len = 24 * RATE;
        let mut far = talker(len, 7, 210.0, 400.0, 320.0, 0.0, 0.25);
        for v in far[10 * RATE..].iter_mut() {
            *v = 0.0;
        }
        let echo = room_echo(&far, (0.150 * RATE as f64) as usize, 0.4);
        let mut near = talker(len, 11, 120.0, 700.0, 380.0, 90.0, 0.2);
        for v in near[..10 * RATE].iter_mut() {
            *v = 0.0;
        }
        let mic: Vec<f32> = (0..len).map(|i| near[i] + echo[i]).collect();
        let (out, report) = cancel_echo_pcm(&mic, &far);
        assert!(report.detected, "{report:?}");
        // Past the echo tail (10 s + filter + reflections), the output is the input.
        let from = 11 * RATE;
        let worst = (from..len)
            .map(|i| (out[i] - mic[i]).abs())
            .fold(0.0f32, f32::max);
        assert!(worst < 1e-5, "max difference {worst}");
    }

    #[test]
    fn the_stream_does_not_depend_on_how_it_is_pushed() {
        let len = 12 * RATE;
        let far = talker(len, 7, 210.0, 400.0, 320.0, 0.0, 0.25);
        let echo = room_echo(&far, (0.120 * RATE as f64) as usize, 0.4);
        let estimate = BleedEstimate {
            detected: true,
            delay_sec: 0.120,
            drift: 0.0,
            windows: 1,
            consistent_windows: 1,
            duration_sec: 12.0,
        };
        let run = |step: usize| {
            let mut c = EchoCanceller::new(estimate);
            let mut out = Vec::new();
            let mut i = 0;
            while i < len {
                let n = step.min(len - i);
                c.push(&echo[i..i + n], &far[i..i + n], &mut out);
                i += n;
            }
            c.finish(&mut out);
            out
        };
        let a = run(4096);
        let b = run(777);
        assert_eq!(a.len(), len);
        assert_eq!(a, b);
    }
}

/// Measurement on real stems, not part of the suite (`--ignored`). Environment:
/// `AEC_VOICE` and `AEC_SYSTEM`, the two stems (any format ffmpeg reads); `AEC_OUT`, a WAV to
/// write the cleaned voice to; `AEC_NEAR`, optionally, the near end alone when the voice stem is
/// that near end mixed over a real echo — then the double-talk split is printed, and
/// `AEC_NEAR_OUT` gets the near end as the processing left it. `AEC_STRENGTH` picks the preset
/// and the `AEC_*` knobs of `Tuning::from_env` override it.
#[cfg(test)]
mod measure {
    use super::*;

    fn read_mono(path: &str) -> Vec<f32> {
        let mut reader = open_stem(path).unwrap();
        let n = reader.len();
        let mut pcm: PlanarPcm = vec![Vec::new(), Vec::new()];
        reader.pull(n, &mut pcm);
        pcm[0]
            .iter()
            .zip(&pcm[1])
            .map(|(l, r)| 0.5 * (l + r))
            .collect()
    }

    fn db_of(a: &[f32], b: &[f32]) -> f64 {
        let p = |x: &[f32]| x.iter().map(|v| (*v as f64).powi(2)).sum::<f64>();
        10.0 * (p(a) / p(b)).log10()
    }

    fn write_wav(path: &str, x: &[f32]) {
        let mut file = std::io::BufWriter::new(std::fs::File::create(path).unwrap());
        wav_header(&mut file, x.len()).unwrap();
        for v in x {
            let pcm = ((v.clamp(-1.0, 1.0) * 32767.0).round() as i16).to_le_bytes();
            file.write_all(&pcm).unwrap();
            file.write_all(&pcm).unwrap();
        }
    }

    #[test]
    #[ignore]
    fn measure_real_take() {
        let mic = read_mono(&std::env::var("AEC_VOICE").unwrap());
        let reference = read_mono(&std::env::var("AEC_SYSTEM").unwrap());
        let len = mic.len().min(reference.len());
        let (mic, reference) = (&mic[..len], &reference[..len]);
        let started = std::time::Instant::now();
        let (out, report) = match std::env::var("AEC_NEAR") {
            Ok(path) => {
                let mut near = read_mono(&path);
                near.resize(len, 0.0);
                let (o, n, r) = super::tests::run_with_probe(mic, reference, &near);
                let talking: Vec<usize> = (0..len / 4800)
                    .filter(|f| {
                        near[f * 4800..(f + 1) * 4800]
                            .iter()
                            .map(|v| v * v)
                            .sum::<f32>()
                            / 4800.0
                            > 1e-6
                    })
                    .collect();
                let pick = |x: &[f32]| -> Vec<f32> {
                    talking
                        .iter()
                        .flat_map(|f| x[f * 4800..(f + 1) * 4800].to_vec())
                        .collect()
                };
                let echo: Vec<f32> = (0..len).map(|i| mic[i] - near[i]).collect();
                let left: Vec<f32> = (0..len).map(|i| o[i] - n[i]).collect();
                eprintln!(
                    "double-talk ({} frames of 100 ms): echo reduced {:.1} dB, near end kept at {:.2} dB",
                    talking.len(),
                    db_of(&pick(&echo), &pick(&left)),
                    db_of(&pick(&n), &pick(&near)),
                );
                if let Ok(path) = std::env::var("AEC_NEAR_OUT") {
                    write_wav(&path, &n);
                }
                (o, r)
            }
            Err(_) => cancel_echo_pcm(mic, reference),
        };
        eprintln!(
            "{:.1} s for {:.1} s of audio\n{report:#?}",
            started.elapsed().as_secs_f64(),
            len as f64 / RATE as f64
        );
        if let Ok(path) = std::env::var("AEC_OUT") {
            write_wav(&path, &out);
        }
    }
}
