import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { CursorRecordingData, CursorRecordingSample } from "../../src/native/contracts";
import {
	CURSOR_CHECKPOINT_SUFFIX,
	CursorCheckpointWriter,
	compactCursorPauseRanges,
	rebuildCursorTelemetry,
	recoverCursorCheckpoint,
	shiftCursorTelemetry,
} from "./cursorCheckpoint";

const sample = (
	timeMs: number,
	extra: Partial<CursorRecordingSample> = {},
): CursorRecordingSample => ({
	timeMs,
	cx: 0.5,
	cy: 0.5,
	assetId: "0x10003",
	visible: true,
	cursorType: null,
	interactionType: "move",
	...extra,
});
const asset = {
	id: "0x10003",
	platform: "win32" as const,
	imageDataUrl: "data:image/png;base64,AAAA",
	width: 32,
	height: 32,
	hotspotX: 1,
	hotspotY: 1,
};

describe("cursor pause and offset", () => {
	const data = (times: number[]): CursorRecordingData => ({
		version: 2,
		provider: "native",
		samples: times.map((t) => sample(t)),
		assets: [],
	});

	it("drops the paused samples and closes the gap", () => {
		const out = compactCursorPauseRanges(data([100, 1500, 3000]), [{ startMs: 1000, endMs: 2000 }]);
		expect(out.samples.map((s) => s.timeMs)).toEqual([100, 2000]);
	});

	it("moves everything onto the first frame, never before zero", () => {
		const out = shiftCursorTelemetry(data([300, 100, 900]), 400);
		expect(out.samples.map((s) => s.timeMs)).toEqual([0, 0, 500]);
	});
});

describe("cursor checkpoint", () => {
	let dir = "";
	beforeEach(async () => {
		dir = await fs.mkdtemp(path.join(os.tmpdir(), "cursor-checkpoint-"));
	});
	afterEach(async () => {
		await fs.rm(dir, { recursive: true, force: true });
	});

	it("appends only what is new, and rebuilds what the stop would have written", async () => {
		const video = path.join(dir, "take.mp4");
		const writer = new CursorCheckpointWriter(`${video}${CURSOR_CHECKPOINT_SUFFIX}`);
		const samples = [sample(500), sample(900, { interactionType: "click" })];
		writer.meta(400);
		await writer.flush({ samples, assets: [asset] });
		samples.push(sample(1600), sample(5200));
		writer.pause({ startMs: 2000, endMs: 4000 });
		await writer.flush({ samples, assets: [asset] });

		const text = await fs.readFile(`${video}${CURSOR_CHECKPOINT_SUFFIX}`, "utf-8");
		expect(text.split("\n").filter((line) => line.includes('"type":"asset"'))).toHaveLength(1);
		expect(text.split("\n").filter((line) => line.includes('"type":"sample"'))).toHaveLength(4);

		const rebuilt = rebuildCursorTelemetry(text);
		// 5200 - 2000 paused - 400 offset = 2800.
		expect(rebuilt?.samples.map((s) => s.timeMs)).toEqual([100, 500, 1200, 2800]);
		expect(rebuilt?.samples[1].interactionType).toBe("click");
		expect(rebuilt?.assets).toEqual([asset]);
		expect(rebuilt?.provider).toBe("native");
	});

	it("survives the line the crash cut short", () => {
		const text = `${JSON.stringify({ type: "sample", sample: sample(100) })}\n{"type":"sample","sam`;
		expect(rebuildCursorTelemetry(text)?.samples).toHaveLength(1);
	});

	it("has nothing to rebuild from an empty checkpoint", () => {
		expect(
			rebuildCursorTelemetry(`${JSON.stringify({ type: "meta", cursorOffsetMs: 3 })}\n`),
		).toBeNull();
	});

	it("recovers the cursor file for a take the stop never reached", async () => {
		const video = path.join(dir, "take.mp4");
		await fs.writeFile(
			`${video}${CURSOR_CHECKPOINT_SUFFIX}`,
			`${JSON.stringify({ type: "sample", sample: sample(100) })}\n`,
		);
		expect(await recoverCursorCheckpoint(video)).toBe(true);
		const written = JSON.parse(await fs.readFile(`${video}.cursor.json`, "utf-8"));
		expect(written.samples).toHaveLength(1);
		await expect(fs.access(`${video}${CURSOR_CHECKPOINT_SUFFIX}`)).rejects.toThrow();
	});

	it("leaves a cursor file the stop wrote alone, and drops the checkpoint", async () => {
		const video = path.join(dir, "take.mp4");
		await fs.writeFile(`${video}.cursor.json`, '{"kept":true}');
		await fs.writeFile(`${video}${CURSOR_CHECKPOINT_SUFFIX}`, "");
		expect(await recoverCursorCheckpoint(video)).toBe(true);
		expect(await fs.readFile(`${video}.cursor.json`, "utf-8")).toBe('{"kept":true}');
		await expect(fs.access(`${video}${CURSOR_CHECKPOINT_SUFFIX}`)).rejects.toThrow();
	});

	it("discards the checkpoint after a normal stop", async () => {
		const video = path.join(dir, "take.mp4");
		const writer = new CursorCheckpointWriter(`${video}${CURSOR_CHECKPOINT_SUFFIX}`);
		await writer.flush({ samples: [sample(1)], assets: [] });
		await writer.discard();
		await expect(fs.access(`${video}${CURSOR_CHECKPOINT_SUFFIX}`)).rejects.toThrow();
	});
});
