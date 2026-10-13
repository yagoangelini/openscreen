import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { type AxcutDocument, createEmptyDocument } from "../schema";
import { useProjectStore } from "./projectStore";
import {
	assetsUsingFiles,
	documentUsesFiles,
	rewriteOpenProjectMedia,
	useMediaRelease,
	withMediaReleased,
} from "./recordingMedia";
import { clearHistory, future, past, pushFuture, pushHistory } from "./undoStack";

const save = vi.hoisted(() => vi.fn());
vi.mock("@/native/client", () => ({
	nativeBridgeClient: { aiEdition: { save } },
}));
vi.mock("sonner", () => ({ toast: { error: vi.fn() } }));

const FROM = "C:\\V\\recording-1";
const TO = "C:\\V\\Aula 1";

function doc(dir: string): AxcutDocument {
	const base = createEmptyDocument({ projectId: "proj_1", title: "Aula" });
	return {
		...base,
		assets: [
			{
				id: "asset_1",
				kind: "video",
				label: "take",
				originalPath: `${dir}\\recording-1.mp4`,
				cameraTrack: {
					sourcePath: `${dir}\\recording-1-webcam.mp4`,
					startMs: 0,
					offsetMs: 0,
					visible: true,
				},
			},
		],
	};
}

const moves: Array<[string, string]> = [
	[`${FROM}\\recording-1.mp4`, `${TO}\\recording-1.mp4`],
	[`${FROM}\\recording-1-webcam.mp4`, `${TO}\\recording-1-webcam.mp4`],
];

beforeEach(() => {
	clearHistory();
	save.mockReset();
	save.mockImplementation(async (document: AxcutDocument) => ({ success: true, document }));
	useProjectStore.setState({ projectId: "proj_1", document: doc(FROM) });
});

afterEach(() => {
	useProjectStore.getState().clear();
});

describe("rewriteOpenProjectMedia", () => {
	it("repoints the open project and both undo stacks, and saves without recording an undo", async () => {
		pushHistory({ projectId: "proj_1", doc: doc(FROM) });
		pushFuture({ projectId: "proj_1", doc: doc(FROM) });
		expect(await rewriteOpenProjectMedia(moves)).toBe(true);
		const current = useProjectStore.getState().document;
		expect(current?.assets[0].originalPath).toBe(`${TO}\\recording-1.mp4`);
		expect(current?.assets[0].cameraTrack?.sourcePath).toBe(`${TO}\\recording-1-webcam.mp4`);
		expect(save).toHaveBeenCalledTimes(1);
		expect(past).toHaveLength(1);
		for (const snapshot of [...past, ...future]) {
			expect((snapshot.doc as AxcutDocument).assets[0].originalPath).toBe(`${TO}\\recording-1.mp4`);
		}
	});

	it("leaves a project that does not use the files alone", async () => {
		useProjectStore.setState({ document: doc("C:\\elsewhere") });
		expect(await rewriteOpenProjectMedia(moves)).toBe(false);
		expect(save).not.toHaveBeenCalled();
	});
});

describe("documentUsesFiles / assetsUsingFiles", () => {
	it("tells which assets point at a recording's files", () => {
		const files = moves.map(([from]) => from);
		expect(documentUsesFiles(doc(FROM), files)).toBe(true);
		expect(documentUsesFiles(doc(TO), files)).toBe(false);
		expect(assetsUsingFiles(doc(FROM), [files[1]])).toEqual(["asset_1"]);
		expect(assetsUsingFiles(null, files)).toEqual([]);
	});
});

describe("withMediaReleased", () => {
	it("holds the preview released while the operation runs, even when it throws", async () => {
		vi.useFakeTimers();
		try {
			const seen: number[] = [];
			const run = withMediaReleased(async () => {
				seen.push(useMediaRelease.getState().released);
				throw new Error("busy");
			});
			expect(useMediaRelease.getState().released).toBe(1);
			const settled = run.catch((error: Error) => error.message);
			await vi.advanceTimersByTimeAsync(500);
			expect(await settled).toBe("busy");
			expect(seen).toEqual([1]);
			expect(useMediaRelease.getState().released).toBe(0);
		} finally {
			vi.useRealTimers();
		}
	});
});
