import { describe, expect, it, vi } from "vitest";
import type { AxcutTranscript } from "../schema";
import { labelTranscriptFromStems } from "./speakerStems";
import { labelSpeakers, peakAmplitudes, transcriptHasTwoSpeakers } from "./speakers";

const BLOCKS_PER_SEC = 100;

/** [min, max] peaks over `durationSec`, with `amp` inside each [start, end) span, a floor elsewhere. */
function peaks(durationSec: number, spans: Array<[number, number, number]>, floor = 0.002) {
	const n = Math.round(durationSec * BLOCKS_PER_SEC);
	const out = new Float32Array(n * 2);
	for (let i = 0; i < n; i++) {
		const t = i / BLOCKS_PER_SEC;
		const amp = spans.find(([s, e]) => t >= s && t < e)?.[2] ?? floor;
		out[2 * i] = -amp;
		out[2 * i + 1] = amp;
	}
	return out;
}

function transcript(spec: Array<[string, number, number, string?]>): AxcutTranscript {
	const words = spec.map(([text, startSec, endSec, seg], i) => ({
		id: `w${i + 1}`,
		segmentId: seg ?? "s1",
		startSec,
		endSec,
		text,
	}));
	const segIds = [...new Set(words.map((w) => w.segmentId))];
	return {
		assetId: "a",
		language: "pt",
		words,
		segments: segIds.map((id) => {
			const own = words.filter((w) => w.segmentId === id);
			return {
				id,
				kind: "speech" as const,
				startSec: own[0].startSec,
				endSec: own[own.length - 1].endSec,
				text: own.map((w) => w.text).join(" "),
				wordIds: own.map((w) => w.id),
			};
		}),
	};
}

describe("peakAmplitudes", () => {
	it("takes the larger magnitude of each [min, max] pair", () => {
		expect(Array.from(peakAmplitudes(new Float32Array([-0.5, 0.2, -0.1, 0.3])))).toEqual([
			0.5,
			expect.closeTo(0.3, 5),
		]);
	});
});

describe("labelSpeakers", () => {
	it("labels each word by the stem that is louder over its span", () => {
		// You speak 0-2 s on the mic, the guest 3-5 s from the computer.
		const voice = peaks(6, [[0, 2, 0.3]]);
		const system = peaks(6, [[3, 5, 0.6]]);
		const t = transcript([
			["Bom", 0.1, 0.5, "s1"],
			["dia.", 0.6, 1.2, "s1"],
			["Olá,", 3.1, 3.6, "s2"],
			["tudo", 3.7, 4.2, "s2"],
			["bem?", 4.3, 4.9, "s2"],
		]);
		const result = labelSpeakers(t, voice, system, 6);
		expect(result.transcript.words.map((w) => w.speaker)).toEqual([
			"mic",
			"mic",
			"system",
			"system",
			"system",
		]);
		expect(result.transcript.segments.map((s) => s.speaker)).toEqual(["mic", "system"]);
		expect(result).toMatchObject({ mic: 2, system: 3 });
		expect(transcriptHasTwoSpeakers(result.transcript)).toBe(true);
	});

	it("compares each stem against its own level, so a quiet mic still wins its words", () => {
		// The mic speaks at a tenth of the call's loudness; the call has music under it all along.
		const voice = peaks(4, [[0, 1.5, 0.05]], 0.001);
		const system = peaks(4, [
			[2, 3.5, 0.8],
			[0, 4, 0.04],
		]);
		const t = transcript([
			["Agora", 0.2, 0.7],
			["sim", 0.8, 1.2],
			["Perfeito", 2.2, 3.0, "s2"],
		]);
		const words = labelSpeakers(t, voice, system, 4).transcript.words;
		expect(words.map((w) => w.speaker)).toEqual(["mic", "mic", "system"]);
	});

	it("gives an undecided word the speaker of the word before it in its segment", () => {
		// Crosstalk at 1.0-1.4 s: both stems equally loud.
		const voice = peaks(3, [
			[0, 0.9, 0.3],
			[1.0, 1.4, 0.3],
		]);
		const system = peaks(3, [[1.0, 1.4, 0.3]]);
		const t = transcript([
			["Isso", 0.1, 0.5],
			["aqui", 0.55, 0.85],
			["junto", 1.05, 1.35],
		]);
		const words = labelSpeakers(t, voice, system, 3).transcript.words;
		expect(words.map((w) => w.speaker)).toEqual(["mic", "mic", "mic"]);
	});

	it("labels nothing, and clears old labels, when no word can be told apart", () => {
		const silent = peaks(2, []);
		const t = transcript([["Oi", 0.1, 0.4]]);
		const stale: AxcutTranscript = {
			...t,
			words: t.words.map((w) => ({ ...w, speaker: "system" as const })),
		};
		const result = labelSpeakers(stale, silent, silent, 2);
		expect(result).toMatchObject({ mic: 0, system: 0 });
		expect(result.transcript.words[0]).not.toHaveProperty("speaker");
		expect(transcriptHasTwoSpeakers(result.transcript)).toBe(false);
	});

	it("does not call a take with one speaker a conversation", () => {
		const voice = peaks(2, [[0, 2, 0.3]]);
		const system = peaks(2, []);
		const result = labelSpeakers(transcript([["Sozinho", 0.1, 0.8]]), voice, system, 2);
		expect(result.mic).toBe(1);
		expect(transcriptHasTwoSpeakers(result.transcript)).toBe(false);
	});
});

describe("labelTranscriptFromStems", () => {
	const t = transcript([
		["Oi", 0.1, 0.5],
		["Olá", 1.1, 1.5, "s2"],
	]);
	const stems = { voicePath: "C:/take.voice.m4a", systemPath: "C:/take.system.m4a" };

	it("reads both stems over the take's length and labels the words", async () => {
		const read = vi.fn(async (path: string, durationSec: number) =>
			path.endsWith("voice.m4a")
				? peaks(durationSec, [[0, 0.8, 0.3]])
				: peaks(durationSec, [[1, 1.8, 0.3]]),
		);
		const result = await labelTranscriptFromStems({ audioStems: stems, durationSec: 2 }, t, read);
		expect(read).toHaveBeenCalledWith(stems.voicePath, 2);
		expect(read).toHaveBeenCalledWith(stems.systemPath, 2);
		expect(result?.transcript.words.map((w) => w.speaker)).toEqual(["mic", "system"]);
	});

	it("says nothing for a take without stems, or a stem that will not decode", async () => {
		const read = vi.fn(async () => null);
		expect(await labelTranscriptFromStems({ durationSec: 2 }, t, read)).toBeNull();
		expect(
			await labelTranscriptFromStems({ audioStems: stems, durationSec: 2 }, t, read),
		).toBeNull();
		const broken = vi.fn(async () => {
			throw new Error("ffmpeg exited 1");
		});
		expect(
			await labelTranscriptFromStems({ audioStems: stems, durationSec: 2 }, t, broken),
		).toBeNull();
	});
});
