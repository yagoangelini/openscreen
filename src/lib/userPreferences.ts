import {
	DEFAULT_EDITOR_LAYOUT_SETTINGS,
	DEFAULT_EXPORT_SETTINGS,
} from "@/components/video-editor/editorDefaults";
import { DEFAULT_LOCALE, LOCALE_STORAGE_KEY } from "@/i18n/config";
import { TRANSCRIPT_LANGUAGE_CODES, type TranscriptLanguageCode } from "@/lib/ai-edition/schema";
import { DEFAULT_GLOSSARY, upgradeStoredGlossary } from "@/lib/ai-edition/transcription/glossary";
import { DEFAULT_VOCABULARY } from "@/lib/ai-edition/transcription/vocabulary";
import type { ExportFormat, ExportQuality } from "@/lib/exporter";
import { type AspectRatio, isAspectRatio } from "@/utils/aspectRatioUtils";
import type { SttWhisperModelPreference } from "../../electron/stt/transcriptionContract";

const PREFS_KEY = "openscreen_user_preferences";

/** What the automatic zooms of a new recording follow: asked each time, or a remembered answer. */
export type AutoZoomAfterRecording = "ask" | "transcript" | "cursor";

export interface UserPreferences {
	/** Default padding % */
	padding: number;
	/** Default aspect ratio */
	aspectRatio: AspectRatio;
	/** Default export quality */
	exportQuality: ExportQuality;
	/** Default export format */
	exportFormat: ExportFormat;
	/** Folder used for the most recent successful export, if any */
	exportFolder: string | null;
	/** Folder of the most recently opened project, if any */
	projectFolder: string | null;
	/** Recording HUD control layout */
	trayLayout: "horizontal" | "vertical";
	/** Force the Windows native recorder to use the software H.264 encoder */
	preferSoftwareEncoder: boolean;
	/** Stop showing the notice that recording fell back to software encoding */
	hideSoftwareEncoderFallbackNotice: boolean;
	/**
	 * Transcribe every new recording as soon as the editor opens. Off by default:
	 * an unrequested inference competed with the preview for the GPU right when
	 * the user wanted to watch the take, and not every video needs captions.
	 */
	autoTranscribe: boolean;
	/** Exports at YouTube's −14 LUFS instead of the −16 the voice is normalised to. */
	youtubeLoudness: boolean;
	/** After a take, blur the e-mails, tenant domains, GUIDs, secrets and phones it shows. */
	autoRedact: boolean;
	/** Terms the transcription is corrected to, one per line (`transcription/glossary.ts`). */
	glossary: string;
	/**
	 * After a take: ask whether its automatic zooms follow the transcript too (transcribed first,
	 * before the editor opens up), or apply a remembered answer.
	 */
	autoZoomAfterRecording: AutoZoomAfterRecording;
	/**
	 * The whisper model: "auto" runs large-v3-turbo on a dedicated GPU with room for it
	 * (874 MB, downloaded on first use) and small everywhere else (electron/stt/whisperDevices.ts).
	 */
	transcriptionModel: SttWhisperModelPreference;
	/**
	 * The language a transcription is decoded in when the run does not pick one; "auto"
	 * detects it. Null follows the app: Portuguese while it speaks Portuguese, else
	 * "auto" (`effectiveTranscriptionLanguage`).
	 */
	transcriptionLanguage: TranscriptLanguageCode | null;
	/** Terms every transcription is told to expect, before the project's own (vocabulary.ts). */
	transcriptionVocabulary: string;
}

export const DEFAULT_PREFS: UserPreferences = {
	padding: DEFAULT_EDITOR_LAYOUT_SETTINGS.padding,
	aspectRatio: DEFAULT_EDITOR_LAYOUT_SETTINGS.aspectRatio,
	exportQuality: DEFAULT_EXPORT_SETTINGS.quality,
	exportFormat: DEFAULT_EXPORT_SETTINGS.format,
	exportFolder: null,
	projectFolder: null,
	trayLayout: "horizontal",
	preferSoftwareEncoder: false,
	hideSoftwareEncoderFallbackNotice: false,
	autoTranscribe: false,
	youtubeLoudness: true,
	autoRedact: true,
	glossary: DEFAULT_GLOSSARY,
	autoZoomAfterRecording: "ask",
	transcriptionModel: "auto",
	transcriptionLanguage: null,
	transcriptionVocabulary: DEFAULT_VOCABULARY,
};

/** The app's language, as the I18n provider resolves it: the stored choice, else pt-BR. */
function appLocale(): string {
	try {
		return localStorage.getItem(LOCALE_STORAGE_KEY) || DEFAULT_LOCALE;
	} catch {
		return DEFAULT_LOCALE;
	}
}

/**
 * The language transcriptions run in by default. Pinned to Portuguese while the app
 * speaks it: detection runs on the first seconds alone, and a take that opens on a
 * product name or a silence could come back as English. "auto" stays one choice away.
 */
export function effectiveTranscriptionLanguage(
	prefs: Pick<UserPreferences, "transcriptionLanguage"> = loadUserPreferences(),
	locale: string = appLocale(),
): TranscriptLanguageCode {
	if (prefs.transcriptionLanguage) return prefs.transcriptionLanguage;
	return locale.toLowerCase().startsWith("pt") ? "pt" : "auto";
}

/** Parses stored preferences without throwing on malformed JSON. */
function safeJsonParse(text: string | null): Record<string, unknown> | null {
	if (!text) return null;
	try {
		return JSON.parse(text);
	} catch {
		return null;
	}
}

