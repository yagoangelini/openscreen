import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
	LibraryError,
	type LibraryGuards,
	listRecordings,
	renameRecording,
	resolveRecording,
	takeFolderName,
	takeFolderNameForFile,
	trashRecording,
	waitUntilMovable,
} from "./recordingsLibrary";

let root: string;
let outside: string;

const NO_GUARDS: LibraryGuards = {
	activeTakePaths: () => [],
	pendingTakePaths: async () => [],
};

async function write(file: string, bytes = 16) {
	await fs.mkdir(path.dirname(file), { recursive: true });
	await fs.writeFile(file, Buffer.alloc(bytes, 1));
}

async function nestedTake(id: number, folder = takeFolderName(id)) {
	const dir = path.join(root, folder);
	await write(path.join(dir, `recording-${id}.mp4`), 1000);
	await write(path.join(dir, `recording-${id}-webcam.mp4`), 500);
	await write(path.join(dir, `recording-${id}.voice.m4a`), 10);
	await write(path.join(dir, `recording-${id}.mp4.cursor.json`), 10);
	await write(path.join(dir, `recording-${id}.session.json`), 10);
	return dir;
}

async function flatTake(id: number) {
	await write(path.join(root, `recording-${id}.mp4`), 2000);
	await write(path.join(root, `recording-${id}-webcam.mp4`), 300);
	await write(path.join(root, `recording-${id}.mp4.layout.json`), 5);
}

async function code(promise: Promise<unknown>): Promise<string> {
	try {
		await promise;
		return "ok";
	} catch (error) {
		return error instanceof LibraryError ? error.code : String(error);
	}
}

beforeEach(async () => {
	const base = await fs.mkdtemp(path.join(os.tmpdir(), "library-"));
	root = path.join(base, "OpenScreen");
	outside = path.join(base, "elsewhere");
	await fs.mkdir(root);
	await fs.mkdir(outside);
});

afterEach(async () => {
	await fs.rm(path.dirname(root), { recursive: true, force: true });
});

describe("take folder names", () => {
	it("derives the folder from any of a take's file names", () => {
		expect(takeFolderName(1791)).toBe("recording-1791");
		expect(takeFolderNameForFile("recording-1791.mp4")).toBe("recording-1791");
		expect(takeFolderNameForFile("recording-1791-webcam.webm")).toBe("recording-1791");
		expect(takeFolderNameForFile("recording-1791.mp4.cursor.json")).toBe("recording-1791");
		expect(takeFolderNameForFile("voiceover-2026.webm")).toBeNull();
		expect(takeFolderNameForFile("recording-.mp4")).toBeNull();
	});
});

describe("listRecordings", () => {
	it("lists nested and flat takes, newest first, with their files and size", async () => {
		await nestedTake(1791000000000, "Aula 1");
		await flatTake(1700000000000);
		await write(path.join(root, "voiceover-x.webm"));
		await fs.mkdir(path.join(root, "not a take"));

		const list = await listRecordings(root, NO_GUARDS);
		expect(list.map((r) => [r.key, r.kind])).toEqual([
			["folder:Aula 1", "folder"],
			["flat:recording-1700000000000", "flat"],
		]);
		const [nested, flat] = list;
		expect(nested.files).toHaveLength(5);
		expect(nested.sizeBytes).toBe(1000 + 500 + 10 + 10 + 10);
		expect(nested.webcamVideoPath).toBe(
			path.join(root, "Aula 1", "recording-1791000000000-webcam.mp4"),
		);
		expect(nested.createdAt).toBe(1791000000000);
		expect(flat.files.map((f) => path.basename(f)).sort()).toEqual([
			"recording-1700000000000-webcam.mp4",
			"recording-1700000000000.mp4",
			"recording-1700000000000.mp4.layout.json",
		]);
		expect(flat.screenVideoPath).toBe(path.join(root, "recording-1700000000000.mp4"));
	});

	it("is empty for a folder that does not exist yet", async () => {
		expect(await listRecordings(path.join(root, "nope"), NO_GUARDS)).toEqual([]);
	});

	it("removes an empty take folder, unless a take is being recorded into it", async () => {
		await fs.mkdir(path.join(root, "recording-1"));
		await fs.mkdir(path.join(root, "recording-2"));
		await listRecordings(root, {
			activeTakePaths: () => [path.join(root, "recording-2", "recording-2.mp4")],
			pendingTakePaths: async () => [],
		});
		await expect(fs.stat(path.join(root, "recording-1"))).rejects.toThrow();
		expect((await fs.stat(path.join(root, "recording-2"))).isDirectory()).toBe(true);
	});

	it("marks a take busy while it records, waits for recovery, or has a crash checkpoint", async () => {
		await nestedTake(1);
		await nestedTake(2);
		await nestedTake(3);
		await write(path.join(root, "recording-3", "recording-3.mp4.cursor.ndjson"));
		const list = await listRecordings(root, {
			activeTakePaths: () => [path.join(root, "recording-1", "recording-1.mp4")],
			pendingTakePaths: async () => [path.join(root, "RECORDING-2", "recording-2.mp4")],
		});
		expect(Object.fromEntries(list.map((r) => [r.name, r.busy]))).toEqual({
			"recording-1": true,
			"recording-2": true,
			"recording-3": true,
		});
	});

	it("never follows a junction out of the folder", async () => {
		await write(path.join(outside, "recording-9.mp4"));
		await fs.symlink(outside, path.join(root, "linked"), "junction");
		const list = await listRecordings(root, NO_GUARDS);
		expect(list.map((r) => r.key)).not.toContain("folder:linked");
	});
});

