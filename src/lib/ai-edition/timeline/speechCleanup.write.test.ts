// @vitest-environment jsdom
// "Limpar fala" as the shell writes it: the picks applied over the live document and saved
// once, so the whole cleanup is one Ctrl+Z.
import { beforeEach, describe, expect, it, vi } from "vitest";
import { type AxcutDocument, createEmptyDocument } from "../schema";
import { useProjectStore } from "../store/projectStore";
import { undo } from "../store/undo";
import { clearHistory, past } from "../store/undoStack";
import {
	applySpeechCleanupPicks,
	planSpeechCleanup,
	type SpeechCleanupOptions,
} from "./speechCleanup";

const bridge = vi.hoisted(() => ({ save: vi.fn() }));
vi.mock("@/native/client", () => ({ nativeBridgeClient: { aiEdition: bridge } }));

const OPTIONS: SpeechCleanupOptions = {
	fillers: ["né", "éé"],
	contextual: ["tipo"],
	aggressive: false,
	silenceMinSec: 0.8,
	keepGapSec: 0.3,
};

function take(): AxcutDocument {
	const base = createEmptyDocument({ projectId: "p_cleanup", title: "Take" });
	const spoken: Array<[string, number, number]> = [
		["Abre", 0, 0.4],
		["né", 0.5, 0.7],
		["o", 0.8, 0.9],
		["Teams.", 0.95, 1.4],
		["Depois", 3.5, 3.9],
		["éé", 4.0, 4.5],
		["clica.", 4.6, 5.0],
	];
	return {
		...base,
		assets: [
			{
				id: "asset_1",
				kind: "video",
				label: "take.mp4",
				originalPath: "C:/take.mp4",
				durationSec: 10,
				cameraTrack: null,
			},
		],
		transcripts: [
			{
				assetId: "asset_1",
				language: "pt",
				segments: [],
				words: spoken.map(([text, startSec, endSec], i) => ({
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
					id: "clip_1",
					assetId: "asset_1",
					sourceStartSec: 0,
					sourceEndSec: 10,
					timelineStartSec: 0,
					timelineEndSec: 10,
					wordRefs: [],
					origin: "system",
					reason: "",
				},
			],
		},
	};
}

describe("applying 'Limpar fala'", () => {
	beforeEach(() => {
		useProjectStore.getState().clear();
		clearHistory();
		bridge.save.mockImplementation(async (document: unknown) => ({ success: true, document }));
	});

	it("cuts only the ticked items, in one save that one undo takes back", async () => {
		const document = take();
		useProjectStore.setState({ document, projectId: document.project.id });
		const items = planSpeechCleanup(document, OPTIONS);
		expect(items.map((i) => i.kind)).toEqual(["filler", "silence", "filler"]);

		// The user unticked the silence.
		const picks = items.filter((i) => i.kind !== "silence").map((i) => i.id);
		const { document: next, items: cut } = applySpeechCleanupPicks(
			document,
			picks,
			OPTIONS,
			(p) => `${p}_${Math.random().toString(36).slice(2)}`,
		);
		expect(cut).toHaveLength(2);
		expect(await useProjectStore.getState().saveDocument(next, { history: true })).toBe(true);
		expect(useProjectStore.getState().document?.timeline.trimRanges).toHaveLength(2);
		expect(past).toHaveLength(1);

		undo();
		expect(useProjectStore.getState().document?.timeline.trimRanges).toHaveLength(0);
	});

	it("cuts nothing a later edit already took", () => {
		const document = take();
		const items = planSpeechCleanup(document, OPTIONS);
		// Meanwhile the user cut "né" by hand.
		const edited: AxcutDocument = {
			...document,
			timeline: {
				...document.timeline,
				trimRanges: [
					{
						id: "mine",
						assetId: "asset_1",
						clipId: "clip_1",
						startSec: 0.45,
						endSec: 0.75,
						reason: "",
						origin: "user",
					},
				],
			},
		};
		const { items: cut } = applySpeechCleanupPicks(
			edited,
			items.map((i) => i.id),
			OPTIONS,
			() => "t",
		);
		expect(cut.map((i) => i.text)).toEqual(["", "éé"]);
	});
});
