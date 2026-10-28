// What each undo step is called in the history menu (right-click on the undo/redo arrows).
//
// A step is a snapshot of the whole document (`undoStack.ts`), not an operation, so it has no
// name of its own. It gets one in two ways:
//
//   1. The write names itself: `saveDocument(next, { history: true, historyLabel: "resetAll" })`.
//      Used where a diff cannot tell what happened (an agent turn, a reset, "Limpar fala").
//   2. Otherwise the label is read off the change, by comparing the document the step returns
//      to with the one the write installed (`inferHistoryLabel`). The comparison runs once per
//      recorded write, field by field, by reference first: an edit is built by spreading the
//      document it edits, so an untouched collection is the same object on both sides and is
//      skipped without being serialised.
//
// A label is a key, translated when the menu draws it (`editor.history.labels.<key>`), so a
// language change relabels the whole history. Anything the diff cannot place is "edit".
//
// Pure, no store import: `projectStore` calls it from `recordHistory`.

import type { AxcutDocument } from "../schema";
import { regionIdentityKey } from "../timeline/timelineMap";

export const HISTORY_LABELS = [
	"edit",
	"agentTurn",
	"renameProject",
	"addClip",
	"splitClip",
	"removeClip",
	"editClip",
	"addTrim",
	"removeTrim",
	"editTrim",
	"speed",
	"addZoom",
	"removeZoom",
	"moveZoom",
	"editZoom",
	"autoZooms",
	"addAnnotation",
	"removeAnnotation",
	"moveAnnotation",
	"editAnnotation",
	"camera",
	"splitCamera",
	"cameraLook",
	"cameraLookAll",
	"audio",
	"mute",
	"echo",
	"transcript",
	"settings",
	"media",
	"speechCleanup",
	"clearTimeline",
	"resetCamera",
	"resetVideo",
	"resetZooms",
	"resetAnnotations",
	"resetAll",
] as const;

export type HistoryLabel = (typeof HISTORY_LABELS)[number];

export function isHistoryLabel(value: unknown): value is HistoryLabel {
	return typeof value === "string" && (HISTORY_LABELS as readonly string[]).includes(value);
}

/** Equal by reference, else by value. Only reached for a field the write replaced. */
function same(a: unknown, b: unknown): boolean {
	if (a === b) return true;
	try {
		return JSON.stringify(a) === JSON.stringify(b);
	} catch {
		return false;
	}
}

type Region = { id: string } & Record<string, unknown>;

/** How a collection of regions changed: one more, one fewer, only moved, or restyled. */
function regionChange(
	before: readonly Region[],
	after: readonly Region[],
): "add" | "remove" | "move" | "edit" | null {
	if (same(before, after)) return null;
	if (after.length > before.length) return "add";
	if (after.length < before.length) return "remove";
	const byId = new Map(before.map((region) => [region.id, region]));
	for (const region of after) {
		const old = byId.get(region.id);
		// A region replaced by another one of the same count reads as an edit, not a move.
		if (!old || regionIdentityKey(old) !== regionIdentityKey(region)) return "edit";
	}
	return "move";
}

type Segment = AxcutDocument["cameraSegments"][number];

/** A camera edit: a piece given its own look (or a look changed), a split, or anything else. */
function cameraChange(before: readonly Segment[], after: readonly Segment[]): HistoryLabel {
	const bare = (segments: readonly Segment[]) =>
		segments.map(({ overrides: _look, ...rest }) => rest);
	if (same(bare(before), bare(after))) return "cameraLook";
	const pieces = (segments: readonly Segment[]) =>
		new Set(segments.map((segment) => segment.segmentId ?? segment.id)).size;
	const grown = pieces(after) - pieces(before);
	const known = new Set(before.map((segment) => segment.id));
	// The first look of a default (implicit) piece stores that piece: one more, carrying a look.
	if (grown === 1 && after.some((segment) => !known.has(segment.id) && segment.overrides)) {
		return "cameraLook";
	}
	if (grown <= 0) return "camera";
	// A split keeps the modes the track had (the default picture-in-picture counts as had); a
	// new full-screen or no-camera stretch -- the import's face spans, the Full Camera key -- is
	// not a split.
	const modes = new Set<string>(["pip", ...before.map((segment) => segment.mode)]);
	return after.every((segment) => modes.has(segment.mode)) ? "splitCamera" : "camera";
}

