import type { ChildProcess } from "node:child_process";
import path from "node:path";

/**
 * What in the main process can hold a take's files open, and a way to let them all go.
 *
 * Windows refuses to move a folder into the Recycle Bin while any file in it is open. Worse,
 * when the holder opened the file with delete sharing, `shell.trashItem` does not just fail:
 * the shell shows its own "Folder Access Denied" prompt first (measured: a file held with
 * FileShare.Delete gives that prompt and then "Failed to perform delete operation"; one held
 * without it fails silently with "Operation was aborted"). So before a take is recycled,
 * everything here that reads it is stopped:
 *
 * - the child processes that read media (ffmpeg for peaks, screen activity, thumbnails and
 *   the transcription's audio; ocr-scan for the privacy blur), tracked by the file they read;
 * - any other holder that registers itself (the compositor's preview views).
 *
 * A job stopped this way fails like a cancelled one; nothing it would have produced is
 * cached, and its file is about to be gone anyway.
 */

export type TakeFileTest = (filePath: string) => boolean;

/** Lets go of every file `isTakeFile` accepts; resolves with how many holders it stopped. */
export type TakeFileReleaser = (isTakeFile: TakeFileTest) => number | Promise<number>;

const releasers = new Map<string, TakeFileReleaser>();
const readers = new Map<ChildProcess, string>();

/** Registers a holder that is not a child process, by a name used in the logs. */
export function registerTakeFileHolder(name: string, releaser: TakeFileReleaser): () => void {
	releasers.set(name, releaser);
	return () => {
		if (releasers.get(name) === releaser) releasers.delete(name);
	};
}

/** Remembers that `child` reads `filePath` until it exits. */
export function trackFileReader(child: ChildProcess, filePath: string): void {
	// A test double without events is nothing to track.
	if (typeof child?.once !== "function") return;
	readers.set(child, filePath);
	const forget = () => readers.delete(child);
	child.once("close", forget);
	child.once("error", forget);
}

/** The files the tracked child processes are reading right now (for tests and logs). */
export function trackedReaderPaths(): string[] {
	return [...readers.values()];
}

const EXIT_WAIT_MS = 3000;

async function stopReaders(isTakeFile: TakeFileTest): Promise<number> {
	const doomed = [...readers].filter(([, filePath]) => isTakeFile(filePath));
	await Promise.all(
		doomed.map(
			([child]) =>
				new Promise<void>((resolve) => {
					if (child.exitCode !== null || child.signalCode !== null) {
						resolve();
						return;
					}
					// The handle closes when the process is gone, not when it is asked to go.
					const timer = setTimeout(resolve, EXIT_WAIT_MS);
					child.once("close", () => {
						clearTimeout(timer);
						resolve();
					});
					try {
						child.kill("SIGKILL");
					} catch {
						clearTimeout(timer);
						resolve();
					}
				}),
		),
	);
	return doomed.length;
}

/**
 * Stops everything in this process that reads a file `isTakeFile` accepts. Returns, per
 * holder, how many were stopped (only the ones that were), for the log.
 */
export async function releaseTakeFiles(isTakeFile: TakeFileTest): Promise<Record<string, number>> {
	const released: Record<string, number> = {};
	const readersStopped = await stopReaders(isTakeFile);
	if (readersStopped > 0) released.readers = readersStopped;
	for (const [name, releaser] of releasers) {
		try {
			const count = await releaser(isTakeFile);
			if (count > 0) released[name] = count;
		} catch (error) {
			console.warn(`[library] could not release ${name}:`, error);
		}
	}
	return released;
}

/** A test for "this file is in that take": inside its folder, or one of its files. */
export function takeFileTest(folderPath: string | null, files: readonly string[]): TakeFileTest {
	const norm = (value: string) => path.resolve(value).toLowerCase();
	const folder = folderPath ? `${norm(folderPath)}${path.sep}` : null;
	const set = new Set(files.map(norm));
	return (filePath) => {
		if (typeof filePath !== "string" || !filePath) return false;
		const candidate = norm(filePath);
		return set.has(candidate) || (folder !== null && candidate.startsWith(folder));
	};
}
