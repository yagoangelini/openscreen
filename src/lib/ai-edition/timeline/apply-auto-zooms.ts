// Shared auto-zoom apply path: the HUD toggle / fresh-recording import and the
// timeline wand both end here. Suggestion math stays in zoom-suggestions.ts;
// this file only collects per-asset telemetry and appends the resulting regions.

import type { CursorTelemetryPoint } from "@/components/video-editor/types";
import { readCameraFullscreenRegions } from "../document/cameraSegments";
import { createId } from "../document/ids";
import type { AxcutAsset, AxcutDocument } from "../schema";
import { getEditorSettings } from "../store/editorSettings";
import { findAssetTranscript } from "../transcription/status";
import type { SpokenWord } from "./speechCues";
import { anchorRegionsWithDerivedMs } from "./timelineMap";
import { autoZoomMotion, motionTransitionSec } from "./zoom-motion";
import { effectiveZoomScale } from "./zoom-scale";
import { type AutoZoomSuggestion, buildAutoZoomSuggestionsForClips } from "./zoom-suggestions";

/** Which assets to read telemetry for. The wand takes every video on the document;
 *  the fresh-recording import narrows it to the take it is pending on, so a project
 *  that already holds other footage does not pay an IPC round trip per asset. */
export type AutoZoomAssetFilter = (asset: AxcutAsset) => boolean;

/** Each recording's transcript words in its own source ms, for the planner to follow. */
export function transcriptWordsByAssetId(document: AxcutDocument): Map<string, SpokenWord[]> {
	const byAsset = new Map<string, SpokenWord[]>();
	for (const asset of document.assets) {
		const words = findAssetTranscript(document, asset.id)?.words ?? [];
		if (words.length === 0) continue;
		byAsset.set(
			asset.id,
			words.map((word) => ({
				startMs: word.startSec * 1000,
				endMs: word.endSec * 1000,
				text: word.text,
			})),
		);
	}
	return byAsset;
}

/**
 * The transcript the automatic zooms would follow, as a short comparable string ("" for none):
 * a word corrected, added or removed changes it. Stored on the document when the zooms are
 * planned, so the editor can offer to plan them again once the transcript moved on.
 */
export function transcriptSignature(document: AxcutDocument): string {
	let hash = 0x811c9dc5;
	let count = 0;
	for (const [assetId, words] of [...transcriptWordsByAssetId(document)].sort(([a], [b]) =>
		a.localeCompare(b),
	)) {
		for (const word of [assetId, ...words.map((w) => `${w.text}@${Math.round(w.startMs)}`)]) {
			for (let i = 0; i < word.length; i += 1) {
				hash ^= word.charCodeAt(i);
				hash = Math.imul(hash, 0x01000193) >>> 0;
			}
			count += 1;
		}
	}
	return count === 0 ? "" : `${count}:${hash.toString(36)}`;
}

const PLANNED_TRANSCRIPT_KEY = "autoZoomTranscript";

/** The transcript signature the automatic zooms were last planned with, or null if never. */
export function plannedTranscriptSignature(document: AxcutDocument): string | null {
	const value = document.legacyEditor?.[PLANNED_TRANSCRIPT_KEY];
	return typeof value === "string" ? value : null;
}

/** The document, noting that its automatic zooms were planned with `signature`. */
export function withPlannedTranscript(document: AxcutDocument, signature: string): AxcutDocument {
	if (plannedTranscriptSignature(document) === signature) return document;
	return {
		...document,
		legacyEditor: { ...(document.legacyEditor ?? {}), [PLANNED_TRANSCRIPT_KEY]: signature },
	};
}

/**
 * The automatic zooms were planned without the transcript the project has now (never with one,
 * or with one since corrected): planning them again would follow it.
 */
export function autoZoomsBehindTranscript(document: AxcutDocument): boolean {
	const current = transcriptSignature(document);
	return current !== "" && plannedTranscriptSignature(document) !== current;
}

export async function collectAutoZoomSuggestionsForDocument(
	document: AxcutDocument,
	getTelemetry: (videoPath: string) => Promise<CursorTelemetryPoint[] | null | undefined>,
	includeAsset: AutoZoomAssetFilter = () => true,
): Promise<AutoZoomSuggestion[]> {
	const assetsWithClips = document.assets.filter(
		(asset) =>
			asset.kind === "video" &&
			asset.originalPath &&
			includeAsset(asset) &&
			document.timeline.clips.some((clip) => clip.assetId === asset.id),
	);
	// Read in parallel, planned in one pass: two recordings' zooms must keep clear of each other too.
	const telemetryByAssetId = new Map(
		await Promise.all(
			assetsWithClips.map(
				async (asset) => [asset.id, (await getTelemetry(asset.originalPath)) ?? []] as const,
			),
		),
	);
	const settings = getEditorSettings(document).autoZoom;
	const motion = autoZoomMotion(settings);
	return buildAutoZoomSuggestionsForClips({
		telemetryByAssetId,
		// What was said guides the zooms too, whenever the project has a transcript.
		wordsByAssetId: transcriptWordsByAssetId(document),
		clips: document.timeline.clips,
		settings,
		existingRegions: [
			...document.zoomRanges.map((region) => {
				const scale = effectiveZoomScale(region);
				return {
					startMs: region.startMs,
					endMs: region.endMs,
					scale,
					// An automatic zoom moves with the project's motion, and ramps for that long.
					...(region.source === "auto"
						? { rampMs: motionTransitionSec(motion, scale) * 1000 }
						: {}),
				};
			}),
			...cameraFullscreenReservations(document),
		],
	});
}

