import { describe, expect, it } from "vitest";
import { type AxcutDocument, createEmptyDocument } from "../schema";
import { deriveCaptionCues } from "./cues";
import { DEFAULT_CAPTION_SETTINGS, getCaptionSettings, patchCaptionSettings } from "./settings";
import { documentToSrt } from "./srt";

function conversation(): AxcutDocument {
	const base = createEmptyDocument({ projectId: "p", title: "t" });
	const spoken: Array<[string, number, number, "mic" | "system"]> = [
		["Bom", 0, 0.3, "mic"],
		["dia,", 0.35, 0.7, "mic"],
		["pessoal.", 0.75, 1.2, "mic"],
		["Olá,", 1.6, 1.9, "system"],
		["obrigado", 1.95, 2.4, "system"],
		["pelo", 2.45, 2.6, "system"],
		["convite.", 2.65, 3.1, "system"],
		["Vamos", 3.5, 3.8, "mic"],
		["lá.", 3.85, 4.2, "mic"],
	];
	return {
		...base,
		assets: [
			{
				id: "a",
				kind: "video",
				label: "call.mp4",
				originalPath: "C:/call.mp4",
				durationSec: 5,
				cameraTrack: null,
			},
		],
		transcripts: [
			{
				assetId: "a",
				language: "pt",
				segments: [],
				words: spoken.map(([text, startSec, endSec, speaker], i) => ({
					id: `w${i}`,
					segmentId: "s",
					startSec,
					endSec,
					text,
					speaker,
				})),
			},
		],
		timeline: {
			...base.timeline,
			clips: [
				{
					id: "c",
					assetId: "a",
					sourceStartSec: 0,
					sourceEndSec: 5,
					timelineStartSec: 0,
					timelineEndSec: 5,
					wordRefs: [],
					origin: "system",
					reason: "",
				},
			],
		},
	};
}

const ON = { ...DEFAULT_CAPTION_SETTINGS, enabled: true, maxWordsPerLine: 7 };

describe("captions with who speaks", () => {
	it("are off by default, and the words flow as before", () => {
		const cues = deriveCaptionCues(conversation(), ON, {});
		expect(cues.some((c) => c.text.includes("["))).toBe(false);
	});

	it("break the line where the speaker changes and name the new one", () => {
		const cues = deriveCaptionCues(
			conversation(),
			{ ...ON, speakerLabels: true, speakerNameMic: "Yago", speakerNameSystem: "Ana" },
			{},
		);
		expect(cues.map((c) => c.text)).toEqual([
			"[Yago] Bom dia, pessoal.",
			"[Ana] Olá, obrigado pelo convite.",
			"[Yago] Vamos lá.",
		]);
	});

	it("fall back to the default names, and reach the .srt", () => {
		const doc = patchCaptionSettings(conversation(), { enabled: true, speakerLabels: true });
		expect(getCaptionSettings(doc).speakerLabels).toBe(true);
		const srt = documentToSrt(doc);
		expect(srt).toContain("[Você] Bom dia, pessoal.");
		expect(srt).toContain("[Convidado] Olá, obrigado pelo convite.");
	});

	it("label nothing for a take with one speaker", () => {
		const solo = conversation();
		solo.transcripts[0].words = solo.transcripts[0].words.map((w) => ({ ...w, speaker: "mic" }));
		const cues = deriveCaptionCues(solo, { ...ON, speakerLabels: true }, {});
		expect(cues.some((c) => c.text.includes("["))).toBe(false);
	});
});
