import { execFile } from "node:child_process";

import type { WhisperModelId } from "./modelManager";

/**
 * Which whisper model a transcription runs on, and how "auto" decides.
 *
 * large-v3-turbo is the accurate one (docs/HANDOFF.md has the pt-BR numbers), but
 * it is a 874 MB download and holds ~1.4 GB of video memory, so "auto" only picks
 * it where it runs well: a DEDICATED GPU with room for it. The answer comes from
 * the helper itself (`whisper-stt-server --list-devices`, the devices ggml sees),
 * asked before any model is downloaded. A helper built before that flag exits
 * without the list, and could not load turbo anyway (its DTW preset is fixed to
 * small), so it reads as "no such GPU": small.
 */

/** The user's choice; "auto" is the default. */
export type WhisperModelPreference = "auto" | WhisperModelId;

export function isWhisperModelPreference(value: unknown): value is WhisperModelPreference {
	return value === "auto" || value === "small" || value === "large-v3-turbo";
}

export interface WhisperDevice {
	name: string;
	description: string;
	type: "gpu" | "igpu" | "cpu" | "accel";
	memoryFreeBytes: number;
	memoryTotalBytes: number;
}

/**
 * The smallest dedicated GPU "auto" puts turbo on. It needs ~1.4 GB, the editor's
 * preview and the export share the card, and a 4 GB card reports a little under
 * 4 GiB; 3.5 GiB keeps those and leaves out 2 and 3 GB cards.
 */
export const TURBO_MIN_VRAM_BYTES = 3.5 * 1024 ** 3;
/** And the room it needs right now, when the driver reports it. */
export const TURBO_MIN_FREE_VRAM_BYTES = 1.5 * 1024 ** 3;

/** The device list out of `--list-devices`' stdout, or [] when there is none. */
export function parseDeviceList(stdout: string): WhisperDevice[] {
	const line = stdout.split(/\r?\n/).find((l) => l.trim().startsWith('{"devices"'));
	if (!line) return [];
	try {
		const parsed = JSON.parse(line) as { devices?: unknown };
		if (!Array.isArray(parsed.devices)) return [];
		return parsed.devices.flatMap((raw): WhisperDevice[] => {
			if (!raw || typeof raw !== "object") return [];
			const d = raw as Record<string, unknown>;
			const type = d.type;
			if (type !== "gpu" && type !== "igpu" && type !== "cpu" && type !== "accel") return [];
			return [
				{
					name: typeof d.name === "string" ? d.name : "",
					description: typeof d.description === "string" ? d.description : "",
					type,
					memoryFreeBytes: typeof d.memory_free === "number" ? d.memory_free : 0,
					memoryTotalBytes: typeof d.memory_total === "number" ? d.memory_total : 0,
				},
			];
		});
	} catch {
		return [];
	}
}

/** The dedicated GPU that can hold large-v3-turbo, or null. */
export function turboCapableDevice(devices: WhisperDevice[]): WhisperDevice | null {
	return (
		devices.find(
			(d) =>
				d.type === "gpu" &&
				d.memoryTotalBytes >= TURBO_MIN_VRAM_BYTES &&
				// 0 = the driver does not say; the total already passed.
				(d.memoryFreeBytes === 0 || d.memoryFreeBytes >= TURBO_MIN_FREE_VRAM_BYTES),
		) ?? null
	);
}

/** The model a preference means on this machine. */
export function resolveWhisperModel(
	preference: WhisperModelPreference,
	devices: WhisperDevice[],
): WhisperModelId {
	if (preference !== "auto") return preference;
	return turboCapableDevice(devices) ? "large-v3-turbo" : "small";
}

/** Ask the helper for its devices; [] on any failure (old helper, no binary, timeout). */
export function listWhisperDevices(
	binaryPath: string,
	timeoutMs = 15_000,
): Promise<WhisperDevice[]> {
	return new Promise((resolve) => {
		execFile(
			binaryPath,
			["--list-devices"],
			{ timeout: timeoutMs, windowsHide: true },
			(_error, stdout) => resolve(parseDeviceList(String(stdout ?? ""))),
		);
	});
}
