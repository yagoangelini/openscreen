import type { CursorTelemetryPoint, ZoomFocus } from "@/components/video-editor/types";

/** Binary-search the sorted telemetry and lerp the cursor position at the given playback time. */
export function interpolateCursorAt(
	telemetry: CursorTelemetryPoint[],
	timeMs: number,
): ZoomFocus | null {
	if (telemetry.length === 0) return null;

	if (timeMs <= telemetry[0].timeMs) {
		return { cx: telemetry[0].cx, cy: telemetry[0].cy };
	}

	const last = telemetry[telemetry.length - 1];
	if (timeMs >= last.timeMs) {
		return { cx: last.cx, cy: last.cy };
	}

	let lo = 0;
	let hi = telemetry.length - 1;

	while (lo < hi - 1) {
		const mid = (lo + hi) >>> 1;
		if (telemetry[mid].timeMs <= timeMs) {
			lo = mid;
		} else {
			hi = mid;
		}
	}

	const before = telemetry[lo];
	const after = telemetry[hi];
	const span = after.timeMs - before.timeMs;
	const t = span > 0 ? (timeMs - before.timeMs) / span : 0;

	return {
		cx: before.cx + (after.cx - before.cx) * t,
		cy: before.cy + (after.cy - before.cy) * t,
	};
}

/**
 * The view of an automatic zoom under a following camera, at `timeMs`: starts on `start` (the
 * planned focus) at `t0Ms`, holds still while the pointer stays inside `deadZone` of the zoomed
 * view (per axis), and once it leaves re-frames exponentially with time constant `tauSec`, just far
 * enough to bring the pointer back to the zone's edge. Replayed over the raw samples from `t0Ms`
 * to `tEndMs`, so it is a pure function of its arguments. Mirror of `CursorTrack::follow_view`
 * (Rust, cursor.rs); `calmMotion.parity.test.ts` holds the two to the same numbers.
 */
export function followViewAt(
	telemetry: CursorTelemetryPoint[],
	start: ZoomFocus,
	t0Ms: number,
	timeMs: number,
	tEndMs: number,
	scale: number,
	deadZone: number,
	tauSec: number,
): ZoomFocus | null {
	if (telemetry.length === 0) return null;
	const end = Math.max(tEndMs, t0Ms);
	const t = Math.min(Math.max(timeMs, t0Ms), end);
	const half = 0.5 / Math.max(1, scale);
	const dead = half * Math.min(1, Math.max(0, deadZone));
	const tau = Math.max(1e-3, tauSec);
	const reach = (v: number) => Math.min(1 - half, Math.max(half, v));
	const pull = (cursor: number, view: number) =>
		cursor - Math.min(dead, Math.max(-dead, cursor - view));
	const step = (view: ZoomFocus, cx: number, cy: number, dtMs: number): ZoomFocus => {
		if (!(dtMs > 0)) return view;
		const a = 1 - Math.exp(-dtMs / 1000 / tau);
		return {
			cx: view.cx + (pull(cx, view.cx) - view.cx) * a,
			cy: view.cy + (pull(cy, view.cy) - view.cy) * a,
		};
	};
	let view: ZoomFocus = { cx: reach(start.cx), cy: reach(start.cy) };
	let at = t0Ms;
	for (const sample of telemetry) {
		if (sample.timeMs <= t0Ms) continue;
		if (sample.timeMs > end) {
			// The last state is interpolated at the window's end, toward the next sample.
			if (at < end) {
				const next = step(view, sample.cx, sample.cy, sample.timeMs - at);
				const f = Math.min(1, Math.max(0, (end - at) / (sample.timeMs - at)));
				const atEnd = {
					cx: view.cx + (next.cx - view.cx) * f,
					cy: view.cy + (next.cy - view.cy) * f,
				};
				if (t >= end) return atEnd;
				const g = (t - at) / (end - at);
				return { cx: view.cx + (atEnd.cx - view.cx) * g, cy: view.cy + (atEnd.cy - view.cy) * g };
			}
			break;
		}
		const raw = step(view, sample.cx, sample.cy, sample.timeMs - at);
		const next = { cx: reach(raw.cx), cy: reach(raw.cy) };
		if (sample.timeMs >= t) {
			// Between two states, linear, like the renderer.
			const f = sample.timeMs > at ? (t - at) / (sample.timeMs - at) : 1;
			return { cx: view.cx + (next.cx - view.cx) * f, cy: view.cy + (next.cy - view.cy) * f };
		}
		view = next;
		at = sample.timeMs;
	}
	if (t > at) {
		// Past the last sample, the view keeps settling on the still pointer.
		const last = telemetry[telemetry.length - 1];
		const settled = step(view, last.cx, last.cy, t - at);
		return { cx: reach(settled.cx), cy: reach(settled.cy) };
	}
	return view;
}

/**
 * Exponential smoothing to reduce jitter from high-frequency cursor data.
 * Lower factor = smoother/more lag, higher = more responsive.
 */
export function smoothCursorFocus(raw: ZoomFocus, prev: ZoomFocus, factor: number): ZoomFocus {
	return {
		cx: prev.cx + (raw.cx - prev.cx) * factor,
		cy: prev.cy + (raw.cy - prev.cy) * factor,
	};
}

export interface FollowParams {
	minFactor: number;
	maxFactor: number;
	rampDistance: number;
	referenceMs: number;
}

/**
 * Advance the auto-follow focus from `prev` toward target `raw` over `dtMs` of content time. The
 * distance-adaptive factor is reframed against `referenceMs` so convergence is content-time based and
 * matches between preview and export. Returns `prev` unchanged when paused so the camera holds still.
 */
export function advanceFollowFocus(
	prev: ZoomFocus,
	raw: ZoomFocus,
	dtMs: number,
	params: FollowParams,
): ZoomFocus {
	if (!(dtMs > 0)) return prev;
	const base = adaptiveSmoothFactor(
		raw,
		prev,
		params.minFactor,
		params.maxFactor,
		params.rampDistance,
	);
	const factor = timeCorrectedFollowFactor(base, dtMs, params.referenceMs);
	return smoothCursorFocus(raw, prev, factor);
}

/**
 * Make a per-frame smoothing `baseFactor` frame-rate independent by reframing it in content time.
 * The camera converges as `(1 - baseFactor)^(dtMs / referenceMs)` regardless of frame chunking, so
 * preview (variable fps) and export (fixed fps) follow at the same speed. Larger `referenceMs` =
 * floatier. Returns 0 when paused so the camera holds still.
 */
export function timeCorrectedFollowFactor(
	baseFactor: number,
	dtMs: number,
	referenceMs: number,
): number {
	if (!(dtMs > 0) || !(referenceMs > 0)) return 0;
	return 1 - (1 - baseFactor) ** (dtMs / referenceMs);
}

/**
 * Adaptive smoothing factor that scales with distance: far from target = faster (maxFactor), close =
 * slower (minFactor). Replaces a hard deadzone with a natural deceleration curve.
 */
export function adaptiveSmoothFactor(
	raw: ZoomFocus,
	prev: ZoomFocus,
	minFactor: number,
	maxFactor: number,
	rampDistance: number,
): number {
	const dx = raw.cx - prev.cx;
	const dy = raw.cy - prev.cy;
	const distance = Math.sqrt(dx * dx + dy * dy);
	const t = Math.min(1, distance / rampDistance);
	return minFactor + (maxFactor - minFactor) * t;
}
