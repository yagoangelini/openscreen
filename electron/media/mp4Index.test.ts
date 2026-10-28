import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { hasMp4Index } from "./mp4Index";

/** A top-level box: 32-bit size, four-letter type, then the payload. */
function box(type: string, payload = Buffer.alloc(0)): Buffer {
	const header = Buffer.alloc(8);
	header.writeUInt32BE(8 + payload.length, 0);
	header.write(type, 4, "latin1");
	return Buffer.concat([header, payload]);
}

/** A box with the 64-bit size form (`size == 1`, then the real size). */
function largeBox(type: string, payload: Buffer): Buffer {
	const header = Buffer.alloc(16);
	header.writeUInt32BE(1, 0);
	header.write(type, 4, "latin1");
	header.writeBigUInt64BE(BigInt(16 + payload.length), 8);
	return Buffer.concat([header, payload]);
}

describe("hasMp4Index", () => {
	let dir: string;
	const write = async (name: string, data: Buffer) => {
		const file = path.join(dir, name);
		await fs.writeFile(file, data);
		return file;
	};

	beforeAll(async () => {
		dir = await fs.mkdtemp(path.join(os.tmpdir(), "mp4-index-"));
	});
	afterAll(async () => {
		// Windows keeps a just-unlinked file "delete pending" while a scanner holds it, and the folder
		// reads as not empty for a moment: retry instead of failing the test on its cleanup.
		await fs.rm(dir, { recursive: true, force: true, maxRetries: 10, retryDelay: 50 });
	});

	it("finds the index a finished writer leaves at the end", async () => {
		const file = await write(
			"done.m4a",
			Buffer.concat([box("ftyp", Buffer.from("M4A ")), box("mdat", Buffer.alloc(64)), box("moov")]),
		);
		expect(await hasMp4Index(file)).toBe(true);
	});

	it("reads past a long mdat written with the 64-bit size", async () => {
		const file = await write(
			"large.m4a",
			Buffer.concat([
				box("ftyp"),
				largeBox("mdat", Buffer.alloc(40)),
				box("moov", Buffer.alloc(8)),
			]),
		);
		expect(await hasMp4Index(file)).toBe(true);
	});

	it("refuses a file whose writer died before it finalized", async () => {
		// The mdat size is only filled in on finalize: "to the end of the file" until then.
		const unsized = Buffer.concat([box("ftyp"), box("mdat", Buffer.alloc(64))]);
		unsized.writeUInt32BE(0, 8);
		expect(await hasMp4Index(await write("crashed.m4a", unsized))).toBe(false);
		// Or a size that runs past what was written.
		const truncated = Buffer.concat([box("ftyp"), box("mdat", Buffer.alloc(64))]).subarray(0, 40);
		expect(await hasMp4Index(await write("truncated.m4a", truncated))).toBe(false);
	});

	it("refuses an index cut short, a file that is not an MP4, and a missing file", async () => {
		const cut = Buffer.concat([box("ftyp"), box("moov", Buffer.alloc(32))]).subarray(0, 30);
		expect(await hasMp4Index(await write("cut.m4a", cut))).toBe(false);
		expect(await hasMp4Index(await write("text.m4a", Buffer.from("aac")))).toBe(false);
		expect(await hasMp4Index(path.join(dir, "missing.m4a"))).toBe(false);
	});
});
