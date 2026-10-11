import { describe, expect, it } from "vitest";
import type { AxcutCameraSegment, AxcutClip } from "../schema";
import {
	cameraPieceAt,
	cameraPieces,
	cameraTimelineEndMs,
	carveCameraSpan,
	deriveCameraModeRuns,
	findCameraPiece,
	MIN_CAMERA_PIECE_MS,
	mergeCameraPieceWithNext,
	moveCameraBoundary,
	readCameraFullscreenRegions,
	readCameraHiddenRegions,
	removeCameraPiece,
	setCameraModeOverSpan,
	setCameraPieceMode,
	splitCameraAt,
} from "./cameraSegments";

// Two clips of one take: source 0-10 s at 0-10 s on the ruler, then source 20-30 s at 10-20 s.
const clip = (id: string, sourceStartSec: number, timelineStartSec: number): AxcutClip => ({
	id,
	assetId: "a",
	sourceStartSec,
	sourceEndSec: sourceStartSec + 10,
	timelineStartSec,
	timelineEndSec: timelineStartSec + 10,
	wordRefs: [],
	origin: "user",
	reason: "",
});
const clips = [clip("c1", 0, 0), clip("c2", 20, 10)];
const END = 20_000;

/** A stored fragment on `c1` (ruler == source there). */
const onC1 = (
	id: string,
	startMs: number,
	endMs: number,
	mode: AxcutCameraSegment["mode"],
	segmentId = `seg_${id}`,
): AxcutCameraSegment => ({
	id,
	segmentId,
	startMs,
	endMs,
	clipId: "c1",
	sourceStartSec: startMs / 1000,
	sourceEndSec: endMs / 1000,
	mode,
	origin: "user",
});

const spans = (segments: AxcutCameraSegment[]) =>
	cameraPieces(segments, END).map((p) => [p.startMs, p.endMs, p.mode, p.implicit]);

describe("cameraPieces", () => {
	it("is one implicit picture-in-picture piece over a timeline nobody cut", () => {
		expect(spans([])).toEqual([[0, END, "pip", true]]);
		expect(cameraTimelineEndMs(clips)).toBe(END);
	});

	it("fills the gaps between stored pieces with implicit ones", () => {
		expect(spans([onC1("f", 2000, 5000, "fullscreen")])).toEqual([
			[0, 2000, "pip", true],
			[2000, 5000, "fullscreen", false],
			[5000, END, "pip", true],
		]);
	});

	it("keeps two touching pieces of the same mode apart, and joins one piece's fragments", () => {
		const twoPieces = [onC1("a", 0, 3000, "fullscreen"), onC1("b", 3000, 6000, "fullscreen")];
		expect(spans(twoPieces).slice(0, 2)).toEqual([
			[0, 3000, "fullscreen", false],
			[3000, 6000, "fullscreen", false],
		]);
		const across = setCameraModeOverSpan([], clips, 8000, 12_000, "hidden").segments;
		// One fragment per clip, one piece.
		expect(across.map((s) => s.clipId)).toEqual(["c1", "c2"]);
		expect(new Set(across.map((s) => s.segmentId)).size).toBe(1);
		expect(spans(across)[1]).toEqual([8000, 12_000, "hidden", false]);
	});

	it("finds a piece by key or by any of its fragments, and the piece under a moment", () => {
		const across = setCameraModeOverSpan([], clips, 8000, 12_000, "hidden").segments;
		const pieces = cameraPieces(across, END);
		expect(findCameraPiece(pieces, across[1].id)?.startMs).toBe(8000);
		expect(findCameraPiece(pieces, "implicit:0")?.endMs).toBe(8000);
		expect(cameraPieceAt(pieces, 8000)?.mode).toBe("hidden");
		expect(cameraPieceAt(pieces, END)?.startMs).toBe(12_000);
	});
});

