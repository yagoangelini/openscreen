import { describe, expect, it } from "vitest";
import type { AxcutClip, AxcutDocument, AxcutTrimRange, AxcutWord } from "../schema";
import { createEmptyDocument } from "../schema";
import {
	applySpeechCleanup,
	DEFAULT_CONTEXTUAL_FILLERS,
	DEFAULT_SPEECH_FILLERS,
	normalizeFillerToken,
	parseFillerList,
	planSpeechCleanup,
	type SpeechCleanupOptions,
	speechCleanupSavedSec,
} from "./speechCleanup";

const OPTIONS: SpeechCleanupOptions = {
	fillers: DEFAULT_SPEECH_FILLERS,
	contextual: DEFAULT_CONTEXTUAL_FILLERS,
	aggressive: false,
	silenceMinSec: 0.8,
	keepGapSec: 0.3,
};

/** Words laid out from `[text, start, end]`. */
function words(spec: Array<[string, number, number]>, assetId = "asset_1"): AxcutWord[] {
	return spec.map(([text, startSec, endSec], i) => ({
		id: `${assetId}_w${i + 1}`,
		segmentId: "seg_1",
		startSec,
		endSec,
		text,
	}));
}

function clip(overrides: Partial<AxcutClip> = {}): AxcutClip {
	return {
		id: "clip_1",
		assetId: "asset_1",
		sourceStartSec: 0,
		sourceEndSec: 20,
		timelineStartSec: 0,
		timelineEndSec: 20,
		wordRefs: [],
		origin: "system",
		reason: "",
		...overrides,
	};
}

function doc(
	spec: Array<[string, number, number]>,
	opts: { clips?: AxcutClip[]; trims?: AxcutTrimRange[] } = {},
): AxcutDocument {
	const base = createEmptyDocument({ projectId: "p", title: "t" });
	return {
		...base,
		assets: [
			{
				id: "asset_1",
				kind: "video",
				label: "take.mp4",
				originalPath: "/tmp/take.mp4",
				durationSec: 20,
				cameraTrack: null,
				video: { codec: "h264", width: 1920, height: 1080, fps: 30 },
			},
		],
		transcripts: [{ assetId: "asset_1", language: "pt", segments: [], words: words(spec) }],
		timeline: {
			...base.timeline,
			clips: opts.clips ?? [clip()],
			trimRanges: opts.trims ?? [],
		},
	};
}

describe("normalizeFillerToken / parseFillerList", () => {
	it("strips punctuation and case, reads a held letter as a double one, keeps accents", () => {
		expect(normalizeFillerToken("Né?")).toBe("né");
		expect(normalizeFillerToken("Éééé...")).toBe("éé");
		expect(normalizeFillerToken("hummmm,")).toBe("humm");
		expect(normalizeFillerToken("é")).toBe("é");
		expect(normalizeFillerToken("e")).toBe("e");
	});

	it("reads one entry per line or comma, without repeats", () => {
		expect(parseFillerList("né\n  então   assim , tipo\nNÉ\n\n")).toEqual([
			"né",
			"então assim",
			"tipo",
		]);
	});
});

describe("planSpeechCleanup: pure hesitations", () => {
	it("always cuts them, and never the real words around them", () => {
		const d = doc([
			["Vamos", 0, 0.4],
			["abrir", 0.45, 0.8],
			["né,", 0.85, 1.05],
			["o", 1.1, 1.2],
			["Teams.", 1.25, 1.7],
		]);
		const items = planSpeechCleanup(d, OPTIONS);
		expect(items).toHaveLength(1);
		expect(items[0]).toMatchObject({ kind: "filler", reason: "filler", text: "né," });
		// Inside the gaps around it, never past the neighbours' edges.
		expect(items[0].startSec).toBeGreaterThanOrEqual(0.8);
		expect(items[0].endSec).toBeLessThanOrEqual(1.1);
		expect(items[0].startSec).toBeLessThanOrEqual(0.85);
		expect(items[0].endSec).toBeGreaterThanOrEqual(1.05);
	});

	it("does not take 'é' (is) or 'e' (and) for 'éé'", () => {
		const d = doc([
			["Isso", 0, 0.3],
			["é", 0.35, 0.45],
			["simples", 0.5, 0.9],
			["e", 0.95, 1.0],
			["rápido.", 1.05, 1.5],
		]);
		expect(planSpeechCleanup(d, OPTIONS)).toEqual([]);
	});

	it("matches a longer-held hesitation", () => {
		const d = doc([
			["Então", 0, 0.3],
			["vamos", 0.35, 0.6],
			["éééé", 0.7, 1.3],
			["clicar", 1.35, 1.7],
		]);
		const items = planSpeechCleanup(d, OPTIONS);
		expect(items.map((i) => i.text)).toEqual(["éééé"]);
	});
});

