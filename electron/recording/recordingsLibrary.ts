import type { Dirent } from "node:fs";
import fs from "node:fs/promises";
import path from "node:path";
import { filesMoveMapper, folderMoveMapper, type PathMapper } from "../../src/lib/mediaPathRewrite";
import { sanitizeRecordingName, uniqueRecordingName } from "../../src/lib/recordingName";
import { CURSOR_CHECKPOINT_SUFFIX } from "./cursorCheckpoint";

/**
 * The recordings library: every take in the recordings folder, for the Studio's Media tab.
 *
 * Since this module, a take is written into a folder of its own,
 * `<recordings folder>\recording-<id>\`, holding everything that belongs to it (screen,
 * webcam, stems, sidecars, session). The user names it after the take, which renames the
 * folder; the files inside keep their `recording-<id>` names, because every sidecar, the
 * session manifest and several caches find each other by that stem.
 *
 * Takes made before this sit flat in the folder root. They are NOT migrated: moving them
 * would rewrite projects the user did not open, for no gain they asked for. They are
 * listed by grouping the root files on their `recording-<id>` stem, and a rename of one
 * moves just that take into a folder of its own -- one take, on request.
 *
 * Security: the renderer only ever names a recording by the key this module handed it,
 * and every operation resolves that key again inside the folder, refusing anything that
 * is a link, sits outside it, or still belongs to a take being recorded or recovered.
 */

export const TAKE_FILE_PREFIX = "recording-";

const SCREEN_FILE = /^recording-(\d+)\.(mp4|webm|mov|mkv)$/i;
const VIDEO_FILE = /\.(mp4|webm|mov|mkv)$/i;
const WEBCAM_FILE = /-webcam\.(mp4|webm|mov|mkv)$/i;
const TAKE_STEM = /^recording-(\d+)$/;
/** `recording-<id>` followed by its extension or `-webcam`: every file of one flat take. */
const TAKE_FILE = /^(recording-\d+)(?=[.-])/i;

/** The folder name a take is first written into. */
export function takeFolderName(recordingId: number): string {
	return `${TAKE_FILE_PREFIX}${recordingId}`;
}

/**
 * The take's folder for one of its file names (`recording-<id>.mp4`,
 * `recording-<id>-webcam.webm`...), or null for a name that is not a take's.
 */
export function takeFolderNameForFile(fileName: string): string | null {
	const match = TAKE_FILE.exec(fileName);
	return match ? match[1].toLowerCase() : null;
}

export type LibraryRecordingKind = "folder" | "flat";

export interface LibraryRecording {
	/** What the renderer hands back to name this recording: `folder:<name>` or `flat:<stem>`. */
	key: string;
	kind: LibraryRecordingKind;
	/** The folder name, or the stem of a flat take. */
	name: string;
	folderPath: string | null;
	screenVideoPath: string;
	webcamVideoPath?: string;
	files: string[];
	sizeBytes: number;
	/** Epoch ms: the take id when it is one, else the screen file's time. */
	createdAt: number;
	/** Being recorded, finalized or waiting for crash recovery: no rename, no delete. */
	busy: boolean;
}

export interface LibraryGuards {
	/** Files of takes being recorded or finalized right now. */
	activeTakePaths(): readonly string[];
	/** Takes the crash-recovery journal still lists (not yet in a saved project). */
	pendingTakePaths(): Promise<readonly string[]>;
}

const samePath = (a: string, b: string) =>
	path.resolve(a).toLowerCase() === path.resolve(b).toLowerCase();

function plausibleEpoch(id: string): number | null {
	const value = Number(id);
	// 2001-09-09 .. 2286: a take id is Date.now() at the start of the take.
	return Number.isFinite(value) && value > 1e12 && value < 1e13 ? value : null;
}

async function readEntries(dir: string): Promise<Dirent[]> {
	try {
		return await fs.readdir(dir, { withFileTypes: true });
	} catch (error) {
		if ((error as NodeJS.ErrnoException)?.code === "ENOENT") return [];
		throw error;
	}
}

