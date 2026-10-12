import { describe, expect, it, vi } from "vitest";
import type { CursorTelemetryPoint } from "@/components/video-editor/types";
import { type AxcutDocument, createEmptyDocument } from "../schema";
import {
	appendAutoZoomSuggestions,
	autoZoomsBehindTranscript,
	collectAutoZoomSuggestionsForDocument,
	collectAutoZoomSuggestionsForLatestDocument,
	transcriptSignature,
	withoutAutoZooms,
	withPlannedTranscript,
} from "./apply-auto-zooms";

// A click at `atMs`, in a take whose pointer moves on until 9.5 s: the click is not its last.
function clickAt(atMs: number, cx: number, cy: number): CursorTelemetryPoint[] {
	return [
		{ timeMs: atMs - 300, cx, cy },
		{ timeMs: atMs, cx, cy, interactionType: "click" },
		{ timeMs: atMs + 300, cx, cy, interactionType: "mouseup" },
		{ timeMs: 9500, cx: 0.5, cy: 0.5 },
	];
}

function documentWithClip(durationSec = 10): AxcutDocument {
	const doc = createEmptyDocument({ projectId: "p1", title: "Recording" });
	return {
		...doc,
		assets: [
			{
				id: "asset_1",
				kind: "video",
				label: "rec.mp4",
				originalPath: "C:\\recordings\\rec.mp4",
				cameraTrack: null,
				durationSec,
			},
		],
		project: { ...doc.project, primaryAssetId: "asset_1" },
		timeline: {
			...doc.timeline,
			clips: [
				{
					id: "clip_1",
					assetId: "asset_1",
					sourceStartSec: 0,
					sourceEndSec: durationSec,
					timelineStartSec: 0,
					timelineEndSec: durationSec,
					wordRefs: [],
					origin: "system",
					reason: "",
				},
			],
		},
	};
}

describe("collectAutoZoomSuggestionsForDocument", () => {
	it("builds suggestions from the asset's cursor sidecar", async () => {
		const document = documentWithClip();
		const suggestions = await collectAutoZoomSuggestionsForDocument(document, async () =>
			clickAt(4000, 0.4, 0.6),
		);
		expect(suggestions).toEqual([
			{ span: { start: 3600, end: 6100 }, focus: { cx: 0.4, cy: 0.6 }, depth: 2 },
		]);
	});

	it("asks for telemetry on the asset path, not a file URL", async () => {
		const document = documentWithClip();
		const paths: string[] = [];
		await collectAutoZoomSuggestionsForDocument(document, async (videoPath) => {
			paths.push(videoPath);
			return [];
		});
		expect(paths).toEqual(["C:\\recordings\\rec.mp4"]);
	});

	it("returns nothing without a clip window", async () => {
		const document = createEmptyDocument({ projectId: "p1", title: "Empty" });
		const suggestions = await collectAutoZoomSuggestionsForDocument(document, async () =>
			clickAt(4000, 0.5, 0.5),
		);
		expect(suggestions).toEqual([]);
	});

	it("plans every take on the timeline in one pass, so their zooms keep clear of each other", async () => {
		// Two takes back to back: each click's zoom is fine alone, but the pair would zoom out
		// at the cut and straight back in. Planned per take, both would stay.
		const first = documentWithClip();
		const document: AxcutDocument = {
			...first,
			assets: [
				...first.assets,
				{ ...first.assets[0], id: "asset_2", originalPath: "C:\\recordings\\second.mp4" },
			],
			timeline: {
				...first.timeline,
				clips: [
					...first.timeline.clips,
					{
						...first.timeline.clips[0],
						id: "clip_2",
						assetId: "asset_2",
						timelineStartSec: 10,
						timelineEndSec: 20,
					},
				],
			},
		};
		const suggestions = await collectAutoZoomSuggestionsForDocument(document, async (videoPath) =>
			videoPath.endsWith("second.mp4") ? clickAt(1000, 0.5, 0.5) : clickAt(7000, 0.5, 0.5),
		);
		expect(suggestions.map((s) => s.span)).toEqual([{ start: 6300, end: 9000 }]);
	});

	it("keeps clear of the zooms already on the timeline", async () => {
		const document: AxcutDocument = {
			...documentWithClip(),
			zoomRanges: [{ id: "z1", startMs: 3000, endMs: 5000, depth: 3, focus: { cx: 0.5, cy: 0.5 } }],
		};
		const suggestions = await collectAutoZoomSuggestionsForDocument(document, async () =>
			clickAt(6500, 0.4, 0.6),
		);
		expect(suggestions).toEqual([]);
	});

	it("plans no zoom where the camera fills the frame ('Rosto'): there is no screen to zoom into", async () => {
		const fullCamera = (startMs: number, endMs: number) => ({
			id: `cam_${startMs}`,
			segmentId: `seg_${startMs}`,
			startMs,
			endMs,
			clipId: "clip_1",
			sourceStartSec: startMs / 1000,
			sourceEndSec: endMs / 1000,
			mode: "fullscreen" as const,
			origin: "system" as const,
		});
		const telemetry = async () => clickAt(4000, 0.4, 0.6);
		const inside = { ...documentWithClip(), cameraSegments: [fullCamera(2000, 7000)] };
		expect(await collectAutoZoomSuggestionsForDocument(inside, telemetry)).toEqual([]);
		// Just after one, the screen first comes back wide.
		const justBefore = { ...documentWithClip(), cameraSegments: [fullCamera(0, 3000)] };
		expect(await collectAutoZoomSuggestionsForDocument(justBefore, telemetry)).toEqual([]);
		// Well clear of it, the zoom stays.
		const clear = { ...documentWithClip(20), cameraSegments: [fullCamera(14000, 20000)] };
		expect(await collectAutoZoomSuggestionsForDocument(clear, telemetry)).toHaveLength(1);
	});
});

