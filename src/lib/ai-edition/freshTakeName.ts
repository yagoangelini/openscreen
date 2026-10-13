// The name a take gets as it ends: asked in the editor the moment it opens on the take,
// before the take is imported, and used for its folder and for the project.
//
// WHY BEFORE THE IMPORT. On Windows a folder cannot be renamed while anything holds a file
// in it open, and from the import on everything does: the preview decodes the screen video,
// the frame scan and the OCR read it, the waveform decodes its stems. Before the import
// nothing does yet -- every writer closed at the hand-off -- so the rename is a plain,
// atomic folder rename, and no project ever points at the old paths.
//
// WHY IT CANNOT RACE THE TRANSCRIPT AUTO-ZOOM QUESTION. That question is asked after the
// import, about the imported asset (`freshRecordingTranscriptOffer`), and the import waits
// here: the name comes first, then the take is imported, then the zoom question.

import { formatDateTime } from "@/i18n/format";
import { currentLocale, toastText } from "@/i18n/toastText";
import { sanitizeRecordingName } from "@/lib/recordingName";
import type { RecordingSession } from "@/lib/recordingSession";

export interface TakeNameRequest {
	/** Prefilled; also what Esc or "Skip" keeps. */
	defaultName: string;
	resolve: (name: string) => void;
}

type Prompt = (request: TakeNameRequest) => void;

let prompt: Prompt | null = null;

/** The editor's dialog registers here while it is mounted. */
export function registerTakeNamePrompt(next: Prompt): () => void {
	prompt = next;
	return () => {
		if (prompt === next) prompt = null;
	};
}

/** The name the dialog would prefill for a take made at `date`. */
export function defaultTakeName(date: Date = new Date()): string {
	const title = toastText("editor", "projectNames.recording", {
		date: formatDateTime(date, currentLocale()),
	});
	return sanitizeRecordingName(title) ?? "Recording";
}

/** Whether the take sits in a `recording-<id>` folder of its own, which is what gets named. */
export function takeHasOwnFolder(screenVideoPath: string): boolean {
	const parts = screenVideoPath.split(/[\\/]/);
	const file = parts.at(-1) ?? "";
	const folder = parts.at(-2) ?? "";
	const stem = /^(recording-\d+)(?=[.-])/i.exec(file)?.[1];
	return (
		Boolean(stem) && /^recording-\d+$/i.test(folder) && folder.toLowerCase() === stem?.toLowerCase()
	);
}

function askTakeName(defaultName: string): Promise<string> {
	const show = prompt;
	if (!show) return Promise.resolve(defaultName);
	return new Promise((resolve) => show({ defaultName, resolve }));
}

export interface NamedTake {
	session: RecordingSession;
	/** The name, for the project title. */
	title: string;
}

/**
 * Asks for the take's name and renames its folder. Null when there is nothing to name (a
 * flat take, a take recovered from elsewhere, no main process that knows how): the import
 * then goes on exactly as before. A rename that fails keeps the take where it is -- it is
 * never lost over a name -- and says so.
 */
export async function nameFreshTake(
	session: RecordingSession,
	onRenameFailed?: (message: string) => void,
): Promise<NamedTake | null> {
	const api = typeof window === "undefined" ? undefined : window.electronAPI;
	if (!api?.nameFreshTake || !takeHasOwnFolder(session.screenVideoPath)) return null;
	const createdAt = Number.isFinite(session.createdAt) ? new Date(session.createdAt) : new Date();
	const typed = await askTakeName(defaultTakeName(createdAt));
	const name = sanitizeRecordingName(typed) ?? defaultTakeName(createdAt);
	try {
		const result = await api.nameFreshTake(name);
		if (result.success) return { session: result.session, title: result.name ?? name };
		onRenameFailed?.(result.error);
	} catch (error) {
		onRenameFailed?.(error instanceof Error ? error.message : String(error));
	}
	return { session, title: name };
}
