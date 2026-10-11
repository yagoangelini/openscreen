// The camera track: pure edits of `document.cameraSegments` (schema v9).
//
// The camera never gets a clock of its own. Its file plays wherever the screen clip under it
// plays (`assetCameraSource`, timeline/camera.ts), so cutting, trimming or moving a clip
// already cuts and moves the camera with it. What the track changes is how the camera is
// SHOWN over a stretch of the ruler: as the picture-in-picture, filling the frame, or not at
// all. Each stretch is a PIECE, and the user edits each piece on its own.
//
// Stored sparse, shown continuous. Only the pieces the user made are stored; the ruler time
// no stored piece covers is an IMPLICIT picture-in-picture piece, drawn in the gaps
// (`cameraPieces`). Splitting or editing an implicit piece stores it.
//
// A stored piece is one clip-anchored fragment per clip it covers (like a zoom), and the
// fragments of one piece share `segmentId`. Pieces are told apart by the merge rule's
// identity (timelineMap), which includes `segmentId` and `mode`: two side-by-side pieces
// with the same mode stay two pills. The scene does the opposite (`deriveCameraModeRuns`):
// it joins touching pieces of one mode, or the camera would leave full screen and come
// straight back at every seam.
//
// Every edit works on RAW ruler milliseconds and re-anchors the pieces it touches with
// `anchorRegionsWithDerivedMs`, the same door every other region kind goes through.
//
// Relative imports only: the main process (agent tools) imports this module.

import type { AxcutCameraMode, AxcutCameraSegment, AxcutClip, AxcutDocument } from "../schema";
import { anchorRegionsWithDerivedMs, coalesceRegionsForRuler } from "../timeline/timelineMap";
import { createId } from "./ids";

export type CameraMode = AxcutCameraMode;

/** Every mode a piece can take, in the order the inspector offers them. */
export const CAMERA_MODES: readonly CameraMode[] = ["pip", "fullscreen", "hidden"];

/** The shortest piece a split or a boundary drag may leave, in ms. Shorter than the
 *  full-camera ease (`TRANSITION_WINDOW_MS`) on purpose: the ease shortens itself to fit. */
export const MIN_CAMERA_PIECE_MS = 100;

/** A piece of the camera track as the ruler draws it. */
export interface CameraPiece {
	/** The piece's first fragment id, or `implicit:<startMs>` for a gap nothing stores. */
	key: string;
	/** The stored fragments under the piece; empty for an implicit piece. */
	ids: string[];
	segmentId?: string;
	/** RAW ruler span. */
	startMs: number;
	endMs: number;
	mode: CameraMode;
	implicit: boolean;
}

/** A span of one camera mode, as the scene and the preview read it: a Full Camera region
 *  in the shape `cameraFullscreenRegions` always had, anchor included. */
export interface CameraModeRun {
	id: string;
	startMs: number;
	endMs: number;
	clipId?: string;
	sourceStartSec?: number;
	sourceEndSec?: number;
}

type Payload = Pick<AxcutCameraSegment, "mode" | "origin"> & { segmentId?: string };

const IMPLICIT_PREFIX = "implicit:";

export function isImplicitCameraKey(key: string): boolean {
	return key.startsWith(IMPLICIT_PREFIX);
}

/** The pieces of a document, tolerant of a document built before the field existed. */
export function readCameraSegments(
	document: Pick<AxcutDocument, "cameraSegments"> | null | undefined,
): AxcutCameraSegment[] {
	return Array.isArray(document?.cameraSegments) ? document.cameraSegments : [];
}

/** Where the ruler ends: the last clip's end, in ms. */
export function cameraTimelineEndMs(clips: readonly AxcutClip[]): number {
	return Math.round(clips.reduce((max, clip) => Math.max(max, clip.timelineEndSec), 0) * 1000);
}

/**
 * The track as the ruler draws it: every stored piece, with an implicit picture-in-picture
 * piece in each gap between 0 and `endMs`. Sorted by start.
 */
export function cameraPieces(
	segments: readonly AxcutCameraSegment[],
	endMs: number,
): CameraPiece[] {
	const stored: CameraPiece[] = coalesceRegionsForRuler([...segments])
		.map((pill) => ({
			key: pill.ids[0],
			ids: pill.ids,
			...(pill.member.segmentId ? { segmentId: pill.member.segmentId } : {}),
			startMs: Math.round(pill.start * 1000),
			endMs: Math.round(pill.end * 1000),
			mode: pill.member.mode,
			implicit: false,
		}))
		.sort((a, b) => a.startMs - b.startMs);
	const out: CameraPiece[] = [];
	let cursor = 0;
	const gap = (startMs: number, gapEndMs: number) => {
		if (gapEndMs - startMs < 1) return;
		out.push({
			key: `${IMPLICIT_PREFIX}${startMs}`,
			ids: [],
			startMs,
			endMs: gapEndMs,
			mode: "pip",
			implicit: true,
		});
	};
	for (const piece of stored) {
		gap(cursor, piece.startMs);
		out.push(piece);
		cursor = Math.max(cursor, piece.endMs);
	}
	gap(cursor, endMs);
	return out;
}

