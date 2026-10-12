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

	it("moves everything onto the first frame, keeping only the last position before it", () => {
		const out = shiftCursorTelemetry(data([300, 100, 900]), 400);
		expect(out.samples.map((s) => s.timeMs)).toEqual([0, 500]);
	});

	it("moves and compacts the fine path like the samples", () => {
		const withPath: CursorRecordingData = {
			...data([100, 1500, 3000]),
			path: [
				[50, 0.1, 0.1],
				[1200, 0.2, 0.2],
				[2500, 0.3, 0.3],
				[3100, 0.4, 0.4],
			],
		};
		const compacted = compactCursorPauseRanges(withPath, [{ startMs: 1000, endMs: 2000 }]);
		expect(compacted.path).toEqual([
			[50, 0.1, 0.1],
			[1500, 0.3, 0.3],
			[2100, 0.4, 0.4],
		]);
		// Before the first frame it goes: the sample at 0 holds where the pointer was.
		expect(shiftCursorTelemetry(compacted, 400).path).toEqual([
			[1100, 0.3, 0.3],
			[1700, 0.4, 0.4],
		]);
		// An old recording without a path stays without one.
		expect("path" in shiftCursorTelemetry(data([100, 900]), 400)).toBe(false);
		expect("path" in compactCursorPauseRanges(data([100]), [{ startMs: 1, endMs: 2 }])).toBe(false);
	});

	it("drops a click made before the first frame, keeping where the cursor was", () => {
		const out = shiftCursorTelemetry(
			{
				...data([]),
				samples: [sample(1000, { interactionType: "click", cx: 0.2 }), sample(4000)],
			},
			3000,
		);
		expect(out.samples).toHaveLength(2);
		expect(out.samples[0]).toMatchObject({ timeMs: 0, cx: 0.2 });
		expect(out.samples[0].interactionType).toBeUndefined();
		expect(out.samples[1].timeMs).toBe(1000);
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

	it("writes nothing once discarded, even from a flush scheduled before", async () => {
		const video = path.join(dir, "take.mp4");
		const file = `${video}${CURSOR_CHECKPOINT_SUFFIX}`;
		const writer = new CursorCheckpointWriter(file);
		const pending = writer.flush({ samples: [sample(100)], assets: [] });
		await writer.discard();
		await pending;
		await writer.flush({ samples: [sample(100), sample(200)], assets: [] });
		await expect(fs.stat(file)).rejects.toThrow();
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

	it("checkpoints the fine path and rebuilds it with the samples", async () => {
		const video = path.join(dir, "take.mp4");
		const writer = new CursorCheckpointWriter(`${video}${CURSOR_CHECKPOINT_SUFFIX}`);
		const samples = [sample(500)];
		const fine: Array<[number, number, number]> = [[510, 0.51, 0.5]];
		writer.meta(400);
		await writer.flush({ samples, assets: [asset], path: fine });
		fine.push([520, 0.52, 0.5], [530, 0.53, 0.5]);
		await writer.flush({ samples, assets: [asset], path: fine });
		await writer.flush({ samples, assets: [asset], path: fine });

		const text = await fs.readFile(`${video}${CURSOR_CHECKPOINT_SUFFIX}`, "utf-8");
		// One line per flush with something new, each with only what is new.
		expect(text.split("\n").filter((line) => line.includes('"type":"path"'))).toHaveLength(2);
		const rebuilt = rebuildCursorTelemetry(`${text}{"type":"path","points":[[540,"x",1],[550]]}\n`);
		expect(rebuilt?.path).toEqual([
			[110, 0.51, 0.5],
			[120, 0.52, 0.5],
			[130, 0.53, 0.5],
		]);
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
