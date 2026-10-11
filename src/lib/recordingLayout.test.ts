import { describe, expect, it } from "vitest";
import {
	parseRecordingLayout,
	recordingFaceSpansSec,
	recordingLayoutHasFace,
	recordingLayoutOnAsset,
} from "./recordingLayout";

describe("parseRecordingLayout", () => {
	it("reads the file the main process writes", () => {
		expect(
			parseRecordingLayout({
				version: 1,
				initial: "face",
				switches: [{ atMs: 5230, layout: "screen" }],
			}),
		).toEqual({ version: 1, initial: "face", switches: [{ atMs: 5230, layout: "screen" }] });
	});

	it("sorts, clamps, and drops what is unreadable or changes nothing", () => {
		expect(
			parseRecordingLayout({
				initial: "screen",
				switches: [
					{ atMs: 9000, layout: "screen" },
					{ atMs: 4000.4, layout: "face" },
					{ atMs: 6000, layout: "tilted" },
					{ atMs: "7000", layout: "face" },
					{ atMs: 8000, layout: "face" },
					null,
					{ atMs: -5, layout: "screen" },
				],
			}),
		).toEqual({
			version: 1,
			initial: "screen",
			switches: [
				{ atMs: 4000, layout: "face" },
				{ atMs: 9000, layout: "screen" },
			],
		});
	});

	it("keeps the last of several switches at one time", () => {
		expect(
			parseRecordingLayout({
				initial: "screen",
				switches: [
					{ atMs: 3000, layout: "face" },
					{ atMs: 3000, layout: "screen" },
					{ atMs: 3000, layout: "face" },
				],
			})?.switches,
		).toEqual([{ atMs: 3000, layout: "face" }]);
	});

	it("refuses a file with no usable start", () => {
		expect(parseRecordingLayout(null)).toBeNull();
		expect(parseRecordingLayout([])).toBeNull();
		expect(parseRecordingLayout({ initial: "both", switches: [] })).toBeNull();
	});
});

describe("recordingFaceSpansSec", () => {
	const onAsset = (raw: unknown) => {
		const file = parseRecordingLayout(raw);
		if (!file) throw new Error("unparsable");
		return recordingLayoutOnAsset(file);
	};

	it("is the face intro, then the screen", () => {
		const layout = onAsset({ initial: "face", switches: [{ atMs: 5230, layout: "screen" }] });
		expect(recordingLayoutHasFace(layout)).toBe(true);
		expect(recordingFaceSpansSec(layout, 20)).toEqual([{ startSec: 0, endSec: 5.23 }]);
	});

	it("runs a face span still open at the stop to the end of the take", () => {
		const layout = onAsset({
			initial: "screen",
			switches: [
				{ atMs: 2000, layout: "face" },
				{ atMs: 4000, layout: "screen" },
				{ atMs: 8000, layout: "face" },
			],
		});
		expect(recordingFaceSpansSec(layout, 10)).toEqual([
			{ startSec: 2, endSec: 4 },
			{ startSec: 8, endSec: 10 },
		]);
	});

	it("clamps to the take's length and leaves out what is past it", () => {
		const layout = onAsset({
			initial: "screen",
			switches: [
				{ atMs: 9000, layout: "face" },
				{ atMs: 15000, layout: "screen" },
				{ atMs: 16000, layout: "face" },
			],
		});
		expect(recordingFaceSpansSec(layout, 12)).toEqual([{ startSec: 9, endSec: 12 }]);
	});

	it("has no span for a take that stayed on the screen", () => {
		const layout = onAsset({ initial: "screen", switches: [] });
		expect(recordingLayoutHasFace(layout)).toBe(false);
		expect(recordingFaceSpansSec(layout, 10)).toEqual([]);
	});
});
