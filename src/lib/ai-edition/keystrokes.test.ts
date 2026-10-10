import { describe, expect, it } from "vitest";
import { keystrokeTextRegions } from "./keystrokeRegions";
import { formatKeystroke, keystrokesFromCursorSamples } from "./keystrokes";
import { type AxcutDocument, createEmptyDocument } from "./schema";

const key = (timeMs: number, combo?: string) => ({
	timeMs,
	cx: 0.5,
	cy: 0.5,
	input: combo ? { kind: "key", combo } : { kind: "key" },
});

describe("keystrokesFromCursorSamples", () => {
	it("keeps the chords, in order, and drops plain typing and malformed entries", () => {
		const out = keystrokesFromCursorSamples([
			key(5000, "Ctrl+V"),
			key(1000, "Ctrl+C"),
			key(1500),
			key(2000, "Shift+A"),
			{ timeMs: 3000, input: { kind: "key", combo: "Ctrl+<script>alert(1)</script>" } },
			{ timeMs: -1, input: { kind: "key", combo: "Ctrl+X" } },
			null,
			{ cx: 0 },
		]);
		expect(out).toEqual([
			{ sec: 1, combo: "Ctrl+C" },
			{ sec: 5, combo: "Ctrl+V" },
		]);
	});

	it("folds a chord repeated in quick succession into one plate with a count", () => {
		const out = keystrokesFromCursorSamples([
			key(1000, "Ctrl+Z"),
			key(1400, "Ctrl+Z"),
			key(1900, "Ctrl+Z"),
			key(4000, "Ctrl+Z"),
		]);
		expect(out).toEqual([
			{ sec: 1, combo: "Ctrl+Z", count: 3, lastSec: 1.9 },
			{ sec: 4, combo: "Ctrl+Z" },
		]);
	});

	it("joins repeats on when they were really pressed, not on a guess", () => {
		// Five quick presses inside 0.8 s, then one 0.9 s after the last of them: the
		// count used to assume 0.8 s between presses, and swallowed that sixth one too.
		const out = keystrokesFromCursorSamples([
			key(1000, "Ctrl+Z"),
			key(1200, "Ctrl+Z"),
			key(1400, "Ctrl+Z"),
			key(1600, "Ctrl+Z"),
			key(1800, "Ctrl+Z"),
			key(2700, "Ctrl+Z"),
		]);
		expect(out).toEqual([
			{ sec: 1, combo: "Ctrl+Z", count: 5, lastSec: 1.8 },
			{ sec: 2.7, combo: "Ctrl+Z" },
		]);
	});

	it("is empty for anything that is not a sample list", () => {
		expect(keystrokesFromCursorSamples(undefined)).toEqual([]);
		expect(keystrokesFromCursorSamples({ samples: [] })).toEqual([]);
	});
});

describe("formatKeystroke", () => {
	it("spaces the keys and counts repeats", () => {
		expect(formatKeystroke({ combo: "Win+Shift+S" })).toBe("Win + Shift + S");
		expect(formatKeystroke({ combo: "Ctrl+Z", count: 3 })).toBe("Ctrl + Z  ×3");
	});
});

describe("keystrokeTextRegions", () => {
	const documentWith = (
		keystrokes: Array<{ sec: number; combo: string; count?: number; lastSec?: number }>,
		clipSourceStartSec = 0,
	): AxcutDocument => {
		const doc = createEmptyDocument({ projectId: "p", title: "t" });
		return {
			...doc,
			assets: [
				{
					id: "asset_1",
					kind: "video",
					label: "take",
					originalPath: "C:/take.mp4",
					cameraTrack: null,
					keystrokes,
				},
			],
			timeline: {
				...doc.timeline,
				clips: [
					{
						id: "clip_1",
						assetId: "asset_1",
						sourceStartSec: clipSourceStartSec,
						sourceEndSec: clipSourceStartSec + 60,
						timelineStartSec: 0,
						timelineEndSec: 60,
						wordRefs: [],
						origin: "system",
						reason: "test",
					},
				],
			},
		} as AxcutDocument;
	};

	it("puts a plate where the timeline plays each chord, one at a time", () => {
		const regions = keystrokeTextRegions(
			documentWith([
				{ sec: 10, combo: "Ctrl+C" },
				{ sec: 11, combo: "Ctrl+V" },
			]),
		);
		expect(regions.map((r) => [r.startMs, r.endMs, r.content])).toEqual([
			[10_000, 11_000, "Ctrl + C"],
			[11_000, 12_600, "Ctrl + V"],
		]);
		expect(regions[0].space).toBe("frame");
		expect(regions[0].position.y + regions[0].size.height).toBeCloseTo(94);
	});

	it("follows the clip, and leaves out a chord the edit cut away", () => {
		const regions = keystrokeTextRegions(
			documentWith(
				[
					{ sec: 5, combo: "Ctrl+S" },
					{ sec: 130, combo: "Alt+Tab" },
				],
				100,
			),
		);
		expect(regions.map((r) => [r.startMs, r.content])).toEqual([[30_000, "Alt + Tab"]]);
	});

	it("stays up from the first press until a beat after the last one", () => {
		const regions = keystrokeTextRegions(
			documentWith([{ sec: 1, combo: "Ctrl+Z", count: 5, lastSec: 1.8 }]),
		);
		expect(regions).toHaveLength(1);
		expect(regions[0].startMs).toBeCloseTo(1000, 6);
		expect(regions[0].endMs).toBeCloseTo(3400, 6);
	});

	it("sits above the captions when they show", () => {
		const [region] = keystrokeTextRegions(documentWith([{ sec: 1, combo: "Ctrl+K" }]), {
			aboveTopPct: 80,
		});
		expect(region.position.y + region.size.height).toBeCloseTo(79);
	});
});
