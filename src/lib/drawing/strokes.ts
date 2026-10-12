/**
 * The strokes drawn on the drawing layer, and how they fade. Pure, so the timing is tested
 * without a canvas: `DrawingOverlay.tsx` only paints what these return.
 */

import type { DrawingTool } from "./overlayState";

export interface Point {
	x: number;
	y: number;
}

export interface Stroke {
	id: number;
	tool: DrawingTool;
	color: string;
	width: number;
	/** Pen and highlighter: every point. The shapes: [start, end]. */
	points: Point[];
	/** When the stroke was finished (pointer up); null while it is being drawn. */
	finishedAtMs: number | null;
}

/** How long the fade itself lasts, after the stroke's time is up. */
export const STROKE_FADE_MS = 600;

/**
 * 1 while the stroke is drawn and for `fadeSeconds` after, then down to 0 over
 * STROKE_FADE_MS. A `fadeSeconds` of 0 keeps it until it is cleared.
 */
export function strokeOpacity(stroke: Stroke, nowMs: number, fadeSeconds: number): number {
	if (stroke.finishedAtMs === null || fadeSeconds <= 0) return 1;
	const fadeStart = stroke.finishedAtMs + fadeSeconds * 1000;
	if (nowMs <= fadeStart) return 1;
	return Math.max(0, 1 - (nowMs - fadeStart) / STROKE_FADE_MS);
}

/** The strokes still on screen at `nowMs`. */
export function liveStrokes(
	strokes: readonly Stroke[],
	nowMs: number,
	fadeSeconds: number,
): Stroke[] {
	return strokes.filter((stroke) => strokeOpacity(stroke, nowMs, fadeSeconds) > 0);
}

/** The highlighter is wide and see-through, so the text under it still reads. */
export function strokePaint(stroke: Stroke): { width: number; alpha: number } {
	return stroke.tool === "highlighter"
		? { width: stroke.width * 3, alpha: 0.35 }
		: { width: stroke.width, alpha: 1 };
}

/** Pen and highlighter grow point by point; the shapes keep their start and move their end. */
export function extendStroke(stroke: Stroke, point: Point): Stroke {
	if (stroke.tool === "pen" || stroke.tool === "highlighter") {
		const last = stroke.points.at(-1);
		// Sub-pixel moves only add points nobody can see.
		if (last && Math.hypot(point.x - last.x, point.y - last.y) < 1) return stroke;
		return { ...stroke, points: [...stroke.points, point] };
	}
	return { ...stroke, points: [stroke.points[0] ?? point, point] };
}

/** The two sides of an arrow's head at `to`, sized to the line's width. */
export function arrowHead(from: Point, to: Point, width: number): [Point, Point] {
	const angle = Math.atan2(to.y - from.y, to.x - from.x);
	const length = Math.max(12, width * 4);
	const spread = Math.PI / 7;
	return [
		{ x: to.x - length * Math.cos(angle - spread), y: to.y - length * Math.sin(angle - spread) },
		{ x: to.x - length * Math.cos(angle + spread), y: to.y - length * Math.sin(angle + spread) },
	];
}

/** The box between two corners, whichever way the drag went. */
export function boxBetween(
	a: Point,
	b: Point,
): { x: number; y: number; width: number; height: number } {
	return {
		x: Math.min(a.x, b.x),
		y: Math.min(a.y, b.y),
		width: Math.abs(a.x - b.x),
		height: Math.abs(a.y - b.y),
	};
}

/** A click with no drag leaves a dot with the pen, and nothing with a shape. */
export function isWorthKeeping(stroke: Stroke): boolean {
	if (stroke.tool === "pen" || stroke.tool === "highlighter") return stroke.points.length > 0;
	const [a, b] = stroke.points;
	return Boolean(a && b) && Math.hypot(b.x - a.x, b.y - a.y) >= 4;
}
