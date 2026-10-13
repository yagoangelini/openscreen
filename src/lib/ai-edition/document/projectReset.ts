// "Restaurar": a track, or the whole project, back to what the recording's import made of it.
//
// Every reset here is a pure function of the document; the renderer writes the result as ONE
// undoable save (`components/ai-edition/projectReset.ts`), so a single Ctrl+Z brings all of it
// back. What each one covers, and why:
//
//   camera       The pieces the take's "Rosto / Tela + câmera" log makes
//                (`cameraSegmentsFromRecordedLayouts`, built with the function the import
//                uses), and nothing else: every piece the user split, restyled or gave a look
//                of its own goes. A take with no log gets the default picture-in-picture.
//   video        One clip per recording, the whole of it, in the order they first play: cuts,
//                trims, speed changes, splits, reorders, crops, pauses and inserted words go.
//                "The whole of it" is what the import plays: up to the press on Stop when the
//                take recorded one (`recordedEndSec`), so the stop click never comes back.
//                Regions anchored to the footage (zooms, annotations, camera pieces, audio)
//                follow the footage, not the ruler: a zoom on second 40 of the take stays on
//                second 40 even when a cut before it had pulled it to 30.
//   zooms        No zoom left; the renderer plans the automatic ones again, as the import does.
//   annotations  Only the automatic privacy blurs stay (`AUTO_REDACT_SOURCE`): the OCR finds
//                the same ones in the same take, and "Procurar de novo" re-runs it with new
//                words. Text, arrows, highlights, steps and hand-drawn blurs go.
//   all          Everything above, plus the imported audio tracks and the muted stretches.
//                What stays: the transcript and its corrections (transcribing again is slow),
//                the media, the project's name and its look (composition, background,
//                cursor, camera style, captions style, volumes) -- the look is what a new
//                import inherits too (`newProjectLook` in the document service), so keeping
//                it IS the just-imported state.
//
// Relative imports only, like the rest of `document/`.

import { AUTO_REDACT_SOURCE } from "../redaction";
import type { AxcutAsset, AxcutClip, AxcutDocument } from "../schema";
import { isGeneratedAssetId } from "../timeline/clip-parts";
import { regionIdentityKey } from "../timeline/timelineMap";
import { dropUnusedGeneratedMedia } from "./audioTracks";
import { cameraSegmentsFromRecordedLayouts } from "./cameraSegments";
import { createId } from "./ids";
import {
	mapAllRegionCollections,
	reanchorRows,
	recordedClipLengthSec,
	rederiveRegionMs,
	resequenceClips,
} from "./timeline";

export const PROJECT_RESET_SCOPES = ["camera", "video", "zooms", "annotations", "all"] as const;
export type ProjectResetScope = (typeof PROJECT_RESET_SCOPES)[number];

/** The recordings a video reset lays out: every real (not generated) video the timeline plays,
 *  in the order each first plays; the project's primary one when no clip is left. */
function takeAssets(document: AxcutDocument): AxcutAsset[] {
	const isTake = (asset: AxcutAsset | undefined): asset is AxcutAsset =>
		!!asset && asset.kind === "video" && !isGeneratedAssetId(asset.id);
	const out: AxcutAsset[] = [];
	for (const clip of document.timeline.clips) {
		const asset = document.assets.find((a) => a.id === clip.assetId);
		if (isTake(asset) && !out.includes(asset)) out.push(asset);
	}
	if (out.length > 0) return out;
	const primary = document.assets.find((a) => a.id === document.project.primaryAssetId);
	const fallback = isTake(primary) ? primary : document.assets.find(isTake);
	return fallback ? [fallback] : [];
}

/** How long a recording is: its probed length, else the furthest any of its clips reaches. */
function takeLengthSec(asset: AxcutAsset, clips: readonly AxcutClip[]): number | null {
	if (asset.durationSec !== undefined && Number.isFinite(asset.durationSec)) {
		if (asset.durationSec > 0) return asset.durationSec;
	}
	const reach = clips
		.filter((clip) => clip.assetId === asset.id)
		.reduce((max, clip) => Math.max(max, clip.sourceEndSec ?? 0), 0);
	return reach > 0 ? reach : null;
}

