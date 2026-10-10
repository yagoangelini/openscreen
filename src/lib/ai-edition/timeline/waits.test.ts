import { describe, expect, it } from "vitest";
import type { CursorTelemetryPoint } from "@/components/video-editor/types";
import { type AxcutDocument, createEmptyDocument } from "../schema";
import { findWaits, waitSpeedRegions } from "./waits";

/** 10 blocks per second; `loud` lists the [from, to) seconds with speech. */
function peaksFor(durationSec: number, loud: Array<[number, number]>): Float32Array {
	const blocks = durationSec * 10;
	const out = new Float32Array(blocks * 2);
	for (let i = 0; i < blocks; i++) {
		const t = i / 10;
		const amp = loud.some(([a, b]) => t >= a && t < b) ? 0.4 : 0.003;
		out[2 * i] = -amp;
		out[2 * i + 1] = amp;
	}
	return out;
}

const still = (fromSec: number, toSec: number): CursorTelemetryPoint[] =>
	Array.from({ length: Math.round((toSec - fromSec) * 2) + 1 }, (_, i) => ({
		timeMs: (fromSec + i / 2) * 1000,
		cx: 0.5,
		cy: 0.5,
	}));

describe("findWaits", () => {
	it("finds a quiet, still stretch and keeps half a second at each end", () => {
		const waits = findWaits({
			peaks: peaksFor(60, [
				[0, 10],
				[30, 60],
			]),
			durationSec: 60,
			telemetry: still(0, 60),
		});
		expect(waits).toHaveLength(1);
		expect(waits[0].startSec).toBeCloseTo(10.5, 1);
		expect(waits[0].endSec).toBeCloseTo(29.5, 1);
	});

	it("cuts a silence where the user clicks or types inside it", () => {
		const telemetry = [
			...still(0, 60),
			{ timeMs: 20_000, cx: 0.5, cy: 0.5, interactionType: "click" as const },
		];
		const waits = findWaits({
			peaks: peaksFor(60, [
				[0, 10],
				[30, 60],
			]),
			durationSec: 60,
			telemetry,
		});
		expect(waits.map((w) => [Math.round(w.startSec), Math.round(w.endSec)])).toEqual([
			[11, 20],
			[21, 30],
		]);
	});

	it("leaves a short pause alone, and asks for longer silence with no cursor to go by", () => {
		const peaks = peaksFor(40, [
			[0, 10],
			[13, 20],
			[27, 40],
		]);
		expect(findWaits({ peaks, durationSec: 40, telemetry: still(0, 40) })).toHaveLength(1);
		expect(findWaits({ peaks, durationSec: 40, telemetry: null })).toHaveLength(0);
	});

	it("says nothing without audio", () => {
		expect(findWaits({ peaks: null, durationSec: 30, telemetry: null })).toEqual([]);
	});
});

describe("waitSpeedRegions", () => {
	it("places 4x regions where the clip plays the waits, skipping speed already set", () => {
		const base = createEmptyDocument({ projectId: "p", title: "t" });
		const document = {
			...base,
			assets: [
				{ id: "a1", kind: "video", label: "t", originalPath: "C:/t.mp4", cameraTrack: null },
			],
			timeline: {
				...base.timeline,
				clips: [
					{
						id: "c1",
						assetId: "a1",
						sourceStartSec: 10,
						sourceEndSec: 70,
						timelineStartSec: 0,
						timelineEndSec: 60,
						wordRefs: [],
						origin: "system",
						reason: "t",
					},
				],
			},
			legacyEditor: { speedRegions: [{ id: "s0", startMs: 40_000, endMs: 45_000, speed: 2 }] },
		} as AxcutDocument;
		let n = 0;
		const regions = waitSpeedRegions(
			document,
			"a1",
			[
				{ startSec: 20, endSec: 30 },
				{ startSec: 52, endSec: 58 },
			],
			(prefix) => `${prefix}_${++n}`,
		);
		expect(regions.map((r) => [r.startMs, r.endMs, r.speed])).toEqual([[10_000, 20_000, 4]]);
	});
});
