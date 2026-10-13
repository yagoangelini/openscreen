// A project whose recording is gone: deleted from the library, from Explorer, or a drive
// that is not plugged in. The editor must not show a timeline for media that does not exist,
// so it asks the main process which of the project's files are there and, when one the
// timeline needs is missing, shows a choice instead (Locate..., Remove from the project,
// Close the project).
//
// Pure: what to check, what is missing, and how a "Locate..." answer relinks the document.

import { filesMoveMapper, folderMoveMapper, rewriteMediaPaths } from "@/lib/mediaPathRewrite";
import type { AxcutDocument } from "./schema";

export type MissingMediaRole = "screen" | "camera";

export interface MediaFileRef {
	assetId: string;
	label: string;
	role: MissingMediaRole;
	path: string;
}

/**
 * The files the timeline cannot do without: each video asset's screen file and, when it
 * has one, its camera. The voice and computer stems are left out on purpose: without them
 * a take only loses its separate volumes, never its sound.
 */
export function mediaFilesOf(document: AxcutDocument): MediaFileRef[] {
	const files: MediaFileRef[] = [];
	for (const asset of document.assets) {
		if (asset.kind === "audio") continue;
		files.push({
			assetId: asset.id,
			label: asset.label,
			role: "screen",
			path: asset.originalPath,
		});
		if (asset.cameraTrack?.sourcePath) {
			files.push({
				assetId: asset.id,
				label: asset.label,
				role: "camera",
				path: asset.cameraTrack.sourcePath,
			});
		}
	}
	return files;
}

/** One string per set of paths, so a check runs again only when they change. */
export function mediaSignature(document: AxcutDocument | null): string {
	return document
		? mediaFilesOf(document)
				.map((file) => `${file.role}:${file.path}`)
				.join("\n")
		: "";
}

export function missingMediaOf(files: MediaFileRef[], exists: readonly boolean[]): MediaFileRef[] {
	return files.filter((_, index) => exists[index] === false);
}

function basename(filePath: string): string {
	return filePath.split(/[\\/]/).pop() ?? filePath;
}

function dirname(filePath: string): string {
	const index = Math.max(filePath.lastIndexOf("\\"), filePath.lastIndexOf("/"));
	return index > 0 ? filePath.slice(0, index) : filePath;
}

/**
 * The document after the user pointed at `picked` for the missing `file`. Same file name:
 * the whole folder moved (a renamed or moved take), so everything the document had in the
 * old folder -- camera, stems -- follows. Another name: only that file is repointed.
 */
export function relinkDocument(
	document: AxcutDocument,
	file: MediaFileRef,
	picked: string,
): AxcutDocument {
	const sameName = basename(picked).toLowerCase() === basename(file.path).toLowerCase();
	const mapper = sameName
		? folderMoveMapper(dirname(file.path), dirname(picked))
		: filesMoveMapper([[file.path, picked]]);
	return rewriteMediaPaths(document, mapper).value;
}

/** The document without the missing cameras (their screen file is still there). */
export function dropMissingCameras(
	document: AxcutDocument,
	missing: MediaFileRef[],
): AxcutDocument {
	const cameraless = new Set(
		missing.filter((file) => file.role === "camera").map((file) => file.assetId),
	);
	if (cameraless.size === 0) return document;
	return {
		...document,
		assets: document.assets.map((asset) =>
			cameraless.has(asset.id) ? { ...asset, cameraTrack: null } : asset,
		),
	};
}
