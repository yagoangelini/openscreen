import { describe, expect, it } from "vitest";
import {
	collectMediaPaths,
	combineMappers,
	filesMoveMapper,
	folderMoveMapper,
	isPathUnder,
	rewriteMediaPaths,
} from "./mediaPathRewrite";

const FROM = "C:\\Users\\Yago\\Videos\\OpenScreen\\recording-1791";
const TO = "C:\\Users\\Yago\\Videos\\OpenScreen\\Aula 3 - Copilot";

describe("folderMoveMapper", () => {
	const map = folderMoveMapper(FROM, TO);

	it("moves a file inside the folder", () => {
		expect(map(`${FROM}\\recording-1791.mp4`)).toBe(`${TO}\\recording-1791.mp4`);
	});

	it("matches Windows paths without case and with either separator", () => {
		expect(map("c:/users/yago/videos/openscreen/RECORDING-1791/recording-1791.voice.m4a")).toBe(
			`${TO}\\recording-1791.voice.m4a`,
		);
	});

	it("maps the folder itself", () => {
		expect(map(`${FROM}\\`)).toBe(TO);
	});

	it("leaves a sibling with the same prefix alone", () => {
		expect(map(`${FROM}0\\recording-17910.mp4`)).toBeNull();
		expect(map(`${FROM}.mp4`)).toBeNull();
	});

	it("leaves relative paths and plain text alone", () => {
		expect(map("recording-1791.mp4")).toBeNull();
		expect(map("Gravação de hoje")).toBeNull();
	});

	it("keeps POSIX paths case-sensitive", () => {
		const posix = folderMoveMapper("/home/y/OpenScreen/a", "/home/y/OpenScreen/b");
		expect(posix("/home/y/OpenScreen/a/x.mp4")).toBe("/home/y/OpenScreen/b/x.mp4");
		expect(posix("/home/y/OpenScreen/A/x.mp4")).toBeNull();
	});
});

describe("filesMoveMapper", () => {
	it("moves exactly the listed files", () => {
		const map = filesMoveMapper([
			["C:\\R\\recording-1.mp4", "C:\\R\\Aula\\recording-1.mp4"],
			["C:\\R\\recording-1-webcam.mp4", "C:\\R\\Aula\\recording-1-webcam.mp4"],
		]);
		expect(map("c:\\r\\RECORDING-1.mp4")).toBe("C:\\R\\Aula\\recording-1.mp4");
		expect(map("C:\\R\\recording-1.mp4.cursor.json")).toBeNull();
	});
});

describe("rewriteMediaPaths", () => {
	const document = {
		project: { id: "proj_1", title: `Aula em ${FROM}` },
		assets: [
			{
				id: "asset_1",
				originalPath: `${FROM}\\recording-1791.mp4`,
				cameraTrack: { sourcePath: `${FROM}\\recording-1791-webcam.mp4`, offsetMs: 0 },
				audioStems: {
					voicePath: `${FROM}\\recording-1791.voice.m4a`,
					systemPath: `${FROM}\\recording-1791.system.m4a`,
				},
			},
			{ id: "asset_2", originalPath: "D:\\outra\\video.mp4", cameraTrack: null },
		],
		timeline: { clips: [{ id: "c1", assetId: "asset_1" }] },
	};

	it("rewrites every path under the moved folder, and nothing else", () => {
		const { value, changed } = rewriteMediaPaths(document, folderMoveMapper(FROM, TO));
		expect(changed).toBe(4);
		expect(value.assets[0]).toMatchObject({
			originalPath: `${TO}\\recording-1791.mp4`,
			cameraTrack: { sourcePath: `${TO}\\recording-1791-webcam.mp4` },
			audioStems: {
				voicePath: `${TO}\\recording-1791.voice.m4a`,
				systemPath: `${TO}\\recording-1791.system.m4a`,
			},
		});
		// Text that merely mentions the path is not a path.
		expect(value.project.title).toBe(document.project.title);
		expect(value.assets[1]).toBe(document.assets[1]);
		expect(value.timeline).toBe(document.timeline);
	});

	it("never mutates its input", () => {
		const before = JSON.stringify(document);
		rewriteMediaPaths(document, folderMoveMapper(FROM, TO));
		expect(JSON.stringify(document)).toBe(before);
	});

	it("hands back the same reference when nothing moved", () => {
		const { value, changed } = rewriteMediaPaths(document, folderMoveMapper("E:\\x", "E:\\y"));
		expect(changed).toBe(0);
		expect(value).toBe(document);
	});

	it("combines mappers, first claim wins", () => {
		const map = combineMappers(
			filesMoveMapper([["D:\\outra\\video.mp4", "D:\\nova\\video.mp4"]]),
			folderMoveMapper(FROM, TO),
		);
		const { value, changed } = rewriteMediaPaths(document, map);
		expect(changed).toBe(5);
		expect(value.assets[1].originalPath).toBe("D:\\nova\\video.mp4");
	});
});

describe("collectMediaPaths / isPathUnder", () => {
	it("lists absolute paths only", () => {
		expect(collectMediaPaths({ a: ["C:\\x.mp4", "rel.mp4", { b: "/tmp/y" }], n: 3 })).toEqual([
			"C:\\x.mp4",
			"/tmp/y",
		]);
	});

	it("tells whether a path is under a folder", () => {
		expect(isPathUnder(`${FROM}\\recording-1791.mp4`, FROM)).toBe(true);
		expect(isPathUnder(`${FROM}x\\recording-1791.mp4`, FROM)).toBe(false);
	});
});
