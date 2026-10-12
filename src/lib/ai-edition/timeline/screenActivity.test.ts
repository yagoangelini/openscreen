import { describe, expect, it } from "vitest";
import {
	ACTIVITY_GRID_H,
	ACTIVITY_GRID_W,
	activityWindow,
	diffFrames,
	readScreenActivity,
	ScreenActivityRecorder,
} from "./screenActivity";

const W = ACTIVITY_GRID_W;
const H = ACTIVITY_GRID_H;

function frame(fill = 30): Uint8Array {
	return new Uint8Array(W * H).fill(fill);
}

/** `base` with the cells of [x0, x1) × [y0, y1) (in cells) set to `value`. */
function paint(base: Uint8Array, x0: number, y0: number, x1: number, y1: number, value: number) {
	const out = Uint8Array.from(base);
	for (let y = y0; y < y1; y += 1) for (let x = x0; x < x1; x += 1) out[y * W + x] = value;
	return out;
}

describe("diffFrames", () => {
	it("finds nothing between two identical frames, nor in encoder noise", () => {
		expect(diffFrames(frame(), frame())).toBeNull();
		expect(diffFrames(frame(30), frame(38))).toBeNull();
	});

	it("boxes a menu that appears, in frame fractions", () => {
		const menu = paint(frame(), 120, 9, 150, 45, 200);
		const step = diffFrames(frame(), menu);
		expect(step?.boxes).toHaveLength(1);
		const [box] = step?.boxes ?? [];
		expect(box.x).toBeCloseTo(120 / W, 4);
		expect(box.y).toBeCloseTo(9 / H, 4);
		expect(box.width).toBeCloseTo(30 / W, 4);
		expect(box.height).toBeCloseTo(36 / H, 4);
		expect(step?.share).toBeCloseTo((30 * 36) / (W * H), 4);
	});

	it("keeps two changes apart, largest first, and drops a lone cell", () => {
		let next = paint(frame(), 10, 10, 20, 15, 220);
		next = paint(next, 100, 60, 140, 80, 220);
		next = paint(next, 70, 40, 71, 41, 220);
		const step = diffFrames(frame(), next);
		expect(step?.boxes.map((b) => Math.round(b.x * W))).toEqual([100, 10]);
	});

	it("joins the rows of one menu into one box", () => {
		// Rows with a cell of background between them: one change, not five.
		let next = frame();
		for (let row = 0; row < 5; row += 1)
			next = paint(next, 50, 20 + row * 2, 70, 21 + row * 2, 220);
		expect(diffFrames(frame(), next)?.boxes).toHaveLength(1);
	});
});

describe("ScreenActivityRecorder", () => {
	it("stamps each change with the time of the frame it appeared in", () => {
		const recorder = new ScreenActivityRecorder(8);
		recorder.push(frame());
		recorder.push(frame());
		recorder.push(paint(frame(), 10, 10, 30, 30, 200));
		recorder.push(paint(frame(), 10, 10, 30, 30, 200));
		const activity = recorder.result();
		expect(activity.steps.map((s) => s.t)).toEqual([250]);
		expect(activity.durationMs).toBe(375);
	});
});

describe("readScreenActivity", () => {
	it("reads a stored scan back, and refuses anything else", () => {
		const recorder = new ScreenActivityRecorder();
		recorder.push(frame());
		recorder.push(paint(frame(), 10, 10, 30, 30, 200));
		const stored = JSON.parse(JSON.stringify(recorder.result()));
		expect(readScreenActivity(stored)).toEqual(recorder.result());
		expect(readScreenActivity(null)).toBeNull();
		expect(readScreenActivity({ version: 2, fps: 8, steps: [] })).toBeNull();
		expect(
			readScreenActivity({ version: 1, fps: 8, steps: [{ t: 1, share: 0.1, boxes: [{ x: 0 }] }] })
				?.steps,
		).toEqual([]);
	});

	it("cuts one clip's window out of a scan, on the clip's own clock", () => {
		const activity = {
			version: 1 as const,
			fps: 8,
			durationMs: 10_000,
			steps: [1000, 4000, 9000].map((t) => ({
				t,
				share: 0.01,
				boxes: [{ x: 0, y: 0, width: 0.1, height: 0.1, share: 0.01 }],
			})),
		};
		expect(activityWindow(activity, 3000, 8000, 3000).map((s) => s.t)).toEqual([1000]);
	});
});