describe("appendAutoZoomSuggestions", () => {
	it("leaves the document unchanged when there is nothing to add", () => {
		const document = documentWithClip();
		expect(appendAutoZoomSuggestions(document, [])).toBe(document);
	});

	it("anchors each suggestion onto the clip", () => {
		const document = documentWithClip();
		const next = appendAutoZoomSuggestions(
			document,
			[{ span: { start: 3000, end: 5000 }, focus: { cx: 0.4, cy: 0.6 }, depth: 2 }],
			(prefix) => `${prefix}_fixed`,
		);
		expect(next).not.toBe(document);
		expect(next.zoomRanges).toHaveLength(1);
		expect(next.zoomRanges[0]).toMatchObject({
			startMs: 3000,
			endMs: 5000,
			depth: 2,
			source: "auto",
			clipId: "clip_1",
		});
		expect(next.zoomRanges[0]).not.toHaveProperty("focusMode");
	});

	it("keeps an exact scale the depth table does not have", () => {
		const next = appendAutoZoomSuggestions(documentWithClip(), [
			{ span: { start: 3000, end: 5000 }, focus: { cx: 0.4, cy: 0.6 }, depth: 1, customScale: 1.3 },
		]);
		expect(next.zoomRanges[0]).toMatchObject({ depth: 1, customScale: 1.3 });
	});
});

describe("withoutAutoZooms", () => {
	it("drops the automatic zooms and keeps the ones drawn by hand", () => {
		const document: AxcutDocument = {
			...documentWithClip(),
			zoomRanges: [
				{ id: "a", startMs: 0, endMs: 1000, depth: 2, focus: { cx: 0.5, cy: 0.5 }, source: "auto" },
				{ id: "h", startMs: 2000, endMs: 3000, depth: 2, focus: { cx: 0.5, cy: 0.5 } },
			],
		};
		expect(withoutAutoZooms(document).zoomRanges.map((z) => z.id)).toEqual(["h"]);
		const handOnly = withoutAutoZooms(document);
		expect(withoutAutoZooms(handOnly)).toBe(handOnly);
	});
});

describe("collectAutoZoomSuggestionsForLatestDocument", () => {
	const telemetry: CursorTelemetryPoint[] = [0, 600, 1200, 1800].map((timeMs) => ({
		timeMs,
		cx: 0.5,
		cy: 0.5,
	}));

	it("collects once when the clips stand still", async () => {
		const doc = documentWithClip();
		const getTelemetry = vi.fn(async () => telemetry);

		const out = await collectAutoZoomSuggestionsForLatestDocument(() => doc, getTelemetry);

		expect(out?.document).toBe(doc);
		expect(getTelemetry).toHaveBeenCalledTimes(1);
	});

	// THE case: the telemetry read takes seconds, and the suggestions carry timeline
	// spans that `appendAutoZoomSuggestions` will anchor against whatever the store
	// holds at write time. A trim landing in between makes the first collection
	// describe a timeline that no longer exists.
	it("collects again when the clips moved during the read", async () => {
		const before = documentWithClip();
		const after: AxcutDocument = {
			...before,
			timeline: {
				...before.timeline,
				clips: before.timeline.clips.map((clip) => ({ ...clip, sourceEndSec: 4 })),
			},
		};
		let current = before;
		const getTelemetry = vi.fn(async () => {
			current = after;
			return telemetry;
		});

		const out = await collectAutoZoomSuggestionsForLatestDocument(() => current, getTelemetry);

		expect(out?.document).toBe(after);
		expect(getTelemetry.mock.calls.length).toBeGreaterThan(1);
	});

	it("gives up when the project is gone", async () => {
		const getTelemetry = vi.fn(async () => telemetry);
		expect(await collectAutoZoomSuggestionsForLatestDocument(() => null, getTelemetry)).toBeNull();
		expect(getTelemetry).not.toHaveBeenCalled();
	});
});