/** The piece a key or a stored fragment id names. */
export function findCameraPiece(
	pieces: readonly CameraPiece[],
	keyOrId: string,
): CameraPiece | undefined {
	return pieces.find((piece) => piece.key === keyOrId || piece.ids.includes(keyOrId));
}

/** The piece under a ruler moment; at a boundary, the one that starts there. */
export function cameraPieceAt(
	pieces: readonly CameraPiece[],
	atMs: number,
): CameraPiece | undefined {
	return (
		pieces.find((piece) => atMs >= piece.startMs && atMs < piece.endMs) ??
		pieces.find((piece) => atMs === piece.endMs)
	);
}

function payloadOf(segments: readonly AxcutCameraSegment[], piece: CameraPiece): Payload {
	const member = piece.implicit ? undefined : segments.find((s) => s.id === piece.ids[0]);
	return member
		? {
				mode: member.mode,
				origin: member.origin,
				...(member.segmentId ? { segmentId: member.segmentId } : {}),
			}
		: { mode: "pip", origin: "user" };
}

/** One piece's fragments for a ruler span, anchored to the clips it covers. */
function placePiece(
	payload: Payload,
	id: string,
	startMs: number,
	endMs: number,
	clips: AxcutClip[],
): AxcutCameraSegment[] {
	return anchorRegionsWithDerivedMs(
		[{ ...payload, id, startMs: Math.round(startMs), endMs: Math.round(endMs) }],
		clips,
		() => createId("cam"),
	) as AxcutCameraSegment[];
}

function without(segments: readonly AxcutCameraSegment[], ids: readonly string[]) {
	const drop = new Set(ids);
	return segments.filter((segment) => !drop.has(segment.id));
}

/**
 * Clear a ruler span of every stored piece: a piece across an edge keeps the part outside
 * it, and one wholly inside goes. A leftover shorter than `MIN_CAMERA_PIECE_MS` goes too,
 * as nobody could aim at it. The left leftover keeps the piece's id and `segmentId`; the
 * right one is a piece of its own.
 */
export function carveCameraSpan(
	segments: readonly AxcutCameraSegment[],
	clips: AxcutClip[],
	startMs: number,
	endMs: number,
): AxcutCameraSegment[] {
	const lo = Math.min(startMs, endMs);
	const hi = Math.max(startMs, endMs);
	let out = [...segments];
	for (const piece of cameraPieces(segments, 0)) {
		if (piece.implicit || piece.endMs <= lo || piece.startMs >= hi) continue;
		const payload = payloadOf(segments, piece);
		out = without(out, piece.ids);
		const left = lo - piece.startMs >= MIN_CAMERA_PIECE_MS;
		if (left) out.push(...placePiece(payload, piece.key, piece.startMs, lo, clips));
		if (piece.endMs - hi >= MIN_CAMERA_PIECE_MS) {
			out.push(
				...placePiece(
					left ? { ...payload, segmentId: createId("camseg") } : payload,
					left ? createId("cam") : piece.key,
					hi,
					piece.endMs,
					clips,
				),
			);
		}
	}
	return out;
}

/**
 * Give a ruler span its own piece in `mode`, over whatever was there. What the "Full
 * Camera" shortcut and the agent's `addCameraFullscreen` do. `ids` are the new piece's
 * fragments, empty when the span covers no clip.
 */
export function setCameraModeOverSpan(
	segments: readonly AxcutCameraSegment[],
	clips: AxcutClip[],
	startMs: number,
	endMs: number,
	mode: CameraMode,
	options: { id?: string; segmentId?: string; origin?: AxcutCameraSegment["origin"] } = {},
): { segments: AxcutCameraSegment[]; ids: string[] } {
	const lo = Math.max(0, Math.min(startMs, endMs));
	const hi = Math.max(startMs, endMs);
	const placed = placePiece(
		{
			mode,
			origin: options.origin ?? "user",
			segmentId: options.segmentId ?? createId("camseg"),
		},
		options.id ?? createId("cam"),
		lo,
		hi,
		clips,
	);
	return {
		segments: [...carveCameraSpan(segments, clips, lo, hi), ...placed],
		ids: placed.map((segment) => segment.id),
	};
}

