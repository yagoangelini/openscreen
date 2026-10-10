import { describe, expect, it } from "vitest";
import { buildChapters, formatChaptersForYouTube, formatChapterTime } from "./chapters";
import { type AxcutDocument, createEmptyDocument } from "./schema";

function documentWith(options: {
	durationSec: number;
	markersSec?: number[];
	words?: Array<[number, string]>;
	clipSourceStartSec?: number;
}): AxcutDocument {
	const doc = createEmptyDocument({ projectId: "proj_1", title: "Tutorial" });
	const start = options.clipSourceStartSec ?? 0;
	return {
		...doc,
		assets: [
			{
				id: "asset_1",
				kind: "video",
				label: "take",
				originalPath: "C:/take.mp4",
				cameraTrack: null,
				...(options.markersSec ? { markersSec: options.markersSec } : {}),
			},
		],
		transcripts: options.words
			? [
					{
						assetId: "asset_1",
						language: "pt",
						segments: [],
						words: options.words.map(([sec, text], index) => ({
							id: `w${index}`,
							segmentId: "s0",
							startSec: sec,
							endSec: sec + 0.3,
							text,
						})),
					},
				]
			: [],
		timeline: {
			...doc.timeline,
			clips: [
				{
					id: "clip_1",
					assetId: "asset_1",
					sourceStartSec: start,
					sourceEndSec: start + options.durationSec,
					timelineStartSec: 0,
					timelineEndSec: options.durationSec,
					wordRefs: [],
					origin: "system",
					reason: "test",
				},
			],
		},
	} as AxcutDocument;
}

const fallbackTitle = (index: number) => `Capítulo ${index}`;

describe("buildChapters", () => {
	it("starts at 0:00 and cuts at every marker, titled by the first words spoken", () => {
		const chapters = buildChapters(
			documentWith({
				durationSec: 120,
				markersSec: [30, 75],
				words: [
					[1, "olá"],
					[1.4, "pessoal,"],
					[31, "agora"],
					[31.4, "vamos"],
					[31.8, "abrir"],
					[32.2, "o"],
					[32.6, "Power"],
					[33, "Automate"],
					[33.4, "hoje"],
				],
			}),
			{ fallbackTitle },
		);
		expect(chapters.map((c) => c.startSec)).toEqual([0, 30, 75]);
		expect(chapters[0].title).toBe("Olá pessoal");
		expect(chapters[1].title).toBe("Agora vamos abrir o Power Automate");
		expect(chapters[2].title).toBe("Capítulo 3");
	});

	it("drops a marker that would make a chapter shorter than 10 seconds", () => {
		const chapters = buildChapters(documentWith({ durationSec: 60, markersSec: [4, 30, 55] }), {
			fallbackTitle,
		});
		expect(chapters.map((c) => c.startSec)).toEqual([0, 30]);
	});

	it("splits on long pauses when the take has no markers", () => {
		const chapters = buildChapters(
			documentWith({
				durationSec: 90,
				words: [
					[1, "um"],
					[2, "dois"],
					[40, "três"],
					[41, "quatro"],
				],
			}),
			{ fallbackTitle },
		);
		expect(chapters.map((c) => c.startSec)).toEqual([0, 40]);
		expect(chapters[1].title).toBe("Três quatro");
	});

	it("places markers where the clip plays them, not at their source time", () => {
		const chapters = buildChapters(
			documentWith({ durationSec: 60, markersSec: [130], clipSourceStartSec: 100 }),
			{ fallbackTitle },
		);
		expect(chapters.map((c) => c.startSec)).toEqual([0, 30]);
	});

	it("has nothing to say about an empty timeline", () => {
		const doc = createEmptyDocument({ projectId: "p", title: "t" });
		expect(buildChapters(doc, { fallbackTitle })).toEqual([]);
	});
});

describe("formatting for YouTube", () => {
	it("writes m:ss, and h:mm:ss past an hour", () => {
		expect(formatChapterTime(0)).toBe("0:00");
		expect(formatChapterTime(247.9)).toBe("4:07");
		expect(formatChapterTime(3729)).toBe("1:02:09");
	});

	it("one chapter per line", () => {
		expect(
			formatChaptersForYouTube([
				{ startSec: 0, title: "Introdução" },
				{ startSec: 65, title: "Criando o fluxo" },
			]),
		).toBe("0:00 Introdução\n1:05 Criando o fluxo");
	});
});
