import fs from "node:fs/promises";

/**
 * How much disk a take needs, and what to do when it is running out.
 *
 * Nothing checked this before: a recording ran until the disk filled, the
 * encoder's write failed, and the take ended wherever that happened to be.
 * At the helper's top bitrate (45 Mbps for 4K) that is about 20 GB an hour,
 * and the recordings folder lives on the system drive.
 */

/**
 * Bytes a minute of recording is budgeted at. The helper's top configured
 * bitrate (45 Mbps) plus audio, rounded up: a quiet screen under VBR spends
 * far less, but an estimate that runs out early is the one that loses a take.
 */
export const RECORDING_BYTES_PER_MINUTE = 350 * 1024 * 1024;

/** Below this a take is not started: it would end within a minute or two. */
export const CRITICAL_FREE_BYTES = 1024 * 1024 * 1024;

/** Below this the user is warned at start: under about half an hour of room. */
export const LOW_FREE_BYTES = 30 * RECORDING_BYTES_PER_MINUTE;

/**
 * While recording, the take is stopped and saved once free space drops under
 * this. Enough headroom for the encoder to finalize and the sidecars to be
 * written, which a disk filled to the last byte would refuse.
 */
export const STOP_RECORDING_FREE_BYTES = 512 * 1024 * 1024;

export type FreeSpaceLevel = "ok" | "low" | "critical";

export interface FreeSpaceAssessment {
	level: FreeSpaceLevel;
	freeBytes: number;
	/** Whole minutes of recording the free space holds at the budgeted rate. */
	minutesLeft: number;
}

export function assessFreeSpace(freeBytes: number): FreeSpaceAssessment {
	const minutesLeft = Math.max(0, Math.floor(freeBytes / RECORDING_BYTES_PER_MINUTE));
	const level: FreeSpaceLevel =
		freeBytes < CRITICAL_FREE_BYTES ? "critical" : freeBytes < LOW_FREE_BYTES ? "low" : "ok";
	return { level, freeBytes, minutesLeft };
}

/** Free bytes on the volume holding `dir`, or null when the OS will not say. */
export async function readFreeBytes(dir: string): Promise<number | null> {
	try {
		const stats = await fs.statfs(dir);
		return stats.bavail * stats.bsize;
	} catch {
		// Not knowing is not a reason to refuse a recording.
		return null;
	}
}
