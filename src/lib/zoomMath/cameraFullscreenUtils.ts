import type { CameraFullscreenRegion } from "@/components/video-editor/types";
import { type SpeedRegion, screenTimeMs } from "@/lib/ai-edition/timeline/speed";
import { TRANSITION_WINDOW_MS } from "./constants";
import { easeOutScreenStudio } from "./mathUtils";

// The return to the normal layout should feel gentler than the expansion, so the
// lead-out window is stretched relative to the lead-in one.
const LEAD_OUT_WINDOW_MS = TRANSITION_WINDOW_MS * 1.5;

/**
 * Ease-in/hold/ease-out envelope for a single region. Unlike zoom's
 * `computeRegionStrength` (which anticipates the transition before `startMs`),
 * Full Camera must stay fully contained within [startMs, endMs]: progress is
 * exactly 0 at startMs, eases up to 1 within a lead-in window that starts at
 * startMs, holds at 1, then eases back down to exactly 0 at endMs (over a longer
 * window than the lead-in). Outside [startMs, endMs] progress is always 0. The
 * transition windows are clamped to at most half the region's duration so short
 * regions still ease in/out fully within their own bounds instead of overlapping.
 * Windows are measured on screen time (`screenTimeMs`), like zoom's.
 */
function computeCameraFullscreenRegionStrength(
	region: CameraFullscreenRegion,
	timeMs: number,
	speedRegions: readonly SpeedRegion[],
): number {
	// A span that opens the video has nothing to ease from: held from the first frame, as the
	// compositor holds it (`holdAtProgrammeEdges` in sceneDescription.ts). A switch recorded on
	// the HUD is a cut on its side (`continuesBefore` / `continuesAfter`, as the scene carries).
	const opensVideo = region.startMs <= 0 || region.continuesBefore === true;
	const cutAtEnd = region.continuesAfter === true;
	if (
		(opensVideo ? timeMs < region.startMs : timeMs <= region.startMs) ||
		(cutAtEnd ? timeMs > region.endMs : timeMs >= region.endMs)
	) {
		return 0;
	}

	const start = screenTimeMs(speedRegions, region.startMs);
	const end = screenTimeMs(speedRegions, region.endMs);
	const t = screenTimeMs(speedRegions, timeMs);
	const halfDuration = (end - start) / 2;
	const leadInWindow = opensVideo ? 0 : Math.min(TRANSITION_WINDOW_MS, halfDuration);
	const leadOutWindow = cutAtEnd
		? 0
		: Math.min(LEAD_OUT_WINDOW_MS, opensVideo ? end - start : halfDuration);
	const leadInEnd = start + leadInWindow;
	const leadOutStart = end - leadOutWindow;

	if (t < leadInEnd) {
		const progress = leadInWindow > 0 ? (t - start) / leadInWindow : 1;
		return easeOutScreenStudio(progress);
	}

	if (t <= leadOutStart) {
		return 1;
	}

	const progress = leadOutWindow > 0 ? (end - t) / leadOutWindow : 0;
	return easeOutScreenStudio(progress);
}

/**
 * Returns the Full Camera progress (0..1) at a given time: 0 = webcam at its normal
 * layout, 1 = webcam fully covering the canvas. Ramps in/out at the edges of the
 * dominant region using the same easing as zoom. When multiple regions overlap
 * (shouldn't normally happen given timeline overlap guards, but is handled
 * defensively) the strongest one wins.
 */
export function computeCameraFullscreenProgress(
	regions: CameraFullscreenRegion[],
	timeMs: number,
	speedRegions: readonly SpeedRegion[] = [],
): number {
	let strongest = 0;
	for (const region of regions) {
		const strength = computeCameraFullscreenRegionStrength(region, timeMs, speedRegions);
		if (strength > strongest) {
			strongest = strength;
		}
	}
	return strongest;
}

/** Where the camera is between two looks of the camera track at one moment: `k` 0 = `from`
 *  (`null`: the global look), 1 = `to`. Mirrors `camera_look_at` (regions.rs). */
export interface CameraLookBlend<T> {
	from: T | null;
	to: T;
	k: number;
}

function smoothstep01(x: number): number {
	const t = Math.min(1, Math.max(0, x));
	return t * t * (3 - 2 * t);
}

/**
 * The per-piece look under `timeMs` (raw ruler ms), for the preview's overlay. The same
 * envelope the compositor runs on: contained in the span, `TRANSITION_WINDOW_MS` each way and
 * at most half the span, smoothstep. A span that ends where the next one starts holds to its
 * end, and the next one eases from it, so the camera goes straight from one look to the other.
 */
export function computeCameraLookBlend<T extends { startMs: number; endMs: number }>(
	runs: readonly T[],
	timeMs: number,
	speedRegions: readonly SpeedRegion[] = [],
): CameraLookBlend<T> | null {
	const sorted = [...runs].sort((a, b) => a.startMs - b.startMs);
	for (let i = 0; i < sorted.length; i++) {
		const run = sorted[i];
		const prev = sorted[i - 1];
		const next = sorted[i + 1];
		const chainedBefore = prev !== undefined && Math.abs(run.startMs - prev.endMs) <= 1;
		const chainedAfter = next !== undefined && Math.abs(next.startMs - run.endMs) <= 1;
		if (timeMs <= run.startMs || (chainedAfter ? timeMs > run.endMs : timeMs >= run.endMs)) {
			continue;
		}
		const start = screenTimeMs(speedRegions, run.startMs);
		const end = screenTimeMs(speedRegions, run.endMs);
		const t = screenTimeMs(speedRegions, timeMs);
		const span = end - start;
		const leadIn = chainedAfter
			? Math.min(TRANSITION_WINDOW_MS, span)
			: Math.min(TRANSITION_WINDOW_MS, span / 2);
		const leadOut = chainedAfter ? 0 : Math.min(TRANSITION_WINDOW_MS, span / 2);
		const phase =
			t < start + leadIn
				? leadIn > 0
					? (t - start) / leadIn
					: 1
				: t <= end - leadOut
					? 1
					: leadOut > 0
						? (end - t) / leadOut
						: 0;
		const rising = chainedAfter || t < start + span / 2;
		return { from: rising && chainedBefore ? prev : null, to: run, k: smoothstep01(phase) };
	}
	return null;
}
