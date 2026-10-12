// "Limpar fala": the hesitations and long silences of a take, found from the transcript
// alone (no AI), offered as a list the user reviews, and applied as ordinary trims.
//
// THE HEURISTIC. Two lists, both editable in preferences:
//
//   - Pure hesitations ("né", "éé", "ãã", "hum"...): words that carry nothing, cut wherever
//     they stand as a whole word.
//   - Contextual fillers ("tipo", "então", "então assim"...): real words that are fillers only
//     some of the time. Cut only when the use says filler:
//       * REPEATED: the same entry said twice in a row ("então, então vamos") -- every
//         occurrence but the last is cut;
//       * ISOLATED: a pause on BOTH sides. A pause is at least `PAUSE_SEC` of silence, or a
//         shorter one (`SHORT_PAUSE_SEC`) right after punctuation Whisper wrote ("Então, ...");
//         the edge of the clip counts as a pause.
//     "Vou criar um tipo de coluna" or "então a gente abre" never qualify. A toggle
//     (`aggressive`) cuts them wherever they appear, for whoever wants that.
//   - Long silences: a gap between two kept words longer than `silenceMinSec` is shortened
//     to `keepGapSec`, half on each side, rather than cut whole -- speech glued end to end
//     sounds wrong. A filler sitting in a pause takes the pause with it under the same rule.
//     Silence before the first word and after the last word of a clip is left alone.
//
// What it never does: cut inside a word (every cut lies between the end of a kept word and
// the start of the next), touch a stretch that already has a trim in it, or cut an inserted
// word. Matching is on whole words, case-insensitive, punctuation stripped, a letter held
// longer ("ééé", "hummm") read as the same as twice ("éé", "humm"). Accents are kept: "e"
// (and) and "é" (is) are words, "éé" is not.
//
// Every time here is SOURCE seconds of the clip's asset; a clip only ever plays its own
// source window, so a cut per clip is already the clip anchor a trim needs (v7).

import type { AxcutDocument, AxcutTrimRange } from "../schema";
import {
	buildAggregatedSections,
	type ClipSection,
	isInsertedWord,
	isSilenceWord,
	placementRawSec,
} from "./aggregated-transcript";
import { mergeCloseCuts } from "./cut-breath";
import { removedRawSpans } from "./programme-time";
import { trimAppliesToClip } from "./trim-mapping";

export const DEFAULT_SPEECH_FILLERS = ["né", "éé", "ãã", "ahn", "hum", "humm", "hmm", "hm", "uhm"];
export const DEFAULT_CONTEXTUAL_FILLERS = ["tipo", "então", "então assim", "quer dizer", "sabe"];
export const DEFAULT_SILENCE_MIN_SEC = 0.8;
export const DEFAULT_SILENCE_KEEP_SEC = 0.3;

/** Silence that reads as a pause on its own. */
export const PAUSE_SEC = 0.3;
/** Silence that reads as a pause after punctuation the transcriber wrote. */
export const SHORT_PAUSE_SEC = 0.12;
/** A cut shorter than this is not worth a pill on the timeline. */
const MIN_CUT_SEC = 0.05;

export interface SpeechCleanupOptions {
	/** Pure hesitations: always cut. */
	fillers: readonly string[];
	/** Real words cut only when isolated or repeated (or always, with `aggressive`). */
	contextual: readonly string[];
	aggressive: boolean;
	/** Silences longer than this are shortened. */
	silenceMinSec: number;
	/** What a shortened silence keeps. */
	keepGapSec: number;
}

export type SpeechCleanupReason = "filler" | "repeated" | "isolated" | "aggressive" | "silence";

export interface SpeechCleanupItem {
	/** Stable for the same document: `clipId:startMs`. What the review list's checkboxes key on. */
	id: string;
	kind: "filler" | "silence";
	/** Why the strongest of its words was picked; "silence" for a pause alone. */
	reason: SpeechCleanupReason;
	clipId: string;
	assetId: string;
	/** The cut, in source seconds. */
	startSec: number;
	endSec: number;
	/** The same cut's start on the raw ruler, to seek to it from the list. */
	rawStartSec: number;
	/** The words cut, as the transcript has them ("" for a silence). */
	text: string;
	/** The silence the cut leaves in place of what was there (0 for a filler said mid-flow). */
	keptSec: number;
}

