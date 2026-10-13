// @vitest-environment jsdom
//
// The resets, the "Todos os trechos" camera look and the history menu, through the real store:
// each is ONE undoable write, carries its name into the history, and Ctrl+Z (or a jump in the
// history menu) brings back exactly what was there.

import { act, renderHook } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import {
	cameraPieces,
	cameraTimelineEndMs,
	readCameraSegments,
	setCameraPieceLook,
	splitCameraAt,
} from "@/lib/ai-edition/document/cameraSegments";
import { resetCameraTrack } from "@/lib/ai-edition/document/projectReset";
import { type AxcutDocument, documentSchema } from "@/lib/ai-edition/schema";
import { getEditorSettings } from "@/lib/ai-edition/store/editorSettings";
import { useProjectStore } from "@/lib/ai-edition/store/projectStore";
import { clearHistory, historyEntries, redo, undo } from "@/lib/ai-edition/store/undo";
import { past } from "@/lib/ai-edition/store/undoStack";
import {
	applyCameraLookToAllPieces,
	useEditorSettings,
} from "@/lib/ai-edition/store/useEditorSettings";
import { runProjectReset } from "./projectReset";

const saveMock = vi.hoisted(() => vi.fn());
vi.mock("@/native/client", () => ({
	nativeBridgeClient: { aiEdition: { save: saveMock }, cursor: { getTelemetry: vi.fn() } },
}));

const LAYOUT = {
	initial: "screen" as const,
	switches: [
		{ atSec: 5, layout: "face" as const },
		{ atSec: 8, layout: "screen" as const },
	],
};

function imported(): AxcutDocument {
	return resetCameraTrack(
		documentSchema.parse({
			schemaVersion: 9,
			project: {
				id: "proj_1",
				title: "Gravação",
				createdAt: "2026-10-13T00:00:00.000Z",
				updatedAt: "2026-10-13T00:00:00.000Z",
				primaryAssetId: "a",
			},
			assets: [
				{
					id: "a",
					kind: "video",
					label: "take.mp4",
					originalPath: "C:/takes/take.mp4",
					durationSec: 30,
					cameraLayout: LAYOUT,
				},
			],
			timeline: {
				clips: [
					{
						id: "c1",
						assetId: "a",
						sourceStartSec: 0,
						sourceEndSec: 30,
						timelineStartSec: 0,
						timelineEndSec: 30,
						wordRefs: [],
						origin: "system",
						reason: "",
					},
				],
			},
			zoomRanges: [
				{
					id: "auto_z",
					startMs: 12000,
					endMs: 14000,
					clipId: "c1",
					sourceStartSec: 12,
					sourceEndSec: 14,
					depth: 2,
					focus: { cx: 0.4, cy: 0.4 },
					source: "auto",
				},
			],
			legacyEditor: { webcamSizePreset: 25, webcamAnchor: "bottom-right" },
		}),
	);
}

/** Three camera pieces; the first and the last have their own size, the last its own anchor. */
function withOwnLooks(doc: AxcutDocument): AxcutDocument {
	const clips = doc.timeline.clips;
	const a = splitCameraAt(readCameraSegments(doc), clips, 2000);
	if (!a) throw new Error("split");
	const b = setCameraPieceLook(a.segments, clips, a.leftKey, { webcamSizePreset: 40 });
	if (!b) throw new Error("look");
	const pieces = cameraPieces(b.segments, cameraTimelineEndMs(clips));
	const last = pieces[pieces.length - 1];
	const c = setCameraPieceLook(b.segments, clips, last.key, {
		webcamSizePreset: 15,
		webcamAnchor: "top-left",
	});
	if (!c) throw new Error("look 2");
	return { ...doc, cameraSegments: c.segments };
}

/** A blur drawn by hand, on the footage at 2-3 s. */
const userBlur = () =>
	documentSchema.parse({
		...imported(),
		annotations: [
			{
				id: "user_blur",
				startMs: 2000,
				endMs: 3000,
				type: "blur",
				position: { x: 10, y: 10 },
				size: { width: 20, height: 10 },
				style: {},
				zIndex: 1,
			},
		],
	}).annotations[0];

const doc = () => useProjectStore.getState().document as AxcutDocument;
const store = () => useProjectStore.getState();

beforeEach(() => {
	store().clear();
	clearHistory();
	saveMock.mockReset();
	saveMock.mockImplementation(async (document: unknown) => ({ success: true, document }));
	useProjectStore.setState({ projectId: "proj_1", document: imported() });
});

/** Make an edit the way the editor does: one recorded save. */
async function edit(next: (d: AxcutDocument) => AxcutDocument, label?: "addZoom") {
	await store().saveDocument(next(doc()), { history: true, historyLabel: label });
}