describe("planSpeechCleanup: contextual fillers", () => {
	it("keeps 'tipo' and 'então' used as words", () => {
		const d = doc([
			["Vou", 0, 0.2],
			["criar", 0.25, 0.5],
			["um", 0.55, 0.65],
			["tipo", 0.7, 0.95],
			["de", 1.0, 1.1],
			["coluna,", 1.15, 1.5],
			["então", 1.55, 1.8],
			["a", 1.85, 1.9],
			["gente", 1.95, 2.2],
			["salva.", 2.25, 2.6],
		]);
		expect(planSpeechCleanup(d, OPTIONS)).toEqual([]);
	});

	it("cuts one isolated between pauses", () => {
		const d = doc([
			["Pronto.", 0, 0.5],
			["Tipo...", 1.0, 1.3],
			["agora", 1.8, 2.1],
			["abre.", 2.15, 2.5],
		]);
		const items = planSpeechCleanup(d, OPTIONS);
		expect(items).toHaveLength(1);
		expect(items[0]).toMatchObject({ reason: "isolated", text: "Tipo..." });
		// 1.0 s of pauses around it: shortened to the kept gap, not glued.
		expect(items[0].keptSec).toBeCloseTo(0.3, 5);
		expect(items[0].startSec).toBeCloseTo(0.65, 5);
		expect(items[0].endSec).toBeCloseTo(1.65, 5);
	});

	it("counts a short pause after punctuation as a pause", () => {
		const d = doc([
			["Feito.", 0, 0.4],
			["Então,", 0.55, 0.85],
			["vamos", 1.0, 1.3],
		]);
		expect(planSpeechCleanup(d, OPTIONS).map((i) => i.reason)).toEqual(["isolated"]);
	});

	it("cuts the first of a repeated pair and keeps the last", () => {
		const d = doc([
			["então", 0, 0.3],
			["então", 0.35, 0.65],
			["vamos", 0.7, 1.0],
			["lá", 1.05, 1.3],
		]);
		const items = planSpeechCleanup(d, OPTIONS);
		expect(items).toHaveLength(1);
		expect(items[0]).toMatchObject({ reason: "repeated", text: "então" });
		expect(items[0].endSec).toBeLessThanOrEqual(0.35);
	});

	it("matches a phrase entry as one item", () => {
		const d = doc([
			["Ok.", 0, 0.3],
			["Então", 0.8, 1.0],
			["assim,", 1.02, 1.3],
			["o", 1.8, 1.9],
			["fluxo", 1.95, 2.3],
		]);
		const items = planSpeechCleanup(d, OPTIONS);
		expect(items.map((i) => i.text)).toEqual(["Então assim,"]);
	});

	it("cuts them anywhere when aggressive", () => {
		const d = doc([
			["Vou", 0, 0.2],
			["criar", 0.25, 0.5],
			["tipo", 0.55, 0.8],
			["uma", 0.85, 1.0],
			["lista", 1.05, 1.4],
		]);
		expect(planSpeechCleanup(d, OPTIONS)).toEqual([]);
		const items = planSpeechCleanup(d, { ...OPTIONS, aggressive: true });
		expect(items.map((i) => i.reason)).toEqual(["aggressive"]);
	});
});

