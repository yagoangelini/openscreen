// @vitest-environment jsdom
// Agent turns: one reply is one undo step, a staged reply touches nothing until it
// is applied, and "Desfazer esta resposta" reverts exactly that reply or nothing.
import { beforeEach, describe, expect, it, vi } from "vitest";
import { executeAgentTool } from "../../../../electron/ai-edition/agent-tools";
import { type AxcutDocument, createEmptyDocument, documentSchema } from "../schema";
import { runAgentTurn } from "./agentDocumentApply";
import { latestUndoableTurnId, summarizeAgentTurnChanges, useAgentTurnStore } from "./agentTurns";
import { isAgentTurnLatest } from "./agentTurnUndo";
import { useProjectStore } from "./projectStore";
import { clearHistory, redo, undo } from "./undo";
import { future, past } from "./undoStack";

const saveMock = vi.hoisted(() => vi.fn());

vi.mock("@/native/client", () => ({
	nativeBridgeClient: {
		aiEdition: { save: saveMock },
	},
}));

const CREATED_AT = "2026-01-01T00:00:00.000Z";

function projectDocument(): AxcutDocument {
	const base = createEmptyDocument({
		title: "Tutorial",
		projectId: "proj_1",
		createdAt: CREATED_AT,
	});
	return documentSchema.parse({
		...base,
		project: { ...base.project, primaryAssetId: "asset_1" },
		assets: [
			{
				id: "asset_1",
				kind: "video",
				label: "Recording",
				originalPath: "C:/videos/rec.mp4",
				durationSec: 60,
			},
		],
		transcripts: [
			{
				assetId: "asset_1",
				language: "pt-BR",
				segments: [
					{
						id: "seg_1",
						kind: "speech",
						startSec: 0,
						endSec: 1,
						text: "Olá pessoal",
						wordIds: ["w1", "w2"],
					},
				],
				words: [
					{ id: "w1", segmentId: "seg_1", text: "Olá", startSec: 0, endSec: 0.5 },
					{ id: "w2", segmentId: "seg_1", text: "pessoal", startSec: 0.5, endSec: 1 },
				],
			},
		],
		timeline: {
			...base.timeline,
			clips: [
				{
					id: "clip_1",
					assetId: "asset_1",
					sourceStartSec: 0,
					sourceEndSec: 60,
					timelineStartSec: 0,
					timelineEndSec: 60,
					wordRefs: [],
					origin: "user",
					reason: "",
				},
			],
		},
	});
}

/** What a real multi-tool reply hands back: three writes, chained the way the agent's
 *  document holder chains them, through the same executor the agent uses. */
function agentReplyOn(document: AxcutDocument): AxcutDocument {
	let working = document;
	for (const [name, args] of [
		["addTrim", { startSec: 10, endSec: 12, reason: "silence" }],
		["addTrim", { startSec: 20, endSec: 21, reason: "silence" }],
		["addZoom", { startSec: 30, endSec: 35 }],
	] as const) {
		const step = executeAgentTool(working, name, JSON.stringify(args));
		expect(step.ok).toBe(true);
		working = step.document as AxcutDocument;
	}
	return working;
}

function openProject(document: AxcutDocument) {
	useProjectStore.setState({ projectId: document.project.id, document, revision: 1 });
}

/** Run one agent turn the way the chat does and stage it under `messageId`. */
async function stageTurn(messageId: string) {
	const sent: { document?: AxcutDocument } = {};
	const turn = await runAgentTurn(async (snapshot) => {
		sent.document = snapshot;
		return { document: snapshot ? agentReplyOn(snapshot) : undefined };
	});
	if (!sent.document) throw new Error("no live document");
	useAgentTurnStore.getState().track(messageId, {
		projectId: sent.document.project.id,
		status: "pending",
		changes: summarizeAgentTurnChanges(sent.document, turn.result.document as AxcutDocument),
		apply: turn.applyDocument,
		undoHandle: turn.undoHandle,
	});
	return turn;
}

