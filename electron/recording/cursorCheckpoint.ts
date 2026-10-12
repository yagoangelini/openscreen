import { constants as fsConstants } from "node:fs";
import fs from "node:fs/promises";
import type {
	CursorPathPoint,
	CursorRecordingData,
	NativeCursorAsset,
} from "../../src/native/contracts";

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
 *   {"type":"path","points":[[t,cx,cy],...]}   the fine path since the last flush
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
	const path = data.path?.flatMap(([timeMs, cx, cy]): CursorPathPoint[] => {
		let pausedBeforePointMs = 0;
		for (const range of normalizedRanges) {
			if (timeMs >= range.startMs && timeMs <= range.endMs) {
				return [];
			}
			if (timeMs > range.endMs) {
				pausedBeforePointMs += range.endMs - range.startMs;
			}
		}
		return [[Math.max(0, timeMs - pausedBeforePointMs), cx, cy]];
	});
	return {
		...data,
		samples: samples.sort((a, b) => a.timeMs - b.timeMs),
		...(path ? { path: path.sort((a, b) => a[0] - b[0]) } : {}),
	};
}

/**
 * Moves the telemetry from the sampler's clock onto the video's first frame. What came before
 * the first frame is dropped, all but the last position, which becomes the cursor at 0: the
 * sampler starts with the countdown, and a click during it piled up at 0 s was one auto-zoom
 * then zoomed in on before the take had begun.
 */
export function shiftCursorTelemetry(
	data: CursorRecordingData,
	offsetMs: number,
): CursorRecordingData {
	if (!Number.isFinite(offsetMs) || offsetMs <= 0) {
		return data;
	}
	const sorted = [...data.samples].sort((a, b) => a.timeMs - b.timeMs);
	const before = sorted.filter((sample) => sample.timeMs < offsetMs);
	const samples = sorted
		.filter((sample) => sample.timeMs >= offsetMs)
		.map((sample) => ({ ...sample, timeMs: sample.timeMs - offsetMs }));
	const last = before.at(-1);
	if (last && samples[0]?.timeMs !== 0) {
		const { interactionType: _click, input: _input, ...position } = last;
		samples.unshift({ ...position, timeMs: 0 });
	}
	// The path before the first frame goes too: the sample at 0 holds where the pointer was.
	const path = data.path
		?.filter(([timeMs]) => timeMs >= offsetMs)
		.map(([timeMs, cx, cy]): CursorPathPoint => [timeMs - offsetMs, cx, cy]);
	return { ...data, samples, ...(path ? { path } : {}) };
}

/** Appends what is new since the last flush; reads the session's live arrays. */
export class CursorCheckpointWriter {
	private writtenSamples = 0;
	private writtenPathPoints = 0;
	private writtenAssets = new Set<string>();
	private pending: string[] = [];
	private chain: Promise<void> = Promise.resolve();
	/** Discarded: nothing more is written, even by a flush already scheduled. */
	private discarded = false;

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
		path?: readonly CursorPathPoint[];
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
		const path = data.path ?? [];
		if (path.length > this.writtenPathPoints) {
			this.pending.push(
				JSON.stringify({ type: "path", points: path.slice(this.writtenPathPoints) }),
			);
			this.writtenPathPoints = path.length;
		}
		if (this.discarded || this.pending.length === 0) {
			this.pending = [];
			return this.chain;
		}
		const text = `${this.pending.join("\n")}\n`;
		this.pending = [];
		this.chain = this.chain
			.then(() => (this.discarded ? undefined : fs.appendFile(this.path, text, "utf-8")))
			.catch((error) => {
				console.warn("[cursor-checkpoint] could not append", error);
			});
		return this.chain;
	}

	/** The take was saved normally: the real cursor file supersedes this one. */
	async discard() {
		this.discarded = true;
		this.pending = [];
		await this.chain;
		await fs.rm(this.path, { force: true }).catch(() => undefined);
	}
}

/** Reads a checkpoint back into the telemetry the stop would have written. */
export function rebuildCursorTelemetry(text: string): CursorRecordingData | null {
	const assets = new Map<string, NativeCursorAsset>();
	const samples: CursorRecordingData["samples"] = [];
	const path: CursorPathPoint[] = [];
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
			points?: unknown;
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
		} else if (entry.type === "path" && Array.isArray(entry.points)) {
			for (const point of entry.points) {
				if (
					Array.isArray(point) &&
					point.length === 3 &&
					point.every((value) => typeof value === "number" && Number.isFinite(value))
				) {
					path.push(point as CursorPathPoint);
				}
			}
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
		...(path.length > 0 ? { path: path.sort((a, b) => a[0] - b[0]) } : {}),
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
	// Unindented: an indented `path` takes a line per number.
	await fs.writeFile(telemetryPath, JSON.stringify(data), "utf-8");
	await fs.rm(checkpointPath, { force: true }).catch(() => undefined);
	return true;
}
