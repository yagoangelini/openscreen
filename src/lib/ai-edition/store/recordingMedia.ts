// The open project's side of a recording that moves or goes away from the library.
//
// Windows will not rename or recycle a folder while a file in it is open, and the editor
// holds the open project's take open the whole time: the native preview decodes it, the
// camera overlay plays its webcam. So a library rename or delete of a take the open project
// uses first RELEASES the media (the editor unmounts its preview while `released` is set),
// does the operation, and then hands the preview its new paths.

import { create } from "zustand";
import { filesMoveMapper, rewriteMediaPaths } from "@/lib/mediaPathRewrite";
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

/**
 * The files moved (`moves`: old path, new path): the open project and its undo history are
 * repointed, and the result saved. The main process has already rewritten the project file;
 * this is what keeps the editor's next save from writing the old paths back over it.
 */
export async function rewriteOpenProjectMedia(
	moves: ReadonlyArray<readonly [string, string]>,
): Promise<boolean> {
	if (moves.length === 0) return false;
	await waitForDocumentSaves();
	const store = useProjectStore.getState();
	const document = store.document;
	if (!document) return false;
	const mapper = filesMoveMapper(moves);
	mapHistory((doc) => rewriteMediaPaths(doc, mapper).value);
	const { value, changed } = rewriteMediaPaths(document, mapper);
	if (changed === 0) return false;
	// `history: false`: the user renamed a folder, not the project. Undo already holds the
	// new paths (mapHistory above), so stepping back never brings the old ones.
	return store.saveDocument(value, { history: false });
}