describe("the transcript the automatic zooms were planned with", () => {
	const withWords = (doc: AxcutDocument, texts: string[]): AxcutDocument => ({
		...doc,
		transcripts: [
			{
				assetId: "asset_1",
				language: "pt",
				segments: [],
				words: texts.map((text, i) => ({
					id: `w${i}`,
					segmentId: `s${i}`,
					startSec: i,
					endSec: i + 0.5,
					text,
				})),
			},
		] as AxcutDocument["transcripts"],
	});

	it("has nothing to follow without a transcript", () => {
		const doc = documentWithClip();
		expect(transcriptSignature(doc)).toBe("");
		expect(autoZoomsBehindTranscript(doc)).toBe(false);
	});

	it("is behind once a transcript arrives, and caught up once planned with it", () => {
		const doc = withWords(documentWithClip(), ["clica", "aqui"]);
		expect(autoZoomsBehindTranscript(doc)).toBe(true);
		const planned = withPlannedTranscript(doc, transcriptSignature(doc));
		expect(autoZoomsBehindTranscript(planned)).toBe(false);
	});

	it("is behind again when a word is corrected", () => {
		const doc = withWords(documentWithClip(), ["voar", "pra", "baixo"]);
		const planned = withPlannedTranscript(doc, transcriptSignature(doc));
		const corrected = withWords(planned, ["rolar", "pra", "baixo"]);
		expect(autoZoomsBehindTranscript(corrected)).toBe(true);
	});
});

describe("auto-zoom context beyond the pointer", () => {
	it("reads each recording's screen activity from its own path", async () => {
		const document = documentWithClip();
		const paths: string[] = [];
		await collectAutoZoomSuggestionsForDocument(
			document,
			async () => clickAt(4000, 0.4, 0.6),
			undefined,
			async (videoPath) => {
				paths.push(videoPath);
				return null;
			},
		);
		expect(paths).toEqual(["C:\\recordings\\rec.mp4"]);
	});

	it("plans the same without the activity when its scan fails", async () => {
		const document = documentWithClip();
		const failing = await collectAutoZoomSuggestionsForDocument(
			document,
			async () => clickAt(4000, 0.4, 0.6),
			undefined,
			async () => {
				throw new Error("no ffmpeg");
			},
		);
		const without = await collectAutoZoomSuggestionsForDocument(document, async () =>
			clickAt(4000, 0.4, 0.6),
		);
		expect(failing).toEqual(without);
	});

	it("keeps clear of the take's camera-only span even when its pieces never reached the document", async () => {
		const base = documentWithClip();
		const document: AxcutDocument = {
			...base,
			assets: base.assets.map((asset) => ({
				...asset,
				cameraLayout: {
					initial: "screen" as const,
					switches: [
						{ atSec: 3, layout: "face" as const },
						{ atSec: 8, layout: "screen" as const },
					],
				},
			})),
		};
		expect(document.cameraSegments ?? []).toEqual([]);
		const suggestions = await collectAutoZoomSuggestionsForDocument(document, async () =>
			clickAt(5000, 0.4, 0.6),
		);
		expect(suggestions).toEqual([]);
	});

	it("writes a shot the planner made to follow the pointer as a following zoom", () => {
		const next = appendAutoZoomSuggestions(
			documentWithClip(),
			[
				{ span: { start: 1000, end: 5000 }, focus: { cx: 0.3, cy: 0.3 }, depth: 1, follow: true },
				{ span: { start: 7000, end: 9000 }, focus: { cx: 0.6, cy: 0.6 }, depth: 2 },
			],
			(prefix) => `${prefix}_x`,
		);
		expect(next.zoomRanges.map((zoom) => zoom.focusMode)).toEqual(["auto", undefined]);
		expect(next.zoomRanges.every((zoom) => zoom.source === "auto")).toBe(true);
	});
});
