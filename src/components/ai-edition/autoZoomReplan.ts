// Planning the automatic zooms again, from wherever the editor offers it: the auto-zoom settings,
// the transcript pane once the transcript moved on, and the dialog after a recording.

import type { AxcutDocument } from "@/lib/ai-edition/schema";
import { useProjectStore } from "@/lib/ai-edition/store/projectStore";
import {
	appendAutoZoomSuggestions,
	collectAutoZoomSuggestionsForLatestDocument,
	transcriptSignature,
	withoutAutoZooms,
	withPlannedTranscript,
} from "@/lib/ai-edition/timeline/apply-auto-zooms";
import {
	getScreenActivityForZooms,
	getTelemetryWithFramePopups,
} from "@/lib/ai-edition/timeline/framePopups";
import { nativeBridgeClient } from "@/native/client";

/**
 * Drops every automatic zoom and plans them again with the current settings and, when the
 * project has one, its transcript. Zooms drawn by hand stay, and the new plan keeps clear of
 * them. One undo step. Returns how many were planned, or null when the project changed or could
 * not be saved.
 */
export async function replanAutoZooms(): Promise<number | null> {
	const { projectId } = useProjectStore.getState();
	const planned = await planAutoZooms(() => {
		const document = useProjectStore.getState().document;
		return document ? withoutAutoZooms(document) : null;
	});
	const store = useProjectStore.getState();
	if (!planned || store.projectId !== projectId) return null;
	return (await store.saveDocument(planned.document, { history: true })) ? planned.count : null;
}

/**
 * The automatic zooms planned over a document that has none of its own yet, the way the
 * replan above plans them: same telemetry, same frames, the transcript when there is one.
 * What "Restaurar zooms" and "Restaurar tudo" use, before their single write. Null when the
 * document reader gave nothing.
 */
export async function planAutoZoomsOver(
	base: AxcutDocument,
): Promise<{ document: AxcutDocument; count: number } | null> {
	return planAutoZooms(() => base);
}

async function planAutoZooms(
	readDocument: () => AxcutDocument | null,
): Promise<{ document: AxcutDocument; count: number } | null> {
	const collected = await collectAutoZoomSuggestionsForLatestDocument(
		readDocument,
		(videoPath) =>
			getTelemetryWithFramePopups(videoPath, (path) =>
				nativeBridgeClient.cursor.getTelemetry(path),
			),
		undefined,
		getScreenActivityForZooms,
	);
	if (!collected) return null;
	return {
		document: withPlannedTranscript(
			appendAutoZoomSuggestions(collected.document, collected.suggestions),
			transcriptSignature(collected.document),
		),
		count: collected.suggestions.length,
	};
}
