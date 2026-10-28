// The folder of audio the preview plays from files the app renders: the echo-free voice
// ("Remover eco do alto-falante", ~250 MB per 20 min take), the enhanced voice ("Melhorar a
// voz"), a take's second track. All of it is cache, rebuilt when missing, so it is kept under a
// size cap, and the folder that held it before 2.7.2 (inside userData, where Chromium could not
// read it) is removed.
//
// No `electron` import: the folders are handed in, so the tests run on temp dirs.

import { promises as fs } from "node:fs";
import path from "node:path";

/** The cap: past it, the oldest files go first. */
export const PREVIEW_AUDIO_CACHE_MAX_BYTES = 2 * 1024 ** 3;

/** The folder the cache used to live in, inside userData. */
export const LEGACY_PREVIEW_AUDIO_FOLDER = "preview-audio";

/**
 * Deletes `<userData>/preview-audio`: nothing reads it since the cache moved to the temp folder,
 * and on a machine that used the echo removal or "Melhorar a voz" it holds hundreds of MB. Only
 * that one folder the app created; never anything else in userData. Resolves to whether it was
 * there.
 */
export async function removeLegacyPreviewAudio(userDataDir: string): Promise<boolean> {
	const legacy = path.join(userDataDir, LEGACY_PREVIEW_AUDIO_FOLDER);
	try {
		const stat = await fs.lstat(legacy);
		if (!stat.isDirectory()) return false;
	} catch {
		return false;
	}
	await fs.rm(legacy, { recursive: true, force: true });
	return true;
}

/**
 * Brings `dir` under `maxBytes` by deleting its oldest files (by mtime), never one `keep` says
 * to keep: the file just written, and the outputs of the jobs still running. A file that cannot
 * be deleted (open elsewhere) is skipped. Resolves to the paths deleted.
 */
export async function evictPreviewAudioCache(
	dir: string,
	keep: (filePath: string) => boolean,
	maxBytes = PREVIEW_AUDIO_CACHE_MAX_BYTES,
): Promise<string[]> {
	let names: string[];
	try {
		names = await fs.readdir(dir);
	} catch {
		return [];
	}
	const files: { filePath: string; size: number; mtimeMs: number }[] = [];
	for (const name of names) {
		const filePath = path.join(dir, name);
		try {
			const stat = await fs.stat(filePath);
			if (stat.isFile()) files.push({ filePath, size: stat.size, mtimeMs: stat.mtimeMs });
		} catch {
			// Gone meanwhile.
		}
	}
	let total = files.reduce((sum, file) => sum + file.size, 0);
	const deleted: string[] = [];
	files.sort((a, b) => a.mtimeMs - b.mtimeMs);
	for (const file of files) {
		if (total <= maxBytes) break;
		if (keep(file.filePath)) continue;
		try {
			await fs.unlink(file.filePath);
			total -= file.size;
			deleted.push(file.filePath);
		} catch {
			// In use elsewhere: the next write tries again.
		}
	}
	return deleted;
}