describe("planSpeechCleanup: silences", () => {
	it("shortens a long silence to the kept gap, half on each side", () => {
		const d = doc([
			["Abre", 0, 0.4],
			["aqui.", 0.45, 0.8],
			["Depois", 3.0, 3.4],
		]);
		const items = planSpeechCleanup(d, OPTIONS);
		expect(items).toHaveLength(1);
		expect(items[0]).toMatchObject({ kind: "silence", reason: "silence", text: "" });
		expect(items[0].startSec).toBeCloseTo(0.95, 5);
		expect(items[0].endSec).toBeCloseTo(2.85, 5);
		expect(speechCleanupSavedSec(items)).toBeCloseTo(1.9, 5);
	});

	it("leaves a pause under the threshold, and the clip's head and tail", () => {
		const d = doc([
			["Abre", 2, 2.4],
			["aqui.", 3.0, 3.4],
		]);
		expect(planSpeechCleanup(d, OPTIONS)).toEqual([]);
	});

	it("never touches a stretch that already has a trim", () => {
		const d = doc(
			[
				["Abre", 0, 0.4],
				["aqui.", 0.45, 0.8],
				["Depois", 3.0, 3.4],
				["né", 3.5, 3.7],
				["fecha.", 3.8, 4.2],
			],
			{
				trims: [
					{
						id: "trim_1",
						assetId: "asset_1",
						clipId: "clip_1",
						startSec: 1.5,
						endSec: 2.0,
						reason: "",
						origin: "user",
					},
				],
			},
		);
		const items = planSpeechCleanup(d, OPTIONS);
		expect(items.map((i) => i.kind)).toEqual(["filler"]);
		// Off-centre too: a trim that does not cover the silence's middle still keeps it out.
		const offCentre = doc(
			[
				["Abre", 0, 0.4],
				["Depois", 3.0, 3.4],
			],
			{
				trims: [
					{
						id: "trim_1",
						assetId: "asset_1",
						clipId: "clip_1",
						startSec: 0.5,
						endSec: 0.7,
						reason: "",
						origin: "user",
					},
				],
			},
		);
		expect(planSpeechCleanup(offCentre, OPTIONS)).toEqual([]);
	});
});

describe("planSpeechCleanup: across clips", () => {
	it("cuts each clip in its own source window, anchored on that clip", () => {
		const spec: Array<[string, number, number]> = [
			["Primeiro", 0, 0.5],
			["né", 0.6, 0.8],
			["passo.", 0.9, 1.3],
			["Segundo", 10, 10.5],
			["hum", 10.6, 10.9],
			["passo.", 11.0, 11.4],
		];
		const d = doc(spec, {
			clips: [
				clip({
					id: "a",
					sourceStartSec: 0,
					sourceEndSec: 5,
					timelineStartSec: 0,
					timelineEndSec: 5,
				}),
				clip({
					id: "b",
					sourceStartSec: 9,
					sourceEndSec: 15,
					timelineStartSec: 5,
					timelineEndSec: 11,
				}),
			],
		});
		const items = planSpeechCleanup(d, OPTIONS);
		expect(items.map((i) => [i.clipId, i.text])).toEqual([
			["a", "né"],
			["b", "hum"],
		]);
		// The second one sits on the ruler where clip b plays it.
		expect(items[1].rawStartSec).toBeCloseTo(5 + (items[1].startSec - 9), 5);
	});
});

describe("applySpeechCleanup", () => {
	it("adds every picked cut as a trim on its clip, in one document", () => {
		const d = doc([
			["Abre", 0, 0.4],
			["né", 0.5, 0.7],
			["aqui.", 0.8, 1.2],
			["Depois", 3.0, 3.4],
		]);
		const items = planSpeechCleanup(d, OPTIONS);
		expect(items).toHaveLength(2);
		let n = 0;
		const next = applySpeechCleanup(d, items, (p) => `${p}_${++n}`);
		expect(next.timeline.trimRanges).toHaveLength(2);
		for (const trim of next.timeline.trimRanges) {
			expect(trim).toMatchObject({ assetId: "asset_1", clipId: "clip_1", origin: "user" });
		}
		// Planning again over the result finds nothing left to do.
		expect(planSpeechCleanup(next, OPTIONS)).toEqual([]);
		// Applying nothing is the same document.
		expect(applySpeechCleanup(d, [], () => "x")).toBe(d);
	});
});