describe("splitCameraAt", () => {
	it("stores an implicit piece as two picture-in-picture pieces", () => {
		const split = splitCameraAt([], clips, 4000);
		expect(split).not.toBeNull();
		expect(spans(split?.segments ?? [])).toEqual([
			[0, 4000, "pip", false],
			[4000, END, "pip", false],
		]);
		// The right half crosses the junction: two fragments, one piece.
		const right = (split?.segments ?? []).filter((s) => s.startMs >= 4000);
		expect(right.map((s) => s.clipId)).toEqual(["c1", "c2"]);
		expect(new Set(right.map((s) => s.segmentId)).size).toBe(1);
		expect(split?.rightKey).toBe(right[0].id);
	});

	it("cuts a stored piece in two of its mode, the left half keeping its id", () => {
		const split = splitCameraAt([onC1("f", 2000, 8000, "fullscreen")], clips, 5000);
		expect(split?.leftKey).toBe("f");
		expect(spans(split?.segments ?? []).slice(1, 3)).toEqual([
			[2000, 5000, "fullscreen", false],
			[5000, 8000, "fullscreen", false],
		]);
		const [left, right] = split?.segments ?? [];
		expect(left.segmentId).toBe("seg_f");
		expect(right.segmentId).not.toBe("seg_f");
	});

	it("refuses a cut too close to an edge, or on one", () => {
		const segments = [onC1("f", 2000, 8000, "fullscreen")];
		expect(splitCameraAt(segments, clips, 2000)).toBeNull();
		expect(splitCameraAt(segments, clips, 2000 + MIN_CAMERA_PIECE_MS - 1)).toBeNull();
		expect(splitCameraAt([], [], 1000)).toBeNull();
	});
});

describe("setCameraPieceMode", () => {
	it("changes a stored piece in place, every fragment of it", () => {
		const across = setCameraModeOverSpan([], clips, 8000, 12_000, "hidden").segments;
		const set = setCameraPieceMode(across, clips, across[0].id, "fullscreen");
		expect(set?.key).toBe(across[0].id);
		expect(set?.segments.map((s) => s.mode)).toEqual(["fullscreen", "fullscreen"]);
	});

	it("stores an implicit piece to give it a mode", () => {
		const set = setCameraPieceMode([], clips, "implicit:0", "hidden");
		expect(spans(set?.segments ?? [])).toEqual([[0, END, "hidden", false]]);
		expect(set?.key).toBe(set?.segments[0].id);
		expect(setCameraPieceMode([], clips, "nope", "hidden")).toBeNull();
	});
});

describe("carveCameraSpan / setCameraModeOverSpan", () => {
	it("lays a piece over others, keeping what sticks out on each side", () => {
		const placed = setCameraModeOverSpan(
			[onC1("p", 1000, 9000, "hidden")],
			clips,
			3000,
			5000,
			"fullscreen",
		);
		expect(spans(placed.segments).slice(1, 4)).toEqual([
			[1000, 3000, "hidden", false],
			[3000, 5000, "fullscreen", false],
			[5000, 9000, "hidden", false],
		]);
		const ids = placed.segments.map((s) => s.id);
		expect(ids[0]).toBe("p");
		expect(new Set(placed.segments.map((s) => s.segmentId)).size).toBe(3);
	});

	it("drops a leftover too short to aim at", () => {
		const carved = carveCameraSpan([onC1("p", 1000, 5000, "hidden")], clips, 1050, 5000);
		expect(carved).toEqual([]);
	});
});