/** One list entry or one transcript word, reduced to what matching compares. */
export function normalizeFillerToken(text: string): string {
	return text
		.normalize("NFC")
		.toLocaleLowerCase("pt-BR")
		.replace(/^[\p{P}\p{S}]+|[\p{P}\p{S}]+$/gu, "")
		.replace(/(\p{L})\1{2,}/gu, "$1$1");
}

/** A preference's text (one entry per line, or comma-separated) as a list of entries. */
export function parseFillerList(text: string): string[] {
	const seen = new Set<string>();
	const out: string[] = [];
	for (const raw of text.split(/[\n,;]/)) {
		const entry = raw.trim().replace(/\s+/g, " ");
		const key = entry.split(" ").map(normalizeFillerToken).filter(Boolean).join(" ");
		if (!key || seen.has(key)) continue;
		seen.add(key);
		out.push(entry);
	}
	return out;
}

export function formatFillerList(entries: readonly string[]): string {
	return entries.join("\n");
}

interface Entry {
	tokens: string[];
	contextual: boolean;
}

function compileEntries(options: SpeechCleanupOptions): Entry[] {
	const compile = (list: readonly string[], contextual: boolean) =>
		list
			.map((entry) => ({
				tokens: entry.split(/\s+/).map(normalizeFillerToken).filter(Boolean),
				contextual,
			}))
			.filter((e) => e.tokens.length > 0);
	// Longest first, so "então assim" is tried before "então"; pure before contextual on a tie.
	return [...compile(options.fillers, false), ...compile(options.contextual, true)].sort(
		(a, b) => b.tokens.length - a.tokens.length || Number(a.contextual) - Number(b.contextual),
	);
}

/** A transcript word the cleanup can reason about: spoken, with a span. */
interface Spoken {
	/** Index in the section's `words` (silence pseudo-words included). */
	index: number;
	startSec: number;
	endSec: number;
	text: string;
	token: string;
	kept: boolean;
}

