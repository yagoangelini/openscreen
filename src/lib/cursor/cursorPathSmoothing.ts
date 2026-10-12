import type { CursorRecordingData, CursorRecordingSample } from "@/native/contracts";
import { clamp } from "@/utils/math";

/**
 * Offline cursor-path smoothing for native recordings. TypeScript mirror of the compositor's
 * `CursorTrack::smoothed` (crates/compositor/src/cursor.rs), which draws the cursor in the
 * preview and the export; keep the two in step.
 *
 * The whole path is known up front, so the smoothing is zero-phase: resample to 240 Hz, then
 * replace each point with the centred Gaussian average of the path around it. A pointer moving at
 * a steady speed is drawn exactly where it is, when it is there; only tremor and the corners of
 * the sampled path are rounded off. Each click is pulled back onto its raw point at its instant.
 * The spring this replaced trailed the real pointer by ~190 ms at the default strength.
 */

export interface SmoothedCursorPosition {
	cx: number;
	cy: number;
}

export interface SmoothedCursorPath {
	/** Smoothed normalized position at a time, or null when the cursor is hidden there. */
	sampleAt(timeMs: number): SmoothedCursorPosition | null;
}

/** 240 steps/sec, the compositor's grid. */
const STEP_MS = 1000 / 240;
/** Spread (one standard deviation) of the Gaussian at smoothing 1 (`SMOOTHING_SIGMA_MAX_S`). */
export const CURSOR_SMOOTHING_SIGMA_MAX_MS = 30;

interface SmoothedRun {
	start: number;
	end: number;
	times: number[];
	xs: number[];
	ys: number[];
}

function binarySearchAtOrBefore(times: ArrayLike<number>, timeMs: number, hi: number): number {
	let low = 0;
	let high = hi;
	let result = -1;
	while (low <= high) {
		const mid = low + ((high - low) >> 1);
		if (times[mid] <= timeMs) {
			result = mid;
			low = mid + 1;
		} else {
			high = mid - 1;
		}
	}
	return result;
}

/** Linear interpolation of a series' position at an arbitrary time; held past both ends. */
function interpolate(
	times: ArrayLike<number>,
	xs: ArrayLike<number>,
	ys: ArrayLike<number>,
	timeMs: number,
): SmoothedCursorPosition {
	const last = times.length - 1;
	if (timeMs <= times[0]) return { cx: xs[0], cy: ys[0] };
	if (timeMs >= times[last]) return { cx: xs[last], cy: ys[last] };
	const i = binarySearchAtOrBefore(times, timeMs, last);
	const span = times[i + 1] - times[i];
	if (span <= 0) return { cx: xs[i], cy: ys[i] };
	const t = (timeMs - times[i]) / span;
	return { cx: xs[i] + (xs[i + 1] - xs[i]) * t, cy: ys[i] + (ys[i + 1] - ys[i]) * t };
}

function interpolateRun(samples: CursorRecordingSample[], timeMs: number): SmoothedCursorPosition {
	return interpolate(
		samples.map((s) => s.timeMs),
		samples.map((s) => s.cx),
		samples.map((s) => s.cy),
		timeMs,
	);
}

/** Centred convolution with a Gaussian of `sigmaMs`, each end held: zero phase. */
function gaussianSmooth(values: Float64Array, sigmaMs: number): number[] {
	const radius = Math.max(1, Math.ceil((3 * sigmaMs) / STEP_MS));
	const kernel: number[] = [];
	for (let j = -radius; j <= radius; j++) {
		const d = (j * STEP_MS) / sigmaMs;
		kernel.push(Math.exp(-0.5 * d * d));
	}
	const total = kernel.reduce((sum, w) => sum + w, 0);
	const last = values.length - 1;
	const out: number[] = new Array(values.length);
	for (let i = 0; i < values.length; i++) {
		let sum = 0;
		for (let j = 0; j < kernel.length; j++) {
			sum += values[clamp(i + j - radius, 0, last)] * kernel[j];
		}
		out[i] = sum / total;
	}
	return out;
}

function smoothstep01(x: number): number {
	const u = clamp(x, 0, 1);
	return u * u * (3 - 2 * u);
}

/** Maximal runs of visible samples, so we never smooth across a hidden gap. */
function splitVisibleRuns(samples: CursorRecordingSample[]): CursorRecordingSample[][] {
	const runs: CursorRecordingSample[][] = [];
	let current: CursorRecordingSample[] = [];
	for (const sample of samples) {
		if (sample.visible === false) {
			if (current.length) runs.push(current);
			current = [];
			continue;
		}
		current.push(sample);
	}
	if (current.length) runs.push(current);
	return runs;
}

/**
 * Each click's offset from its raw point, applied in full at its instant and faded out over the
 * kernel's reach on both sides; the instant becomes a point of the run (`pin_clicks` in Rust).
 */