describe("removeCameraPiece / mergeCameraPieceWithNext", () => {
	it("puts a piece back to the default", () => {
		const segments = [onC1("f", 2000, 5000, "fullscreen")];
		expect(removeCameraPiece(segments, clips, "f")).toEqual([]);
		expect(removeCameraPiece(segments, clips, "implicit:0")).toEqual(segments);
	});

	it("grows a stored piece over the next one, its mode winning", () => {
		const segments = [onC1("a", 0, 3000, "fullscreen"), onC1("b", 3000, 6000, "hidden")];
		const merged = mergeCameraPieceWithNext(segments, clips, "a");
		expect(merged?.key).toBe("a");
		expect(spans(merged?.segments ?? []).slice(0, 2)).toEqual([
			[0, 6000, "fullscreen", false],
			[6000, END, "pip", true],
		]);
		// Into the implicit piece after it, too.
		const intoGap = mergeCameraPieceWithNext(merged?.segments ?? [], clips, "a");
		expect(spans(intoGap?.segments ?? [])).toEqual([[0, END, "fullscreen", false]]);
		expect(mergeCameraPieceWithNext(intoGap?.segments ?? [], clips, "a")).toBeNull();
	});

	it("makes an implicit piece and the stored one after it implicit", () => {
		const merged = mergeCameraPieceWithNext(
			[onC1("f", 2000, 5000, "fullscreen")],
			clips,
			"implicit:0",
		);
		expect(merged?.segments).toEqual([]);
		expect(merged?.key).toBe("implicit:0");
	});
});

describe("moveCameraBoundary", () => {
	it("rolls the edge: one piece grows by what the other loses", () => {
		const segments = [onC1("a", 0, 3000, "fullscreen"), onC1("b", 3000, 6000, "hidden")];
		const rolled = moveCameraBoundary(segments, clips, "a", 4000);
		expect(spans(rolled ?? []).slice(0, 2)).toEqual([
			[0, 4000, "fullscreen", false],
			[4000, 6000, "hidden", false],
		]);
	});

	it("moves only the stored side against an implicit neighbour, and keeps both long enough", () => {
		const segments = [onC1("f", 2000, 5000, "fullscreen")];
		expect(spans(moveCameraBoundary(segments, clips, "f", 7000) ?? []).slice(1, 3)).toEqual([
			[2000, 7000, "fullscreen", false],
			[7000, END, "pip", true],
		]);
		// Clamped so the left piece keeps MIN_CAMERA_PIECE_MS.
		expect(spans(moveCameraBoundary(segments, clips, "f", 0) ?? [])[1]).toEqual([
			2000,
			2000 + MIN_CAMERA_PIECE_MS,
			"fullscreen",
			false,
		]);
		// The last piece has no next one.
		expect(moveCameraBoundary(segments, clips, "implicit:5000", 9000)).toBeNull();
	});
});

describe("deriveCameraModeRuns", () => {
	it("joins touching pieces of one mode on a clip, so the camera does not dip at the seam", () => {
		const segments = [
			onC1("a", 1000, 3000, "fullscreen"),
			onC1("b", 3000, 6000, "fullscreen"),
			onC1("c", 6000, 7000, "pip"),
			onC1("d", 8000, 9000, "fullscreen"),
		];
		expect(deriveCameraModeRuns(segments, "fullscreen")).toEqual([
			{ id: "a", startMs: 1000, endMs: 6000, clipId: "c1", sourceStartSec: 1, sourceEndSec: 6 },
			{ id: "d", startMs: 8000, endMs: 9000, clipId: "c1", sourceStartSec: 8, sourceEndSec: 9 },
		]);
		expect(readCameraFullscreenRegions({ cameraSegments: segments })).toHaveLength(2);
		expect(readCameraHiddenRegions({ cameraSegments: segments })).toEqual([]);
	});

	it("keeps the fragments on each side of a clip junction apart, as Full Camera always did", () => {
		const across = setCameraModeOverSpan([], clips, 8000, 12_000, "fullscreen").segments;
		expect(deriveCameraModeRuns(across, "fullscreen").map((r) => r.clipId)).toEqual(["c1", "c2"]);
	});

	it("reads nothing from a document without a track", () => {
		expect(readCameraFullscreenRegions(null)).toEqual([]);
		expect(readCameraFullscreenRegions({} as never)).toEqual([]);
	});
});
