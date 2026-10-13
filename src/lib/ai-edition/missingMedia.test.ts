import { describe, expect, it } from "vitest";
import {
	dropMissingCameras,
	mediaFilesOf,
	mediaSignature,
	missingMediaOf,
	relinkDocument,
} from "./missingMedia";
import { type AxcutDocument, createEmptyDocument } from "./schema";

const DIR = "C:\\Users\\Yago\\Videos\\OpenScreen\\Aula 1";

function documentWith(assets: Array<Partial<AxcutDocument["assets"][number]>>): AxcutDocument {
	const base = createEmptyDocument({ projectId: "proj_1", title: "Aula" });
	return {
		...base,
		assets: assets.map((asset, index) => ({
			id: `asset_${index}`,
			kind: "video" as const,
			label: `take ${index}`,
			originalPath: `${DIR}\\recording-${index}.mp4`,
			cameraTrack: null,
			...asset,
		})),
	};
}

const camera = (path: string) => ({ sourcePath: path, startMs: 0, offsetMs: 0, visible: true });

describe("missing media", () => {
	const doc = documentWith([
		{
			cameraTrack: camera(`${DIR}\\recording-0-webcam.mp4`),
			audioStems: {
				voicePath: `${DIR}\\recording-0.voice.m4a`,
				systemPath: `${DIR}\\recording-0.system.m4a`,
			},
		},
		{ kind: "audio", originalPath: "C:\\music.mp3" },
	]);

	it("checks each video's screen and camera, not audio overlays or stems", () => {
		expect(mediaFilesOf(doc).map((file) => [file.role, file.path])).toEqual([
			["screen", `${DIR}\\recording-0.mp4`],
			["camera", `${DIR}\\recording-0-webcam.mp4`],
		]);
	});

	it("reports what the main process says is gone", () => {
		const files = mediaFilesOf(doc);
		expect(missingMediaOf(files, [true, true])).toEqual([]);
		expect(missingMediaOf(files, [false, true]).map((file) => file.role)).toEqual(["screen"]);
		// No answer for a file is not "missing".
		expect(missingMediaOf(files, [])).toEqual([]);
	});

	it("changes signature only when the paths do", () => {
		const renamed = { ...doc, project: { ...doc.project, title: "Outra" } };
		expect(mediaSignature(renamed)).toBe(mediaSignature(doc));
		expect(mediaSignature(documentWith([{}]))).not.toBe(mediaSignature(doc));
		expect(mediaSignature(null)).toBe("");
	});

	it("relinks the whole folder when the picked file has the same name", () => {
		const [screen] = mediaFilesOf(doc);
		const next = relinkDocument(doc, screen, "D:\\Backup\\Aula 1\\recording-0.mp4");
		expect(next.assets[0].originalPath).toBe("D:\\Backup\\Aula 1\\recording-0.mp4");
		expect(next.assets[0].cameraTrack?.sourcePath).toBe(
			"D:\\Backup\\Aula 1\\recording-0-webcam.mp4",
		);
		expect(next.assets[0].audioStems?.voicePath).toBe("D:\\Backup\\Aula 1\\recording-0.voice.m4a");
		expect(next.assets[1]).toBe(doc.assets[1]);
	});

	it("repoints only that file when the picked one has another name", () => {
		const [screen] = mediaFilesOf(doc);
		const next = relinkDocument(doc, screen, "D:\\outro.mp4");
		expect(next.assets[0].originalPath).toBe("D:\\outro.mp4");
		expect(next.assets[0].cameraTrack?.sourcePath).toBe(`${DIR}\\recording-0-webcam.mp4`);
	});

	it("drops only the cameras that are missing", () => {
		const [, cam] = mediaFilesOf(doc);
		expect(dropMissingCameras(doc, [cam]).assets[0].cameraTrack).toBeNull();
		expect(dropMissingCameras(doc, [])).toBe(doc);
	});
});
