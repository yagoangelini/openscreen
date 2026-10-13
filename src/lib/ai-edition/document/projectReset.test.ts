import { describe, expect, it } from "vitest";
import { type AxcutDocument, documentSchema } from "../schema";
import {
	cameraPieces,
	cameraTimelineEndMs,
	readCameraSegments,
	setCameraPieceLook,
	splitCameraAt,
} from "./cameraSegments";
import {
	applyProjectReset,
	resetAnnotationTrack,
	resetCameraTrack,
	resetProjectToImport,
	resetVideoTrack,
} from "./projectReset";

// A 30 s take recorded starting on the screen, switched to the face at 5 s and back at 8 s.
const LAYOUT = {
	initial: "screen" as const,
	switches: [
		{ atSec: 5, layout: "face" as const },
		{ atSec: 8, layout: "screen" as const },
	],
};

const annotation = (id: string, startMs: number, endMs: number, extra: object = {}) => ({
	id,
	startMs,
	endMs,
	clipId: "c1",
	sourceStartSec: startMs / 1000,
	sourceEndSec: endMs / 1000,
	type: "blur",
	content: "",
	position: { x: 10, y: 10 },
	size: { width: 20, height: 10 },
	style: {},
	zIndex: 1,
	...extra,
});

/** The project as the import leaves it: one whole clip, the face piece, one automatic blur. */
function imported(): AxcutDocument {
	const base = documentSchema.parse({
		schemaVersion: 9,
		project: {
			id: "proj_1",
			title: "Gravação",
			createdAt: "2026-10-13T00:00:00.000Z",
			updatedAt: "2026-10-13T00:00:00.000Z",
			primaryAssetId: "a",
		},
		assets: [
			{
				id: "a",
				kind: "video",
				label: "take.mp4",
				originalPath: "C:/takes/take.mp4",
				durationSec: 30,
				cameraLayout: LAYOUT,
			},
		],
		timeline: {
			clips: [
				{
					id: "c1",
					assetId: "a",
					sourceStartSec: 0,
					sourceEndSec: 30,
					timelineStartSec: 0,
					timelineEndSec: 30,
					wordRefs: [],
					origin: "system",
					reason: "Auto-imported recording",
				},
			],
		},
		annotations: [annotation("auto_1", 1000, 30000, { annotationSource: "auto-redact" })],
		legacyEditor: { cursorClickRing: true, webcamSizePreset: 25 },
	});
	return resetCameraTrack(base);
}

/** The same project after an editing session: a cut, a split, a speed change, a zoom, a drawn
 *  blur, a camera piece split and restyled, an imported audio track and a muted stretch. */
function edited(): AxcutDocument {
	const doc = imported();
	const clips = [
		{ ...doc.timeline.clips[0], sourceEndSec: 10, timelineEndSec: 10 },
		{
			...doc.timeline.clips[0],
			id: "c2",
			sourceStartSec: 15,
			sourceEndSec: 30,
			timelineStartSec: 10,
			timelineEndSec: 25,
		},
	];
	const split = splitCameraAt(readCameraSegments(doc), clips, 2000);
	if (!split) throw new Error("split failed");
	const styled = setCameraPieceLook(split.segments, clips, split.leftKey, { webcamSizePreset: 40 });
	if (!styled) throw new Error("look failed");
	return {
		...doc,
		timeline: {
			...doc.timeline,
			clips,
			trimRanges: [
				{
					id: "t1",
					assetId: "a",
					clipId: "c2",
					startSec: 20,
					endSec: 22,
					reason: "",
					origin: "user",
				},
			],
			muteRanges: [{ startSec: 3, endSec: 4, reason: "" }],
		},
		cameraSegments: styled.segments,
		zoomRanges: [
			{
				id: "z1",
				startMs: 16000,
				endMs: 18000,
				clipId: "c2",
				sourceStartSec: 21,
				sourceEndSec: 23,
				depth: 2,
				focus: { cx: 0.5, cy: 0.5 },
			},
		],
		annotations: [
			...doc.annotations,
			annotation("user_1", 2000, 3000) as unknown as AxcutDocument["annotations"][number],
		],
		audioTracks: [
			{
				id: "music",
				assetId: "song",
				startMs: 0,
				endMs: 5000,
				offsetMs: 0,
			} as unknown as AxcutDocument["audioTracks"][number],
		],
		legacyEditor: {
			...doc.legacyEditor,
			speedRegions: [{ id: "s1", startMs: 1000, endMs: 2000, speed: 2 }],
		},
	};
}

