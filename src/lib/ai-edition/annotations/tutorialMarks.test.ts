import { describe, expect, it } from "vitest";
import { pointerToFramePct, sampleAt } from "./pointerPlacement";
import {
	HIGHLIGHT_DEFAULTS,
	highlightShape,
	nextStepNumber,
	stepBoxAround,
	stepNumberColor,
	tutorialSceneEntries,
} from "./tutorialMarks";

const base = {
	id: "ann-1",
	startSec: 1,
	endSec: 3,
	clipIndex: 0,
	x: 0.4,
	y: 0.4,
	w: (0.064 * 9) / 16,
	h: 0.064 * (1080 / 1080),
	zIndex: 2,
};

describe("tutorial marks", () => {
	it("numbers steps in creation order, after the highest one there", () => {
		expect(nextStepNumber([])).toBe(1);
		expect(
			nextStepNumber([
				{ type: "step", stepData: { number: 4, color: "#000000", label: "" } },
				{ type: "text" },
				{ type: "step", stepData: { number: 2, color: "#000000", label: "" } },
			]),
		).toBe(5);
	});

	it("keeps a step badge square in pixels and inside the frame", () => {
		const box = stepBoxAround({ x: 50, y: 50 }, 108, 16 / 9);
		expect(box.size.height).toBeCloseTo(10);
		// 10 % of 1080 px = 108 px; 108 px of 1920 = 5.625 %.
		expect(box.size.width).toBeCloseTo(5.625);
		expect(box.position.x + box.size.width / 2).toBeCloseTo(50);
		const corner = stepBoxAround({ x: 100, y: 0 }, 108, 16 / 9);
		expect(corner.position.x + corner.size.width).toBeLessThanOrEqual(100);
		expect(corner.position.y).toBe(0);
	});

	it("picks dark digits on a light badge", () => {
		expect(stepNumberColor("#2563EB")).toBe("#ffffff");
		expect(stepNumberColor("#FACC15")).toBe("#111827");
		expect(stepNumberColor("not-a-colour")).toBe("#ffffff");
	});

	it("draws a highlight as the whole frame dimmed around its box, fading", () => {
		const shape = highlightShape({ ...HIGHLIGHT_DEFAULTS, dim: 0.7, borderWidth: 0 });
		expect(shape).toEqual({
			fill: "rgba(0, 0, 0, 0.7)",
			radiusRel: 16 / 1080,
			featherRel: 12 / 1080,
			borderRel: 0,
			invert: true,
			animation: "fade",
		});
		expect(highlightShape({ ...HIGHLIGHT_DEFAULTS, borderWidth: 3 }).borderColor).toBe("#34B27B");
		const [entry] = tutorialSceneEntries(
			{ type: "highlight", highlightData: HIGHLIGHT_DEFAULTS },
			base,
			16 / 9,
		);
		expect(entry).toMatchObject({ id: "ann-1", kind: "shape", space: "frame", x: 0.4, zIndex: 2 });
	});

	it("draws a step as a popping disc, its number over it, and its label beside it", () => {
		const entries = tutorialSceneEntries(
			{ type: "step", stepData: { number: 3, color: "#2563EB", label: "Abra o menu" } },
			base,
			16 / 9,
		);
		expect(entries.map((e) => [e.id, e.kind])).toEqual([
			["ann-1", "shape"],
			["ann-1:number", "text"],
			["ann-1:label", "text"],
		]);
		const [disc, number, label] = entries;
		expect(disc.shape).toMatchObject({ fill: "#2563EB", invert: false, animation: "pop" });
		expect(disc.shape?.borderColor).toBe("#ffffff");
		expect(number.text).toMatchObject({ content: "3", textAlign: "center", animation: "pop" });
		expect(number.text?.fontSizeRel).toBeCloseTo(0.032);
		expect(number).toMatchObject({ x: base.x, y: base.y, w: base.w, h: base.h });
		// The label starts right of the badge, same height, left aligned on a plate.
		expect(label.x).toBeGreaterThan(base.x + base.w);
		expect(label.text).toMatchObject({ content: "Abra o menu", textAlign: "left" });
		expect(label.text?.backgroundColor).not.toBe("transparent");
	});

	it("moves the label to the left of a badge at the right edge", () => {
		const right = { ...base, x: 0.96 };
		const label = tutorialSceneEntries(
			{ type: "step", stepData: { number: 1, color: "#2563EB", label: "Salvar" } },
			right,
			16 / 9,
		)[2];
		expect(label.x + label.w).toBeLessThan(right.x);
		expect(label.text?.textAlign).toBe("right");
	});

	it("leaves the label out when it is empty", () => {
		const entries = tutorialSceneEntries(
			{ type: "step", stepData: { number: 1, color: "#2563EB", label: "  " } },
			base,
			16 / 9,
		);
		expect(entries).toHaveLength(2);
	});
});

describe("pointer placement", () => {
	it("maps a recorded pointer through the crop into the footage rect of the frame", () => {
		const footage = { rect: { x: 0.1, y: 0.1, width: 0.8, height: 0.8 }, crop: null };
		const p = pointerToFramePct({ cx: 0.5, cy: 0.25 }, footage);
		expect(p?.x).toBeCloseTo(50);
		expect(p?.y).toBeCloseTo(30);
		const cropped = { ...footage, crop: { x: 0.5, y: 0, width: 0.5, height: 1 } };
		const q = pointerToFramePct({ cx: 0.75, cy: 0.5 }, cropped);
		expect(q?.x).toBeCloseTo(50);
		expect(q?.y).toBeCloseTo(50);
		expect(pointerToFramePct({ cx: 0.25, cy: 0.5 }, cropped)).toBeNull();
	});

	it("reads the sample in effect at a time", () => {
		const samples = [
			{ timeMs: 0, cx: 0.1, cy: 0.1 },
			{ timeMs: 100, cx: 0.2, cy: 0.2 },
			{ timeMs: 200, cx: 0.3, cy: 0.3 },
		];
		expect(sampleAt(samples, 150)?.cx).toBe(0.2);
		expect(sampleAt(samples, 500)?.cx).toBe(0.3);
		expect(sampleAt([], 10)).toBeNull();
	});
});