function legacyWithout(doc: AxcutDocument, key: string): unknown {
	const legacy = doc.legacyEditor as Record<string, unknown> | null;
	if (!legacy) return null;
	const { [key]: _drop, ...rest } = legacy;
	return rest;
}

/** The "Remover eco do alto-falante" settings: its switch, its "Intensidade", the compensation. */
const ECHO_KEYS: readonly string[] = ["echoCancel", "echoCancelStrength", "systemCompensation"];

/** Whether the editor settings changed, and only in `ECHO_KEYS`. */
function onlyEchoSettingsChanged(prev: AxcutDocument, next: AxcutDocument): boolean {
	const before = (prev.legacyEditor ?? {}) as Record<string, unknown>;
	const after = (next.legacyEditor ?? {}) as Record<string, unknown>;
	let changed = false;
	for (const key of new Set([...Object.keys(before), ...Object.keys(after)])) {
		if (same(before[key], after[key])) continue;
		if (!ECHO_KEYS.includes(key)) return false;
		changed = true;
	}
	return changed;
}

function speedRegionsOf(doc: AxcutDocument): unknown {
	return (doc.legacyEditor as Record<string, unknown> | null)?.speedRegions ?? [];
}

/**
 * The label of the step that turned `prev` into `next`, read off what changed. Clips first:
 * a clip edit re-derives every region anchored to it, so the zooms and pieces that moved with
 * it are a consequence, not the edit.
 */
export function inferHistoryLabel(prev: AxcutDocument, next: AxcutDocument): HistoryLabel {
	const prevClips = prev.timeline?.clips ?? [];
	const nextClips = next.timeline?.clips ?? [];
	if (!same(prevClips, nextClips)) {
		if (nextClips.length > prevClips.length) {
			const assets = new Set(prevClips.map((clip) => clip.assetId));
			return nextClips.every((clip) => assets.has(clip.assetId)) ? "splitClip" : "addClip";
		}
		if (nextClips.length < prevClips.length) return "removeClip";
		return "editClip";
	}
	const trims = regionChange(
		(prev.timeline?.trimRanges ?? []) as Region[],
		(next.timeline?.trimRanges ?? []) as Region[],
	);
	if (trims === "add") return "addTrim";
	if (trims === "remove") return "removeTrim";
	if (trims) return "editTrim";
	if (!same(speedRegionsOf(prev), speedRegionsOf(next))) return "speed";
	if (!same(prev.cameraSegments, next.cameraSegments)) {
		return cameraChange(prev.cameraSegments ?? [], next.cameraSegments ?? []);
	}
	const zooms = regionChange(
		(prev.zoomRanges ?? []) as unknown as Region[],
		(next.zoomRanges ?? []) as unknown as Region[],
	);
	if (zooms === "add") {
		const known = new Set((prev.zoomRanges ?? []).map((zoom) => zoom.id));
		const added = (next.zoomRanges ?? []).filter((zoom) => !known.has(zoom.id));
		return added.length > 1 && added.every((zoom) => zoom.source === "auto")
			? "autoZooms"
			: "addZoom";
	}
	if (zooms === "remove") return "removeZoom";
	if (zooms === "move") return "moveZoom";
	if (zooms) return "editZoom";
	const annotations = regionChange(
		(prev.annotations ?? []) as unknown as Region[],
		(next.annotations ?? []) as unknown as Region[],
	);
	if (annotations === "add") return "addAnnotation";
	if (annotations === "remove") return "removeAnnotation";
	if (annotations === "move") return "moveAnnotation";
	if (annotations) return "editAnnotation";
	if (!same(prev.audioTracks, next.audioTracks)) return "audio";
	if (!same(prev.timeline?.muteRanges, next.timeline?.muteRanges)) return "mute";
	if (!same(prev.audioStemMutes, next.audioStemMutes)) return "mute";
	if (!same(prev.transcript, next.transcript) || !same(prev.transcripts, next.transcripts)) {
		return "transcript";
	}
	if (!same(legacyWithout(prev, "speedRegions"), legacyWithout(next, "speedRegions"))) {
		return onlyEchoSettingsChanged(prev, next) ? "echo" : "settings";
	}
	if (!same(prev.assets, next.assets)) return "media";
	if (prev.project?.title !== next.project?.title) return "renameProject";
	return "edit";
}
