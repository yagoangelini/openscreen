import { constants as fsConstants } from "node:fs";
import fs from "node:fs/promises";
import type { CursorRecordingData, NativeCursorAsset } from "../../src/native/contracts";

/**
 * A crash-safe copy of the cursor telemetry, written while the take runs.
 *
 * The telemetry lives in the main process's memory until the stop writes
 * `<video>.cursor.json`. A take that ends any other way -- the app crashed, the
 * machine lost power -- is offered back by the pending-takes journal, and used
 * to come back without its cursor, so without a single auto-zoom. This appends
 * what the sampler has seen to `<video>.cursor.ndjson` every few seconds, and
 * the recovery rebuilds the cursor file from it. A normal stop deletes it.
 *
 * One JSON object per line, so a line cut short by the crash costs that line and
 * nothing before it:
 *   {"type":"meta","cursorOffsetMs":412}       once the first frame is known
 *   {"type":"asset","asset":{...}}             each cursor image, once
 *   {"type":"sample","sample":{...}}           each sample, in arrival order
 *   {"type":"pause","startMs":..,"endMs":..}   each completed pause
 */

export const CURSOR_CHECKPOINT_SUFFIX = ".cursor.ndjson";
export const CURSOR_CHECKPOINT_INTERVAL_MS = 5_000;

export interface PauseRange {
	startMs: number;
	endMs: number;
}

/** Drops the samples inside a pause and closes the gap it left. */
export function compactCursorPauseRanges(
	data: CursorRecordingData,
	ranges: PauseRange[],
): CursorRecordingData {
	const normalizedRanges = ranges
		.map((range) => ({
			startMs: Math.max(0, Math.min(range.startMs, range.endMs)),
			endMs: Math.max(0, Math.max(range.startMs, range.endMs)),
		}))
		.filter((range) => Number.isFinite(range.startMs) && Number.isFinite(range.endMs))
		.filter((range) => range.endMs > range.startMs)
		.sort((a, b) => a.startMs - b.startMs);
	if (normalizedRanges.length === 0) {
		return data;
	}
	const samples = data.samples.flatMap((sample) => {
		let pausedBeforeSampleMs = 0;
		for (const range of normalizedRanges) {
			if (sample.timeMs >= range.startMs && sample.timeMs <= range.endMs) {
				return [];
			}
			if (sample.timeMs > range.endMs) {
				pausedBeforeSampleMs += range.endMs - range.startMs;
			}
		}
		return [{ ...sample, timeMs: Math.max(0, sample.timeMs - pausedBeforeSampleMs) }];
	});
	return { ...data, samples: samples.sort((a, b) => a.timeMs - b.timeMs) };
}

/** Moves the telemetry from the sampler's clock onto the video's first frame. */
export function shiftCursorTelemetry(
	data: CursorRecordingData,
	offsetMs: number,
): CursorRecordingData {
	if (!Number.isFinite(offsetMs) || offsetMs <= 0) {
		return data;
	}
	return {
		...data,
		samples: data.samples
			.map((sample) => ({ ...sample, timeMs: Math.max(0, sample.timeMs - offsetMs) }))
			.sort((a, b) => a.timeMs - b.timeMs),
	};
}

/** Appends what is new since the last flush; reads the session's live arrays. */
export class CursorCheckpointWriter {
	private writtenSamples = 0;
	private writtenAssets = new Set<string>();
	private pending: string[] = [];
	private chain: Promise<void> = Promise.resolve();

	constructor(readonly path: string) {}

	meta(cursorOffsetMs: number) {
		this.pending.push(JSON.stringify({ type: "meta", cursorOffsetMs }));
	}

	pause(range: PauseRange) {
		this.pending.push(JSON.stringify({ type: "pause", ...range }));
	}

