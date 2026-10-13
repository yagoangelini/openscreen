import { type FSWatcher, watch } from "node:fs";
import fs from "node:fs/promises";
import path from "node:path";
import { type IpcMain, shell, type WebContents } from "electron";
import { isPathUnder, type PathMapper, rewriteMediaPaths } from "../../src/lib/mediaPathRewrite";
import { sanitizeRecordingName } from "../../src/lib/recordingName";
import type { RecordingSession } from "../../src/lib/recordingSession";
import type { DocumentService } from "../ai-edition/document-service";
import { moveCachedPeaks } from "../media/audioPeaks";
import { rewriteRegistryPaths } from "../media/mediaLinksRegistry";
import { getRecordingPreview } from "../media/recordingPreview";
import { moveCachedScreenActivity } from "../media/screenActivity";
import { releaseTakeFiles, takeFileTest } from "../media/takeFileHolders";
import { rewritePendingTakePaths } from "../recording/pendingTakes";
import {
	LibraryError,
	type LibraryGuards,
	type LibraryRecording,
	listRecordings,
	type MoveResult,
	renameRecording,
	resolveRecording,
	screenFileOf,
	takeFolderNameForFile,
	trashRecording,
} from "../recording/recordingsLibrary";

/**
 * The IPC side of the recordings library (Media tab) and of the name asked for after a take.
 * Kept out of `handlers.ts`, which hands in what only it knows: where takes go, which take
 * is recording, the hand-off slot, the project store.
 */
export interface RecordingsLibraryDeps {
	/** The recordings folder new takes go to (the user's choice or Videos\OpenScreen). */
	recordingsFolder(): string;
	guards: LibraryGuards;
	documents: DocumentService;
	/** Where the take journal lives (RECORDINGS_DIR). */
	journalDir(): string;
	/** Where the media-links registry lives (DEFAULT_RECORDINGS_DIR). */
	registryDir(): string;
	/** The take waiting for the editor, if any, and a way to repoint it. */
	currentSession(): RecordingSession | null;
	setCurrentSession(session: RecordingSession): void;
	/** Resolves once the take's stop has finished and its helper let go of its files. */
	takeSettled(): Promise<void>;
}

export type LibraryAnswer<T extends object = object> =
	| ({ success: true } & T)
	| { success: false; code: string; error: string };

function failure(error: unknown): { success: false; code: string; error: string } {
	if (error instanceof LibraryError)
		return { success: false, code: error.code, error: error.message };
	return {
		success: false,
		code: "failed",
		error: error instanceof Error ? error.message : String(error),
	};
}

const MEDIA_FILE = /\.(mp4|webm|mov|mkv|m4a|wav)$/i;

/**
 * Everything that remembers where a recording's files were, told where they are now.
 * The project the editor holds open is rewritten in memory by the renderer as well
 * (with the `moves` it gets back), or its next save would put the old paths back.
 */
async function followMove(deps: RecordingsLibraryDeps, result: MoveResult): Promise<string[]> {
	const mapper: PathMapper = result.mapper;
	const changedProjects = await deps.documents.rewriteMediaPaths(mapper).catch((error) => {
		console.warn("[library] could not rewrite the projects:", error);
		return [] as string[];
	});
	for (const [, to] of result.moves) {
		if (!to.toLowerCase().endsWith(".session.json")) continue;
		try {
			const raw = JSON.parse(await fs.readFile(to, "utf-8"));
			const rewritten = rewriteMediaPaths(raw, mapper);
			if (rewritten.changed > 0) {
				await fs.writeFile(to, JSON.stringify(rewritten.value, null, 2), "utf-8");
			}
		} catch (error) {
			console.warn("[library] could not rewrite the session manifest:", to, error);
		}
	}
	await rewritePendingTakePaths(deps.journalDir(), mapper).catch((error) =>
		console.warn("[library] could not rewrite the take journal:", error),
	);
	await rewriteRegistryPaths(deps.registryDir(), mapper).catch((error) =>
		console.warn("[library] could not rewrite the media-links registry:", error),
	);
	await Promise.all(
		result.moves
			.filter(([from]) => MEDIA_FILE.test(from))
			.flatMap(([from, to]) => [moveCachedPeaks(from, to), moveCachedScreenActivity(from, to)]),
	);
	const session = deps.currentSession();
	if (session) {
		const rewritten = rewriteMediaPaths(session, mapper);
		if (rewritten.changed > 0) deps.setCurrentSession(rewritten.value);
	}
	console.info("[library] recording moved", {
		to: result.folderPath,
		files: result.moves.length,
		projects: changedProjects.length,
	});
	return changedProjects;
}

