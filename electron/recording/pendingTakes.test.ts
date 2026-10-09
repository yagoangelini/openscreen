import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
	clearPendingTake,
	collectRecoverableTakes,
	PENDING_TAKES_FILE,
	RECOVERABLE_TAKE_MIN_BYTES,
	readPendingTakes,
	recordPendingTake,
} from "./pendingTakes";

let dir: string;

beforeEach(async () => {
	dir = await fs.mkdtemp(path.join(os.tmpdir(), "openscreen-pending-takes-"));
});

afterEach(async () => {
	await fs.rm(dir, { recursive: true, force: true });
});

async function writeFile(name: string, bytes: number) {
	const filePath = path.join(dir, name);
	await fs.writeFile(filePath, Buffer.alloc(bytes));
	return filePath;
}

describe("pending takes journal", () => {
	it("reads as empty when no journal exists", async () => {
		expect(await readPendingTakes(dir)).toEqual([]);
	});

	it("reads as empty when the journal is damaged", async () => {
		await fs.writeFile(path.join(dir, PENDING_TAKES_FILE), "{not json");
		expect(await readPendingTakes(dir)).toEqual([]);
	});

	it("records a take once per screen file", async () => {
		const screen = path.join(dir, "recording-1.mp4");
		await recordPendingTake(dir, { screenVideoPath: screen, createdAt: 1 });
		await recordPendingTake(dir, {
			screenVideoPath: screen,
			createdAt: 1,
			webcamVideoPath: path.join(dir, "recording-1-webcam.mp4"),
		});
		const takes = await readPendingTakes(dir);
		expect(takes).toHaveLength(1);
		expect(takes[0].webcamVideoPath).toBe(path.join(dir, "recording-1-webcam.mp4"));
	});

	it("removes the journal file once the last take is cleared", async () => {
		const screen = path.join(dir, "recording-1.mp4");
		await recordPendingTake(dir, { screenVideoPath: screen, createdAt: 1 });
		await clearPendingTake(dir, screen.toUpperCase());
		await expect(fs.stat(path.join(dir, PENDING_TAKES_FILE))).rejects.toThrow();
	});
});

describe("collectRecoverableTakes", () => {
	it("offers playable takes newest first and keeps them listed", async () => {
		const older = await writeFile("recording-1.mp4", RECOVERABLE_TAKE_MIN_BYTES);
		const newer = await writeFile("recording-2.mp4", RECOVERABLE_TAKE_MIN_BYTES * 2);
		await recordPendingTake(dir, { screenVideoPath: older, createdAt: 1 });
		await recordPendingTake(dir, { screenVideoPath: newer, createdAt: 2 });

		const takes = await collectRecoverableTakes(dir);
		expect(takes.map((take) => take.screenVideoPath)).toEqual([newer, older]);
		expect(await readPendingTakes(dir)).toHaveLength(2);
	});

	it("forgets takes whose file is missing or too small to hold a frame", async () => {
		const stub = await writeFile("recording-1.mp4", 100);
		const missing = path.join(dir, "recording-2.mp4");
		await recordPendingTake(dir, { screenVideoPath: stub, createdAt: 1 });
		await recordPendingTake(dir, { screenVideoPath: missing, createdAt: 2 });

		expect(await collectRecoverableTakes(dir)).toEqual([]);
		expect(await readPendingTakes(dir)).toEqual([]);
	});

	it("drops a webcam file that did not survive but keeps the screen", async () => {
		const screen = await writeFile("recording-1.mp4", RECOVERABLE_TAKE_MIN_BYTES);
		const webcam = await writeFile("recording-1-webcam.mp4", 0);
		await recordPendingTake(dir, {
			screenVideoPath: screen,
			webcamVideoPath: webcam,
			createdAt: 1,
		});

		const [take] = await collectRecoverableTakes(dir);
		expect(take.screenVideoPath).toBe(screen);
		expect(take.webcamVideoPath).toBeUndefined();
	});

	it("never offers the take that is recording right now", async () => {
		const live = await writeFile("recording-1.mp4", RECOVERABLE_TAKE_MIN_BYTES);
		await recordPendingTake(dir, { screenVideoPath: live, createdAt: 1 });

		expect(await collectRecoverableTakes(dir, { excludeScreenVideoPath: live })).toEqual([]);
		expect(await readPendingTakes(dir)).toHaveLength(1);
	});
});
