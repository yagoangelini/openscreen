import { spawn } from "node:child_process";
import { existsSync } from "node:fs";
import os from "node:os";
import { join } from "node:path";
import { app } from "electron";

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

export interface OcrScanResult {
	success: boolean;
	output?: string;
	error?: string;
	/** The scan was cut short by the timeout; `output` covers the start of the take. */
	partial?: boolean;
}

export function runOcrScan(
	videoPath: string,
	options: { intervalMs?: number; timeoutMs?: number } = {},
): Promise<OcrScanResult> {
	if (process.platform !== "win32") {
		return Promise.resolve({ success: false, error: "OCR scan is Windows-only." });
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
			if (code === 0 || timedOut) {
				resolve({ success: true, output, ...(timedOut ? { partial: true } : {}) });
				return;
			}
			const message = output.match(/"type":"error","message":"([^"]*)"/)?.[1] ?? stderr.trim();
			resolve({ success: false, error: message || `ocr-scan exited with code ${code}` });
		});
	});
}
