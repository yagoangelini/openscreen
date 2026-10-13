import { type ChildProcess, spawn } from "node:child_process";
import { existsSync } from "node:fs";
import os from "node:os";
import { join } from "node:path";
import { app } from "electron";
import { trackFileReader } from "../media/takeFileHolders";

/**
 * Runs `ocr-scan.exe` over a recording: the text on screen, read by Windows' own
 * OCR, for the editor's automatic privacy blur. Windows only; offline.
 *
 * Bounded: a scan that has not finished in `timeoutMs` is killed and whatever it
 * printed is returned, so a long take still gets blurs for its first part rather
 * than none. Run at below-normal priority, since it competes with the preview.
 */

const DEFAULT_TIMEOUT_MS = 10 * 60_000;
/** Ten minutes of take is about 300 samples; a still screen costs almost nothing. */
export const OCR_SCAN_INTERVAL_MS = 2_000;

function ocrScanCandidates(): string[] {
	const archTag = process.arch === "arm64" ? "win32-arm64" : "win32-x64";
	const resolve = (...segs: string[]) => {
		const p = join(app.getAppPath(), ...segs);
		return app.isPackaged ? p.replace(/\.asar([/\\])/, ".asar.unpacked$1") : p;
	};
	return [
		process.env.OPENSCREEN_OCR_SCAN_EXE?.trim(),
		resolve("electron", "native", "bin", archTag, "ocr-scan.exe"),
		app.isPackaged
			? join(process.resourcesPath, "electron", "native", "bin", archTag, "ocr-scan.exe")
			: null,
	].filter((c): c is string => Boolean(c));
}

export function findOcrScanPath(): string | null {
	return ocrScanCandidates().find((candidate) => existsSync(candidate)) ?? null;
}

/**
 * Scans still running. Windows does not take a child down with its parent, and the
 * kill timer dies with the app, so a scan left behind at quit would read on, unbounded,
 * holding a file of the install open through an update.
 */
const runningScans = new Set<ChildProcess>();

function track(child: ChildProcess): void {
	runningScans.add(child);
	child.once("close", () => runningScans.delete(child));
	child.once("error", () => runningScans.delete(child));
}

/** Ends every scan still running; called as the app quits. */
export function killRunningScans(): void {
	for (const child of runningScans) {
		try {
			child.kill();
		} catch {
			// Already gone.
		}
	}
	runningScans.clear();
}

export interface OcrScanResult {
	success: boolean;
	output?: string;
	error?: string;
	/**
	 * The scan stopped before the end of the take -- the timeout, or the process killed
	 * from outside (an antivirus) -- and `output` covers its start only.
	 */
	partial?: boolean;
	/** Not a failure to report: this platform has no scanner at all. */
	unsupported?: boolean;
}