describe("Todos os trechos (camera look on every piece)", () => {
	it("gives every piece the value, pieces with their own look included, in one write", async () => {
		await edit(withOwnLooks);
		const before = doc();
		const { result } = renderHook(() =>
			useEditorSettings({ transform: applyCameraLookToAllPieces, historyLabel: "cameraLookAll" }),
		);
		const pastBefore = past.length;
		await act(async () => {
			await result.current.set({ webcamSizePreset: 33 });
		});
		expect(past.length).toBe(pastBefore + 1);
		expect(historyEntries().undo[0].label).toBe("cameraLookAll");
		expect(getEditorSettings(doc()).webcamSizePreset).toBe(33);
		const pieces = cameraPieces(readCameraSegments(doc()), 30000);
		// No piece overrides the size any more: every one shows 33.
		expect(pieces.every((p) => p.overrides?.webcamSizePreset === undefined)).toBe(true);
		// The anchor the last piece had of its own is not what this edit was about: it stays.
		expect(pieces[pieces.length - 1].overrides).toEqual({ webcamAnchor: "top-left" });
		// And one Ctrl+Z puts both the global size and the pieces' own sizes back.
		expect(undo()).toBe(true);
		expect(doc()).toEqual(before);
	});
});

describe("runProjectReset", () => {
	const deps = {
		autoZoomEnabled: async () => true,
		// The planner as the import would run it on this take: the one automatic zoom.
		planZooms: async (d: AxcutDocument) => ({
			document: { ...d, zoomRanges: imported().zoomRanges },
		}),
	};

	it.each([
		"camera",
		"video",
		"zooms",
		"annotations",
		"all",
	] as const)("%s: one labelled write, and one undo restores the edited project", async (scope) => {
		await edit(withOwnLooks);
		await edit((d) => ({
			...d,
			zoomRanges: [{ ...d.zoomRanges[0], id: "user_z", source: undefined, startMs: 1000 }],
			annotations: [userBlur()],
		}));
		const editedDoc = doc();
		const pastBefore = past.length;
		const savesBefore = saveMock.mock.calls.length;
		expect(await runProjectReset(scope, deps)).toBe(true);
		expect(saveMock.mock.calls.length).toBe(savesBefore + 1);
		expect(past.length).toBe(pastBefore + 1);
		expect(historyEntries().undo[0].label).toBe(
			{
				camera: "resetCamera",
				video: "resetVideo",
				zooms: "resetZooms",
				annotations: "resetAnnotations",
				all: "resetAll",
			}[scope],
		);
		expect(undo()).toBe(true);
		expect(doc()).toEqual(editedDoc);
	});

	it("'all' gives back the just-imported project, automatic zooms planned again", async () => {
		const fresh = imported();
		await edit(withOwnLooks);
		await edit((d) => ({ ...d, zoomRanges: [] }));
		expect(await runProjectReset("all", deps)).toBe(true);
		const after = doc();
		expect(after.timeline.clips).toEqual(fresh.timeline.clips);
		expect(after.zoomRanges).toEqual(fresh.zoomRanges);
		const shape = (d: AxcutDocument) =>
			cameraPieces(readCameraSegments(d), 30000).map(({ startMs, endMs, mode, overrides }) => ({
				startMs,
				endMs,
				mode,
				overrides,
			}));
		expect(shape(after)).toEqual(shape(fresh));
	});

	it("keeps the automatic zooms when the planner cannot run", async () => {
		await edit((d) => ({
			...d,
			zoomRanges: [...d.zoomRanges, { ...d.zoomRanges[0], id: "u", source: undefined }],
		}));
		expect(
			await runProjectReset("zooms", {
				autoZoomEnabled: async () => true,
				planZooms: async () => {
					throw new Error("no telemetry");
				},
			}),
		).toBe(true);
		expect(doc().zoomRanges.map((z) => z.id)).toEqual(["auto_z"]);
	});

	it("writes nothing when the project is already as imported", async () => {
		const pastBefore = past.length;
		expect(await runProjectReset("annotations", deps)).toBe(true);
		expect(past.length).toBe(pastBefore);
		expect(saveMock).not.toHaveBeenCalled();
	});
});

describe("the history menu's jump", () => {
	it("lists the named steps nearest first and walks to a chosen one in one step", async () => {
		const original = doc();
		await edit(withOwnLooks); // splitCamera
		const afterCamera = doc();
		await edit((d) => ({ ...d, zoomRanges: [] })); // removeZoom
		await edit((d) => ({ ...d, project: { ...d.project, title: "Novo nome" } })); // rename
		expect(historyEntries().undo).toEqual([
			{ label: "renameProject", steps: 1 },
			{ label: "removeZoom", steps: 2 },
			{ label: "splitCamera", steps: 3 },
		]);
		const latest = doc();

		// "Desfazer até" the zoom removal: two steps back, at once.
		expect(undo(2)).toBe(true);
		expect(doc()).toEqual(afterCamera);
		expect(historyEntries().undo).toEqual([{ label: "splitCamera", steps: 1 }]);
		expect(historyEntries().redo).toEqual([
			{ label: "removeZoom", steps: 1 },
			{ label: "renameProject", steps: 2 },
		]);

		// Further back than there is stops at the oldest.
		expect(undo(10)).toBe(true);
		expect(doc()).toEqual(original);

		// "Refazer até" the rename: every step back, labels intact.
		expect(redo(3)).toBe(true);
		expect(doc()).toEqual(latest);
		expect(historyEntries().undo.map((e) => e.label)).toEqual([
			"renameProject",
			"removeZoom",
			"splitCamera",
		]);
		expect(historyEntries().redo).toEqual([]);
	});
});
