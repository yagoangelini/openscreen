import { sourceSpanToTimelineSpans } from "./captions/cues";
import { projectRawTimelineSecToPlayback, readSpeedRegions } from "./document/timeline";
import type { AxcutDocument } from "./schema";
import { findAssetTranscript } from "./transcription/status";

/**
 * YouTube chapters for the description box, built locally from the edit.
 *
 * Boundaries come from the marks the user left with the marker shortcut while
 * recording; without any, from long pauses in the speech. Each title is the first
 * words spoken after its boundary, for the user to edit -- a starting point, not a
 * finished description, and no network or model involved.
 *
 * YouTube's own rules shape the output: the first chapter starts at 0:00 and none
 * is shorter than 10 seconds.
 *
 * Every time here is on the EXPORTED video's clock, like the .srt beside it: the clips
 * place words and markers on the raw ruler, and the export then drops the trims and
 * plays the speed regions faster, so a chapter read off the raw ruler would point past
 * its moment by everything cut or sped up before it.
 */

/** YouTube ignores a chapter list with a chapter under this. */
export const MIN_CHAPTER_SEC = 10;

/** A silence this long in the speech is taken as a change of subject. */
export const CHAPTER_PAUSE_SEC = 4;

/** How many spoken words make a title. */
const TITLE_WORDS = 6;

export interface Chapter {
	startSec: number;
	title: string;
}

interface TimedWord {
	sec: number;
	endSec: number;
	text: string;
}

/** Raw-ruler seconds to the exported video's, through its trims and speed regions. */
function playbackClock(document: AxcutDocument): (rawSec: number) => number {
	const { clips, trimRanges } = document.timeline;
	const speedRegions = readSpeedRegions(document);
	return (rawSec) => projectRawTimelineSecToPlayback(clips, trimRanges, rawSec, speedRegions);
}

/** How long the exported video runs. */
function playbackDurationSec(document: AxcutDocument): number {
	const rawEnd = document.timeline.clips.reduce(
		(max, clip) => Math.max(max, clip.timelineEndSec),
		0,
	);
	return rawEnd > 0 ? playbackClock(document)(rawEnd) : 0;
}

/** A word the export cut away collapses to (almost) nothing on its clock. */
const TRIMMED_WORD_SEC = 0.01;

/** Every transcribed word the export plays, in order, at the time it plays there. */
function timelineWords(document: AxcutDocument): TimedWord[] {
	const clips = document.timeline.clips;
	const toPlayback = playbackClock(document);
	const words: TimedWord[] = [];
	for (const asset of document.assets) {
		const transcript = findAssetTranscript(document, asset.id);
		if (!transcript) continue;
		for (const word of transcript.words) {
			for (const span of sourceSpanToTimelineSpans(asset.id, word.startSec, word.endSec, clips)) {
				const sec = toPlayback(span.startSec);
				const endSec = toPlayback(span.endSec);
				if (endSec - sec < TRIMMED_WORD_SEC) continue;
				words.push({ sec, endSec, text: word.text });
			}
		}
	}
	return words.sort((a, b) => a.sec - b.sec);
}

/**
 * Every marker of the timeline, at the time the export plays it. A marker inside a
 * trimmed stretch lands where the kept content resumes, which is where the section
 * it opened now starts.
 */
function timelineMarkers(document: AxcutDocument): number[] {
	const clips = document.timeline.clips;
	const toPlayback = playbackClock(document);
	return document.assets
		.flatMap((asset) =>
			(asset.markersSec ?? []).flatMap((sec) =>
				sourceSpanToTimelineSpans(asset.id, sec, sec + 0.001, clips).map((span) =>
					toPlayback(span.startSec),
				),
			),
		)
		.sort((a, b) => a - b);
}

function pauseBoundaries(words: TimedWord[]): number[] {
	const out: number[] = [];
	for (let index = 1; index < words.length; index++) {
		if (words[index].sec - words[index - 1].endSec >= CHAPTER_PAUSE_SEC) {
			out.push(words[index].sec);
		}
	}
	return out;
}

function titleAt(words: TimedWord[], startSec: number, endSec: number): string {
	const spoken = words
		.filter((word) => word.sec >= startSec - 0.05 && word.sec < endSec)
		.slice(0, TITLE_WORDS)
		.map((word) => word.text.trim())
		.filter(Boolean)
		.join(" ")
		.replace(/\s+([,.;:!?])/g, "$1")
		.replace(/[,.;:]+$/, "");
	return spoken ? spoken.charAt(0).toUpperCase() + spoken.slice(1) : "";
}

export function buildChapters(
	document: AxcutDocument,
	options: { fallbackTitle: (index: number) => string },
): Chapter[] {
	const totalSec = playbackDurationSec(document);
	if (totalSec <= 0) return [];
	const words = timelineWords(document);
	const markers = timelineMarkers(document);
	const candidates = markers.length > 0 ? markers : pauseBoundaries(words);

	// 0:00 first, then every boundary that leaves both neighbours at least the minimum.
	const starts = [0];
	for (const sec of candidates) {
		if (sec - starts[starts.length - 1] >= MIN_CHAPTER_SEC && totalSec - sec >= MIN_CHAPTER_SEC) {
			starts.push(sec);
		}
	}
	return starts.map((startSec, index) => ({
		startSec,
		title:
			titleAt(words, startSec, starts[index + 1] ?? totalSec) || options.fallbackTitle(index + 1),
	}));
}

/** "0:00", "4:07", "1:02:09" -- the timestamp form YouTube links. */
export function formatChapterTime(sec: number): string {
	const whole = Math.max(0, Math.floor(sec));
	const hours = Math.floor(whole / 3600);
	const minutes = Math.floor((whole % 3600) / 60);
	const seconds = whole % 60;
	const ss = String(seconds).padStart(2, "0");
	return hours > 0 ? `${hours}:${String(minutes).padStart(2, "0")}:${ss}` : `${minutes}:${ss}`;
}

/** The lines to paste into a YouTube description. */
export function formatChaptersForYouTube(chapters: Chapter[]): string {
	return chapters
		.map((chapter) => `${formatChapterTime(chapter.startSec)} ${chapter.title}`)
		.join("\n");
}

/** What is said during each chapter, for writing its title: up to `maxChars` of it. */
export function chapterTranscripts(
	document: AxcutDocument,
	chapters: Chapter[],
	maxChars = 400,
): string[] {
	const words = timelineWords(document);
	const totalSec = playbackDurationSec(document);
	return chapters.map((chapter, index) => {
		const endSec = chapters[index + 1]?.startSec ?? totalSec;
		const text = words
			.filter((word) => word.sec >= chapter.startSec - 0.05 && word.sec < endSec)
			.map((word) => word.text.trim())
			.filter(Boolean)
			.join(" ");
		return text.length > maxChars ? `${text.slice(0, maxChars)}…` : text;
	});
}
