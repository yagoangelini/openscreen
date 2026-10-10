import { describe, expect, it } from "vitest";
import type { AxcutTranscript } from "../schema";
import { applyGlossary, DEFAULT_GLOSSARY, parseGlossary } from "./glossary";

function transcriptOf(
	texts: string[],
	segmentOf: (i: number) => string = () => "s1",
): AxcutTranscript {
	const words = texts.map((text, i) => ({
		id: `w${i}`,
		segmentId: segmentOf(i),
		startSec: i,
		endSec: i + 0.8,
		text,
	}));
	const segmentIds = [...new Set(words.map((w) => w.segmentId))];
	return {
		assetId: "a1",
		language: "pt",
		segments: segmentIds.map((id) => ({
			id,
			kind: "speech" as const,
			startSec: 0,
			endSec: texts.length,
			text: words
				.filter((w) => w.segmentId === id)
				.map((w) => w.text)
				.join(" "),
			wordIds: words.filter((w) => w.segmentId === id).map((w) => w.id),
		})),
		words,
	} as AxcutTranscript;
}

const glossary = parseGlossary(DEFAULT_GLOSSARY);

describe("applyGlossary", () => {
	it("folds a misheard name into one word with the term, timing kept, punctuation carried", () => {
		const { transcript, replaced } = applyGlossary(
			transcriptOf(["vamos", "abrir", "o", "power", "automeite,", "e", "depois"]),
			glossary,
		);
		expect(replaced).toBe(1);
		expect(transcript.words.map((w) => w.text)).toEqual([
			"vamos",
			"abrir",
			"o",
			"Power Automate,",
			"e",
			"depois",
		]);
		const term = transcript.words[3];
		expect([term.startSec, term.endSec]).toEqual([3, 4.8]);
		expect(transcript.segments[0].wordIds).not.toContain("w4");
		expect(transcript.segments[0].text).toBe("vamos abrir o Power Automate, e depois");
	});

	it("fixes the case of the term itself, and prefers the longer match", () => {
		const { transcript } = applyGlossary(
			transcriptOf(["no", "sharepoint", "e", "no", "copilot", "studio."]),
			glossary,
		);
		expect(transcript.words.map((w) => w.text)).toEqual([
			"no",
			"SharePoint",
			"e",
			"no",
			"Copilot Studio.",
		]);
	});

	it("does not join words across two segments, and leaves a clean transcript alone", () => {
		const split = transcriptOf(["share", "point"], (i) => `s${i}`);
		expect(applyGlossary(split, glossary).replaced).toBe(0);
		const clean = transcriptOf(["abrir", "a", "lista"]);
		expect(applyGlossary(clean, glossary).transcript).toBe(clean);
	});
});

describe("parseGlossary", () => {
	it("reads terms with or without variants, skipping comments and blanks", () => {
		const entries = parseGlossary("# meus termos\n\nTenant X: tenante xis\nContoso\n");
		expect(entries.map((e) => [e.term, e.variants])).toEqual([
			[
				"Tenant X",
				[
					["tenant", "x"],
					["tenante", "xis"],
				],
			],
			["Contoso", [["contoso"]]],
		]);
	});
});