	/** Queues the new lines and writes them; writes never overlap or reorder. */
	flush(data: {
		samples: readonly CursorRecordingData["samples"][number][];
		assets: readonly NativeCursorAsset[];
	}) {
		for (const asset of data.assets) {
			if (!this.writtenAssets.has(asset.id)) {
				this.writtenAssets.add(asset.id);
				this.pending.push(JSON.stringify({ type: "asset", asset }));
			}
		}
		for (let index = this.writtenSamples; index < data.samples.length; index++) {
			this.pending.push(JSON.stringify({ type: "sample", sample: data.samples[index] }));
		}
		this.writtenSamples = data.samples.length;
		if (this.pending.length === 0) {
			return this.chain;
		}
		const text = `${this.pending.join("\n")}\n`;
		this.pending = [];
		this.chain = this.chain
			.then(() => fs.appendFile(this.path, text, "utf-8"))
			.catch((error) => {
				console.warn("[cursor-checkpoint] could not append", error);
			});
		return this.chain;
	}

	/** The take was saved normally: the real cursor file supersedes this one. */
	async discard() {
		this.pending = [];
		await this.chain;
		await fs.rm(this.path, { force: true }).catch(() => undefined);
	}
}

/** Reads a checkpoint back into the telemetry the stop would have written. */
export function rebuildCursorTelemetry(text: string): CursorRecordingData | null {
	const assets = new Map<string, NativeCursorAsset>();
	const samples: CursorRecordingData["samples"] = [];
	const pauses: PauseRange[] = [];
	let offsetMs = 0;
	for (const line of text.split(/\r?\n/)) {
		if (!line.trim()) {
			continue;
		}
		let entry: {
			type?: string;
			cursorOffsetMs?: number;
			asset?: NativeCursorAsset;
			sample?: CursorRecordingData["samples"][number];
			startMs?: number;
			endMs?: number;
		};
		try {
			entry = JSON.parse(line);
		} catch {
			// The line the crash cut short; everything before it is intact.
			continue;
		}
		if (entry.type === "meta" && typeof entry.cursorOffsetMs === "number") {
			offsetMs = entry.cursorOffsetMs;
		} else if (entry.type === "asset" && entry.asset?.id) {
			assets.set(entry.asset.id, entry.asset);
		} else if (entry.type === "sample" && entry.sample && typeof entry.sample.timeMs === "number") {
			samples.push(entry.sample);
		} else if (
			entry.type === "pause" &&
			typeof entry.startMs === "number" &&
			typeof entry.endMs === "number"
		) {
			pauses.push({ startMs: entry.startMs, endMs: entry.endMs });
		}
	}
	if (samples.length === 0) {
		return null;
	}
	samples.sort((a, b) => a.timeMs - b.timeMs);
	const data: CursorRecordingData = {
		version: 2,
		provider: assets.size > 0 ? "native" : "none",
		samples,
		assets: [...assets.values()],
	};
	return shiftCursorTelemetry(compactCursorPauseRanges(data, pauses), offsetMs);
}

/**
 * For a recovered take: writes `<video>.cursor.json` from its checkpoint when
 * the stop never got to. Returns whether there is cursor telemetry now.
 */
export async function recoverCursorCheckpoint(videoPath: string): Promise<boolean> {
	const telemetryPath = `${videoPath}.cursor.json`;
	const checkpointPath = `${videoPath}${CURSOR_CHECKPOINT_SUFFIX}`;
	const exists = (target: string) =>
		fs.access(target, fsConstants.F_OK).then(
			() => true,
			() => false,
		);
	if (await exists(telemetryPath)) {
		await fs.rm(checkpointPath, { force: true }).catch(() => undefined);
		return true;
	}
	if (!(await exists(checkpointPath))) {
		return false;
	}
	const data = rebuildCursorTelemetry(await fs.readFile(checkpointPath, "utf-8"));
	if (!data) {
		return false;
	}
	await fs.writeFile(telemetryPath, JSON.stringify(data, null, 2), "utf-8");
	await fs.rm(checkpointPath, { force: true }).catch(() => undefined);
	return true;
}