function moveAnswer(result: MoveResult, projects: string[]) {
	return {
		name: result.name,
		folderPath: result.folderPath,
		moves: result.moves,
		changedProjectIds: projects,
	};
}

export interface LibraryListing {
	folder: string;
	recordings: Array<
		LibraryRecording & { projects: Array<{ id: string; title: string; updatedAt: string }> }
	>;
}

export function registerRecordingsLibraryHandlers(ipcMain: IpcMain, deps: RecordingsLibraryDeps) {
	ipcMain.handle("recordings-library:list", async (): Promise<LibraryAnswer<LibraryListing>> => {
		try {
			const folder = deps.recordingsFolder();
			const recordings = await listRecordings(folder, deps.guards);
			const projects = await deps.documents.listProjectMediaPaths().catch(() => []);
			return {
				success: true,
				folder,
				recordings: recordings.map((recording) => ({
					...recording,
					projects: projects
						.filter((project) =>
							project.paths.some((used) =>
								recording.folderPath
									? isPathUnder(used, recording.folderPath)
									: recording.files.some((file) => isPathUnder(used, file)),
							),
						)
						.sort((a, b) => b.updatedAt.localeCompare(a.updatedAt))
						.map(({ id, title, updatedAt }) => ({ id, title, updatedAt })),
				})),
			};
		} catch (error) {
			return failure(error);
		}
	});

	ipcMain.handle("recordings-library:preview", async (_, key: unknown) => {
		try {
			const recording = await resolveRecording(deps.recordingsFolder(), key);
			const screen = screenFileOf(recording.files);
			if (!screen) return { success: false, code: "not-found", error: "No video." };
			return { success: true, ...(await getRecordingPreview(screen)) };
		} catch (error) {
			return failure(error);
		}
	});

	ipcMain.handle("recordings-library:rename", async (_, key: unknown, name: unknown) => {
		try {
			const result = await renameRecording(deps.recordingsFolder(), key, name, deps.guards);
			const projects = result.moves.length > 0 ? await followMove(deps, result) : [];
			return { success: true, ...moveAnswer(result, projects) };
		} catch (error) {
			return failure(error);
		}
	});

	ipcMain.handle("recordings-library:trash", async (_, key: unknown) => {
		try {
			const removed = await trashRecording(
				deps.recordingsFolder(),
				key,
				deps.guards,
				(target) => shell.trashItem(target),
				{
					// Whatever this process still reads in the take (a scan, a thumbnail, a preview
					// view nobody destroyed) is stopped first: the bin cannot take an open folder.
					release: async (recording) => {
						const released = await releaseTakeFiles(
							takeFileTest(recording.folderPath, recording.files),
						);
						if (Object.keys(released).length > 0) {
							console.info("[library] let go of the take before the bin", released);
						}
					},
				},
			);
			console.info("[library] recording sent to the Recycle Bin", {
				target: removed.folderPath ?? removed.files[0],
			});
			return { success: true, files: removed.files, folderPath: removed.folderPath };
		} catch (error) {
			return failure(error);
		}
	});

	ipcMain.handle("recordings-library:reveal", async (_, key: unknown) => {
		try {
			const recording = await resolveRecording(deps.recordingsFolder(), key);
			const target = recording.folderPath ?? recording.files[0];
			if (target) shell.showItemInFolder(target);
			return { success: true };
		} catch (error) {
			return failure(error);
		}
	});

	// Which of these files are there. Only a stat: what the editor needs to tell a take
	// that was deleted from one that is merely slow to open.
	ipcMain.handle("media-files-exist", async (_, paths: unknown) => {
		if (!Array.isArray(paths) || paths.length > 500) return { success: false, exists: [] };
		const exists = await Promise.all(
			paths.map(async (candidate) => {
				if (typeof candidate !== "string" || !path.isAbsolute(candidate)) return false;
				return (await fs.stat(candidate).catch(() => null))?.isFile() ?? false;
			}),
		);
		return { success: true, exists };
	});

	/**
	 * The name the user gave the take that just ended, before the editor opens it: its folder
	 * is renamed while nothing has the files open yet. Acts only on the take in the hand-off
	 * slot -- the renderer never names a path -- and only when it sits in a take folder of
	 * its own, directly in the recordings folder (a flat take, or one recorded elsewhere, keeps
	 * its place).
	 */
	ipcMain.handle("name-fresh-take", async (_, name: unknown) => {
		try {
			const session = deps.currentSession();
			if (!session) return { success: false, code: "not-found", error: "No take is waiting." };
			if (typeof name !== "string" || !sanitizeRecordingName(name)) {
				return { success: false, code: "invalid-name", error: "That name cannot be used." };
			}
			const root = deps.recordingsFolder();
			const folder = path.dirname(session.screenVideoPath);
			const folderName = path.basename(folder);
			if (
				path.resolve(path.dirname(folder)).toLowerCase() !== path.resolve(root).toLowerCase() ||
				takeFolderNameForFile(path.basename(session.screenVideoPath)) !== folderName.toLowerCase()
			) {
				return { success: true, session, renamed: false };
			}
			// Every writer of the take has closed by the hand-off; the helper process itself can
			// take a moment longer to go, and the folder is not renamed under it.
			await deps.takeSettled();
			// The journal still lists the take (it is not in a project yet), and is rewritten
			// with it, so it is not a reason to refuse here.
			const guards: LibraryGuards = {
				activeTakePaths: deps.guards.activeTakePaths,
				pendingTakePaths: async () => [],
			};
			const result = await renameRecording(root, `folder:${folderName}`, name, guards);
			if (result.moves.length > 0) await followMove(deps, result);
			return {
				success: true,
				session: deps.currentSession() ?? session,
				renamed: result.moves.length > 0,
				name: result.name,
			};
		} catch (error) {
			return failure(error);
		}
	});

	registerLibraryWatch(ipcMain, deps);
}

