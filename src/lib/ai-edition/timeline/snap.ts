// Magnetic snapping for every timeline drag: an edge (or, for a move, either edge of the
// span) that comes within a few screen pixels of a target locks onto it exactly, and lets go
// as soon as the pointer is past the radius again. Pure apart from `watchAltDuringDrag`.
//
// What a dragged edge can lock onto, and in what order:
//
//   1. the playhead — always first: "end this exactly where I parked the playhead" is the
//      gesture the magnet exists for, so a nearer clip junction or pill edge never steals it;
//   2. everything else, nearest first — clip boundaries (cut points), the timeline's start and
//      end, the edges of the other elements on every lane, and the marker shortcut's marks.
//
// The radius is in SCREEN PIXELS, turned into seconds through the current zoom
// (`snapRadiusSec`), so the magnet feels the same zoomed all the way in on one word and
// zoomed out over a half-hour take. A radius written as a duration was the bug the pill
// drag's old 1.2%-of-the-timeline magnet had.
//
// Holding Alt (Option on a Mac) turns the magnet off for as long as it is held.

/** How close, on screen, an edge has to come to a target to lock onto it. */
export const SNAP_RADIUS_PX = 8;

export type SnapTargetKind = "playhead" | "clip" | "bound" | "edge" | "marker";

export interface SnapTarget {
	/** Raw-ruler seconds — the playhead's own clock. */
	sec: number;
	kind: SnapTargetKind;
}

export interface SnapHit {
	/** The target's time, exactly: the edge is SET to this, not nudged towards it. */
	sec: number;
	target: SnapTarget;
}

/** The magnet radius in seconds at a zoom of `pxPerSec`. 0 while the panel is unmeasured
 *  (first paint, jsdom): better to drop an edge exactly where it was released than to move it
 *  by a radius computed from a width we do not have. */
export function snapRadiusSec(pxPerSec: number, radiusPx = SNAP_RADIUS_PX): number {
	return Number.isFinite(pxPerSec) && pxPerSec > 0 ? radiusPx / pxPerSec : 0;
}

/** Lower is stronger. The playhead outranks everything; the rest compete on distance. */
function tier(kind: SnapTargetKind): number {
	return kind === "playhead" ? 0 : 1;
}

function better(candidate: SnapHit, distance: number, best: SnapHit | null, bestDistance: number) {
	if (!best) return true;
	const a = tier(candidate.target.kind);
	const b = tier(best.target.kind);
	return a < b || (a === b && distance < bestDistance);
}

/** The target `valueSec` locks onto, or null when none is within `radiusSec`. */
export function findSnap(
	valueSec: number,
	targets: readonly SnapTarget[],
	radiusSec: number,
): SnapHit | null {
	if (!(radiusSec > 0) || !Number.isFinite(valueSec)) return null;
	let best: SnapHit | null = null;
	let bestDistance = Number.POSITIVE_INFINITY;
	for (const target of targets) {
		if (!Number.isFinite(target.sec)) continue;
		const distance = Math.abs(target.sec - valueSec);
		// Strictly inside: the radius is where the magnet lets go.
		if (distance >= radiusSec) continue;
		const hit = { sec: target.sec, target };
		if (better(hit, distance, best, bestDistance)) {
			best = hit;
			bestDistance = distance;
		}
	}
	return best;
}

/** One dragged edge: where it lands, and what (if anything) it locked onto. `free` is the
 *  Alt bypass. */
export function snapEdge(
	valueSec: number,
	targets: readonly SnapTarget[],
	radiusSec: number,
	free = false,
): { sec: number; hit: SnapHit | null } {
	const hit = free ? null : findSnap(valueSec, targets, radiusSec);
	return { sec: hit ? hit.sec : valueSec, hit };
}

/**
 * A whole span being moved: either edge may lock, and the span moves by the same amount so
 * its length never changes. The playhead wins for either edge; otherwise the edge with the
 * nearer target does. Returns the shift to apply to BOTH edges.
 */
export function snapSpan(
	startSec: number,
	endSec: number,
	targets: readonly SnapTarget[],
	radiusSec: number,
	free = false,
): { deltaSec: number; hit: SnapHit | null; edge: "start" | "end" | null } {
	if (free) return { deltaSec: 0, hit: null, edge: null };
	const atStart = findSnap(startSec, targets, radiusSec);
	const atEnd = findSnap(endSec, targets, radiusSec);
	const startDistance = atStart ? Math.abs(atStart.sec - startSec) : Number.POSITIVE_INFINITY;
	const endDistance = atEnd ? Math.abs(atEnd.sec - endSec) : Number.POSITIVE_INFINITY;
	if (atEnd && better(atEnd, endDistance, atStart, startDistance)) {
		return { deltaSec: atEnd.sec - endSec, hit: atEnd, edge: "end" };
	}
	if (atStart) return { deltaSec: atStart.sec - startSec, hit: atStart, edge: "start" };
	return { deltaSec: 0, hit: null, edge: null };
}

/** The targets of one drag. The caller leaves the dragged element's own edges out of
 *  `edgesSec`: an edge is never its own magnet. */
export function buildSnapTargets(input: {
	playheadSec?: number | null;
	totalSec: number;
	clipBoundariesSec?: readonly number[];
	edgesSec?: readonly number[];
	markersSec?: readonly number[];
}): SnapTarget[] {
	const out: SnapTarget[] = [];
	const push = (sec: number, kind: SnapTargetKind) => {
		if (Number.isFinite(sec)) out.push({ sec, kind });
	};
	if (input.playheadSec != null) push(input.playheadSec, "playhead");
	push(0, "bound");
	push(input.totalSec, "bound");
	for (const sec of input.clipBoundariesSec ?? []) push(sec, "clip");
	for (const sec of input.edgesSec ?? []) push(sec, "edge");
	for (const sec of input.markersSec ?? []) push(sec, "marker");
	return out;
}

/** Whether the value an edge finally took is the target it snapped to — false when a clamp
 *  (minimum length, a neighbour, the source length) pulled it off again, so the cue never
 *  claims a lock that did not happen. */
export function landedOn(hit: SnapHit | null, finalSec: number): SnapHit | null {
	return hit && Math.abs(hit.sec - finalSec) < 1e-9 ? hit : null;
}

/**
 * Alt pressed or released mid-drag, without the pointer moving: `onChange` re-runs the drag at
 * the last pointer position so the magnet lets go (or grabs) at once. The key is consumed while
 * the drag lasts — on Windows a lone Alt that reaches the window toggles its hidden menu bar
 * (`setAutoHideMenuBar`), which would shift the whole editor under the pointer. Returns the
 * cleanup.
 */
export function watchAltDuringDrag(onChange: (altKey: boolean) => void): () => void {
	const handle = (e: KeyboardEvent) => {
		if (e.key !== "Alt") return;
		e.preventDefault();
		onChange(e.type === "keydown");
	};
	window.addEventListener("keydown", handle, true);
	window.addEventListener("keyup", handle, true);
	return () => {
		window.removeEventListener("keydown", handle, true);
		window.removeEventListener("keyup", handle, true);
	};
}