async function sizeOf(filePath: string): Promise<number> {
	return (await fs.stat(filePath).catch(() => null))?.size ?? 0;
}

function pickScreenFile(names: string[]): string | null {
	return (
		names.find((name) => SCREEN_FILE.test(name)) ??
		names.find((name) => VIDEO_FILE.test(name) && !WEBCAM_FILE.test(name)) ??
		null
	);
}

/** The screen video among a recording's files. */
export function screenFileOf(files: readonly string[]): string | null {
	const name = pickScreenFile(files.map((file) => path.basename(file)));
	return name ? (files.find((file) => path.basename(file) === name) ?? null) : null;
}

function webcamFor(screenName: string, names: string[]): string | null {
	const stem = screenName.replace(VIDEO_FILE, "");
	return (
		names.find((name) => name.toLowerCase().startsWith(`${stem.toLowerCase()}-webcam.`)) ?? null
	);
}

async function createdAtFor(screenPath: string, stem: string): Promise<number> {
	const id = TAKE_STEM.exec(stem)?.[1];
	const fromId = id ? plausibleEpoch(id) : null;
	if (fromId !== null) return fromId;
	const stats = await fs.stat(screenPath).catch(() => null);
	return stats ? Math.round(stats.birthtimeMs || stats.mtimeMs) : 0;
}

function isBusy(
	files: readonly string[],
	active: readonly string[],
	pending: readonly string[],
): boolean {
	return (
		files.some((file) => file.toLowerCase().endsWith(CURSOR_CHECKPOINT_SUFFIX)) ||
		files.some((file) => [...active, ...pending].some((other) => samePath(file, other)))
	);
}

/**
 * Every recording in `root`, newest first: each folder holding a video, and each flat
 * `recording-<id>` take. Links are skipped, never followed. Empty `recording-<id>` folders
 * (a take that was cancelled before its first frame) are removed on the way, unless a take
 * is being recorded into them.
 */
export async function listRecordings(
	root: string,
	guards: LibraryGuards,
): Promise<LibraryRecording[]> {
	const active = guards.activeTakePaths();
	const pending = await guards.pendingTakePaths();
	const entries = await readEntries(root);
	const recordings: LibraryRecording[] = [];

	for (const entry of entries) {
		if (!entry.isDirectory() || entry.isSymbolicLink() || entry.name.startsWith(".")) continue;
		const folderPath = path.join(root, entry.name);
		const inner = await readEntries(folderPath);
		const names = inner.filter((item) => item.isFile()).map((item) => item.name);
		if (names.length === 0 && inner.length === 0 && TAKE_STEM.test(entry.name)) {
			const recording = [...active, ...pending].some((file) =>
				sameDir(path.dirname(path.resolve(file)), folderPath),
			);
			if (!recording) await fs.rmdir(folderPath).catch(() => undefined);
			continue;
		}
		const screenName = pickScreenFile(names);
		if (!screenName) continue;
		const files = names.map((name) => path.join(folderPath, name));
		const webcamName = webcamFor(screenName, names);
		const sizes = await Promise.all(files.map(sizeOf));
		const screenVideoPath = path.join(folderPath, screenName);
		recordings.push({
			key: `folder:${entry.name}`,
			kind: "folder",
			name: entry.name,
			folderPath,
			screenVideoPath,
			...(webcamName ? { webcamVideoPath: path.join(folderPath, webcamName) } : {}),
			files,
			sizeBytes: sizes.reduce((sum, size) => sum + size, 0),
			createdAt: await createdAtFor(screenVideoPath, screenName.replace(VIDEO_FILE, "")),
			busy:
				isBusy(files, active, pending) ||
				[...active, ...pending].some((file) =>
					sameDir(path.dirname(path.resolve(file)), folderPath),
				),
		});
	}

	const flat = new Map<string, string[]>();
	for (const entry of entries) {
		if (!entry.isFile()) continue;
		const stem = takeFolderNameForFile(entry.name);
		if (!stem) continue;
		flat.set(stem, [...(flat.get(stem) ?? []), entry.name]);
	}
	for (const [stem, names] of flat) {
		const screenName = names.find((name) => SCREEN_FILE.test(name));
		if (!screenName) continue;
		const files = names.map((name) => path.join(root, name));
		const webcamName = webcamFor(screenName, names);
		const sizes = await Promise.all(files.map(sizeOf));
		const screenVideoPath = path.join(root, screenName);
		recordings.push({
			key: `flat:${stem}`,
			kind: "flat",
			name: stem,
			folderPath: null,
			screenVideoPath,
			...(webcamName ? { webcamVideoPath: path.join(root, webcamName) } : {}),
			files,
			sizeBytes: sizes.reduce((sum, size) => sum + size, 0),
			createdAt: await createdAtFor(screenVideoPath, stem),
			busy: isBusy(files, active, pending),
		});
	}

	return recordings.sort((a, b) => b.createdAt - a.createdAt);
}