export function runOcrScan(
	videoPath: string,
	options: { intervalMs?: number; timeoutMs?: number } = {},
): Promise<OcrScanResult> {
	if (process.platform !== "win32") {
		return Promise.resolve({
			success: false,
			unsupported: true,
			error: "OCR scan is Windows-only.",
		});
	}
	const helper = findOcrScanPath();
	if (!helper) {
		return Promise.resolve({ success: false, error: "ocr-scan.exe is not available." });
	}
	return new Promise((resolve) => {
		const startedAt = Date.now();
		const child = spawn(helper, [videoPath, String(options.intervalMs ?? OCR_SCAN_INTERVAL_MS)], {
			stdio: ["ignore", "pipe", "pipe"],
			windowsHide: true,
		});
		track(child);
		trackFileReader(child, videoPath);
		try {
			// BELOW_NORMAL: the preview and the user come first.
			if (child.pid) os.setPriority(child.pid, os.constants.priority.PRIORITY_BELOW_NORMAL);
		} catch {
			// Not fatal: it just runs at normal priority.
		}
		let output = "";
		let stderr = "";
		let timedOut = false;
		child.stdout.setEncoding("utf8");
		child.stdout.on("data", (chunk: string) => {
			output += chunk;
		});
		child.stderr.setEncoding("utf8");
		child.stderr.on("data", (chunk: string) => {
			stderr += chunk;
		});
		const timer = setTimeout(() => {
			timedOut = true;
			child.kill();
		}, options.timeoutMs ?? DEFAULT_TIMEOUT_MS);
		child.once("error", (error) => {
			clearTimeout(timer);
			resolve({ success: false, error: error.message });
		});
		child.once("close", (code) => {
			clearTimeout(timer);
			const done = output.match(/\{"type":"done"[^\n]*\}/)?.[0];
			console.info("[ocr-scan] finished", {
				code,
				timedOut,
				elapsedMs: Date.now() - startedAt,
				summary: done ?? null,
			});
			// What it read before it stopped is kept, however it stopped: a scan an antivirus
			// killed at minute 40 still blurs the first 40 minutes. Only the closing line says
			// the whole take was looked at.
			const finished = done !== undefined;
			const readSomething = /"type":"(?:frame|same)"/.test(output);
			if (code === 0 || timedOut || readSomething) {
				resolve({ success: true, output, ...(finished ? {} : { partial: true }) });
				return;
			}
			const message = output.match(/"type":"error","message":"([^"]*)"/)?.[1] ?? stderr.trim();
			resolve({ success: false, error: message || `ocr-scan exited with code ${code}` });
		});
	});
}

export interface FrameChangesResult {
	success: boolean;
	unsupported?: boolean;
	changes?: Array<{ t: number; rect: { x: number; y: number; width: number; height: number } }>;
	error?: string;
}

/**
 * What changed on screen just after each of `timesMs` (`ocr-scan.exe --popups`): the menus
 * a web page draws, which UI Automation cannot see. Windows only; bounded like the OCR.
 */
export function runFrameChangeScan(
	videoPath: string,
	timesMs: number[],
	timeoutMs = 60_000,
): Promise<FrameChangesResult> {
	if (process.platform !== "win32") {
		return Promise.resolve({
			success: false,
			unsupported: true,
			error: "Frame scan is Windows-only.",
		});
	}
	const helper = findOcrScanPath();
	if (!helper) return Promise.resolve({ success: false, error: "ocr-scan.exe is not available." });
	const times = timesMs.filter((t) => Number.isFinite(t) && t >= 0).map((t) => Math.round(t));
	if (times.length === 0) return Promise.resolve({ success: true, changes: [] });
	return new Promise((resolve) => {
		const child = spawn(helper, ["--popups", videoPath, times.join(",")], {
			stdio: ["ignore", "pipe", "ignore"],
			windowsHide: true,
		});
		track(child);
		trackFileReader(child, videoPath);
		try {
			// Like the OCR: the preview and the user come first.
			if (child.pid) os.setPriority(child.pid, os.constants.priority.PRIORITY_BELOW_NORMAL);
		} catch {
			// Not fatal: it just runs at normal priority.
		}
		let output = "";
		child.stdout.setEncoding("utf8");
		child.stdout.on("data", (chunk: string) => {
			output += chunk;
		});
		const timer = setTimeout(() => child.kill(), timeoutMs);
		child.once("error", (error) => {
			clearTimeout(timer);
			resolve({ success: false, error: error.message });
		});
		child.once("close", () => {
			clearTimeout(timer);
			const changes: NonNullable<FrameChangesResult["changes"]> = [];
			for (const line of output.split(/\r?\n/)) {
				try {
					const event = JSON.parse(line) as { type?: string; t?: number; rect?: number[] };
					if (event.type === "change" && typeof event.t === "number" && event.rect?.length === 4) {
						const [x, y, width, height] = event.rect;
						changes.push({ t: event.t, rect: { x, y, width, height } });
					}
				} catch {
					// Not a line of the scan.
				}
			}
			resolve({ success: true, changes });
		});
	});
}
