import { spawn } from "node:child_process";
import { createHash } from "node:crypto";
import { mkdir, readFile, stat, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { app } from "electron";
import { resolveFfmpeg } from "./audioPeaks";

/**
 * The duration and a small thumbnail of a recording, for the library in the Media tab.
 *
 * One ffmpeg run per take gives both: the listing it prints names the duration, and one
 * frame scaled to 320 px is the thumbnail. Cached in `userData/recording-library` by path,
 * size and modification time, so a library of fifty takes pays for this once, not on
 * every visit. Takes are read one or two at a time, below normal priority: the preview
 * and an export come first.
 */

export interface RecordingPreview {
	durationSec: number | null;
	/** A `data:image/jpeg` URL, or null when no frame could be read. */
	thumbnailDataUrl: string | null;
}

const RUN_TIMEOUT_MS = 20_000;
const MAX_PARALLEL = 2;

/** "Duration: 00:01:02.50" in ffmpeg's listing of its input. */
export function parseFfmpegDuration(listing: string): number | null {
	const match = /Duration:\s*(\d+):(\d{2}):(\d{2}(?:\.\d+)?)/.exec(listing);
	if (!match) return null;
	const seconds = Number(match[1]) * 3600 + Number(match[2]) * 60 + Number(match[3]);
	return Number.isFinite(seconds) && seconds > 0 ? seconds : null;
}

function cacheDir(): string | null {
	try {
		return typeof app?.getPath === "function"
			? path.join(app.getPath("userData"), "recording-library")
			: null;
	} catch {
		return null;
	}
}

let running = 0;
const queue: Array<() => void> = [];

async function slot<T>(work: () => Promise<T>): Promise<T> {
	if (running >= MAX_PARALLEL) await new Promise<void>((resolve) => queue.push(resolve));
	running += 1;
	try {
		return await work();
	} finally {
		running -= 1;
		queue.shift()?.();
	}
}

function runFfmpeg(ffmpeg: string, args: string[]): Promise<string> {
	return new Promise((resolve) => {
		let listing = "";
		const child = spawn(ffmpeg, args, {
			stdio: ["ignore", "ignore", "pipe"],
			windowsHide: true,
			timeout: RUN_TIMEOUT_MS,
			killSignal: "SIGKILL",
		});
		try {
			if (child.pid) os.setPriority(child.pid, os.constants.priority.PRIORITY_BELOW_NORMAL);
		} catch {
			// Normal priority, then.
		}
		child.stderr.on("data", (chunk: Buffer) => {
			if (listing.length < 64_000) listing += chunk.toString();
		});
		child.once("error", () => resolve(listing));
		child.once("close", () => resolve(listing));
	});
}

const inFlight = new Map<string, Promise<RecordingPreview>>();

export async function getRecordingPreview(videoPath: string): Promise<RecordingPreview> {
	const info = await stat(videoPath);
	const key = createHash("sha1")
		.update(`preview-v1:${videoPath}:${info.size}:${info.mtimeMs}`)
		.digest("hex")
		.slice(0, 32);
	const existing = inFlight.get(key);
	if (existing) return existing;
	const job = computePreview(videoPath, key).finally(() => inFlight.delete(key));
	inFlight.set(key, job);
	return job;
}

async function computePreview(videoPath: string, key: string): Promise<RecordingPreview> {
	const dir = cacheDir();
	const metaPath = dir ? path.join(dir, `${key}.json`) : null;
	const thumbPath = dir ? path.join(dir, `${key}.jpg`) : path.join(os.tmpdir(), `${key}.jpg`);
	if (metaPath) {
		try {
			const meta = JSON.parse(await readFile(metaPath, "utf-8")) as { durationSec?: unknown };
			const thumb = await readFile(thumbPath).catch(() => null);
			return {
				durationSec: typeof meta.durationSec === "number" ? meta.durationSec : null,
				thumbnailDataUrl: thumb ? `data:image/jpeg;base64,${thumb.toString("base64")}` : null,
			};
		} catch {
			// Not cached yet.
		}
	}
	const ffmpeg = resolveFfmpeg();
	if (!ffmpeg) return { durationSec: null, thumbnailDataUrl: null };
	if (dir) await mkdir(dir, { recursive: true }).catch(() => undefined);

	return slot(async () => {
		const frameArgs = (seekSec: number | null) => [
			"-hide_banner",
			"-y",
			...(seekSec !== null ? ["-ss", String(seekSec)] : []),
			"-i",
			videoPath,
			"-map",
			"0:v:0",
			"-frames:v",
			"1",
			"-vf",
			"scale=320:-2",
			"-q:v",
			"5",
			thumbPath,
		];
		// A second in, past a black first frame; a take shorter than that gets its first one.
		const listing = await runFfmpeg(ffmpeg, frameArgs(1));
		let thumb = await readFile(thumbPath).catch(() => null);
		if (!thumb || thumb.length === 0) {
			await runFfmpeg(ffmpeg, frameArgs(null));
			thumb = await readFile(thumbPath).catch(() => null);
		}
		const durationSec = parseFfmpegDuration(listing);
		if (metaPath) {
			await writeFile(metaPath, JSON.stringify({ durationSec })).catch(() => undefined);
		}
		return {
			durationSec,
			thumbnailDataUrl:
				thumb && thumb.length > 0 ? `data:image/jpeg;base64,${thumb.toString("base64")}` : null,
		};
	});
}
