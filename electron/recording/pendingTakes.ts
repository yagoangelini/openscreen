import fs from "node:fs/promises";
import path from "node:path";
import { type PathMapper, rewriteMediaPaths } from "../../src/lib/mediaPathRewrite";
import type { RecordingSession } from "../../src/lib/recordingSession";

/**
 * A journal of takes that have not reached the editor yet.
 *
 * A take is written here the moment its helper starts and leaves only once the
 * editor has picked it up. Everything in between can kill the app -- a crash of
 * the main process, Windows logging off, the user quitting mid-take, a stop
 * that saved the file but never got to open it -- and every one of those used
 * to leave a playable MP4 sitting unnoticed in a hidden folder, with nothing
 * pointing at it. Whatever is still listed at the next launch is offered back.
 *
 * Lives outside `electron/ipc/handlers.ts` so it can be tested: that module
 * calls `app.getPath()` while it is being imported.
 */

export const PENDING_TAKES_FILE = ".pending-takes.json";

/** Same floor as the stop salvage: below this an MP4 is a header and nothing else. */
export const RECOVERABLE_TAKE_MIN_BYTES = 64 * 1024;

export interface PendingTake {
	screenVideoPath: string;
	webcamVideoPath?: string;
	createdAt: number;
	cursorCaptureMode?: RecordingSession["cursorCaptureMode"];
}

function journalPath(recordingsDir: string) {
	return path.join(recordingsDir, PENDING_TAKES_FILE);
}

function isPendingTake(value: unknown): value is PendingTake {
	if (!value || typeof value !== "object") {
		return false;
	}
	const take = value as Partial<PendingTake>;
	return typeof take.screenVideoPath === "string" && typeof take.createdAt === "number";
}

export async function readPendingTakes(recordingsDir: string): Promise<PendingTake[]> {
	try {
		const parsed: unknown = JSON.parse(await fs.readFile(journalPath(recordingsDir), "utf-8"));
		return Array.isArray(parsed) ? parsed.filter(isPendingTake) : [];
	} catch {
		// Missing is the normal case, and a damaged journal must not stop the
		// app from starting: it is a safety net, not a source of truth.
		return [];
	}
}

async function writePendingTakes(recordingsDir: string, takes: PendingTake[]) {
	const target = journalPath(recordingsDir);
	if (takes.length === 0) {
		await fs.rm(target, { force: true });
		return;
	}
	// Temp file then rename, so a crash mid-write leaves the previous journal
	// rather than half of a new one.
	const temp = `${target}.tmp`;
	await fs.writeFile(temp, JSON.stringify(takes, null, 2), "utf-8");
	await fs.rename(temp, target);
}

const samePath = (left: string, right: string) =>
	path.resolve(left).toLowerCase() === path.resolve(right).toLowerCase();

/** Adds or updates the entry for this take's screen file. */
export async function recordPendingTake(recordingsDir: string, take: PendingTake) {
	const takes = await readPendingTakes(recordingsDir);
	const rest = takes.filter((entry) => !samePath(entry.screenVideoPath, take.screenVideoPath));
	await writePendingTakes(recordingsDir, [...rest, take]);
}

/** The take reached the editor, or the user discarded it: nothing left to recover. */
export async function clearPendingTake(recordingsDir: string, screenVideoPath: string) {
	const takes = await readPendingTakes(recordingsDir);
	const rest = takes.filter((entry) => !samePath(entry.screenVideoPath, screenVideoPath));
	if (rest.length !== takes.length) {
		await writePendingTakes(recordingsDir, rest);
	}
}

/** A take folder was renamed: the journal follows its files. */
export async function rewritePendingTakePaths(recordingsDir: string, mapper: PathMapper) {
	const takes = await readPendingTakes(recordingsDir);
	const { value, changed } = rewriteMediaPaths(takes, mapper);
	if (changed > 0) await writePendingTakes(recordingsDir, value);
}

/**
 * The listed takes worth offering back, newest first. Entries whose screen file
 * is gone or too small to hold a frame are dropped from the journal as a side
 * effect, so a take that really was lost is not offered on every launch.
 * A webcam path that no longer exists is left out of the returned take rather
 * than failing it: the screen recording is what matters.
 */
export async function collectRecoverableTakes(
	recordingsDir: string,
	options: { excludeScreenVideoPath?: string | null } = {},
): Promise<PendingTake[]> {
	const takes = await readPendingTakes(recordingsDir);
	const sizeOf = async (filePath: string) => (await fs.stat(filePath).catch(() => null))?.size ?? 0;

	const recoverable: PendingTake[] = [];
	const kept: PendingTake[] = [];
	for (const take of takes) {
		if (
			options.excludeScreenVideoPath &&
			samePath(take.screenVideoPath, options.excludeScreenVideoPath)
		) {
			kept.push(take);
			continue;
		}
		if ((await sizeOf(take.screenVideoPath)) < RECOVERABLE_TAKE_MIN_BYTES) {
			continue;
		}
		kept.push(take);
		const webcamVideoPath =
			take.webcamVideoPath && (await sizeOf(take.webcamVideoPath)) > 0
				? take.webcamVideoPath
				: undefined;
		recoverable.push({ ...take, webcamVideoPath });
	}

	if (kept.length !== takes.length) {
		await writePendingTakes(recordingsDir, kept);
	}
	return recoverable.sort((left, right) => right.createdAt - left.createdAt);
}

/**
 * The editor's hand-off slot changed (`set-current-recording-session`). A take leaves the
 * journal when the editor CONSUMES it -- sets the slot to null once the take is in a project
 * it saved -- and not before: not when a stop parks it there, and not when the editor merely
 * asks for it. The app can die between the ask and the save (the editor a stop opened for a
 * renderer that died, killed with the rest of the app), and a journal cleared on the ask left
 * a saved take that no launch ever offered again.
 */
export async function settlePendingTakeHandOff(
	recordingsDir: string,
	parked: Pick<PendingTake, "screenVideoPath"> | null,
	next: unknown,
) {
	if (next === null && parked) {
		await clearPendingTake(recordingsDir, parked.screenVideoPath);
	}
}