/** What the camera track shows, ids aside: each piece's span, mode and look. */
const shape = (doc: AxcutDocument) =>
	cameraPieces(readCameraSegments(doc), cameraTimelineEndMs(doc.timeline.clips)).map((p) => ({
		startMs: p.startMs,
		endMs: p.endMs,
		mode: p.mode,
		overrides: p.overrides,
	}));

describe("resetCameraTrack", () => {
	it("rebuilds the pieces the take's layout log makes, with no look of their own", () => {
		const doc = edited();
		const reset = resetCameraTrack(doc);
		expect(readCameraSegments(reset).some((s) => s.overrides)).toBe(false);
		// The face span (source 5-8 s) on the edited timeline: it plays 5-8 s on the ruler.
		expect(shape(reset).filter((p) => p.mode === "fullscreen")).toEqual([
			{ startMs: 5000, endMs: 8000, mode: "fullscreen", overrides: undefined },
		]);
	});

	it("is the import's own result on an unedited take", () => {
		const doc = imported();
		expect(shape(resetCameraTrack(doc))).toEqual(shape(doc));
	});

	it("leaves a take without a layout log on the default picture-in-picture", () => {
		const doc = edited();
		const noLog = { ...doc, assets: doc.assets.map(({ cameraLayout: _l, ...a }) => a) };
		expect(readCameraSegments(resetCameraTrack(noLog))).toEqual([]);
	});
});

describe("resetVideoTrack", () => {
	it("puts the whole recording back as one clip, without cuts or speed", () => {
		const reset = resetVideoTrack(edited());
		expect(reset.timeline.clips).toHaveLength(1);
		expect(reset.timeline.clips[0]).toMatchObject({
			id: "c1",
			assetId: "a",
			sourceStartSec: 0,
			sourceEndSec: 30,
			timelineStartSec: 0,
			timelineEndSec: 30,
		});
		expect(reset.timeline.trimRanges).toEqual([]);
		expect((reset.legacyEditor as { speedRegions: unknown[] }).speedRegions).toEqual([]);
	});

	it("ends the take's clip at the press on Stop, as the import does, not at the file's end", () => {
		// The take recorded 30 s, but Stop was pressed at 29.85 s: the import plays 0-29.85.
		const doc = edited();
		const pressed: AxcutDocument = {
			...doc,
			assets: doc.assets.map((asset) => ({ ...asset, recordedEndSec: 29.85 })),
		};
		const reset = resetVideoTrack(pressed);
		expect(reset.timeline.clips).toHaveLength(1);
		expect(reset.timeline.clips[0]).toMatchObject({
			sourceStartSec: 0,
			sourceEndSec: 29.85,
			timelineEndSec: 29.85,
		});
		expect(resetProjectToImport(pressed).timeline.clips[0].sourceEndSec).toBe(29.85);
	});

	it("keeps the regions on the same footage, not on the same ruler time", () => {
		const reset = resetVideoTrack(edited());
		// The zoom was on source 21-23 s of the second clip: on the full clip that is 21-23 s.
		expect(reset.zoomRanges).toEqual([
			expect.objectContaining({ id: "z1", clipId: "c1", startMs: 21000, endMs: 23000 }),
		]);
		// And so is the camera: the face piece is back on source 5-8 s.
		expect(shape(reset).find((p) => p.mode === "fullscreen")).toMatchObject({
			startMs: 5000,
			endMs: 8000,
		});
	});
});

describe("resetAnnotationTrack", () => {
	it("keeps only the automatic privacy blurs", () => {
		const reset = resetAnnotationTrack(edited());
		expect(reset.annotations.map((a) => a.id)).toEqual(["auto_1"]);
	});
});

describe("resetProjectToImport", () => {
	it("equals the just-imported project, transcript and look kept, zooms left to the planner", () => {
		const before = imported();
		const reset = resetProjectToImport(edited());
		expect(reset.timeline.clips).toEqual(before.timeline.clips);
		expect(reset.timeline.trimRanges).toEqual([]);
		expect(reset.timeline.muteRanges).toEqual([]);
		expect(reset.audioTracks).toEqual([]);
		expect(reset.zoomRanges).toEqual([]);
		expect(reset.annotations).toEqual(before.annotations);
		expect(shape(reset)).toEqual(shape(before));
		// The look is the project's, as a new import would inherit it.
		expect(reset.legacyEditor).toMatchObject({ cursorClickRing: true, webcamSizePreset: 25 });
		expect(reset.transcript).toEqual(before.transcript);
	});

	it("is what applyProjectReset('all') returns", () => {
		const doc = edited();
		expect(shape(applyProjectReset(doc, "all"))).toEqual(shape(resetProjectToImport(doc)));
	});
});