describe("resolveRecording", () => {
	it("refuses traversal and separators in the key", async () => {
		for (const key of [
			"folder:..",
			"folder:.",
			"folder:../elsewhere",
			"folder:a\\..\\..",
			"folder:C:\\Windows",
			"flat:../recording-1",
			"other:x",
			"folder:",
			42,
			null,
		]) {
			expect(await code(resolveRecording(root, key))).toBe("invalid-key");
		}
	});

	it("refuses a junction pointing outside the folder", async () => {
		await write(path.join(outside, "recording-9.mp4"));
		await fs.symlink(outside, path.join(root, "linked"), "junction");
		expect(await code(resolveRecording(root, "folder:linked"))).toBe("outside-folder");
	});

	it("refuses a flat key that is not a take stem", async () => {
		await write(path.join(root, "notes.txt"));
		expect(await code(resolveRecording(root, "flat:notes"))).toBe("invalid-key");
		expect(await code(resolveRecording(root, "flat:recording-5"))).toBe("not-found");
	});
});

describe("renameRecording", () => {
	it("renames a take folder", async () => {
		const dir = await nestedTake(10);
		const result = await renameRecording(root, "folder:recording-10", "Aula 3: Teams", NO_GUARDS);
		expect(result.name).toBe("Aula 3- Teams");
		expect(result.folderPath).toBe(path.join(root, "Aula 3- Teams"));
		expect((await fs.readdir(result.folderPath)).sort()).toHaveLength(5);
		await expect(fs.stat(dir)).rejects.toThrow();
		expect(result.mapper(path.join(dir, "recording-10.mp4"))).toBe(
			path.join(result.folderPath, "recording-10.mp4"),
		);
		expect(result.moves).toHaveLength(5);
	});

	it("numbers a name that is taken, ignoring case", async () => {
		await nestedTake(11);
		await fs.mkdir(path.join(root, "aula"));
		await write(path.join(root, "Aula (2)"));
		const result = await renameRecording(root, "folder:recording-11", "Aula", NO_GUARDS);
		expect(result.name).toBe("Aula (3)");
	});

	it("changes only the case of a folder's own name", async () => {
		await nestedTake(12, "aula");
		const result = await renameRecording(root, "folder:aula", "Aula", NO_GUARDS);
		expect(result.name).toBe("Aula");
		expect(await fs.readdir(root)).toContain("Aula");
	});

	it("keeps the folder when the name is unchanged", async () => {
		await nestedTake(13, "Aula");
		const result = await renameRecording(root, "folder:Aula", "Aula", NO_GUARDS);
		expect(result.moves).toEqual([]);
	});

	it("refuses an unusable name", async () => {
		await nestedTake(14);
		for (const name of ["", "  ", "CON", "..", 7]) {
			expect(await code(renameRecording(root, "folder:recording-14", name, NO_GUARDS))).toBe(
				"invalid-name",
			);
		}
	});

	it("refuses a take that is being recorded or recovered", async () => {
		await nestedTake(15);
		const guards: LibraryGuards = {
			activeTakePaths: () => [],
			pendingTakePaths: async () => [path.join(root, "recording-15", "recording-15.mp4")],
		};
		expect(await code(renameRecording(root, "folder:recording-15", "x", guards))).toBe("busy");
		expect(await fs.readdir(root)).toContain("recording-15");
	});

	it("moves a flat take into a folder of its own", async () => {
		await flatTake(16);
		const result = await renameRecording(root, "flat:recording-16", "Antiga", NO_GUARDS);
		expect((await fs.readdir(result.folderPath)).sort()).toEqual([
			"recording-16-webcam.mp4",
			"recording-16.mp4",
			"recording-16.mp4.layout.json",
		]);
		expect(await fs.readdir(root)).toEqual(["Antiga"]);
		expect(result.mapper(path.join(root, "recording-16.mp4"))).toBe(
			path.join(root, "Antiga", "recording-16.mp4"),
		);
		expect(result.mapper(path.join(root, "recording-160.mp4"))).toBeNull();
	});

	it("puts a flat take back where it was when one file cannot move", async () => {
		await flatTake(17);
		let calls = 0;
		const failing = async (from: string, to: string) => {
			calls += 1;
			if (calls === 2) throw Object.assign(new Error("busy"), { code: "EBUSY" });
			await fs.rename(from, to);
		};
		expect(
			await code(
				renameRecording(root, "flat:recording-17", "X", NO_GUARDS, {
					rename: failing,
					attempts: 1,
				}),
			),
		).toBe("in-use");
		expect((await fs.readdir(root)).sort()).toEqual([
			"recording-17-webcam.mp4",
			"recording-17.mp4",
			"recording-17.mp4.layout.json",
		]);
	});

	it("retries a folder held open for a moment", async () => {
		await nestedTake(18);
		let calls = 0;
		const flaky = async (from: string, to: string) => {
			calls += 1;
			if (calls < 3) throw Object.assign(new Error("perm"), { code: "EPERM" });
			await fs.rename(from, to);
		};
		const result = await renameRecording(root, "folder:recording-18", "Y", NO_GUARDS, {
			rename: flaky,
		});
		expect(result.name).toBe("Y");
		expect(calls).toBe(3);
	});
});

