// The open project's side of a recording that moves or goes away from the library.
//
// Windows will not rename or recycle a folder while a file in it is open, and the editor
// holds the open project's take open the whole time: the native preview decodes it, the
// camera overlay plays its webcam. So a library rename or delete of a take the open project
// uses first RELEASES the media (the editor unmounts its preview while `released` is set),
// does the operation, and then hands the preview its new paths.

import { create } from "zustand";
import { filesMoveMapper, rewriteMediaPaths } from "@/lib/mediaPathRewrite";
import { isAutomaticLabel } from "@/lib/recordingName";
import type { AxcutDocument } from "../schema";
import { useProjectStore, waitForDocumentSaves } from "./projectStore";
import { mapHistory } from "./undoStack";

interface MediaReleaseState {
	/** How many operations need the preview to let go of its files right now. */
	released: number;
}

export const useMediaRelease = create<MediaReleaseState>(() => ({ released: 0 }));

/** The time the preview takes to tear its native view down once it unmounts. */
const RELEASE_SETTLE_MS = 400;

/** Runs `operation` with the editor's preview unmounted, so nothing holds the take open. */
export async function withMediaReleased<T>(operation: () => Promise<T>): Promise<T> {
	useMediaRelease.setState((state) => ({ released: state.released + 1 }));
	try {
		await new Promise((resolve) => setTimeout(resolve, RELEASE_SETTLE_MS));
		return await operation();
	} finally {
		useMediaRelease.setState((state) => ({ released: Math.max(0, state.released - 1) }));
	}
}

/** Whether the open project points at any of these files. */
export function documentUsesFiles(
	document: AxcutDocument | null,
	files: readonly string[],
): boolean {
	if (!document || files.length === 0) return false;
	const used = filesMoveMapper(files.map((file) => [file, file] as const));
	let hit = false;
	rewriteMediaPaths(document.assets, (value) => {
		if (used(value) !== null) hit = true;
		return null;
	});
	return hit;
}

/** The ids of the open project's assets that point at any of these files. */
export function assetsUsingFiles(
	document: AxcutDocument | null,
	files: readonly string[],
): string[] {
	if (!document) return [];
	return document.assets
		.filter((asset) => documentUsesFiles({ ...document, assets: [asset] }, files))
		.map((asset) => asset.id);
}

export interface TakeRename {
	/** The folder's name before (null for a flat take, which had none). */
	from: string | null;
	to: string;
}

/**
 * The document with the label of each asset whose video is among the moved files set to the
 * take's new name -- when that label is automatic (the file name, or the old folder name).
 * The same document when nothing changes. Run before the paths are rewritten: it matches
 * the assets on their old paths.
 */
export function relabelMovedAssets(
	document: AxcutDocument,
	moves: ReadonlyArray<readonly [string, string]>,
	rename?: TakeRename,
): AxcutDocument {
	if (!rename) return document;
	const moved = filesMoveMapper(moves);
	let touched = false;
	const assets = document.assets.map((asset) => {
		if (moved(asset.originalPath) === null) return asset;
		if (!isAutomaticLabel(asset.label, asset.originalPath, rename.from)) return asset;
		if (asset.label === rename.to) return asset;
		touched = true;
		return { ...asset, label: rename.to };
	});
	return touched ? { ...document, assets } : document;
}

/**
 * The files moved (`moves`: old path, new path): the open project and its undo history are
 * repointed, and the result saved. The main process has already rewritten the project file;
 * this is what keeps the editor's next save from writing the old paths back over it.
 */
export async function rewriteOpenProjectMedia(
	moves: ReadonlyArray<readonly [string, string]>,
	/** The take was renamed: its assets' automatic labels (never typed ones) take the new name. */
	rename?: TakeRename,
): Promise<boolean> {
	if (moves.length === 0) return false;
	await waitForDocumentSaves();
	const store = useProjectStore.getState();
	const document = store.document;
	if (!document) return false;
	const mapper = filesMoveMapper(moves);
	// Snapshots are documents saved by this editor; one without assets is left as it is.
	mapHistory((doc) => {
		const snapshot = doc as AxcutDocument;
		const relabelled = Array.isArray(snapshot?.assets)
			? relabelMovedAssets(snapshot, moves, rename)
			: snapshot;
		return rewriteMediaPaths(relabelled, mapper).value;
	});
	const relabelled = relabelMovedAssets(document, moves, rename);
	const { value, changed } = rewriteMediaPaths(relabelled, mapper);
	if (changed === 0 && relabelled === document) return false;
	// `history: false`: the user renamed a folder, not the project. Undo already holds the
	// new paths (mapHistory above), so stepping back never brings the old ones.
	return store.saveDocument(value, { history: false });
}
