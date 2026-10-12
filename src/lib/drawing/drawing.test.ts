import { describe, expect, it } from "vitest";
import {
	DEFAULT_DRAWING_STYLE,
	type DrawingMachineState,
	drawingWindowPlan,
	INITIAL_DRAWING_STATE,
	reduceDrawing,
	sanitizeDrawingStyle,
} from "./overlayState";
import {
	arrowHead,
	boxBetween,
	extendStroke,
	isWorthKeeping,
	liveStrokes,
	STROKE_FADE_MS,
	type Stroke,
	strokeOpacity,
	strokePaint,
} from "./strokes";

const run = (...events: Parameters<typeof reduceDrawing>[1][]): DrawingMachineState =>
	events.reduce(reduceDrawing, INITIAL_DRAWING_STATE);

describe("the drawing overlay state machine", () => {
	it("starts off, and the toggle enters drawing mode", () => {
		expect(INITIAL_DRAWING_STATE.phase).toBe("off");
		expect(run({ type: "toggle" }).phase).toBe("drawing");
	});

	it("leaves straight to off when nothing was drawn", () => {
		expect(run({ type: "toggle" }, { type: "toggle" }).phase).toBe("off");
		expect(run({ type: "toggle" }, { type: "exit" }).phase).toBe("off");
	});

	it("keeps the layer showing, click-through, while strokes fade, then turns off", () => {
		const leaving = run({ type: "toggle" }, { type: "strokes", visible: true }, { type: "exit" });
		expect(leaving.phase).toBe("showing");
		expect(reduceDrawing(leaving, { type: "strokes", visible: false }).phase).toBe("off");
	});

	it("goes back to drawing from showing", () => {
		const showing = run({ type: "toggle" }, { type: "strokes", visible: true }, { type: "toggle" });
		expect(showing.phase).toBe("showing");
		expect(reduceDrawing(showing, { type: "toggle" }).phase).toBe("drawing");
	});

	it("stays in drawing mode when the strokes fade under the pen", () => {
		const drawing = run({ type: "toggle" }, { type: "strokes", visible: true });
		expect(reduceDrawing(drawing, { type: "strokes", visible: false }).phase).toBe("drawing");
	});

	it("ignores an exit when not drawing", () => {
		expect(run({ type: "exit" })).toEqual(INITIAL_DRAWING_STATE);
	});

	it("takes the mouse and the keys only while drawing", () => {
		expect(drawingWindowPlan("off")).toEqual({
			layerVisible: false,
			layerTakesMouse: false,
			toolbarVisible: false,
			drawingKeys: false,
		});
		expect(drawingWindowPlan("drawing")).toEqual({
			layerVisible: true,
			layerTakesMouse: true,
			toolbarVisible: true,
			drawingKeys: true,
		});
		expect(drawingWindowPlan("showing")).toEqual({
			layerVisible: true,
			layerTakesMouse: false,
			toolbarVisible: false,
			drawingKeys: false,
		});
	});

	it("reads a stored style back, replacing what is unknown", () => {
		expect(sanitizeDrawingStyle(undefined)).toEqual(DEFAULT_DRAWING_STYLE);
		expect(
			sanitizeDrawingStyle({ tool: "arrow", color: "#22c55e", width: 12, fadeSeconds: 0 }),
		).toEqual({ tool: "arrow", color: "#22c55e", width: 12, fadeSeconds: 0 });
		expect(
			sanitizeDrawingStyle({ tool: "laser", color: "red", width: 99, fadeSeconds: 7 }),
		).toEqual(DEFAULT_DRAWING_STYLE);
	});
});

const stroke = (overrides: Partial<Stroke> = {}): Stroke => ({
	id: 1,
	tool: "pen",
	color: "#ef4444",
	width: 6,
	points: [{ x: 0, y: 0 }],
	finishedAtMs: 1_000,
	...overrides,
});

describe("strokes", () => {
	it("stays solid while drawn and for the fade time, then fades out", () => {
		const s = stroke();
		expect(strokeOpacity(stroke({ finishedAtMs: null }), 99_000, 3)).toBe(1);
		expect(strokeOpacity(s, 4_000, 3)).toBe(1);
		expect(strokeOpacity(s, 4_000 + STROKE_FADE_MS / 2, 3)).toBeCloseTo(0.5);
		expect(strokeOpacity(s, 4_000 + STROKE_FADE_MS, 3)).toBe(0);
	});

	it("never fades with a fade time of 0", () => {
		expect(strokeOpacity(stroke(), 1_000_000, 0)).toBe(1);
	});

	it("drops the strokes that faded out", () => {
		const strokes = [stroke({ id: 1, finishedAtMs: 0 }), stroke({ id: 2, finishedAtMs: 5_000 })];
		expect(liveStrokes(strokes, 4_000, 3).map((s) => s.id)).toEqual([2]);
	});

	it("paints the highlighter wide and see-through", () => {
		expect(strokePaint(stroke({ tool: "highlighter", width: 6 }))).toEqual({
			width: 18,
			alpha: 0.35,
		});
		expect(strokePaint(stroke())).toEqual({ width: 6, alpha: 1 });
	});

	it("grows a pen stroke point by point, skipping sub-pixel moves", () => {
		const grown = extendStroke(stroke(), { x: 10, y: 0 });
		expect(grown.points).toHaveLength(2);
		expect(extendStroke(grown, { x: 10.5, y: 0 })).toBe(grown);
	});

	it("keeps a shape to its start and its moving end", () => {
		const shape = stroke({ tool: "rectangle", points: [{ x: 5, y: 5 }] });
		const once = extendStroke(shape, { x: 50, y: 40 });
		const twice = extendStroke(once, { x: 80, y: 90 });
		expect(twice.points).toEqual([
			{ x: 5, y: 5 },
			{ x: 80, y: 90 },
		]);
	});

	it("draws the arrow head back from the tip, on both sides of the line", () => {
		const [left, right] = arrowHead({ x: 0, y: 0 }, { x: 100, y: 0 }, 6);
		expect(left.x).toBeLessThan(100);
		expect(right.x).toBeLessThan(100);
		expect(left.y).toBeCloseTo(-right.y);
		expect(Math.hypot(100 - left.x, left.y)).toBeCloseTo(24);
	});

	it("boxes a drag whichever way it went", () => {
		expect(boxBetween({ x: 50, y: 10 }, { x: 10, y: 40 })).toEqual({
			x: 10,
			y: 10,
			width: 40,
			height: 30,
		});
	});

	it("drops a shape that was only a click", () => {
		expect(
			isWorthKeeping(
				stroke({
					tool: "ellipse",
					points: [
						{ x: 0, y: 0 },
						{ x: 1, y: 1 },
					],
				}),
			),
		).toBe(false);
		expect(
			isWorthKeeping(
				stroke({
					tool: "arrow",
					points: [
						{ x: 0, y: 0 },
						{ x: 30, y: 0 },
					],
				}),
			),
		).toBe(true);
		expect(isWorthKeeping(stroke())).toBe(true);
	});
});
