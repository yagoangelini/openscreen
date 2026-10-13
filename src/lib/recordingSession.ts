export interface ProjectMedia {
	screenVideoPath: string;
	webcamVideoPath?: string;
	/**
	 * Milliseconds to shift the webcam asset's playback position relative to
	 * the screen recording. Negative when the webcam started capturing before
	 * the screen recording's real start (e.g. the browser MediaRecorder for
	 * the webcam is started in the renderer before the native Windows helper
	 * process finishes spawning and confirms recording), so the editor skips
	 * that much extra leading footage instead of showing stale camera frames.
	 */
	webcamOffsetMs?: number;
	cursorCaptureMode?: CursorCaptureMode;
}

/**
 * The take's voice and computer sound on their own, beside its screen video, when it
 * recorded both (the Windows helper writes them). Named after the video, so finding
 * them needs nothing but its path.
 */
export function audioStemPathsFor(screenVideoPath: string): {
	voicePath: string;
	systemPath: string;
} {
	const base = screenVideoPath.replace(/\.[^./\\]+$/, "");
	return { voicePath: `${base}.voice.m4a`, systemPath: `${base}.system.m4a` };
}

/** Sidecar beside a take's screen video holding the marker-shortcut positions (media ms). */
export const RECORDING_MARKERS_SUFFIX = ".markers.json";

export type CursorCaptureMode = "editable-overlay" | "system";

export interface RecordingSession extends ProjectMedia {
	createdAt: number;
	/**
	 * Where the take was stopped, in ms of its media time (the press on Stop). The files run a
	 * little past it; the import ends the take there. Absent on takes from before it existed.
	 */
	stopAtMs?: number;
}

export interface RecordedVideoAssetInput {
	fileName: string;
	videoData: ArrayBuffer;
}

export interface StoreRecordedSessionInput {
	screen: RecordedVideoAssetInput;
	webcam?: RecordedVideoAssetInput;
	createdAt?: number;
	cursorCaptureMode?: CursorCaptureMode;
	/**
	 * Recording wall-clock duration (ms). The main process patches the WebM Duration
	 * header on streamed recordings (the renderer no longer holds the bytes). Browser
	 * MediaRecorder writes no/zero duration, which breaks the editor seek bar and
	 * timeline for anything that took the streaming path.
	 */
	durationMs?: number;
	/** See {@link ProjectMedia.webcamOffsetMs}. */
	webcamOffsetMs?: number;
}

export function normalizeCursorCaptureMode(value: unknown): CursorCaptureMode | undefined {
	return value === "editable-overlay" || value === "system" ? value : undefined;
}

function normalizePath(value: unknown): string | undefined {
	if (typeof value !== "string") {
		return undefined;
	}

	const trimmed = value.trim();
	return trimmed ? trimmed : undefined;
}

export function normalizeProjectMedia(candidate: unknown): ProjectMedia | null {
	if (!candidate || typeof candidate !== "object") {
		return null;
	}

	const raw = candidate as Partial<ProjectMedia>;
	const screenVideoPath = normalizePath(raw.screenVideoPath);

	if (!screenVideoPath) {
		return null;
	}

	const webcamVideoPath = normalizePath(raw.webcamVideoPath);
	const cursorCaptureMode = normalizeCursorCaptureMode(raw.cursorCaptureMode);
	const webcamOffsetMs =
		typeof raw.webcamOffsetMs === "number" && Number.isFinite(raw.webcamOffsetMs)
			? raw.webcamOffsetMs
			: undefined;

	return {
		screenVideoPath,
		...(webcamVideoPath ? { webcamVideoPath } : {}),
		...(webcamOffsetMs !== undefined ? { webcamOffsetMs } : {}),
		...(cursorCaptureMode ? { cursorCaptureMode } : {}),
	};
}

export function normalizeRecordingSession(candidate: unknown): RecordingSession | null {
	if (!candidate || typeof candidate !== "object") {
		return null;
	}

	const raw = candidate as Partial<RecordingSession>;
	const media = normalizeProjectMedia(raw);
	if (!media) {
		return null;
	}

	return {
		...media,
		createdAt:
			typeof raw.createdAt === "number" && Number.isFinite(raw.createdAt)
				? raw.createdAt
				: Date.now(),
		...(typeof raw.stopAtMs === "number" && Number.isFinite(raw.stopAtMs) && raw.stopAtMs > 0
			? { stopAtMs: raw.stopAtMs }
			: {}),
	};
}
