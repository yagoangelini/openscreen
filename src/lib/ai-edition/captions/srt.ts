import { projectRawTimelineSecToPlayback, readSpeedRegions } from "../document/timeline";
import type { AxcutDocument } from "../schema";
import { type CaptionCue, deriveCaptionCues } from "./cues";
import { getCaptionSettings } from "./settings";
import { getCaptionTranslations } from "./translations";

/**
 * The captions as an .srt file, timed to the EXPORTED video: the cues live on the
 * raw ruler, and the export has dropped the trims and played the speed regions
 * faster, so each time goes through the same projection the audio mix uses.
 *
 * Built whether or not the captions are burned in: an uploaded .srt is what
 * YouTube indexes and lets viewers switch off, so it is worth having either way.
 */

/** "00:01:02,345" */
export function formatSrtTime(sec: number): string {
	const ms = Math.max(0, Math.round(sec * 1000));
	const h = Math.floor(ms / 3_600_000);
	const m = Math.floor((ms % 3_600_000) / 60_000);
	const s = Math.floor((ms % 60_000) / 1000);
	const rest = ms % 1000;
	const pad = (n: number, w = 2) => String(n).padStart(w, "0");
	return `${pad(h)}:${pad(m)}:${pad(s)},${pad(rest, 3)}`;
}

export function cuesToSrt(cues: CaptionCue[], toOutputSec: (rawSec: number) => number): string {
	let index = 0;
	const blocks: string[] = [];
	for (const cue of cues) {
		const text = cue.text.trim();
		if (!text) continue;
		const start = toOutputSec(cue.startMs / 1000);
		const end = toOutputSec(cue.endMs / 1000);
		// A cue whose whole span was trimmed away collapses to a point: nothing plays it.
		if (end - start < 0.05) continue;
		index += 1;
		blocks.push(`${index}\n${formatSrtTime(start)} --> ${formatSrtTime(end)}\n${text}`);
	}
	return blocks.length > 0 ? `${blocks.join("\n\n")}\n` : "";
}

/** The document's captions as .srt text, or "" when it has none to give. */
export function documentToSrt(document: AxcutDocument): string {
	const settings = { ...getCaptionSettings(document, 16 / 9), enabled: true };
	const cues = deriveCaptionCues(document, settings, getCaptionTranslations(document));
	const speedRegions = readSpeedRegions(document);
	return cuesToSrt(cues, (rawSec) =>
		projectRawTimelineSecToPlayback(
			document.timeline.clips,
			document.timeline.trimRanges,
			rawSec,
			speedRegions,
		),
	);
}
