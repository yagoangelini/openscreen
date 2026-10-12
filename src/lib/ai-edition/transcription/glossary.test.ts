import { describe, expect, it } from "vitest";
import type { AxcutTranscript } from "../schema";
import { applyGlossary, DEFAULT_GLOSSARY, parseGlossary, upgradeStoredGlossary } from "./glossary";

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

describe("applyGlossary on a transcript the user already edited", () => {
	it("never overrules a word the user corrected or typed in", () => {
		const base = transcriptOf(["abra", "o", "share", "point", "e", "o", "share", "point"]);
		const edited: AxcutTranscript = {
			...base,
			words: base.words.map((word, i) =>
				// The user rewrote the second "share" by hand: that pair is theirs.
				i === 6 ? { ...word, text: "share", originalText: "chair" } : word,
			),
		};
		const { transcript, replaced } = applyGlossary(
			edited,
			parseGlossary("SharePoint: share point"),
			{
				keepEditedWords: true,
			},
		);
		expect(replaced).toBe(1);
		expect(transcript.words.map((w) => w.text)).toEqual([
			"abra",
			"o",
			"SharePoint",
			"e",
			"o",
			"share",
			"point",
		]);
	});

	it("fixes them like any other word on a fresh transcript", () => {
		const base = transcriptOf(["share", "point"]);
		const edited: AxcutTranscript = {
			...base,
			words: base.words.map((word) => ({ ...word, originalText: "x" })),
		};
		expect(applyGlossary(edited, parseGlossary("SharePoint: share point")).replaced).toBe(1);
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

describe("DEFAULT_GLOSSARY on what Whisper really wrote", () => {
	// Lines out of small and large-v3-turbo on pt-BR tutorial speech (docs/HANDOFF.md).
	const fix = (text: string) =>
		applyGlossary(transcriptOf(text.split(" ")), glossary)
			.transcript.words.map((w) => w.text)
			.join(" ");

	it("puts the Microsoft and AI names right", () => {
		expect(fix("entre no Timoz com a sua conta do Tenet.")).toBe(
			"entre no Teams com a sua conta do tenant.",
		);
		expect(fix("uma pasta do Andrile ou")).toBe("uma pasta do OneDrive ou");
		expect(fix("ficam no Pervil. e no pervio")).toBe("ficam no Purview. e no Purview");
		expect(fix("o EJAR OpenAI e o Eger")).toBe("o Azure OpenAI e o Azure");
		expect(fix("o Microsoft Febric junta")).toBe("o Microsoft Fabric junta");
		expect(fix("como o chat GPT ou")).toBe("como o ChatGPT ou");
		expect(fix("pelo MCP, o model context protocol.")).toBe("pelo MCP, o Model Context Protocol.");
		expect(fix("se a sua licença e três")).toBe("se a sua licença E3");
	});

	it("leaves the Portuguese words that sound like a product alone", () => {
		const speech = "a gente vai defender a ordem na cloud";
		expect(fix(speech)).toBe(speech);
	});
});

describe("upgradeStoredGlossary", () => {
	it("moves an untouched older default to the current one", () => {
		const shipped = [
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
		];
		expect(upgradeStoredGlossary(shipped.join("\n"))).toBe(DEFAULT_GLOSSARY);
		expect(upgradeStoredGlossary(shipped.join("\r\n"))).toBe(DEFAULT_GLOSSARY);
	});

	it("keeps a glossary the user edited, and the current default, as they are", () => {
		const mine = "Contoso: contozo";
		expect(upgradeStoredGlossary(mine)).toBe(mine);
		expect(upgradeStoredGlossary(DEFAULT_GLOSSARY)).toBe(DEFAULT_GLOSSARY);
		expect(upgradeStoredGlossary("")).toBe("");
	});
});
