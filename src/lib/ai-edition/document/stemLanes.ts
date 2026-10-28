// The two stem lanes of the timeline: a take recorded with its microphone and its computer sound
// apart (`asset.audioStems`) shows them as "Microfone" and "Áudio do sistema", each editable on
// its own.
//
// What a lane edit is, and what it is not:
//   - Volume and mute of a whole lane are the `voiceGainDb` / `systemGainDb` and `voiceMuted` /
//     `systemMuted` editor settings (one value per project, like the volumes always were).
//   - A silenced stretch is an `AxcutStemMute`, anchored to the take in SOURCE seconds like a
//     trim: every clip cut from the take shows it and plays it silent, and it follows the sound
//     through cuts, reorders and speed changes.
//   - Cutting the video cuts both stems with it. The stems are never shifted against the picture
//     (a screencast lives on lip and click sync), so a lane edit only silences; there is no
//     "detach" that would let one lane slide.
//
// The gain envelope of a lane (`stemMuteGain`) is the export's (`MuteStream`, Rust
// `audio_stream.rs`) — the same ramps, evaluated on source time — so the preview can play it
// from the source file it seeks.

import type { AxcutClip, AxcutDocument, AxcutStemKind, AxcutStemMute } from "../schema";

/** A new silenced stretch: 2 s from the playhead (or what is left of the clip). */
export const STEM_MUTE_DEFAULT_SEC = 2;
/** A new stretch's ramps, each side: short enough to stay a cut, long enough not to click. */
export const STEM_MUTE_DEFAULT_FADE_MS = 30;
/** Shortest stretch an edit leaves. */
export const STEM_MUTE_MIN_SEC = 0.05;

/** Where a clip's source window ends: a raw clip is as long on the ruler as in its source. */
function clipSourceEnd(clip: AxcutClip): number {
	return clip.sourceEndSec ?? clip.sourceStartSec + (clip.timelineEndSec - clip.timelineStartSec);
}

/** A take's stems are on the timeline: some clip shows an asset that has them. */
export function documentHasStemLanes(document: AxcutDocument): boolean {
	const withStems = new Set(document.assets.filter((a) => a.audioStems).map((a) => a.id));
	return document.timeline.clips.some((clip) => withStems.has(clip.assetId));
}

export function stemMutes(document: AxcutDocument): AxcutStemMute[] {
	return document.audioStemMutes ?? [];
}

/** One silenced stretch as a lane draws it: the part of it one clip shows, on the RAW ruler. */
export interface StemMutePill {
	id: string;
	stem: AxcutStemKind;
	clipId: string;
	startSec: number;
	endSec: number;
	fadeMs: number;
}

/**
 * Where each stretch shows on the ruler: once per clip of its take whose source window it
 * overlaps, cut to that window. A raw clip is identity between source and ruler time, so the
 * mapping is a shift by the clip's own offset (`timelineMap.ts`).
 */
export function stemMutePills(document: AxcutDocument, stem: AxcutStemKind): StemMutePill[] {
	const pills: StemMutePill[] = [];
	for (const mute of stemMutes(document)) {
		if (mute.stem !== stem) continue;
		for (const clip of document.timeline.clips) {
			if (clip.assetId !== mute.assetId) continue;
			const from = Math.max(mute.startSec, clip.sourceStartSec);
			const to = Math.min(mute.endSec, clipSourceEnd(clip));
			if (to - from <= 1e-6) continue;
			pills.push({
				id: mute.id,
				stem,
				clipId: clip.id,
				startSec: clip.timelineStartSec + (from - clip.sourceStartSec),
				endSec: clip.timelineStartSec + (to - clip.sourceStartSec),
				fadeMs: mute.fadeMs,
			});
		}
	}
	return pills.sort((a, b) => a.startSec - b.startSec);
}

/** The clip with stems under a ruler time, if any. */
export function stemClipAt(document: AxcutDocument, rawSec: number): AxcutClip | null {
	const withStems = new Set(document.assets.filter((a) => a.audioStems).map((a) => a.id));
	return (
		document.timeline.clips.find(
			(clip) =>
				withStems.has(clip.assetId) &&
				rawSec >= clip.timelineStartSec - 1e-6 &&
				rawSec < clip.timelineEndSec,
		) ?? null
	);
}

/**
 * Silences `durationSec` of one stem from the ruler time `rawSec`, inside the clip under it.
 * A stretch touching or overlapping another of the same take and stem is merged with it: the
 * lane never holds two stretches over the same sound. Null when there is no clip with stems
 * there.
 */
