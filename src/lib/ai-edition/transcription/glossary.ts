import type { AxcutTranscript } from "../schema";

/**
 * The glossary: product names the transcription gets wrong, put right after it.
 *
 * Whisper hears "Power Automate" as "power automeite" and writes "SharePoint" as
 * "share point". The server it runs in takes no prompt to steer it, so instead the
 * words it returns are matched against a list -- each line a term and the ways it
 * comes out misheard -- and a match is replaced by the term, keeping the timing of
 * the words it covers and any punctuation after them. Editable, one line per term:
 *
 *     Power Automate: power automeite, pauer automate
 *
 * The term itself always matches too, so a wrongly cased "sharepoint" is fixed by
 * the line "SharePoint" alone.
 */

export const DEFAULT_GLOSSARY = [
	"SharePoint: share point, sherpoint, xerpoint, sharepoit, shere point",
	"Power Automate: power automeite, pauer automate, power automat, power autometi",
	"Power Apps: powerapps, pauer apps, power aps",
	"Power BI: power b i, pauer bi, power bi, power bí, power biai",
	"Power Platform: pauer platform, power plataform",
	"Power Pages: pauer pages",
	"Copilot: copailot, copailote, copilote, co-pilot",
	"Copilot Studio: copailot studio, copilot estudio",
	"Microsoft 365: microsoft trezentos e sessenta e cinco",
	"Microsoft Teams: microsoft tims",
	"OneDrive: one drive, uandraive, wandraive, wan drive",
	"Outlook: autlook, aut luk, out look",
	"Dataverse: data verse, deiraverse, dataversi, data versi",
	"Entra ID: entra aidi, entra ai di",
	"Planner: planer",
	"Loop: lupe",
	"Viva Engage: viva engeidge",
].join("\n");

interface Entry {
	term: string;
	/** Each variant as normalised tokens; the term's own tokens included. */
	variants: string[][];
}

/** Lowercase, accents and punctuation off: how a word is compared. */
function normalise(text: string): string {
	return text
		.normalize("NFD")
		.replace(/[̀-ͯ]/g, "")
		.toLowerCase()
		.replace(/[^\p{L}\p{N}]+/gu, "");
}

export function parseGlossary(text: string): Entry[] {
	const entries: Entry[] = [];
	for (const raw of text.split(/\r?\n/)) {
		const line = raw.trim();
		if (!line || line.startsWith("#")) continue;
		const colon = line.indexOf(":");
		const term = (colon >= 0 ? line.slice(0, colon) : line).trim();
		if (!term) continue;
		const spoken = colon >= 0 ? line.slice(colon + 1).split(",") : [];
		const variants = [term, ...spoken]
			.map((v) => v.trim().split(/\s+/).map(normalise).filter(Boolean))
			.filter((tokens) => tokens.length > 0);
		entries.push({ term, variants });
	}
	return entries;
}

/** Punctuation the last word of a match ended with, carried over to the term. */
function trailingPunctuation(text: string): string {
	return text.match(/[^\p{L}\p{N}]+$/u)?.[0] ?? "";
}
function leadingPunctuation(text: string): string {
	return text.match(/^[^\p{L}\p{N}]+/u)?.[0] ?? "";
}

/**
 * The transcript with the glossary applied. A match folds its words into the first
 * one, which takes the term and stretches to the last one's end; the others leave
 * the transcript and their segments. Returns the same object when nothing matched.
 *
 * `keepEditedWords`: never touch a word the user corrected or typed in. A fresh
 * transcript has none (their corrections are carried over after the glossary); an
 * existing one does, and the glossary is not allowed to overrule them.
 */
export function applyGlossary(
	transcript: AxcutTranscript,
	glossary: Entry[],
	options: { keepEditedWords?: boolean } = {},
): { transcript: AxcutTranscript; replaced: number } {
	// Longer variants first, so "copilot studio" wins over "copilot".
	const candidates = glossary
		.flatMap((entry) => entry.variants.map((tokens) => ({ term: entry.term, tokens })))
		.sort((a, b) => b.tokens.length - a.tokens.length);
	if (candidates.length === 0) return { transcript, replaced: 0 };
	const words = transcript.words;
	const keys = words.map((word) => normalise(word.text));
	const locked = (word: AxcutTranscript["words"][number]) =>
		options.keepEditedWords === true &&
		(word.originalText !== undefined || (word.source !== undefined && word.source !== "asr"));
	const out: AxcutTranscript["words"] = [];
	const removed = new Set<string>();
	let replaced = 0;
	for (let i = 0; i < words.length; ) {
		const match = candidates.find(
			(c) =>
				i + c.tokens.length <= words.length &&
				c.tokens.every((token, k) => keys[i + k] === token && !locked(words[i + k])) &&
				// Within one segment: a term never straddles two caption lines.
				words[i + c.tokens.length - 1].segmentId === words[i].segmentId,
		);
		if (!match) {
			out.push(words[i]);
			i += 1;
			continue;
		}
		const first = words[i];
		const last = words[i + match.tokens.length - 1];
		const text = `${leadingPunctuation(first.text)}${match.term}${trailingPunctuation(last.text)}`;
		if (text !== first.text || match.tokens.length > 1) replaced += 1;
		out.push({ ...first, text, endSec: last.endSec });
		for (let k = 1; k < match.tokens.length; k++) removed.add(words[i + k].id);
		i += match.tokens.length;
	}
	if (replaced === 0) return { transcript, replaced: 0 };
	const byId = new Map(out.map((word) => [word.id, word]));
	const segments = transcript.segments.map((segment) => {
		const wordIds = segment.wordIds.filter((id) => !removed.has(id));
		const text = wordIds
			.map((id) => byId.get(id)?.text ?? "")
			.filter(Boolean)
			.join(" ");
		return { ...segment, wordIds, text: text || segment.text };
	});
	return { transcript: { ...transcript, words: out, segments }, replaced };
}