const ENDS_PHRASE = /[.,;:!?…]["'”’)\]]*$/u;

function matchesAt(spoken: Spoken[], at: number, tokens: string[]): boolean {
	if (at + tokens.length > spoken.length) return false;
	for (let k = 0; k < tokens.length; k++) {
		const w = spoken[at + k];
		if (!w.kept || w.token !== tokens[k]) return false;
	}
	return true;
}

function pauseBefore(spoken: Spoken[], at: number): boolean {
	if (at === 0) return true;
	const prev = spoken[at - 1];
	const gap = spoken[at].startSec - prev.endSec;
	return gap >= PAUSE_SEC || (ENDS_PHRASE.test(prev.text) && gap >= SHORT_PAUSE_SEC);
}

function pauseAfter(spoken: Spoken[], last: number): boolean {
	if (last === spoken.length - 1) return true;
	const gap = spoken[last + 1].startSec - spoken[last].endSec;
	return gap >= PAUSE_SEC || (ENDS_PHRASE.test(spoken[last].text) && gap >= SHORT_PAUSE_SEC);
}

/** Which spoken words are fillers, and why. */
function markFillers(
	spoken: Spoken[],
	entries: Entry[],
	aggressive: boolean,
): SpeechCleanupReason[] {
	const marks: SpeechCleanupReason[] = new Array(spoken.length);
	let i = 0;
	while (i < spoken.length) {
		let advanced = false;
		for (const entry of entries) {
			if (!matchesAt(spoken, i, entry.tokens)) continue;
			const last = i + entry.tokens.length - 1;
			let reason: SpeechCleanupReason | null = null;
			if (!entry.contextual) reason = "filler";
			else if (aggressive) reason = "aggressive";
			else if (matchesAt(spoken, last + 1, entry.tokens)) reason = "repeated";
			else if (pauseBefore(spoken, i) && pauseAfter(spoken, last)) reason = "isolated";
			if (!reason) continue;
			for (let k = i; k <= last; k++) marks[k] = reason;
			i = last + 1;
			advanced = true;
			break;
		}
		if (!advanced) i += 1;
	}
	return marks;
}

const REASON_RANK: SpeechCleanupReason[] = ["filler", "repeated", "isolated", "aggressive"];

/** The review list for one clip's section. */
export function planSectionCleanup(
	section: ClipSection,
	options: SpeechCleanupOptions,
): SpeechCleanupItem[] {
	const { clip, words } = section;
	const spoken: Spoken[] = [];
	words.forEach((cw, index) => {
		if (isSilenceWord(cw.word) || isInsertedWord(cw.word)) return;
		if (!(cw.word.endSec > cw.word.startSec)) return;
		spoken.push({
			index,
			startSec: cw.word.startSec,
			endSec: cw.word.endSec,
			text: cw.word.text,
			token: normalizeFillerToken(cw.word.text),
			kept: cw.kept,
		});
	});
	if (spoken.length === 0) return [];
	const marks = markFillers(spoken, compileEntries(options), options.aggressive);

	const clipStart = clip.sourceStartSec;
	const clipEnd = clip.sourceEndSec ?? Number.POSITIVE_INFINITY;
	// Everything in the section between two spoken words -- the silence pseudo-words and any
	// inserted word -- has to still be in the film, or a trim is already there.
	const untouchedBetween = (fromIndex: number, toIndex: number) => {
		for (let k = fromIndex + 1; k < toIndex; k++) {
			const cw = words[k];
			if (!cw.kept || isInsertedWord(cw.word)) return false;
		}
		return true;
	};

	const items: SpeechCleanupItem[] = [];
	const push = (
		startSec: number,
		endSec: number,
		marked: Spoken[],
		reasons: SpeechCleanupReason[],
		keptSec: number,
	) => {
		const s = Math.max(startSec, clipStart);
		const e = Math.min(endSec, clipEnd);
		if (!(e - s >= MIN_CUT_SEC)) return;
		const reason =
			marked.length === 0 ? "silence" : (REASON_RANK.find((r) => reasons.includes(r)) ?? "filler");
		items.push({
			id: `${clip.id}:${Math.round(s * 1000)}`,
			kind: marked.length === 0 ? "silence" : "filler",
			reason,
			clipId: clip.id,
			assetId: clip.assetId,
			startSec: s,
			endSec: e,
			rawStartSec: placementRawSec(clip, s),
			text: marked.map((w) => w.text.trim()).join(" "),
			keptSec,
		});
	};

	// Anchors: the spoken words that stay. Each run of fillers sits between two of them (or
	// before the first, or after the last); each pair of anchors bounds one candidate cut.
	const anchors = spoken.map((_, k) => k).filter((k) => marks[k] === undefined);
	const between = (from: number, to: number) => {
		const marked: Spoken[] = [];
		const reasons: SpeechCleanupReason[] = [];
		for (let k = from + 1; k < to; k++) {
			marked.push(spoken[k]);
			reasons.push(marks[k]);
		}
		return { marked, reasons };
	};

	// Fillers before the first word that stays.
	const first = anchors[0] ?? spoken.length;
	if (first > 0) {
		const { marked, reasons } = between(-1, first);
		const next = spoken[first];
		const lastMarked = marked[marked.length - 1];
		const endIndex = next ? next.index : words.length;
		if (untouchedBetween(marked[0].index - 1, endIndex) && (!next || next.kept)) {
			const tail = next ? Math.max(0, next.startSec - lastMarked.endSec) : 0;
			const keep = Math.min(tail, options.keepGapSec / 2);
			const endSec = next ? Math.max(lastMarked.endSec, next.startSec - keep) : lastMarked.endSec;
			push(marked[0].startSec, Math.min(endSec, next?.startSec ?? endSec), marked, reasons, keep);
		}
	}

	for (let n = 0; n + 1 < anchors.length; n++) {
		const a = spoken[anchors[n]];
		const b = spoken[anchors[n + 1]];
		if (!a.kept || !b.kept) continue;
		if (!untouchedBetween(a.index, b.index)) continue;
		const { marked, reasons } = between(anchors[n], anchors[n + 1]);
		const gap = b.startSec - a.endSec;
		if (marked.length === 0) {
			if (gap <= options.silenceMinSec) continue;
			const keep = options.keepGapSec;
			push(a.endSec + keep / 2, b.startSec - keep / 2, marked, reasons, keep);
			continue;
		}
		const spokenDur = marked.reduce((sum, w) => sum + (w.endSec - w.startSec), 0);
		const pauses = Math.max(0, gap - spokenDur);
		const keep = pauses > options.silenceMinSec ? options.keepGapSec : pauses;
		let startSec = Math.min(a.endSec + keep / 2, marked[0].startSec);
		let endSec = Math.max(b.startSec - keep / 2, marked[marked.length - 1].endSec);
		// Never into the words that stay, even where the transcriber made them overlap.
		startSec = Math.max(startSec, a.endSec);
		endSec = Math.min(endSec, b.startSec);
		push(startSec, endSec, marked, reasons, Math.max(0, gap - (endSec - startSec)));
	}

	// Fillers after the last word that stays.
	const lastAnchor = anchors[anchors.length - 1];
	if (lastAnchor !== undefined && lastAnchor < spoken.length - 1) {
		const { marked, reasons } = between(lastAnchor, spoken.length);
		const prev = spoken[lastAnchor];
		if (prev.kept && untouchedBetween(prev.index, marked[marked.length - 1].index + 1)) {
			const lead = Math.max(0, marked[0].startSec - prev.endSec);
			const keep = Math.min(lead, options.keepGapSec / 2);
			const startSec = Math.max(prev.endSec, Math.min(marked[0].startSec, prev.endSec + keep));
			push(startSec, marked[marked.length - 1].endSec, marked, reasons, keep);
		}
	}
	return items;
}

/** The review list for the whole recording lane, in timeline order. */
export function planSpeechCleanup(
	document: AxcutDocument,
	options: SpeechCleanupOptions,
): SpeechCleanupItem[] {
	const { clips, trimRanges } = document.timeline;
	const sections = buildAggregatedSections(
		clips,
		document.transcripts,
		document.assets,
		removedRawSpans(clips, trimRanges),
	);
	const clipsById = new Map(clips.map((c) => [c.id, c]));
	// The word tagging asks about a word's centre; a cut is checked whole, so a trim the
	// user drew inside a long silence is never overlapped by a second one.
	const overlapsTrim = (item: SpeechCleanupItem) => {
		const owner = clipsById.get(item.clipId);
		return trimRanges.some(
			(t) =>
				owner !== undefined &&
				trimAppliesToClip(t, owner) &&
				t.startSec < item.endSec &&
				t.endSec > item.startSec,
		);
	};
	return sections
		.flatMap((section) => (section.transcript ? planSectionCleanup(section, options) : []))
		.filter((item) => !overlapsTrim(item))
		.sort((a, b) => a.rawStartSec - b.rawStartSec);
}

/** Seconds the picked items take out of the film. */
export function speechCleanupSavedSec(items: readonly SpeechCleanupItem[]): number {
	return items.reduce((sum, item) => sum + (item.endSec - item.startSec), 0);
}

/**
 * The document with one trim per picked item, as one edit. Each cut is snapped onto a
 * neighbouring cut of the same clip when only a frame or two would be left between them
 * (`mergeCloseCuts`), against the trims already there and the ones added before it.
 */
export function applySpeechCleanup(
	document: AxcutDocument,
	items: readonly SpeechCleanupItem[],
	makeId: (prefix: string) => string,
): AxcutDocument {
	if (items.length === 0) return document;
	const clipsById = new Map(document.timeline.clips.map((c) => [c.id, c]));
	const trims: AxcutTrimRange[] = [...document.timeline.trimRanges];
	for (const item of items) {
		const clip = clipsById.get(item.clipId);
		if (!clip || clip.assetId !== item.assetId) continue;
		const merged = mergeCloseCuts(
			{ startSec: item.startSec, endSec: item.endSec },
			trims.filter((t) => trimAppliesToClip(t, clip)),
			document.assets.find((a) => a.id === item.assetId)?.video?.fps,
		);
		trims.push({
			id: makeId("trim"),
			assetId: item.assetId,
			clipId: item.clipId,
			startSec: merged.startSec,
			endSec: merged.endSec,
			reason:
				item.kind === "silence"
					? `Clean up speech: silence shortened to ${item.keptSec.toFixed(2)}s.`
					: `Clean up speech: "${item.text}" (${item.reason}).`,
			origin: "user",
		});
	}
	return { ...document, timeline: { ...document.timeline, trimRanges: trims } };
}

/**
 * The picks from a review list, applied to `document` as it is NOW: planned again with the
 * options the list was made with, and only the items still planned (same id) cut. What
 * the shell's write chain runs, so an edit that landed after the list was shown is neither
 * overwritten nor cut against.
 */
export function applySpeechCleanupPicks(
	document: AxcutDocument,
	itemIds: readonly string[],
	options: SpeechCleanupOptions,
	makeId: (prefix: string) => string,
): { document: AxcutDocument; items: SpeechCleanupItem[] } {
	const wanted = new Set(itemIds);
	const items = planSpeechCleanup(document, options).filter((item) => wanted.has(item.id));
	return { document: applySpeechCleanup(document, items, makeId), items };
}