export function addStemMute(
	document: AxcutDocument,
	stem: AxcutStemKind,
	rawSec: number,
	makeId: () => string,
	durationSec = STEM_MUTE_DEFAULT_SEC,
): { document: AxcutDocument; id: string } | null {
	const clip = stemClipAt(document, rawSec);
	if (!clip) return null;
	const startSec = clip.sourceStartSec + Math.max(0, rawSec - clip.timelineStartSec);
	const endSec = Math.min(clipSourceEnd(clip), startSec + durationSec);
	if (endSec - startSec < STEM_MUTE_MIN_SEC) return null;
	const mute: AxcutStemMute = {
		id: makeId(),
		assetId: clip.assetId,
		stem,
		startSec,
		endSec,
		fadeMs: STEM_MUTE_DEFAULT_FADE_MS,
		origin: "user",
	};
	return withMerged(document, mute);
}

/** Merges `mute` with every stretch of its take and stem it touches; the result keeps its id. */
function withMerged(
	document: AxcutDocument,
	mute: AxcutStemMute,
): { document: AxcutDocument; id: string } {
	let merged = mute;
	const rest: AxcutStemMute[] = [];
	for (const other of stemMutes(document)) {
		if (other.id === mute.id) continue;
		const sameLane = other.assetId === mute.assetId && other.stem === mute.stem;
		if (sameLane && other.startSec <= merged.endSec && other.endSec >= merged.startSec) {
			merged = {
				...merged,
				startSec: Math.min(merged.startSec, other.startSec),
				endSec: Math.max(merged.endSec, other.endSec),
				fadeMs: Math.max(merged.fadeMs, other.fadeMs),
			};
		} else {
			rest.push(other);
		}
	}
	return {
		document: { ...document, audioStemMutes: [...rest, merged] },
		id: merged.id,
	};
}

/**
 * Moves or resizes a stretch by ruler seconds: `startDeltaSec` / `endDeltaSec` shift its edges
 * (both the same for a move). Kept inside the take's source and at least `STEM_MUTE_MIN_SEC`
 * long; merged with any stretch it now touches. Null when the id is gone.
 */
export function moveStemMute(
	document: AxcutDocument,
	id: string,
	startDeltaSec: number,
	endDeltaSec: number,
	sourceDurationSec: number,
): { document: AxcutDocument; id: string } | null {
	const mute = stemMutes(document).find((m) => m.id === id);
	if (!mute) return null;
	const limit = sourceDurationSec > 0 ? sourceDurationSec : Number.POSITIVE_INFINITY;
	let startSec = mute.startSec + startDeltaSec;
	let endSec = mute.endSec + endDeltaSec;
	if (startDeltaSec === endDeltaSec) {
		// A move keeps the length.
		const length = mute.endSec - mute.startSec;
		startSec = Math.min(Math.max(0, startSec), Math.max(0, limit - length));
		endSec = startSec + length;
	} else {
		startSec = Math.min(Math.max(0, startSec), endSec - STEM_MUTE_MIN_SEC);
		endSec = Math.max(Math.min(limit, endSec), startSec + STEM_MUTE_MIN_SEC);
	}
	return withMerged(document, { ...mute, startSec, endSec });
}

export function setStemMuteFade(
	document: AxcutDocument,
	id: string,
	fadeMs: number,
): AxcutDocument {
	const value = Math.round(Math.min(2000, Math.max(0, fadeMs)));
	return {
		...document,
		audioStemMutes: stemMutes(document).map((m) => (m.id === id ? { ...m, fadeMs: value } : m)),
	};
}

export function removeStemMute(document: AxcutDocument, id: string): AxcutDocument {
	const next = stemMutes(document).filter((m) => m.id !== id);
	if (next.length === stemMutes(document).length) return document;
	const { audioStemMutes: _drop, ...rest } = document;
	return next.length > 0 ? { ...rest, audioStemMutes: next } : rest;
}

/** One stretch as the export reads it: source seconds, ramps in seconds. */
export interface SceneStemMute {
	startSec: number;
	endSec: number;
	fadeSec: number;
}

/** The stretches of one take and stem, for the scene and the preview. */
export function sceneStemMutes(
	document: AxcutDocument,
	assetId: string,
	stem: AxcutStemKind,
): SceneStemMute[] {
	return stemMutes(document)
		.filter((m) => m.assetId === assetId && m.stem === stem)
		.map((m) => ({ startSec: m.startSec, endSec: m.endSec, fadeSec: m.fadeMs / 1000 }))
		.sort((a, b) => a.startSec - b.startSec);
}

/**
 * The lane's gain at source time `t`: 0 inside a stretch, a linear ramp over its fade on each
 * side, 1 elsewhere; overlapping ramps multiply. Rust `stem_mute_gain` is the same function.
 */
export function stemMuteGain(mutes: readonly SceneStemMute[], t: number): number {
	let gain = 1;
	for (const mute of mutes) {
		if (t >= mute.startSec && t <= mute.endSec) return 0;
		if (mute.fadeSec <= 0) continue;
		if (t < mute.startSec && t > mute.startSec - mute.fadeSec) {
			gain *= (mute.startSec - t) / mute.fadeSec;
		} else if (t > mute.endSec && t < mute.endSec + mute.fadeSec) {
			gain *= (t - mute.endSec) / mute.fadeSec;
		}
	}
	return gain;
}