export class LibraryError extends Error {
	constructor(
		public readonly code:
			| "invalid-key"
			| "not-found"
			| "outside-folder"
			| "busy"
			| "invalid-name"
			| "in-use"
			| "trash-failed",
		message: string,
	) {
		super(message);
		this.name = "LibraryError";
	}
}

export interface ResolvedRecording {
	kind: LibraryRecordingKind;
	name: string;
	/** The folder of a folder take; null for a flat take. */
	folderPath: string | null;
	/** Every file that belongs to it (a folder take: what the folder holds at its top). */
	files: string[];
}

async function realRoot(root: string): Promise<string> {
	try {
		return await fs.realpath(root);
	} catch {
		throw new LibraryError("not-found", "The recordings folder does not exist.");
	}
}

function sameDir(a: string, b: string) {
	return path.resolve(a).toLowerCase() === path.resolve(b).toLowerCase();
}

/**
 * The recording `key` names, resolved again inside `root` -- never a path the renderer
 * sent. A folder must be a real directory (not a link or junction) whose real parent is
 * the real recordings folder; each file of a flat take must be a plain file there.
 */
export async function resolveRecording(root: string, key: unknown): Promise<ResolvedRecording> {
	if (typeof key !== "string") throw new LibraryError("invalid-key", "Invalid recording.");
	const separator = key.indexOf(":");
	const kind = key.slice(0, separator);
	const name = key.slice(separator + 1);
	if (
		separator <= 0 ||
		!name ||
		name === "." ||
		name === ".." ||
		/[\\/]/.test(name) ||
		name.includes("\0") ||
		name !== name.trim()
	) {
		throw new LibraryError("invalid-key", "Invalid recording.");
	}
	const rootReal = await realRoot(root);

	if (kind === "folder") {
		const folderPath = path.join(root, name);
		const stats = await fs.lstat(folderPath).catch(() => null);
		if (!stats) throw new LibraryError("not-found", "The recording is gone.");
		if (stats.isSymbolicLink() || !stats.isDirectory()) {
			throw new LibraryError("outside-folder", "Not a recording folder.");
		}
		const real = await fs.realpath(folderPath);
		if (!sameDir(path.dirname(real), rootReal)) {
			throw new LibraryError("outside-folder", "The recording is outside the recordings folder.");
		}
		const inner = await readEntries(folderPath);
		return {
			kind: "folder",
			name,
			folderPath,
			files: inner.filter((item) => item.isFile()).map((item) => path.join(folderPath, item.name)),
		};
	}

	if (kind === "flat") {
		if (!TAKE_STEM.test(name)) throw new LibraryError("invalid-key", "Invalid recording.");
		const files: string[] = [];
		for (const entry of await readEntries(root)) {
			if (takeFolderNameForFile(entry.name) !== name.toLowerCase()) continue;
			const filePath = path.join(root, entry.name);
			const stats = await fs.lstat(filePath).catch(() => null);
			if (!stats || stats.isSymbolicLink() || !stats.isFile()) continue;
			if (!sameDir(path.dirname(await fs.realpath(filePath)), rootReal)) continue;
			files.push(filePath);
		}
		if (!files.some((file) => SCREEN_FILE.test(path.basename(file)))) {
			throw new LibraryError("not-found", "The recording is gone.");
		}
		return { kind: "flat", name, folderPath: null, files };
	}

	throw new LibraryError("invalid-key", "Invalid recording.");
}