/**
 * Cut the piece under `atMs` in two. Each half is its own piece afterwards, with the mode
 * the piece had: the left half keeps its id, the right one is new. An implicit piece is
 * stored as two picture-in-picture pieces. `null` when no piece has `MIN_CAMERA_PIECE_MS`
 * on both sides of the cut, which includes a cut on a boundary.
 */
export function splitCameraAt(
	segments: readonly AxcutCameraSegment[],
	clips: AxcutClip[],
	atMs: number,
): { segments: AxcutCameraSegment[]; leftKey: string; rightKey: string } | null {
	const at = Math.round(atMs);
	const piece = cameraPieces(segments, cameraTimelineEndMs(clips)).find(
		(p) => at - p.startMs >= MIN_CAMERA_PIECE_MS && p.endMs - at >= MIN_CAMERA_PIECE_MS,
	);
	if (!piece) return null;
	const payload = payloadOf(segments, piece);
	const left = placePiece(
		{ ...payload, segmentId: payload.segmentId ?? createId("camseg") },
		piece.implicit ? createId("cam") : piece.key,
		piece.startMs,
		at,
		clips,
	);
	const right = placePiece(
		{ ...payload, segmentId: createId("camseg") },
		createId("cam"),
		at,
		piece.endMs,
		clips,
	);
	if (left.length === 0 || right.length === 0) return null;
	return {
		segments: [...without(segments, piece.ids), ...left, ...right],
		leftKey: left[0].id,
		rightKey: right[0].id,
	};
}

/**
 * Show the camera another way over one piece. An implicit piece is stored for it. `key` is
 * the piece's key afterwards (it changes only for an implicit piece). `null` for an
 * unknown piece.
 */
export function setCameraPieceMode(
	segments: readonly AxcutCameraSegment[],
	clips: AxcutClip[],
	keyOrId: string,
	mode: CameraMode,
): { segments: AxcutCameraSegment[]; key: string } | null {
	const piece = findCameraPiece(cameraPieces(segments, cameraTimelineEndMs(clips)), keyOrId);
	if (!piece) return null;
	if (!piece.implicit) {
		const under = new Set(piece.ids);
		return {
			segments: segments.map((s) => (under.has(s.id) ? { ...s, mode } : s)),
			key: piece.key,
		};
	}
	const placed = placePiece(
		{ mode, origin: "user", segmentId: createId("camseg") },
		createId("cam"),
		piece.startMs,
		piece.endMs,
		clips,
	);
	if (placed.length === 0) return null;
	return { segments: [...segments, ...placed], key: placed[0].id };
}

/** Put a piece back to the default: its stored fragments go, and the gap left is an
 *  implicit picture-in-picture piece. An implicit piece is already there. */
export function removeCameraPiece(
	segments: readonly AxcutCameraSegment[],
	clips: AxcutClip[],
	keyOrId: string,
): AxcutCameraSegment[] {
	const piece = findCameraPiece(cameraPieces(segments, cameraTimelineEndMs(clips)), keyOrId);
	return piece ? without(segments, piece.ids) : [...segments];
}

/**
 * Join a piece with the one after it. The joined piece is the left one, grown over the
 * right one: its mode wins. Joining an implicit piece makes the pair implicit. `null`
 * when there is no next piece.
 */
export function mergeCameraPieceWithNext(
	segments: readonly AxcutCameraSegment[],
	clips: AxcutClip[],
	keyOrId: string,
): { segments: AxcutCameraSegment[]; key: string } | null {
	const pieces = cameraPieces(segments, cameraTimelineEndMs(clips));
	const index = pieces.findIndex((p) => p.key === keyOrId || p.ids.includes(keyOrId));
	const piece = pieces[index];
	const next = pieces[index + 1];
	if (!piece || !next || next.startMs - piece.endMs > 1) return null;
	if (piece.implicit) {
		return { segments: without(segments, next.ids), key: `${IMPLICIT_PREFIX}${piece.startMs}` };
	}
	const placed = placePiece(
		payloadOf(segments, piece),
		piece.key,
		piece.startMs,
		next.endMs,
		clips,
	);
	return {
		segments: [...without(segments, [...piece.ids, ...next.ids]), ...placed],
		key: piece.key,
	};
}