/**
 * The Full Camera spans ("Rosto" in the HUD) as spans the planner keeps clear of: they show no
 * screen, so a zoom there zooms into nothing. Planned like a zoom already on the timeline with
 * no ramp of its own, so the screen also comes back wide for a moment before the first zoom
 * after one.
 */
function cameraFullscreenReservations(document: AxcutDocument) {
	return readCameraFullscreenRegions(document).map((run) => ({
		startMs: run.startMs,
		endMs: run.endMs,
		rampMs: 0,
	}));
}

/** The automatic zooms of a document, replaced by a fresh plan: what "re-plan" does after the
 *  auto-zoom settings changed. Zooms drawn by hand stay where they are and are planned around. */
export function withoutAutoZooms(document: AxcutDocument): AxcutDocument {
	const zoomRanges = document.zoomRanges.filter((region) => region.source !== "auto");
	return zoomRanges.length === document.zoomRanges.length ? document : { ...document, zoomRanges };
}

/**
 * The clip geometry the suggestions were built against, as a comparable string.
 *
 * Suggestions carry TIMELINE spans, and `appendAutoZoomSuggestions` anchors them
 * against whatever clips the document holds when the write happens. Collecting
 * takes a multi-second telemetry round trip, so those two documents are not
 * necessarily the same one — and if a clip was trimmed, moved, added, removed or
 * reordered in between, the spans land on different media, or on nothing.
 */
export function clipExtentSignature(document: AxcutDocument): string {
	return document.timeline.clips
		.map(
			(clip) =>
				`${clip.id}:${clip.assetId}:${clip.sourceStartSec}:${clip.sourceEndSec ?? ""}:${clip.timelineStartSec}:${clip.timelineEndSec}`,
		)
		.join("|");
}

/**
 * Collect against the document as it is NOW, and collect again if the clips moved
 * while the telemetry was being read.
 *
 * One retry, not a loop: a user who keeps editing through the wait will keep
 * invalidating it, and the honest answer there is the write-time guards, not
 * spinning here. Returns the suggestions together with the document they were
 * built from, so the caller can tell what they describe.
 */
export async function collectAutoZoomSuggestionsForLatestDocument(
	readDocument: () => AxcutDocument | null,
	getTelemetry: (videoPath: string) => Promise<CursorTelemetryPoint[] | null | undefined>,
	includeAsset?: AutoZoomAssetFilter,
): Promise<{ document: AxcutDocument; suggestions: AutoZoomSuggestion[] } | null> {
	const start = readDocument();
	if (!start) return null;
	const startSignature = clipExtentSignature(start);
	const suggestions = await collectAutoZoomSuggestionsForDocument(
		start,
		getTelemetry,
		includeAsset,
	);
	const latest = readDocument();
	if (!latest) return null;
	if (clipExtentSignature(latest) === startSignature) {
		return { document: latest, suggestions };
	}
	return {
		document: latest,
		suggestions: await collectAutoZoomSuggestionsForDocument(latest, getTelemetry, includeAsset),
	};
}

export function appendAutoZoomSuggestions(
	document: AxcutDocument,
	suggestions: AutoZoomSuggestion[],
	makeId: (prefix: string) => string = createId,
): AxcutDocument {
	if (suggestions.length === 0) return document;
	const anchored = suggestions.flatMap((suggestion) =>
		anchorRegionsWithDerivedMs(
			[
				{
					id: makeId("zoom"),
					startMs: Math.round(suggestion.span.start),
					endMs: Math.round(suggestion.span.end),
					depth: suggestion.depth,
					...(suggestion.customScale !== undefined ? { customScale: suggestion.customScale } : {}),
					focus: { cx: suggestion.focus.cx, cy: suggestion.focus.cy },
					// Automatic: how it moves (fixed, hybrid, following) is the project's auto-zoom
					// camera, read at render time (`resolveZoomRendering`), so one control switches
					// them all. Its own focus mode is left unset.
					source: "auto" as const,
				},
			],
			document.timeline.clips,
			() => makeId("zoom"),
		),
	);
	return {
		...document,
		zoomRanges: [...document.zoomRanges, ...anchored] as AxcutDocument["zoomRanges"],
	};
}
