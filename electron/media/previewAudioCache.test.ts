import { promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { evictPreviewAudioCache, removeLegacyPreviewAudio } from "./previewAudioCache";

let root: string;

beforeEach(async () => {
	root = await fs.mkdtemp(path.join(os.tmpdir(), "openscreen-preview-cache-test-"));
});

afterEach(async () => {
	await fs.rm(root, { recursive: true, force: true });
});

/** A file of `size` bytes, last modified `ageSec` seconds ago. */
async function file(name: string, size: number, ageSec: number): Promise<string> {
	const filePath = path.join(root, "cache", name);
	await fs.mkdir(path.dirname(filePath), { recursive: true });
	await fs.writeFile(filePath, Buffer.alloc(size));
	const when = new Date(Date.now() - ageSec * 1000);
	await fs.utimes(filePath, when, when);
	return filePath;
}

const exists = (filePath: string) =>
	fs.access(filePath).then(
		() => true,
		() => false,
	);

describe("removeLegacyPreviewAudio", () => {
	it("deletes userData/preview-audio and nothing else in userData", async () => {
		const userData = path.join(root, "userData");
		await fs.mkdir(path.join(userData, "preview-audio"), { recursive: true });
		await fs.writeFile(path.join(userData, "preview-audio", "take.voice-enhanced-80.wav"), "x");
		await fs.mkdir(path.join(userData, "projects"), { recursive: true });
		await fs.writeFile(path.join(userData, "projects", "p.openscreen"), "{}");
		await fs.writeFile(path.join(userData, "recording-settings.json"), "{}");

		expect(await removeLegacyPreviewAudio(userData)).toBe(true);
		expect(await exists(path.join(userData, "preview-audio"))).toBe(false);
		expect(await exists(path.join(userData, "projects", "p.openscreen"))).toBe(true);
		expect(await exists(path.join(userData, "recording-settings.json"))).toBe(true);
	});

	it("does nothing when the folder is not there, or is not a folder", async () => {
		const userData = path.join(root, "userData");
		await fs.mkdir(userData, { recursive: true });
		expect(await removeLegacyPreviewAudio(userData)).toBe(false);
		await fs.writeFile(path.join(userData, "preview-audio"), "a file");
		expect(await removeLegacyPreviewAudio(userData)).toBe(false);
		expect(await exists(path.join(userData, "preview-audio"))).toBe(true);
	});
});

describe("evictPreviewAudioCache", () => {
	it("deletes the oldest files until the folder fits", async () => {
		const oldest = await file("a.wav", 400, 400);
		const older = await file("b.wav", 400, 300);
		const newer = await file("c.wav", 400, 200);
		const newest = await file("d.wav", 400, 100);
		const deleted = await evictPreviewAudioCache(path.join(root, "cache"), () => false, 1000);
		expect(deleted).toEqual([oldest, older]);
		expect(await exists(newer)).toBe(true);
		expect(await exists(newest)).toBe(true);
	});

	it("never deletes the file just written or one a running job writes", async () => {
		const running = await file("running.wav.partial", 400, 500);
		const old = await file("old.wav", 400, 400);
		const middle = await file("middle.wav", 400, 300);
		const justWritten = await file("new.wav", 400, 1000);
		const keep = new Set([running, justWritten]);
		const deleted = await evictPreviewAudioCache(
			path.join(root, "cache"),
			(filePath) => keep.has(filePath),
			800,
		);
		expect(deleted).toEqual([old, middle]);
		expect(await exists(running)).toBe(true);
		expect(await exists(justWritten)).toBe(true);
	});

	it("leaves a folder under the cap alone, and a missing folder is not an error", async () => {
		const only = await file("a.wav", 100, 10);
		expect(await evictPreviewAudioCache(path.join(root, "cache"), () => false, 1000)).toEqual([]);
		expect(await exists(only)).toBe(true);
		expect(await evictPreviewAudioCache(path.join(root, "nowhere"), () => false, 1)).toEqual([]);
	});
});