function pinClicks(run: SmoothedRun, samples: CursorRecordingSample[], reachMs: number) {
	const reach = Math.max(reachMs, STEP_MS);
	const instants: Array<[number, number, number]> = [];
	for (const click of samples) {
		if (click.interactionType !== "click") continue;
		const at = interpolate(run.times, run.xs, run.ys, click.timeMs);
		const dx = click.cx - at.cx;
		const dy = click.cy - at.cy;
		for (let i = 0; i < run.times.length; i++) {
			const d = Math.abs(run.times[i] - click.timeMs);
			if (d > reach) continue;
			const w = 1 - smoothstep01(d / reach);
			run.xs[i] += dx * w;
			run.ys[i] += dy * w;
		}
		instants.push([click.timeMs, click.cx, click.cy]);
	}
	if (instants.length === 0) return;
	const merged = run.times.map((t, i): [number, number, number] => [t, run.xs[i], run.ys[i]]);
	merged.push(...instants);
	// Stable: a click on a grid instant comes after it, and the lookup reads the click.
	merged.sort((a, b) => a[0] - b[0]);
	run.times = merged.map((p) => p[0]);
	run.xs = merged.map((p) => p[1]);
	run.ys = merged.map((p) => p[2]);
}

function buildSmoothedRun(samples: CursorRecordingSample[], sigmaMs: number): SmoothedRun {
	const start = samples[0].timeMs;
	const end = samples[samples.length - 1].timeMs;
	const stepCount = Math.max(1, Math.round((end - start) / STEP_MS));
	const n = stepCount + 1;
	const grid: number[] = new Array(n);
	const rawX = new Float64Array(n);
	const rawY = new Float64Array(n);
	for (let i = 0; i < n; i++) {
		const t = i === n - 1 ? end : start + i * STEP_MS;
		grid[i] = t;
		const p = interpolateRun(samples, t);
		rawX[i] = p.cx;
		rawY[i] = p.cy;
	}
	const run: SmoothedRun = {
		start,
		end,
		times: grid,
		xs: gaussianSmooth(rawX, sigmaMs),
		ys: gaussianSmooth(rawY, sigmaMs),
	};
	pinClicks(run, samples, 3 * sigmaMs);
	return run;
}

/** Passthrough path (smoothing 0): raw linear interpolation, still respecting visibility gaps. */
function buildRawPath(runs: CursorRecordingSample[][]): SmoothedCursorPath {
	return {
		sampleAt(timeMs) {
			for (const run of runs) {
				if (timeMs >= run[0].timeMs && timeMs <= run[run.length - 1].timeMs) {
					return interpolateRun(run, timeMs);
				}
			}
			return null;
		},
	};
}

function buildSmoothedPath(
	recordingData: CursorRecordingData,
	smoothing01: number,
): SmoothedCursorPath {
	const runs = splitVisibleRuns(recordingData.samples).filter((run) => run.length > 0);
	if (runs.length === 0) {
		return { sampleAt: () => null };
	}
	const sigmaMs = clamp(smoothing01, 0, 1) * CURSOR_SMOOTHING_SIGMA_MAX_MS;
	if (sigmaMs <= 0) {
		return buildRawPath(runs);
	}

	const smoothedRuns: SmoothedRun[] = runs.map((run) =>
		run.length < 2
			? {
					start: run[0].timeMs,
					end: run[0].timeMs,
					times: [run[0].timeMs],
					xs: [run[0].cx],
					ys: [run[0].cy],
				}
			: buildSmoothedRun(run, sigmaMs),
	);

	return {
		sampleAt(timeMs) {
			for (const run of smoothedRuns) {
				if (timeMs >= run.start && timeMs <= run.end) {
					return interpolate(run.times, run.xs, run.ys, timeMs);
				}
			}
			return null;
		},
	};
}

const pathCache = new WeakMap<CursorRecordingData, Map<string, SmoothedCursorPath>>();

/**
 * Returns the smoothed cursor path for a recording at a given strength, memoized per
 * (recordingData, strength) so it's built once.
 */
export function getSmoothedCursorPath(
	recordingData: CursorRecordingData | null | undefined,
	smoothing01: number,
): SmoothedCursorPath | null {
	if (!recordingData || recordingData.samples.length === 0) return null;
	const key = (Number.isFinite(smoothing01) ? clamp(smoothing01, 0, 1) : 0).toFixed(2);
	let byStrength = pathCache.get(recordingData);
	if (!byStrength) {
		byStrength = new Map();
		pathCache.set(recordingData, byStrength);
	}
	let path = byStrength.get(key);
	if (!path) {
		path = buildSmoothedPath(recordingData, Number.parseFloat(key));
		byStrength.set(key, path);
	}
	return path;
}