describe("trashRecording", () => {
	it("sends the whole folder, never a file inside it", async () => {
		await nestedTake(20, "Aula");
		const trashed: string[] = [];
		await trashRecording(root, "folder:Aula", NO_GUARDS, async (target) => {
			trashed.push(target);
		});
		expect(trashed).toEqual([path.join(root, "Aula")]);
	});

	it("sends every file of a flat take, and only those", async () => {
		await flatTake(21);
		await flatTake(210);
		const trashed: string[] = [];
		await trashRecording(root, "flat:recording-21", NO_GUARDS, async (target) => {
			trashed.push(path.basename(target));
		});
		expect(trashed.sort()).toEqual([
			"recording-21-webcam.mp4",
			"recording-21.mp4",
			"recording-21.mp4.layout.json",
		]);
	});

	it("refuses outside the folder and while busy, touching nothing", async () => {
		await write(path.join(outside, "recording-9.mp4"));
		await fs.symlink(outside, path.join(root, "linked"), "junction");
		await nestedTake(22);
		const trashed: string[] = [];
		const trash = async (target: string) => {
			trashed.push(target);
		};
		expect(await code(trashRecording(root, "folder:linked", NO_GUARDS, trash))).toBe(
			"outside-folder",
		);
		expect(await code(trashRecording(root, "folder:..", NO_GUARDS, trash))).toBe("invalid-key");
		const busy: LibraryGuards = {
			activeTakePaths: () => [path.join(root, "recording-22", "recording-22.mp4")],
			pendingTakePaths: async () => [],
		};
		expect(await code(trashRecording(root, "folder:recording-22", busy, trash))).toBe("busy");
		expect(trashed).toEqual([]);
	});

	it("reports a bin that keeps refusing instead of deleting for good", async () => {
		await nestedTake(23);
		const result = await code(
			trashRecording(
				root,
				"folder:recording-23",
				NO_GUARDS,
				async () => {
					throw new Error("no recycle bin");
				},
				{ trashAttempts: 2 },
			),
		);
		expect(result).toBe("trash-failed");
		expect(await fs.readdir(root)).toContain("recording-23");
	});

	it("lets the take go first, then never asks the bin while something still holds it", async () => {
		await nestedTake(24);
		const order: string[] = [];
		// Windows refuses to move a folder with a file open in it: the probe fails every time.
		const held = async () => {
			order.push("probe");
			throw Object.assign(new Error("EPERM: operation not permitted"), { code: "EPERM" });
		};
		const result = await code(
			trashRecording(
				root,
				"folder:recording-24",
				NO_GUARDS,
				async () => {
					order.push("bin");
				},
				{
					release: async () => {
						order.push("release");
					},
					rename: held,
					attempts: 3,
				},
			),
		);
		expect(result).toBe("in-use");
		expect(order).toEqual(["release", "probe", "probe", "probe"]);
		expect(await fs.readdir(root)).toEqual(["recording-24"]);
	});

	it("waits out a short hold, then sends the folder under its own name", async () => {
		await nestedTake(25, "Aula curta");
		let refusals = 2;
		const rename = async (from: string, to: string) => {
			if (refusals-- > 0) {
				throw Object.assign(new Error("EBUSY"), { code: "EBUSY" });
			}
			await fs.rename(from, to);
		};
		const trashed: string[] = [];
		await trashRecording(
			root,
			"folder:Aula curta",
			NO_GUARDS,
			async (target) => {
				trashed.push(target);
				expect(await fs.readdir(root)).toEqual(["Aula curta"]);
			},
			{ rename, attempts: 4 },
		);
		expect(trashed).toEqual([path.join(root, "Aula curta")]);
	});

	it("probes each file of a flat take before the bin gets it", async () => {
		await flatTake(26);
		const probed: string[] = [];
		const rename = async (from: string, to: string) => {
			if (!path.basename(from).startsWith(".")) probed.push(path.basename(from));
			await fs.rename(from, to);
		};
		const trashed: string[] = [];
		await trashRecording(
			root,
			"flat:recording-26",
			NO_GUARDS,
			async (target) => {
				trashed.push(path.basename(target));
			},
			{ rename },
		);
		expect(probed.sort()).toEqual(trashed.sort());
		expect(trashed.length).toBeGreaterThan(1);
	});
});

describe("waitUntilMovable", () => {
	it("leaves the target where it was", async () => {
		await nestedTake(27, "Fica");
		await waitUntilMovable(path.join(root, "Fica"));
		expect(await fs.readdir(root)).toEqual(["Fica"]);
	});
});