/** Load preferences from localStorage, falling back to defaults for missing or invalid fields. */
export function loadUserPreferences(): UserPreferences {
	let raw: Record<string, unknown> | null = null;
	try {
		raw = safeJsonParse(localStorage.getItem(PREFS_KEY));
	} catch {
		return { ...DEFAULT_PREFS };
	}
	if (!raw || typeof raw !== "object") return { ...DEFAULT_PREFS };

	return {
		padding:
			typeof raw.padding === "number" &&
			Number.isFinite(raw.padding) &&
			raw.padding >= 0 &&
			raw.padding <= 100
				? raw.padding
				: DEFAULT_PREFS.padding,
		aspectRatio: isAspectRatio(raw.aspectRatio) ? raw.aspectRatio : DEFAULT_PREFS.aspectRatio,
		exportQuality:
			raw.exportQuality === "medium" ||
			raw.exportQuality === "good" ||
			raw.exportQuality === "source"
				? (raw.exportQuality as ExportQuality)
				: DEFAULT_PREFS.exportQuality,
		exportFormat:
			raw.exportFormat === "gif" || raw.exportFormat === "mp4"
				? (raw.exportFormat as ExportFormat)
				: DEFAULT_PREFS.exportFormat,
		exportFolder:
			typeof raw.exportFolder === "string" && raw.exportFolder.length > 0
				? raw.exportFolder
				: DEFAULT_PREFS.exportFolder,
		projectFolder:
			typeof raw.projectFolder === "string" && raw.projectFolder.length > 0
				? raw.projectFolder
				: DEFAULT_PREFS.projectFolder,
		trayLayout:
			raw.trayLayout === "horizontal" || raw.trayLayout === "vertical"
				? raw.trayLayout
				: DEFAULT_PREFS.trayLayout,
		preferSoftwareEncoder:
			typeof raw.preferSoftwareEncoder === "boolean"
				? raw.preferSoftwareEncoder
				: DEFAULT_PREFS.preferSoftwareEncoder,
		hideSoftwareEncoderFallbackNotice:
			typeof raw.hideSoftwareEncoderFallbackNotice === "boolean"
				? raw.hideSoftwareEncoderFallbackNotice
				: DEFAULT_PREFS.hideSoftwareEncoderFallbackNotice,
		autoTranscribe:
			typeof raw.autoTranscribe === "boolean" ? raw.autoTranscribe : DEFAULT_PREFS.autoTranscribe,
		youtubeLoudness:
			typeof raw.youtubeLoudness === "boolean"
				? raw.youtubeLoudness
				: DEFAULT_PREFS.youtubeLoudness,
		autoRedact: typeof raw.autoRedact === "boolean" ? raw.autoRedact : DEFAULT_PREFS.autoRedact,
		glossary:
			typeof raw.glossary === "string"
				? upgradeStoredGlossary(raw.glossary)
				: DEFAULT_PREFS.glossary,
		autoZoomAfterRecording:
			raw.autoZoomAfterRecording === "transcript" || raw.autoZoomAfterRecording === "cursor"
				? raw.autoZoomAfterRecording
				: DEFAULT_PREFS.autoZoomAfterRecording,
		transcriptionModel:
			raw.transcriptionModel === "small" || raw.transcriptionModel === "large-v3-turbo"
				? raw.transcriptionModel
				: DEFAULT_PREFS.transcriptionModel,
		transcriptionLanguage: (TRANSCRIPT_LANGUAGE_CODES as readonly unknown[]).includes(
			raw.transcriptionLanguage,
		)
			? (raw.transcriptionLanguage as TranscriptLanguageCode)
			: DEFAULT_PREFS.transcriptionLanguage,
		transcriptionVocabulary:
			typeof raw.transcriptionVocabulary === "string"
				? raw.transcriptionVocabulary
				: DEFAULT_PREFS.transcriptionVocabulary,
	};
}

/**
 * Parent directory of a saved file path. Handles both POSIX and Windows
 * separators since the path comes from the OS save dialog. Root dirs keep their
 * trailing separator so the result stays a valid directory ("/video.mp4" -> "/",
 * "C:\\video.mp4" -> "C:\\"). Returns null if no separator is found.
 */
export function parentDirectoryOf(filePath: string): string | null {
	const lastSep = Math.max(filePath.lastIndexOf("/"), filePath.lastIndexOf("\\"));
	if (lastSep < 0) return null;

	// POSIX root, e.g. "/video.mp4" -> "/"
	if (lastSep === 0) return filePath[0];

	// Windows drive root, e.g. "C:\\video.mp4" -> "C:\\"
	if (lastSep === 2 && /^[A-Za-z]:[/\\]/.test(filePath)) {
		return filePath.slice(0, lastSep + 1);
	}

	return filePath.slice(0, lastSep);
}

/** Remembered export folder as `string | undefined`, for IPC handlers that treat absence as "use the default". */
export function getExportFolder(): string | undefined {
	return loadUserPreferences().exportFolder ?? undefined;
}

/** Remembered open-project folder as `string | undefined`, for IPC handlers that treat absence as "use the default". */
export function getProjectFolder(): string | undefined {
	return loadUserPreferences().projectFolder ?? undefined;
}

/** Persist preferences to localStorage; only the provided fields are updated. */
export function saveUserPreferences(partial: Partial<UserPreferences>): void {
	const current = loadUserPreferences();
	const merged = { ...current, ...partial };
	try {
		localStorage.setItem(PREFS_KEY, JSON.stringify(merged));
	} catch {
		// localStorage may be unavailable (e.g. private browsing, quota exceeded)
	}
}