beforeEach(() => {
	useProjectStore.getState().clear();
	clearHistory();
	useAgentTurnStore.setState({ turns: {} });
	saveMock.mockReset();
	saveMock.mockImplementation(async (document) => ({ success: true, document }));
});

describe("summarizeAgentTurnChanges", () => {
	it("counts items per category, not tool calls", () => {
		const before = projectDocument();
		const after = agentReplyOn(before);
		expect(summarizeAgentTurnChanges(before, after)).toEqual([
			{ kind: "cuts", added: 2, removed: 0, changed: 0 },
			{ kind: "zooms", added: 1, removed: 0, changed: 0 },
		]);
	});

	it("reports a rewritten word as a changed transcript word, and is empty for no change", () => {
		const before = projectDocument();
		const step = executeAgentTool(
			before,
			"setWordText",
			JSON.stringify({ assetId: "asset_1", wordId: "w2", text: "galera" }),
		);
		expect(step.ok).toBe(true);
		expect(summarizeAgentTurnChanges(before, step.document as AxcutDocument)).toEqual([
			{ kind: "transcript", added: 0, removed: 0, changed: 1 },
		]);
		expect(summarizeAgentTurnChanges(before, structuredClone(before))).toEqual([]);
	});
});

describe("a whole agent reply is one undo step", () => {
	it("records ONE entry for a reply that made three tool calls, and undo/redo walk it as one", async () => {
		const before = projectDocument();
		openProject(before);
		const turn = await stageTurn("reply_1");

		await expect(useAgentTurnStore.getState().applyTurn("reply_1")).resolves.toBe("applied");
		expect(saveMock).toHaveBeenCalledOnce();
		expect(past).toHaveLength(1);
		const applied = useProjectStore.getState().document;
		expect(applied?.timeline.trimRanges).toHaveLength(2);
		expect(applied?.zoomRanges).toHaveLength(1);
		expect(isAgentTurnLatest(turn.undoHandle())).toBe(true);

		expect(undo()).toBe(true);
		expect(useProjectStore.getState().document).toEqual(before);
		expect(past).toHaveLength(0);
		expect(future).toHaveLength(1);

		expect(redo()).toBe(true);
		expect(useProjectStore.getState().document?.timeline.trimRanges).toHaveLength(2);
		expect(useProjectStore.getState().document?.zoomRanges).toHaveLength(1);
	});
});

describe("approval before applying", () => {
	it("touches nothing while staged, and discarding writes nothing", async () => {
		const before = projectDocument();
		openProject(before);
		await stageTurn("reply_1");

		expect(useAgentTurnStore.getState().turns.reply_1?.status).toBe("pending");
		expect(useProjectStore.getState().document).toBe(before);
		expect(saveMock).not.toHaveBeenCalled();
		expect(past).toHaveLength(0);

		useAgentTurnStore.getState().discardTurn("reply_1");
		expect(useAgentTurnStore.getState().turns.reply_1?.status).toBe("discarded");
		expect(useAgentTurnStore.getState().turns.reply_1?.apply).toBeUndefined();
		await expect(useAgentTurnStore.getState().applyTurn("reply_1")).resolves.toBe("not-pending");
		expect(useProjectStore.getState().document).toBe(before);
		expect(saveMock).not.toHaveBeenCalled();
	});

	it("keeps a staged turn pending on a conflict, and applies it when the user insists", async () => {
		const before = projectDocument();
		openProject(before);
		await stageTurn("reply_1");
		// The user edits while the proposal waits.
		useProjectStore
			.getState()
			.setDocument(
				{ ...before, project: { ...before.project, title: "Renamed" } },
				{ history: true },
			);

		await expect(useAgentTurnStore.getState().applyTurn("reply_1")).resolves.toBe("conflict");
		expect(useAgentTurnStore.getState().turns.reply_1?.status).toBe("pending");
		expect(useProjectStore.getState().document?.project.title).toBe("Renamed");

		await expect(
			useAgentTurnStore.getState().applyTurn("reply_1", { ignoreConflict: true }),
		).resolves.toBe("applied");
		expect(useAgentTurnStore.getState().turns.reply_1?.status).toBe("applied");
		expect(useProjectStore.getState().document?.timeline.trimRanges).toHaveLength(2);
	});

	it("never applies a staged turn to a different project, even when the revisions match", async () => {
		const before = projectDocument();
		openProject(before);
		await stageTurn("reply_1");
		const other = createEmptyDocument({
			title: "Other",
			projectId: "proj_2",
			createdAt: CREATED_AT,
		});
		useProjectStore.setState({ projectId: "proj_2", document: other, revision: 1 });

		await expect(
			useAgentTurnStore.getState().applyTurn("reply_1", { ignoreConflict: true }),
		).resolves.toBe("no-live-document");
		expect(useAgentTurnStore.getState().turns.reply_1?.status).toBe("discarded");
		expect(useProjectStore.getState().document).toBe(other);
		expect(saveMock).not.toHaveBeenCalled();
	});
});

