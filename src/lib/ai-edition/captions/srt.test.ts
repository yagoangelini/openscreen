import { describe, expect, it } from "vitest";
import { type AxcutDocument, createEmptyDocument } from "../schema";
import { cuesToSrt, documentToSrt, formatSrtTime } from "./srt";

describe("formatSrtTime", () => {
	it("writes hours, minutes, seconds and milliseconds", () => {
		expect(formatSrtTime(0)).toBe("00:00:00,000");
		expect(formatSrtTime(62.3456)).toBe("00:01:02,346");
		expect(formatSrtTime(3725.5)).toBe("01:02:05,500");
	});
});

describe("cuesToSrt", () => {
	it("numbers the cues from 1, on the exported clock, and drops a cue trimmed away", () => {
		const srt = cuesToSrt(
			[
				{ id: "a", startMs: 1000, endMs: 2500, text: "Olá pessoal" },
				{ id: "b", startMs: 5000, endMs: 6000, text: "cortado" },
				{ id: "c", startMs: 8000, endMs: 9000, text: " Agora o fluxo " },
			],
			// 4..7 s was trimmed: everything after it plays 3 s earlier, and inside it is one point.
			(sec) => (sec < 4 ? sec : sec < 7 ? 4 : sec - 3),
		);
		expect(srt).toBe(
			"1\n00:00:01,000 --> 00:00:02,500\nOlá pessoal\n\n2\n00:00:05,000 --> 00:00:06,000\nAgora o fluxo\n",
		);
	});

	it("is empty with nothing to say", () => {
		expect(cuesToSrt([], (s) => s)).toBe("");
	});
});

describe("documentToSrt", () => {
	it("captions a transcribed take even with the burned-in captions off, sped up where it is", () => {
		const base = createEmptyDocument({ projectId: "p", title: "t" });
		const words = [
			[1, 1.4, "Olá"],
			[1.5, 2, "pessoal."],
			[20, 20.4, "Agora"],
			[20.5, 21, "vamos."],
		] as const;
		const document = {
			...base,
			assets: [
				{ id: "a1", kind: "video", label: "t", originalPath: "C:/t.mp4", cameraTrack: null },
			],
			transcripts: [
				{
					assetId: "a1",
					language: "pt",
					segments: [
						{
							id: "s1",
							kind: "speech",
							startSec: 1,
							endSec: 2,
							text: "Olá pessoal.",
							wordIds: ["w0", "w1"],
						},
						{
							id: "s2",
							kind: "speech",
							startSec: 20,
							endSec: 21,
							text: "Agora vamos.",
							wordIds: ["w2", "w3"],
						},
					],
					words: words.map(([startSec, endSec, text], i) => ({
						id: `w${i}`,
						segmentId: i < 2 ? "s1" : "s2",
						startSec,
						endSec,
						text,
					})),
				},
			],
			timeline: {
				...base.timeline,
				clips: [
					{
						id: "c1",
						assetId: "a1",
						sourceStartSec: 0,
						sourceEndSec: 30,
						timelineStartSec: 0,
						timelineEndSec: 30,
						wordRefs: [],
						origin: "system",
						reason: "t",
					},
				],
			},
			// 4..16 s at 4x: it plays in 3 s, so "Agora" at 20 s comes out at 11 s.
			legacyEditor: { speedRegions: [{ id: "sp", startMs: 4000, endMs: 16_000, speed: 4 }] },
		} as AxcutDocument;
		const srt = documentToSrt(document);
		expect(srt.startsWith("1\n00:00:01,000 --> ")).toBe(true);
		expect(srt).toContain("Olá pessoal.");
		expect(srt).toMatch(/2\n00:00:11,000 --> 00:00:1\d,\d{3}\nAgora vamos\./);
	});

	it("leaves out a word a trim took from the middle of a line, and closes the gap", () => {
		const base = createEmptyDocument({ projectId: "p", title: "t" });
		const words = [
			[1, 1.5, "Pessoal,"],
			[1.6, 1.9, "né?"],
			[2.0, 2.4, "hoje"],
			[2.5, 3, "vamos."],
		] as const;
		const document = {
			...base,
			assets: [
				{ id: "a1", kind: "video", label: "t", originalPath: "C:/t.mp4", cameraTrack: null },
			],
			transcripts: [
				{
					assetId: "a1",
					language: "pt",
					segments: [
						{
							id: "s1",
							kind: "speech",
							startSec: 1,
							endSec: 3,
							text: "Pessoal, né? hoje vamos.",
							wordIds: ["w0", "w1", "w2", "w3"],
						},
					],
					words: words.map(([startSec, endSec, text], i) => ({
						id: `w${i}`,
						segmentId: "s1",
						startSec,
						endSec,
						text,
					})),
				},
			],
			timeline: {
				...base.timeline,
				clips: [
					{
						id: "c1",
						assetId: "a1",
						sourceStartSec: 0,
						sourceEndSec: 10,
						timelineStartSec: 0,
						timelineEndSec: 10,
						wordRefs: [],
						origin: "system",
						reason: "t",
					},
				],
				// What "Limpar fala" writes for a hesitation: the word and its pauses.
				trimRanges: [
					{ id: "t1", assetId: "a1", startSec: 1.5, endSec: 2.0, origin: "system", reason: "né" },
				],
			},
		} as AxcutDocument;
		const srt = documentToSrt(document);
		expect(srt).not.toContain("né");
		// 1.0 s on the exported clock, and "vamos." ends 0.5 s earlier than it was spoken.
		expect(srt).toBe("1\n00:00:01,000 --> 00:00:02,500\nPessoal, hoje vamos.\n");
	});
});