/**
 * Tells the editor when the recordings folder changed (a take landed, a folder was renamed
 * or deleted in Explorer), so the library and the open project's missing-media check catch
 * up. One recursive watcher while at least one window listens, debounced.
 */
function registerLibraryWatch(ipcMain: IpcMain, deps: RecordingsLibraryDeps) {
	const listeners = new Set<WebContents>();
	let watcher: FSWatcher | null = null;
	let watchedFolder: string | null = null;
	let timer: ReturnType<typeof setTimeout> | null = null;

	const notify = () => {
		if (timer) clearTimeout(timer);
		timer = setTimeout(() => {
			timer = null;
			for (const contents of listeners) {
				if (!contents.isDestroyed()) contents.send("recordings-library-changed");
			}
		}, 600);
	};

	const stop = () => {
		watcher?.close();
		watcher = null;
		watchedFolder = null;
	};

	const ensure = () => {
		const folder = deps.recordingsFolder();
		if (watcher && watchedFolder === folder) return;
		stop();
		try {
			watcher = watch(folder, { recursive: true }, notify);
			watcher.on("error", stop);
			watchedFolder = folder;
		} catch {
			// The folder does not exist yet: the listing says so, and focus refreshes it.
		}
	};

	ipcMain.handle("recordings-library:watch", (event, on: unknown) => {
		const contents = event.sender;
		if (on === false) {
			listeners.delete(contents);
		} else if (!listeners.has(contents)) {
			listeners.add(contents);
			contents.once("destroyed", () => {
				listeners.delete(contents);
				if (listeners.size === 0) stop();
			});
		}
		if (listeners.size === 0) stop();
		else ensure();
		return { success: true };
	});
}
