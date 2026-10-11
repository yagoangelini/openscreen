// What the speaker says, as cues for the automatic zooms. The planner works from the cursor;
// these tell it when the speaker points at something ("clica aqui, nesse botão"), when they are
// still setting the scene, and where their sentences end, so a zoom arrives with the words and
// goes back out in a pause instead of mid-sentence.
//
// The words are the transcript's, in the recording's SOURCE time (the telemetry's axis), in ms.
// Tuned for Brazilian Portuguese tutorials, with the English equivalents alongside.

export interface SpokenWord {
	startMs: number;
	endMs: number;
	text: string;
}

export interface Sentence {
	startMs: number;
	endMs: number;
	words: SpokenWord[];
}

export interface Speech {
	words: SpokenWord[];
	sentences: Sentence[];
}

/** A silence this long between two words ends a sentence, punctuation or not. */
export const SENTENCE_PAUSE_MS = 600;

/**
 * Words that point at something on the screen, accents and case dropped. Demonstratives alone
 * ("esse", "isso") are left out: spoken Portuguese uses them everywhere, pointing or not.
 */
const POINTING = new Set([
	"nesse",
	"nessa",
	"nesses",
	"nessas",
	"neste",
	"nesta",
	"naquele",
	"naquela",
	"clica",
	"clicar",
	"clique",
	"clicamos",
	"clicando",
	"cliquei",
	"clico",
	"seleciona",
	"selecionar",
	"selecione",
	"selecionando",
	"escolhe",
	"escolher",
	"escolha",
	"marca",
	"marcar",
	"botao",
	"botaozinho",
	"opcao",
	"opcoes",
	"icone",
	"iconezinho",
	"menu",
	"campo",
	"aba",
	"link",
	"click",
	"select",
	"button",
	"option",
	"tab",
]);

/**
 * Pointing too, but loosely: "testando aqui", "vamos ver aqui" say nothing about the screen. They
 * count beside a click, or beside a pointer that explores; alone they do not make a zoom.
 */
const LOOSELY_POINTING = new Set(["aqui", "ali", "here"]);

/** Words that say the view is about to move on: the zoom goes wide for them. */
const SCROLLING = new Set([
	"rolar",
	"rola",
	"role",
	"rolando",
	"rolamos",
	"descer",
	"desce",
	"descendo",
	"scroll",
	"scrolling",
]);

/** Lower case, no accents, no punctuation around it. */
export function normalizeWord(text: string): string {
	return text
		.normalize("NFD")
		.replace(/[̀-ͯ]/g, "")
		.toLowerCase()
		.replace(/^[^a-z0-9]+|[^a-z0-9]+$/g, "");
}

export function isPointingWord(word: SpokenWord, strictly = false): boolean {
	const normalized = normalizeWord(word.text);
	return POINTING.has(normalized) || (!strictly && LOOSELY_POINTING.has(normalized));
}

export function isScrollingWord(word: SpokenWord): boolean {
	return SCROLLING.has(normalizeWord(word.text));
}

const ENDS_SENTENCE = /[.!?…]["')\]]*$/;

/** The words, in time order, grouped into sentences by punctuation and pauses. */
export function readSpeech(words: readonly SpokenWord[]): Speech {
	const sorted = words
		.filter((word) => word.text.trim() !== "" && Number.isFinite(word.startMs))
		.map((word) => ({ ...word, endMs: Math.max(word.endMs, word.startMs) }))
		.sort((a, b) => a.startMs - b.startMs);
	const sentences: Sentence[] = [];
	let current: SpokenWord[] = [];
	const close = () => {
		if (current.length === 0) return;
		sentences.push({
			startMs: current[0].startMs,
			endMs: current[current.length - 1].endMs,
			words: current,
		});
		current = [];
	};
	for (const word of sorted) {
		const previous = current[current.length - 1];
		if (previous && word.startMs - previous.endMs >= SENTENCE_PAUSE_MS) close();
		current.push(word);
		if (ENDS_SENTENCE.test(word.text.trim())) close();
	}
	close();
	return { words: sorted, sentences };
}

/** The pointing words said between `fromMs` and `toMs`; `strictly` leaves out "aqui" and "ali". */
export function pointingWordsBetween(
	speech: Speech,
	fromMs: number,
	toMs: number,
	strictly = false,
): SpokenWord[] {
	return speech.words.filter(
		(word) => word.endMs >= fromMs && word.startMs <= toMs && isPointingWord(word, strictly),
	);
}

/** "pra baixo", "para baixo": scrolling said without the verb, or with one Whisper misheard. */
function isDownwards(words: readonly SpokenWord[], index: number): boolean {
	const previous = words[index - 1];
	return (
		normalizeWord(words[index].text) === "baixo" &&
		previous !== undefined &&
		["pra", "para"].includes(normalizeWord(previous.text))
	);
}

/** The first scrolling word said between `fromMs` and `toMs`, if any. */
export function scrollingWordBetween(
	speech: Speech,
	fromMs: number,
	toMs: number,
): SpokenWord | undefined {
	const { words } = speech;
	return words.find(
		(word, index) =>
			word.startMs >= fromMs &&
			word.startMs <= toMs &&
			(isScrollingWord(word) || isDownwards(words, index)),
	);
}

/** The sentence being said at `timeMs`, if any. */
export function sentenceAt(speech: Speech, timeMs: number): Sentence | undefined {
	return speech.sentences.find((s) => s.startMs <= timeMs && timeMs < s.endMs);
}

/** The word being said at `timeMs`, if any. */
export function wordAt(speech: Speech, timeMs: number): SpokenWord | undefined {
	return speech.words.find((word) => word.startMs <= timeMs && timeMs < word.endMs);
}

/** The words that fall in `[fromMs, toMs]`, shifted by `-offsetMs`: one clip's window. */
export function speechWindow(
	words: readonly SpokenWord[],
	fromMs: number,
	toMs: number,
	offsetMs: number,
): SpokenWord[] {
	return words
		.filter((word) => word.startMs >= fromMs && word.startMs <= toMs)
		.map((word) => ({ ...word, startMs: word.startMs - offsetMs, endMs: word.endMs - offsetMs }));
}
