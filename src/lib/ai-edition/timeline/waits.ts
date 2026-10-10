import type { CursorTelemetryPoint } from "@/components/video-editor/types";
import { sourceSpanToTimelineSpans } from "../captions/cues";
import type { AxcutDocument } from "../schema";
import { anchorRegionsWithDerivedMs } from "./timelineMap";

/**
 * "Speed up waits": the stretches of a take where nothing happens -- a flow
 * running, a page loading, a tenant thinking -- offered to the user to play
 * faster. Only ever offered: the user picks which ones (the fork's decision,
 * 2026-10-09), since a silent, still stretch can also be a pause on purpose.
 *
 * A wait is quiet AND still: the audio stays near the take's own floor, and the
 * cursor neither moves nor clicks nor types. Without cursor telemetry (a
 * system-cursor take) only a longer silence counts.
 */

export interface WaitSpan {
	/** Source seconds into the take. */
	startSec: number;
	endSec: number;
}

/** Shorter than this is a breath, not a wait. */
export const MIN_WAIT_SEC = 5;
/** Without the cursor to confirm nothing happens, ask for a longer silence. */
const MIN_SILENT_WAIT_SEC = 8;
/** Kept at normal speed at both ends, so the speed-up does not clip what led in and out. */
const EDGE_KEEP_SEC = 0.5;
/** Cursor travel, in fractions of the frame, that counts as the user doing something. */
const MOVE_EPSILON = 0.004;
export const WAIT_SPEED = 4;

/** Peak amplitude per block from the [min, max] pairs `getAudioPeaks` returns. */
function amplitudes(peaks: Float32Array): Float32Array {
	const out = new Float32Array(Math.floor(peaks.length / 2));
	for (let i = 0; i < out.length; i++) {
		out[i] = Math.max(Math.abs(peaks[2 * i]), Math.abs(peaks[2 * i + 1]));
	}
	return out;
}

/** "Quiet" for this take: just over its own floor, within sane bounds. */
function quietThreshold(amps: Float32Array): number {
	if (amps.length === 0) return 0.02;
	const sorted = Array.from(amps).sort((a, b) => a - b);
	const floor = sorted[Math.floor(sorted.length * 0.1)];
	return Math.min(0.05, Math.max(0.006, floor * 2));
}

/** Times (seconds) the user did something with the mouse or keyboard. */
function activityTimes(telemetry: CursorTelemetryPoint[]): number[] {
	const out: number[] = [];
	let last: CursorTelemetryPoint | null = null;
	for (const point of [...telemetry].sort((a, b) => a.timeMs - b.timeMs)) {
		const acted =
			(point.interactionType && point.interactionType !== "move") ||
			point.input !== undefined ||
			(last !== null && Math.hypot(point.cx - last.cx, point.cy - last.cy) > MOVE_EPSILON);
		if (acted) out.push(point.timeMs / 1000);
		if (point.input === undefined) last = point;
	}
	return out;
}

export function findWaits(options: {
	peaks: Float32Array | null;
	durationSec: number;
	telemetry: CursorTelemetryPoint[] | null;
}): WaitSpan[] {
	const { durationSec } = options;
	if (!options.peaks || options.peaks.length < 4 || !(durationSec > 0)) return [];
	const amps = amplitudes(options.peaks);
	const blockSec = durationSec / amps.length;
	const threshold = quietThreshold(amps);
	const haveCursor = (options.telemetry?.length ?? 0) > 0;
	const minSec = haveCursor ? MIN_WAIT_SEC : MIN_SILENT_WAIT_SEC;

	// Quiet runs first, then each one cut wherever the user acted inside it.
	const quiet: WaitSpan[] = [];
	let runStart = -1;
	for (let i = 0; i <= amps.length; i++) {
		const isQuiet = i < amps.length && amps[i] <= threshold;
		if (isQuiet && runStart < 0) runStart = i;
		if (!isQuiet && runStart >= 0) {
			quiet.push({ startSec: runStart * blockSec, endSec: i * blockSec });
			runStart = -1;
		}
	}
	const acts = haveCursor ? activityTimes(options.telemetry ?? []) : [];
	const still = quiet.flatMap((span) => {
		const cuts = acts.filter((t) => t > span.startSec && t < span.endSec);
		const edges = [span.startSec, ...cuts, span.endSec];
		return edges.slice(1).map((end, i) => ({ startSec: edges[i], endSec: end }));
	});
	return still
		.map((span) => ({
			startSec: span.startSec + EDGE_KEEP_SEC,
			endSec: span.endSec - EDGE_KEEP_SEC,
		}))
		.filter((span) => span.endSec - span.startSec >= minSec - 2 * EDGE_KEEP_SEC);
}

/**
 * Speed regions for the picked waits, wherever the timeline plays them, leaving
 * out any that would overlap a speed region already there.
 */
export function waitSpeedRegions(
	document: AxcutDocument,
	assetId: string,
	waits: WaitSpan[],
	makeId: (prefix: string) => string,
	speed: number = WAIT_SPEED,
): Array<{ id: string; startMs: number; endMs: number; speed: number }> {
	const legacy = (document.legacyEditor as Record<string, unknown> | null) ?? {};
	const existing = (
		(legacy.speedRegions as Array<{ startMs: number; endMs: number }>) ?? []
	).filter((r) => Number.isFinite(r?.startMs) && Number.isFinite(r?.endMs));
	const regions = waits.flatMap((wait) =>
		sourceSpanToTimelineSpans(assetId, wait.startSec, wait.endSec, document.timeline.clips)
			.map((span) => ({
				id: makeId("speed"),
				startMs: Math.round(span.startSec * 1000),
				endMs: Math.round(span.endSec * 1000),
				speed,
			}))
			.filter((r) => !existing.some((e) => r.startMs < e.endMs && r.endMs > e.startMs)),
	);
	return anchorRegionsWithDerivedMs(regions, document.timeline.clips, () => makeId("speed"));
}
