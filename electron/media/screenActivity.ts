import { type ChildProcess, spawn } from "node:child_process";
import { createHash } from "node:crypto";
import { mkdir, readFile, rename, stat, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { app } from "electron";
import {
	ACTIVITY_FPS,
	ACTIVITY_GRID_H,
	ACTIVITY_GRID_W,
	readScreenActivity,
	type ScreenActivity,
	ScreenActivityRecorder,
} from "../../src/lib/ai-edition/timeline/screenActivity";
import { resolveFfmpeg } from "./audioPeaks";
import { trackFileReader } from "./takeFileHolders";

/**
 * Where a take's screen changed, for the automatic zooms (`screenActivity.ts` in the renderer
 * lib holds the diff and the format).
 *
 * ffmpeg decodes the take once, downscaled to a 160×90 grey grid at 8 fps, and the frames are
 * compared here as they stream in: nothing but the changed boxes is kept. Measured on a 51 s
 * 1080p120 take (VFR, ~60 fps actual) on the fork's laptop: 2.6 s, so about 30 s for a
 * 10-minute take, in a child process below normal priority. Cached on disk per recording, like
 * the waveform peaks, so a re-plan pays nothing.
 */

export interface ScreenActivityResult {
	success: boolean;
	activity?: ScreenActivity;
	error?: string;
}

/** Past this, the scan is abandoned and the zooms are planned without it. */
const SCAN_TIMEOUT_MS = 180_000;
const FRAME_BYTES = ACTIVITY_GRID_W * ACTIVITY_GRID_H;

const runningScans = new Set<ChildProcess>();

/** Ends every scan still running; called as the app quits. */
export function killRunningActivityScans(): void {
	for (const child of runningScans) {
		try {
			child.kill();
		} catch {
			// Already gone.
		}
	}
	runningScans.clear();
}

/** The ffmpeg arguments that stream the take as raw grey frames on the activity grid. */
export function screenActivityArgs(videoPath: string): string[] {
	return [
		"-hide_banner",
		"-loglevel",
		"error",
		"-an",
		"-sn",
		"-dn",
		"-i",
		videoPath,
		"-vf",
		`fps=${ACTIVITY_FPS},scale=${ACTIVITY_GRID_W}:${ACTIVITY_GRID_H}:flags=area,format=gray`,
		"-f",
		"rawvideo",
		"pipe:1",
	];
}

function cacheKeyFor(filePath: string, info: { size: number; mtimeMs: number }): string {
	return createHash("sha1")
		.update(`activity-v1:${filePath}:${info.size}:${info.mtimeMs}`)
		.digest("hex")
		.slice(0, 32);
}

async function cacheKey(filePath: string): Promise<string> {
	return cacheKeyFor(filePath, await stat(filePath));
}

/** The take moved (renamed in the library): its cached scan follows it, like the peaks. */
export async function moveCachedScreenActivity(fromPath: string, toPath: string): Promise<void> {
	const dir = cacheDir();
	if (!dir) return;
	try {
		const info = await stat(toPath);
		await rename(
			path.join(dir, `${cacheKeyFor(fromPath, info)}.json`),
			path.join(dir, `${cacheKeyFor(toPath, info)}.json`),
		);
	} catch {
		// Nothing cached: scanned again on demand.
	}
}

function cacheDir(): string | null {
	try {
		return typeof app?.getPath === "function"
			? path.join(app.getPath("userData"), "screen-activity")
			: null;
	} catch {
		return null;
	}
}

function decode(ffmpeg: string, videoPath: string, timeoutMs: number): Promise<ScreenActivity> {
	return new Promise((resolve, reject) => {
		const child = spawn(ffmpeg, screenActivityArgs(videoPath), {
			stdio: ["ignore", "pipe", "pipe"],
			windowsHide: true,
		});
		runningScans.add(child);
		trackFileReader(child, videoPath);
		try {
			// The preview and the user come first, as for the OCR.
			if (child.pid) os.setPriority(child.pid, os.constants.priority.PRIORITY_BELOW_NORMAL);
		} catch {
			// Not fatal: it just runs at normal priority.
		}
		const recorder = new ScreenActivityRecorder();
		let pending: Buffer = Buffer.alloc(0);
		let stderr = "";
		child.stdout.on("data", (chunk: Buffer) => {
			pending = pending.length === 0 ? chunk : Buffer.concat([pending, chunk]);
			let offset = 0;
			while (pending.length - offset >= FRAME_BYTES) {
				// Copied: the recorder keeps the frame as the next one's reference.
				recorder.push(Uint8Array.from(pending.subarray(offset, offset + FRAME_BYTES)));
				offset += FRAME_BYTES;
			}
			pending = pending.subarray(offset);
		});
		child.stderr.on("data", (chunk: Buffer) => {
			stderr = (stderr + chunk.toString()).slice(-2000);
		});
		const timer = setTimeout(() => child.kill(), timeoutMs);
		child.once("error", (error) => {
			clearTimeout(timer);
			runningScans.delete(child);
			reject(error);
		});
		child.once("close", (code) => {
			clearTimeout(timer);
			runningScans.delete(child);
			if (code === 0) resolve(recorder.result());
			else reject(new Error(stderr.trim() || `ffmpeg exited with code ${code}`));
		});
	});
}

/** Scans under way, by path: the import's head start and the zoom pass share one decode. */
const inFlight = new Map<string, Promise<ScreenActivityResult>>();

/** The take's screen activity, from the disk cache when it was scanned before. */
export function getScreenActivity(
	videoPath: string,
	timeoutMs = SCAN_TIMEOUT_MS,
): Promise<ScreenActivityResult> {
	const running = inFlight.get(videoPath);
	if (running) return running;
	const scan = scanScreenActivity(videoPath, timeoutMs).finally(() => inFlight.delete(videoPath));
	inFlight.set(videoPath, scan);
	return scan;
}

async function scanScreenActivity(
	videoPath: string,
	timeoutMs: number,
): Promise<ScreenActivityResult> {
	const ffmpeg = resolveFfmpeg();
	if (!ffmpeg) return { success: false, error: "ffmpeg is not available." };
	const dir = cacheDir();
	let cachePath: string | null = null;
	try {
		cachePath = dir ? path.join(dir, `${await cacheKey(videoPath)}.json`) : null;
	} catch (error) {
		return { success: false, error: String(error) };
	}
	if (cachePath) {
		try {
			const cached = readScreenActivity(JSON.parse(await readFile(cachePath, "utf-8")));
			if (cached) return { success: true, activity: cached };
		} catch {
			// Not cached yet.
		}
	}
	try {
		const activity = await decode(ffmpeg, videoPath, timeoutMs);
		if (cachePath && dir) {
			try {
				await mkdir(dir, { recursive: true });
				await writeFile(cachePath, JSON.stringify(activity));
			} catch {
				// A cache we cannot write is a slower re-plan, not a failure.
			}
		}
		return { success: true, activity };
	} catch (error) {
		return { success: false, error: error instanceof Error ? error.message : String(error) };
	}
}
