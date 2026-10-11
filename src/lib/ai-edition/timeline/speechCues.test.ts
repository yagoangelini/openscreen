import { describe, expect, it } from "vitest";
import {
	isPointingWord,
	normalizeWord,
	pointingWordsBetween,
	readSpeech,
	scrollingWordBetween,
	speechWindow,
} from "./speechCues";

const word = (startMs: number, text: string, endMs = startMs + 250) => ({ startMs, endMs, text });

describe("speechCues", () => {
	it("compares words without case, accents or punctuation", () => {
		expect(normalizeWord("Botão,")).toBe("botao");
		expect(isPointingWord(word(0, "Opção."))).toBe(true);
		expect(isPointingWord(word(0, "isso"))).toBe(false);
	});

	it("counts 'aqui' as pointing only when not asked strictly", () => {
		const speech = readSpeech([word(0, "testando"), word(300, "aqui")]);
		expect(pointingWordsBetween(speech, 0, 1000)).toHaveLength(1);
		expect(pointingWordsBetween(speech, 0, 1000, true)).toHaveLength(0);
	});

	it("splits sentences at punctuation and at pauses", () => {
		const speech = readSpeech([
			word(0, "Fala"),
			word(300, "pessoal."),
			word(600, "Hoje"),
			word(900, "vamos"),
			word(2000, "começar"),
		]);
		expect(speech.sentences.map((s) => s.words.map((w) => w.text).join(" "))).toEqual([
			"Fala pessoal.",
			"Hoje vamos",
			"começar",
		]);
	});

	it("hears scrolling, also as 'pra baixo' without the verb", () => {
		const speech = readSpeech([word(0, "voar"), word(300, "pra"), word(600, "baixo")]);
		expect(scrollingWordBetween(speech, 0, 1000)?.text).toBe("baixo");
		expect(scrollingWordBetween(readSpeech([word(0, "rolando")]), 0, 1000)?.text).toBe("rolando");
	});

	it("takes one clip's window, shifted onto it", () => {
		expect(speechWindow([word(500, "a"), word(5000, "b")], 4000, 6000, 4000)).toEqual([
			{ startMs: 1000, endMs: 1250, text: "b" },
		]);
	});
});