async function assertNotBusy(recording: ResolvedRecording, guards: LibraryGuards) {
	const paths = recording.folderPath ? [recording.folderPath, ...recording.files] : recording.files;
	const active = guards.activeTakePaths();
	const pending = await guards.pendingTakePaths();
	const inFolder = (file: string) =>
		recording.folderPath !== null &&
		sameDir(path.dirname(path.resolve(file)), recording.folderPath);
	if (isBusy(paths, active, pending) || [...active, ...pending].some(inFolder)) {
		throw new LibraryError(
			"busy",
			"This take is still being recorded, finalized or recovered. Try again in a moment.",
		);
	}
}

/**
 * Windows refuses to rename a folder or move a file while something holds it open: the
 * preview decoding the take, an indexer, an antivirus scan of a file just written. Those
 * last a moment, so retry for a few seconds before giving up.
 */
export async function renameWithBackoff(
	from: string,
	to: string,
	attempts = 8,
	rename: (a: string, b: string) => Promise<void> = fs.rename,
): Promise<void> {
	const RETRYABLE = new Set(["EPERM", "EACCES", "EBUSY"]);
	for (let attempt = 0; ; attempt++) {
		try {
			await rename(from, to);
			return;
		} catch (error) {
			const code = (error as NodeJS.ErrnoException)?.code ?? "";
			if (!RETRYABLE.has(code)) throw error;
			if (attempt + 1 >= attempts) {
				throw new LibraryError("in-use", "The recording is open in another program.");
			}
			await new Promise((resolve) => setTimeout(resolve, Math.min(800, 25 * 2 ** attempt)));
		}
	}
}

export interface MoveResult {
	/** The folder the recording is in now. */
	folderPath: string;
	name: string;
	/** Maps every old path of the recording to its new one. */
	mapper: PathMapper;
	/** Each file, old path and new. */
	moves: Array<[string, string]>;
}

async function takenNames(root: string): Promise<string[]> {
	return (await readEntries(root)).map((entry) => entry.name);
}

/**
 * Renames a recording. A folder take renames its folder; a flat take moves its files into
 * a new folder of that name (rolled back if any one cannot move). Collisions get " (2)"...
 */
export async function renameRecording(
	root: string,
	key: unknown,
	desiredName: unknown,
	guards: LibraryGuards,
	options: { rename?: (from: string, to: string) => Promise<void>; attempts?: number } = {},
): Promise<MoveResult> {
	const recording = await resolveRecording(root, key);
	const sanitized = typeof desiredName === "string" ? sanitizeRecordingName(desiredName) : null;
	if (!sanitized) throw new LibraryError("invalid-name", "That name cannot be used for a folder.");
	await assertNotBusy(recording, guards);
	const rename = options.rename ?? fs.rename;

	if (recording.kind === "folder" && recording.folderPath) {
		if (sanitized === recording.name) {
			return {
				folderPath: recording.folderPath,
				name: recording.name,
				mapper: () => null,
				moves: [],
			};
		}
		const name = uniqueRecordingName(sanitized, await takenNames(root), recording.name);
		const target = path.join(root, name);
		await renameWithBackoff(recording.folderPath, target, options.attempts, rename);
		return {
			folderPath: target,
			name,
			mapper: folderMoveMapper(recording.folderPath, target),
			moves: recording.files.map((file) => [file, path.join(target, path.basename(file))]),
		};
	}

	const name = uniqueRecordingName(sanitized, await takenNames(root));
	const target = path.join(root, name);
	await fs.mkdir(target);
	const moved: Array<[string, string]> = [];
	try {
		for (const file of recording.files) {
			const destination = path.join(target, path.basename(file));
			await renameWithBackoff(file, destination, options.attempts, rename);
			moved.push([file, destination]);
		}
	} catch (error) {
		for (const [from, to] of moved.reverse()) {
			await renameWithBackoff(to, from, options.attempts, rename).catch(() => undefined);
		}
		await fs.rmdir(target).catch(() => undefined);
		throw error;
	}
	return { folderPath: target, name, mapper: filesMoveMapper(moved), moves: moved };
}

