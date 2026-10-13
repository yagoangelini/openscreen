// The resets ("Restaurar trilha da câmera", "... de vídeo", "... zooms", "... anotações",
// "Restaurar tudo") as the editor runs them: the pure half from `document/projectReset.ts`,
// the automatic zooms planned again where the import would have planned them, and ONE
// undoable save, so a single Ctrl+Z (or the history menu) brings everything back.
//
// Which reset is waiting for its confirmation lives in a tiny store, so any surface can ask
// for one -- the project menu, a timeline lane's context menu -- and the one dialog the
// editor mounts (`ProjectResetDialog`) asks the user.

import { create } from "zustand";
import {
	applyProjectReset,
	type ProjectResetScope,
	resetReplansZooms,
} from "@/lib/ai-edition/document/projectReset";
import type { AxcutDocument } from "@/lib/ai-edition/schema";
import type { HistoryLabel } from "@/lib/ai-edition/store/historyLabels";
import { useProjectStore, waitForDocumentSaves } from "@/lib/ai-edition/store/projectStore";
import { planAutoZoomsOver } from "./autoZoomReplan";
import { readAutoZoomPref } from "./recordingImport";

export const RESET_HISTORY_LABEL: Record<ProjectResetScope, HistoryLabel> = {
	camera: "resetCamera",
	video: "resetVideo",
	zooms: "resetZooms",
	annotations: "resetAnnotations",
	all: "resetAll",
};

interface ProjectResetRequestState {
	/** The reset waiting for the user's yes, or null. */
	pending: ProjectResetScope | null;
	request: (scope: ProjectResetScope) => void;
	dismiss: () => void;
}

export const useProjectResetRequest = create<ProjectResetRequestState>((set) => ({
	pending: null,
	request: (scope) => set({ pending: scope }),
	dismiss: () => set({ pending: null }),
}));

/** Ask for a reset: the editor's confirmation dialog opens for it. */
export function requestProjectReset(scope: ProjectResetScope): void {
	useProjectResetRequest.getState().request(scope);
}

export interface ProjectResetDeps {
	/** Whether the automatic zooms are planned after a recording. The recording pref by default. */
	autoZoomEnabled?: () => Promise<boolean>;
	/** Plans the automatic zooms over a document without any. The editor's planner by default. */
	planZooms?: (document: AxcutDocument) => Promise<{ document: AxcutDocument } | null>;
}

/** The reset document for `start`: the pure half, then the zooms the import would plan. */
async function buildReset(
	start: AxcutDocument,
	scope: ProjectResetScope,
	deps: ProjectResetDeps,
): Promise<AxcutDocument> {
	const reset = applyProjectReset(start, scope);
	if (!resetReplansZooms(scope)) return reset;
	if (!(await (deps.autoZoomEnabled ?? readAutoZoomPref)())) return reset;
	try {
		const planned = await (deps.planZooms ?? planAutoZoomsOver)(reset);
		if (planned) return planned.document;
	} catch (error) {
		console.warn("[reset] the automatic zooms could not be planned again:", error);
	}
	// No plan (no telemetry, a failed read): keep the automatic zooms the project had, rather
	// than leave the reset with none at all.
	return { ...reset, zoomRanges: start.zoomRanges.filter((zoom) => zoom.source === "auto") };
}

/**
 * Run a reset on the open project, as one undoable write labelled for the history menu.
 * Planning the zooms reads files, so an edit can land meanwhile: the reset is then built
 * again from the newer document, once. Returns whether the reset is on the document.
 */
export async function runProjectReset(
	scope: ProjectResetScope,
	deps: ProjectResetDeps = {},
): Promise<boolean> {
	const first = useProjectStore.getState().document;
	if (!first) return false;
	let start = first;
	for (let attempt = 0; attempt < 2; attempt++) {
		const next = await buildReset(start, scope, deps);
		if ((await waitForDocumentSaves()) === "timeout") return false;
		const latest = useProjectStore.getState().document;
		if (!latest || latest.project.id !== first.project.id) return false;
		if (latest !== start) {
			start = latest;
			continue;
		}
		// Already as imported: no write, so no empty step in the history.
		if (JSON.stringify(next) === JSON.stringify(latest)) return true;
		return useProjectStore
			.getState()
			.saveDocument(next, { history: true, historyLabel: RESET_HISTORY_LABEL[scope] });
	}
	return false;
}