/** Two copies of one region that a duplicated clip had made, now on the same footage: one. */
function withoutDuplicateRegions(document: AxcutDocument): AxcutDocument {
	return mapAllRegionCollections(document, (regions, prefix) => {
		if (prefix === "audio") return regions;
		const seen = new Set<string>();
		return regions.filter((region) => {
			if (typeof region.clipId !== "string") return true;
			const { segmentId: _piece, ...payload } = region as Record<string, unknown>;
			const key = `${region.clipId}|${region.sourceStartSec}|${region.sourceEndSec}|${regionIdentityKey(payload)}`;
			if (seen.has(key)) return false;
			seen.add(key);
			return true;
		});
	});
}

/** "Restaurar trilha de vídeo". The document unchanged when there is no recording to lay out. */
export function resetVideoTrack(document: AxcutDocument): AxcutDocument {
	const takes = takeAssets(document);
	const oldClips = document.timeline.clips;
	const clips: AxcutClip[] = [];
	// Every clip of a recording folds into the clip that keeps the recording's first id, so a
	// region anchored to any of them keeps its source time on the full clip (`reanchorRows`).
	const absorbed = new Map<string, string>();
	for (const asset of takes) {
		const mediaSec = takeLengthSec(asset, oldClips);
		if (mediaSec === null) continue;
		// The import's length, not the file's: the frames after the press on Stop stay in the
		// file (dragging the clip edge brings them back), but a restore must not.
		const length = recordedClipLengthSec(asset, mediaSec);
		const own = oldClips.filter((clip) => clip.assetId === asset.id);
		const first = own[0];
		const id = first?.id ?? createId("clip");
		for (const clip of own.slice(1)) absorbed.set(clip.id, id);
		clips.push({
			id,
			assetId: asset.id,
			sourceStartSec: 0,
			sourceEndSec: length,
			timelineStartSec: 0,
			timelineEndSec: length,
			wordRefs: [...new Set(own.flatMap((clip) => clip.wordRefs))],
			origin: first?.origin ?? "system",
			reason: first?.reason ?? "",
		});
	}
	if (clips.length === 0) return document;
	const laid = resequenceClips(clips);
	const legacy = document.legacyEditor as Record<string, unknown> | null;
	const flat: AxcutDocument = {
		...document,
		timeline: {
			...document.timeline,
			clips: laid,
			trimRanges: [],
			gaps: [],
			speedRanges: [],
		},
		legacyEditor: legacy && "speedRegions" in legacy ? { ...legacy, speedRegions: [] } : legacy,
	};
	const moved = absorbed.size > 0 ? reanchorRows(flat, absorbed) : flat;
	return dropUnusedGeneratedMedia(withoutDuplicateRegions(rederiveRegionMs(moved, laid)));
}

/** "Restaurar trilha da câmera": the pieces the recordings' layout logs make, no look of their own. */
export function resetCameraTrack(document: AxcutDocument): AxcutDocument {
	return { ...document, cameraSegments: cameraSegmentsFromRecordedLayouts(document) };
}

/** "Restaurar zooms", the pure half: no zoom at all. The renderer plans the automatic ones. */
export function resetZoomTrack(document: AxcutDocument): AxcutDocument {
	return { ...document, zoomRanges: [] };
}

/** "Restaurar anotações": only the automatic privacy blurs stay. */
export function resetAnnotationTrack(document: AxcutDocument): AxcutDocument {
	return {
		...document,
		annotations: document.annotations.filter(
			(annotation) => annotation.annotationSource === AUTO_REDACT_SOURCE,
		),
	};
}

/**
 * "Restaurar tudo", the pure half: the video first, so the camera pieces are rebuilt on the
 * restored clips. Zooms are left empty for the renderer to plan, as for `resetZoomTrack`.
 */
export function resetProjectToImport(document: AxcutDocument): AxcutDocument {
	const restored = resetAnnotationTrack(resetCameraTrack(resetVideoTrack(document)));
	return dropUnusedGeneratedMedia({
		...restored,
		zoomRanges: [],
		audioTracks: [],
		timeline: { ...restored.timeline, muteRanges: [] },
	});
}

/** The pure half of a reset. Zooms come back empty in "zooms" and "all": see the module notes. */
export function applyProjectReset(
	document: AxcutDocument,
	scope: ProjectResetScope,
): AxcutDocument {
	switch (scope) {
		case "camera":
			return resetCameraTrack(document);
		case "video":
			return resetVideoTrack(document);
		case "zooms":
			return resetZoomTrack(document);
		case "annotations":
			return resetAnnotationTrack(document);
		case "all":
			return resetProjectToImport(document);
	}
}

/** Whether a reset plans the automatic zooms again once its pure half is done. */
export function resetReplansZooms(scope: ProjectResetScope): boolean {
	return scope === "zooms" || scope === "all";
}
