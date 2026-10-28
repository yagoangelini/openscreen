import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { removeEmptyCaptureOutput } from "./removeEmptyCaptureOutput";

let dir: string;

beforeAll(async () => {
	dir = await fs.mkdtemp(path.join(os.tmpdir(), "empty-capture-output-"));
});

afterAll(async () => {
	// Windows keeps a just-unlinked file "delete pending" while a scanner holds it, and the folder
	// reads as not empty for a moment: retry instead of failing the test on its cleanup.
	await fs.rm(dir, { recursive: true, force: true, maxRetries: 10, retryDelay: 50 });
});

describe("removeEmptyCaptureOutput", () => {
	it("deletes the empty file a start that never began leaves", async () => {
		const file = path.join(dir, "empty.mp4");
		await fs.writeFile(file, "");
		await removeEmptyCaptureOutput(file);
		await expect(fs.stat(file)).rejects.toThrow();
	});

	it("never deletes a file with a single byte in it", async () => {
		const file = path.join(dir, "one-byte.mp4");
		await fs.writeFile(file, "x");
		await removeEmptyCaptureOutput(file);
		expect((await fs.stat(file)).size).toBe(1);
	});

	it("leaves a directory alone and says nothing when the file is missing", async () => {
		const sub = await fs.mkdtemp(path.join(dir, "sub-"));
		await removeEmptyCaptureOutput(sub);
		expect((await fs.stat(sub)).isDirectory()).toBe(true);
		await expect(removeEmptyCaptureOutput(path.join(dir, "missing.mp4"))).resolves.toBe(undefined);
	});
});