/**
 * Roll the boundary between a piece and the next one to `atMs`: one grows by what the
 * other loses, and neither may become shorter than `MIN_CAMERA_PIECE_MS`. An implicit side
 * needs no write, it is whatever the stored side leaves. `null` when there is no next
 * piece or no room to move.
 */
export function moveCameraBoundary(
	segments: readonly AxcutCameraSegment[],
	clips: AxcutClip[],
	leftKeyOrId: string,
	atMs: number,
): AxcutCameraSegment[] | null {
	const pieces = cameraPieces(segments, cameraTimelineEndMs(clips));
	const index = pieces.findIndex((p) => p.key === leftKeyOrId || p.ids.includes(leftKeyOrId));
	const left = pieces[index];
	const right = pieces[index + 1];
	if (!left || !right || right.startMs - left.endMs > 1) return null;
	const lo = left.startMs + MIN_CAMERA_PIECE_MS;
	const hi = right.endMs - MIN_CAMERA_PIECE_MS;
	if (hi < lo) return null;
	const at = Math.round(Math.min(hi, Math.max(lo, atMs)));
	let out = [...segments];
	if (!left.implicit) {
		out = [
			...without(out, left.ids),
			...placePiece(payloadOf(segments, left), left.key, left.startMs, at, clips),
		];
	}
	if (!right.implicit) {
		out = [
			...without(out, right.ids),
			...placePiece(payloadOf(segments, right), right.key, at, right.endMs, clips),
		];
	}
	return out;
}

/**
 * The spans in one mode, as the scene and the preview read them: touching fragments of the
 * same clip are joined whichever piece they belong to, so two side-by-side full-camera
 * pieces are one full-camera stretch and the camera does not ease out and back in at the
 * seam between them. Across a clip junction they stay apart, as the Full Camera regions
 * always did. Sorted by start.
 */
export function deriveCameraModeRuns(
	segments: readonly AxcutCameraSegment[],
	mode: CameraMode,
): CameraModeRun[] {
	const fragments: CameraModeRun[] = segments
		.filter((segment) => segment.mode === mode)
		.map((segment) => ({
			id: segment.id,
			startMs: segment.startMs,
			endMs: segment.endMs,
			...(segment.clipId !== undefined ? { clipId: segment.clipId } : {}),
			...(segment.sourceStartSec !== undefined ? { sourceStartSec: segment.sourceStartSec } : {}),
			...(segment.sourceEndSec !== undefined ? { sourceEndSec: segment.sourceEndSec } : {}),
		}));
	const anchored = (r: CameraModeRun) =>
		typeof r.clipId === "string" &&
		typeof r.sourceStartSec === "number" &&
		typeof r.sourceEndSec === "number";
	const ordered = [...fragments].sort((a, b) =>
		anchored(a) && anchored(b) && a.clipId === b.clipId
			? (a.sourceStartSec as number) - (b.sourceStartSec as number)
			: a.startMs - b.startMs,
	);
	const out: CameraModeRun[] = [];
	for (const fragment of ordered) {
		const joins = out.find((run) =>
			anchored(run) && anchored(fragment)
				? run.clipId === fragment.clipId &&
					(fragment.sourceStartSec as number) <= (run.sourceEndSec as number) + 0.001 &&
					(fragment.sourceEndSec as number) >= (run.sourceStartSec as number) - 0.001
				: !anchored(run) &&
					!anchored(fragment) &&
					fragment.startMs <= run.endMs + 1 &&
					fragment.endMs >= run.startMs - 1,
		);
		if (!joins) {
			out.push({ ...fragment });
			continue;
		}
		joins.startMs = Math.min(joins.startMs, fragment.startMs);
		joins.endMs = Math.max(joins.endMs, fragment.endMs);
		if (anchored(joins)) {
			joins.sourceStartSec = Math.min(
				joins.sourceStartSec as number,
				fragment.sourceStartSec as number,
			);
			joins.sourceEndSec = Math.max(joins.sourceEndSec as number, fragment.sourceEndSec as number);
		}
	}
	return out.sort((a, b) => a.startMs - b.startMs);
}

/** The document's Full Camera spans, derived from its camera pieces. */
export function readCameraFullscreenRegions(
	document: Pick<AxcutDocument, "cameraSegments"> | null | undefined,
): CameraModeRun[] {
	return deriveCameraModeRuns(readCameraSegments(document), "fullscreen");
}

/** The document's no-camera spans, derived from its camera pieces. */
export function readCameraHiddenRegions(
	document: Pick<AxcutDocument, "cameraSegments"> | null | undefined,
): CameraModeRun[] {
	return deriveCameraModeRuns(readCameraSegments(document), "hidden");
}