describe("Desfazer esta resposta", () => {
	it("reverts the whole reply in one step and persists the restored document unrecorded", async () => {
		const before = projectDocument();
		openProject(before);
		await stageTurn("reply_1");
		await useAgentTurnStore.getState().applyTurn("reply_1");
		expect(latestUndoableTurnId(useAgentTurnStore.getState().turns)).toBe("reply_1");
		saveMock.mockClear();

		expect(useAgentTurnStore.getState().undoTurn("reply_1")).toBe(true);
		expect(useAgentTurnStore.getState().turns.reply_1?.status).toBe("undone");
		expect(useProjectStore.getState().document).toEqual(before);
		// The persist, like the one after Ctrl+Z: written, and redo still there.
		expect(saveMock).toHaveBeenCalledOnce();
		await vi.waitFor(() => expect(useProjectStore.getState().dirty).toBe(false));
		expect(past).toHaveLength(0);
		expect(future).toHaveLength(1);
		expect(latestUndoableTurnId(useAgentTurnStore.getState().turns)).toBeNull();
	});

	it("refuses, touching nothing, once a later edit sits on top of the reply", async () => {
		const before = projectDocument();
		openProject(before);
		await stageTurn("reply_1");
		await useAgentTurnStore.getState().applyTurn("reply_1");
		const applied = useProjectStore.getState().document as AxcutDocument;
		const later = { ...applied, project: { ...applied.project, title: "Later edit" } };
		await useProjectStore.getState().saveDocument(later, { history: true });
		expect(latestUndoableTurnId(useAgentTurnStore.getState().turns)).toBeNull();

		expect(useAgentTurnStore.getState().undoTurn("reply_1")).toBe(false);
		expect(useAgentTurnStore.getState().turns.reply_1?.status).toBe("applied");
		expect(useProjectStore.getState().document?.project.title).toBe("Later edit");
		expect(past).toHaveLength(2);
	});

	it("only the newest of two applied replies is undoable on its own", async () => {
		openProject(projectDocument());
		await stageTurn("reply_1");
		await useAgentTurnStore.getState().applyTurn("reply_1");
		await stageTurn("reply_2");
		await useAgentTurnStore.getState().applyTurn("reply_2");

		expect(latestUndoableTurnId(useAgentTurnStore.getState().turns)).toBe("reply_2");
		expect(useAgentTurnStore.getState().undoTurn("reply_1")).toBe(false);
		expect(useAgentTurnStore.getState().undoTurn("reply_2")).toBe(true);
		// With the second reply gone, the first is the latest change again.
		expect(latestUndoableTurnId(useAgentTurnStore.getState().turns)).toBe("reply_1");
		expect(useAgentTurnStore.getState().undoTurn("reply_1")).toBe(true);
		expect(past).toHaveLength(0);
	});
});
