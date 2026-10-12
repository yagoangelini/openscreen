// Planning the automatic zooms again, from wherever the editor offers it: the auto-zoom settings,
// the transcript pane once the transcript moved on, and the dialog after a recording.

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
	const collected = await collectAutoZoomSuggestionsForLatestDocument(
		() => {
			const document = useProjectStore.getState().document;
			return document ? withoutAutoZooms(document) : null;
		},
		(videoPath) =>
			getTelemetryWithFramePopups(videoPath, (path) =>
				nativeBridgeClient.cursor.getTelemetry(path),
			),
		undefined,
		getScreenActivityForZooms,
	);
	const store = useProjectStore.getState();
	if (!collected || store.projectId !== projectId) return null;
	const next = withPlannedTranscript(
		appendAutoZoomSuggestions(collected.document, collected.suggestions),
		transcriptSignature(collected.document),
	);
	return (await store.saveDocument(next, { history: true })) ? collected.suggestions.length : null;
}
