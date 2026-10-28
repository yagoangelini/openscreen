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
//! Three stages, all offline and in order:
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
//!
//! Frames whose reference has been silent for the whole filter length are passed through
//! untouched: a stretch where only the user talks comes out sample for sample as recorded.
//! The first `WARM_UP_SEC` are run twice — once to train the filter, once for real — so the
//! start of the take is cancelled as well as the rest.
//!
//! Measured (`docs/HANDOFF.md`, "Remover eco do alto-falante"): 16 s for the 22 min take in a
//! release build; on its frames where the computer plays, the median level drop is 16–23 dB, and
//! on its frames where only the user talks the level changes by −0.25 dB on average.
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
}

impl Default for Tuning {
    fn default() -> Self {
        Self {
            mu: 0.8,
            gate_lo: 0.45,
            gate_hi: 0.8,
            ratio_floor: 1.0,
            over: 4.0,
            over_double_talk: 1.0,
            floor: GAIN_FLOOR,
            taps: TAPS,
            pre: PRE_FRAMES,
        }
    }
}

impl Tuning {
    #[cfg(test)]
    fn from_env() -> Self {
        let d = Self::default();
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
        }
    }
}

/// See `EchoCanceller::push_with_probe`.
struct Probe {
    buf: Vec<f32>,
    ola: Vec<f32>,
    out: Vec<f32>,
    spec: Vec<Complex<f32>>,
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
    path_gain: Vec<f32>,
    leak_bins: Vec<f32>,
    gain: Vec<f32>,
    leak: f32,
    main_tap: usize,
    totals: Totals,
    // Scratch.
    time: Vec<f32>,
    spec_d: Vec<Complex<f32>>,
    spec_x: Vec<Complex<f32>>,
    spec_out: Vec<Complex<f32>>,
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
        let zero = Complex::new(0.0f32, 0.0);
        Self {
            estimate,
            tuning,
            probe: None,
            taps,
            pre,
            window: sqrt_hann(),
            spec_d: forward.make_output_vec(),
            spec_x: forward.make_output_vec(),
            spec_out: forward.make_output_vec(),
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
            path_gain: vec![0.0; ADAPT_BINS],
            leak_bins: vec![1.0; ADAPT_BINS],
            gain: vec![1.0; BINS],
            leak: 0.5,
            main_tap: pre,
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
                spec: self.forward.make_output_vec(),
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

    /// Samples finalised so far (frames processed × hop, minus the dropped head).
    fn emitted_upto(&self) -> usize {
        (self.frames_seen * HOP).saturating_sub(PAD)
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

        if self.silent_run >= self.taps {
            // Nothing the speakers played can be in this frame: the voice as recorded.
            self.spec_out.copy_from_slice(&self.spec_d);
            self.gain.fill(1.0);
            if mic_power > 3.2e-5 {
                self.totals.voice_energy += mic_power as f64;
                self.totals.voice_frames += 1;
            }
        } else {
            self.totals.processed += 1;
            self.cancel(mic_power);
        }

        // Synthesis and overlap-add.
        self.spec_out[0].im = 0.0;
        self.spec_out[BINS - 1].im = 0.0;
        let _ = self.inverse.process(&mut self.spec_out, &mut self.time);
        // Overlap-added squared sqrt-Hann windows sum to FRAME / (2 HOP).
        let scale = (2 * HOP) as f32 / (FRAME * FRAME) as f32;
        for i in 0..FRAME {
            self.ola[i] += self.time[i] * self.window[i] * scale;
        }
        let drop = self.to_drop.min(HOP);
        self.to_drop -= drop;
        out.extend_from_slice(&self.ola[drop..HOP]);
        if let Some(state) = self.probe.as_mut() {
            for i in 0..FRAME {
                self.time[i] = state.buf[i] * self.window[i];
            }
            let _ = self.forward.process(&mut self.time, &mut state.spec);
            for (s, g) in state.spec.iter_mut().zip(&self.gain) {
                *s *= *g;
            }
            state.spec[0].im = 0.0;
            state.spec[BINS - 1].im = 0.0;
            let _ = self.inverse.process(&mut state.spec, &mut self.time);
            for i in 0..FRAME {
                state.ola[i] += self.time[i] * self.window[i] * scale;
            }
            state.out.extend_from_slice(&state.ola[drop..HOP]);
            state.ola.copy_within(HOP.., 0);
            state.ola[FRAME - HOP..].fill(0.0);
            state.buf.drain(..HOP);
        }
        self.ola.copy_within(HOP.., 0);
        self.ola[FRAME - HOP..].fill(0.0);
        self.mic_buf.drain(..HOP);
        self.ref_buf.drain(..HOP);
    }

    fn cancel(&mut self, mic_power: f32) {
        let zero = Complex::new(0.0f32, 0.0);
        // Echo estimate.
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
        // Hard on frames where the speakers are heard alone, gentle where the user talks too: there
        // an over-estimated echo would take the voice with it.
        let over = tuning.over_double_talk + (tuning.over - tuning.over_double_talk) * gate;
        for k in 0..BINS {
            let e = error[k];
            self.s_ee[k] = 0.5 * self.s_ee[k] + 0.5 * e.norm_sqr();
            let see = self.s_ee[k].max(1e-20);
            let residual = over
                * (self.leak * echo[k].norm_sqr())
                    .max(self.leak_bins[k] * self.path_gain[k] * power[k]);
            let target = (1.0 - residual / see).clamp(tuning.floor, 1.0);
            // Never below the microphone's own noise floor: suppressing the room tone along
            // with the echo would make it breathe in and out with the computer's sound.
            let target = target.max((self.noise[k] / see).sqrt().min(1.0));
            // Fall at most ~4.4 dB per frame (no chopped onsets), rise at once.
            let g = target.max(self.gain[k] * 0.6);
            self.gain[k] = g;
            self.spec_out[k] = e * g;
        }

        // Report.
        let linear: f32 = error.iter().map(|e| e.norm_sqr()).sum::<f32>()
            + self.spec_d[ADAPT_BINS..]
                .iter()
                .map(|d| d.norm_sqr())
                .sum::<f32>();
        let mic: f32 = self.spec_d.iter().map(|d| d.norm_sqr()).sum();
        let after: f32 = self.spec_out.iter().map(|d| d.norm_sqr()).sum();
        let echo_power: f32 = echo.iter().map(|y| y.norm_sqr()).sum();
        if gate > 0.8 {
            self.totals.echo_only_mic += mic as f64;
            self.totals.echo_only_linear += linear as f64;
            self.totals.echo_only_out += after as f64;
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
        }
    }
}

/// Floor of the residual suppression: −40 dB (the microphone's noise floor usually comes first).
const GAIN_FLOOR: f32 = 0.01;
/// Frames of full adaptation (~2 s) before the double-talk detector stops trusting the reference.
const BOOTSTRAP_FRAMES: f32 = 400.0;

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
    (out, canceller.report())
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
    mut each: impl FnMut(&[f32], &[f32]),
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
        each(&vm, &sm);
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
pub fn cancel_echo_file(voice_path: &str, system_path: &str, output: &str) -> Result<EchoReport> {
    let mut tracker = DelayTracker::new();
    for_each_block(voice_path, system_path, None, |mic, reference| {
        tracker.push(reference, mic)
    })?;
    let estimate = tracker.finish();
    if !estimate.detected {
        return Ok(report_without_bleed(&estimate));
    }
    let mut canceller = EchoCanceller::new(estimate);
    let mut scratch = Vec::new();
    for_each_block(
        voice_path,
        system_path,
        Some((WARM_UP_SEC * RATE as f64) as usize),
        |mic, reference| {
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
    let processed = for_each_block(voice_path, system_path, None, |mic, reference| {
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
    Ok(canceller.report())
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

        let (out, near_out, report) = run_with_probe(&mic, &far, &near);
        assert!(report.detected, "{report:?}");
        assert_eq!(out.len(), mic.len());
        assert_eq!(near_out.len(), mic.len());

        // ERLE over the echo-only half (after the first 2 s).
        let a = 2 * RATE;
        let b = len / 2;
        let erle = db(power(&mic[a..b]), power(&out[a..b]));
        eprintln!("echo-only ERLE {erle:.1} dB");
        assert!(erle > 15.0, "ERLE {erle:.1} dB, {report:?}");

        // Double-talk half, split exactly: `near_out` is the near end through the same gains,
        // and the output minus it is what is left of the echo.
        let c = len / 2 + RATE;
        let left: Vec<f32> = (c..len).map(|i| out[i] - near_out[i]).collect();
        let echo_reduction = db(power(&echo[c..]), power(&left));
        let kept_db = db(power(&near_out[c..]), power(&near[c..]));
        eprintln!(
            "double-talk: echo reduced {echo_reduction:.1} dB, near end kept at {kept_db:.2} dB"
        );
        // During double-talk only the linear filter works on the echo (the suppressor backs off to
        // keep the voice): less than on its own, but never more echo than before.
        assert!(
            echo_reduction > 2.0,
            "echo reduced only {echo_reduction:.1} dB during double-talk"
        );
        assert!(kept_db.abs() < 1.0, "near end changed by {kept_db:.2} dB");
    }

    /// `cancel_echo_pcm` with the near end as a probe (see `push_with_probe`).
    pub(super) fn run_with_probe(
        mic: &[f32],
        far: &[f32],
        near: &[f32],
    ) -> (Vec<f32>, Vec<f32>, EchoReport) {
        let len = mic.len();
        let mut tracker = DelayTracker::new();
        tracker.push(far, mic);
        let estimate = tracker.finish();
        let mut canceller = EchoCanceller::with_tuning(estimate, Tuning::from_env());
        let warm = len.min((WARM_UP_SEC * RATE as f64) as usize);
        let mut scratch = Vec::new();
        canceller.push(&mic[..warm], &far[..warm], &mut scratch);
        canceller.rewind();
        let mut out = Vec::new();
        canceller.push_with_probe(mic, far, near, &mut out);
        canceller.finish(&mut out);
        let near_out = canceller.take_probe();
        let report = canceller.report();
        (out, near_out, report)
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
/// that near end mixed over a real echo — then the double-talk split is printed too. The
/// `AEC_*` tuning variables of `Tuning::from_env` apply.
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

    #[test]
    #[ignore]
    fn measure_real_take() {
        let mic = read_mono(&std::env::var("AEC_VOICE").unwrap());
        let reference = read_mono(&std::env::var("AEC_SYSTEM").unwrap());
        let len = mic.len().min(reference.len());
        let (mic, reference) = (&mic[..len], &reference[..len]);
        let started = std::time::Instant::now();
        let (out, near_out, report) = match std::env::var("AEC_NEAR") {
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
                            > 1e-4
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
                (o, Some(n), r)
            }
            Err(_) => {
                let (o, r) = cancel_echo_pcm(mic, reference);
                (o, None, r)
            }
        };
        let _ = near_out;
        eprintln!(
            "{:.1} s for {:.1} s of audio
{report:#?}",
            started.elapsed().as_secs_f64(),
            len as f64 / RATE as f64
        );
        if let Ok(path) = std::env::var("AEC_OUT") {
            let mut file = std::io::BufWriter::new(std::fs::File::create(path).unwrap());
            wav_header(&mut file, out.len()).unwrap();
            for v in &out {
                let pcm = ((v.clamp(-1.0, 1.0) * 32767.0).round() as i16).to_le_bytes();
                file.write_all(&pcm).unwrap();
                file.write_all(&pcm).unwrap();
            }
        }
    }
}