/**
 * Sends a recording to the Recycle Bin: its whole folder, or every file of a flat take.
 * Never deletes for good -- a bin that refuses (a drive without one) is an error the user
 * sees, not a reason to fall back to a permanent delete.
 */
export async function trashRecording(
	root: string,
	key: unknown,
	guards: LibraryGuards,
	trashItem: (target: string) => Promise<void>,
	options: TrashOptions = {},
): Promise<ResolvedRecording> {
	const recording = await resolveRecording(root, key);
	await assertNotBusy(recording, guards);
	await options.release?.(recording);
	const rename = options.rename ?? fs.rename;
	const targets = recording.folderPath ? [recording.folderPath] : recording.files;
	const trashAttempts = options.trashAttempts ?? 3;
	for (const target of targets) {
		for (let attempt = 0; ; attempt++) {
			// Throws "in-use" when something still holds it after the backoff: the bin is never
			// asked then, so the shell has nothing to prompt about.
			await waitUntilMovable(target, options.attempts, rename);
			try {
				await trashItem(target);
				break;
			} catch (error) {
				if (attempt + 1 >= trashAttempts) {
					throw new LibraryError(
						"trash-failed",
						error instanceof Error ? error.message : String(error),
					);
				}
				await new Promise((resolve) => setTimeout(resolve, 200 * (attempt + 1)));
			}
		}
	}
	return recording;
}

export interface TrashOptions {
	/** Lets go of whatever this process still holds in the take (`releaseTakeFiles`). */
	release?: (recording: ResolvedRecording) => Promise<void>;
	rename?: (from: string, to: string) => Promise<void>;
	/** How many times to try the move probe (backoff 25 ms doubling, at most 800 ms). */
	attempts?: number;
	/** How many times to ask the bin, each after a fresh probe. */
	trashAttempts?: number;
}

/** Where the move probe parks a target for an instant: hidden from the listing (a dot). */
function probeName(target: string): string {
	return path.join(path.dirname(target), `.deleting-${Date.now()}-${path.basename(target)}`);
}

/**
 * Waits until nothing holds `target` open, by moving it aside and straight back. On Windows
 * a folder (or file) cannot be renamed while any handle is open in it, whatever the sharing,
 * so a move that succeeds means the bin can take it now. Asking the bin while a handle is
 * open is what must never happen: when that handle shares delete access, the shell answers
 * with its own "Folder Access Denied" prompt (Electron sets FOFX_SHOWELEVATIONPROMPT, which
 * overrides its no-UI flags) and then fails anyway.
 */
export async function waitUntilMovable(
	target: string,
	attempts = 10,
	rename: (from: string, to: string) => Promise<void> = fs.rename,
): Promise<void> {
	const aside = probeName(target);
	await renameWithBackoff(target, aside, attempts, rename);
	try {
		await renameWithBackoff(aside, target, attempts, rename);
	} catch (error) {
		throw new LibraryError(
			"in-use",
			`The recording was moved to ${aside} and could not be moved back: ${
				error instanceof Error ? error.message : String(error)
			}`,
		);
	}
}
