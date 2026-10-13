// The transcription and privacy settings of ONE project: the global defaults ("Padrões", the user
// preferences) plus whatever this project overrides.
//
// The model is INHERIT UNLESS OVERRIDDEN. These settings were global until now, so a project on
// disk has no overrides and keeps following the defaults, which is exactly what it did before:
// nothing changes for it. A value set in the Media panel is stored on the project
// (`legacyEditor.projectOverrides`, the passthrough blob, so no schema change and an older build
// keeps it) and wins over the default from then on; "Usar o padrão" removes it again.
//
// The two lists are not overridden but EXTENDED: a project adds its own glossary lines and its
// own sensitive words to the defaults. A project glossary line for a term the defaults already
// have replaces that line, so a project can also correct a default spelling. That keeps the
// standing list in every project — the reason it exists — and keeps a project's own words out
// of every other project.

import type { SttWhisperModelPreference } from "../../../electron/stt/transcriptionContract";
import {
	effectiveTranscriptionLanguage,
	loadUserPreferences,
	type UserPreferences,
} from "../userPreferences";
import {
	type AxcutDocument,
	TRANSCRIPT_LANGUAGE_CODES,
	type TranscriptLanguageCode,
} from "./schema";

export const PROJECT_OVERRIDES_KEY = "projectOverrides";

export interface ProjectTranscriptionOverrides {
	/** Glossary lines added to the default glossary for this project. */
	glossaryAdditions?: string;
	/** Sensitive words added to the default ones for this project. */
	autoRedactTermsAdditions?: string;
	/** The standing terms (Whisper prompt) for this project, in place of the default ones. */
	transcriptionVocabulary?: string;
	transcriptionLanguage?: TranscriptLanguageCode;
	transcriptionModel?: SttWhisperModelPreference;
	transcribeGuestAudio?: boolean;
	autoRedact?: boolean;
}

export type OverridableField = keyof ProjectTranscriptionOverrides;

/** Where a value a project uses came from. */
export type SettingSource = "default" | "project";

const MODELS: readonly SttWhisperModelPreference[] = ["auto", "small", "large-v3-turbo"];

function isRecord(value: unknown): value is Record<string, unknown> {
	return typeof value === "object" && value !== null && !Array.isArray(value);
}

/** The overrides stored on a project; anything malformed is dropped on its own. */
export function readProjectOverrides(
	doc: Pick<AxcutDocument, "legacyEditor"> | null | undefined,
): ProjectTranscriptionOverrides {
	const legacy = isRecord(doc?.legacyEditor) ? doc.legacyEditor : null;
	const raw =
		legacy && isRecord(legacy[PROJECT_OVERRIDES_KEY]) ? legacy[PROJECT_OVERRIDES_KEY] : {};
	const out: ProjectTranscriptionOverrides = {};
	if (typeof raw.glossaryAdditions === "string") out.glossaryAdditions = raw.glossaryAdditions;
	if (typeof raw.autoRedactTermsAdditions === "string") {
		out.autoRedactTermsAdditions = raw.autoRedactTermsAdditions;
	}
	if (typeof raw.transcriptionVocabulary === "string") {
		out.transcriptionVocabulary = raw.transcriptionVocabulary;
	}
	if ((TRANSCRIPT_LANGUAGE_CODES as readonly unknown[]).includes(raw.transcriptionLanguage)) {
		out.transcriptionLanguage = raw.transcriptionLanguage as TranscriptLanguageCode;
	}
	if ((MODELS as readonly unknown[]).includes(raw.transcriptionModel)) {
		out.transcriptionModel = raw.transcriptionModel as SttWhisperModelPreference;
	}
	if (typeof raw.transcribeGuestAudio === "boolean") {
		out.transcribeGuestAudio = raw.transcribeGuestAudio;
	}
	if (typeof raw.autoRedact === "boolean") out.autoRedact = raw.autoRedact;
	return out;
}

/**
 * The document with these overrides changed. A key set to `undefined` is removed ("use the
 * default"); an empty list addition is removed too, since it adds nothing. With no override
 * left, the key leaves `legacyEditor` altogether, so a reset project is byte-for-byte what it
 * would have been without ever being touched.
 */
export function withProjectOverrides<D extends Pick<AxcutDocument, "legacyEditor">>(
	doc: D,
	patch: { [K in OverridableField]?: ProjectTranscriptionOverrides[K] | undefined },
): D {
	const next: Record<string, unknown> = { ...readProjectOverrides(doc) };
	for (const [key, value] of Object.entries(patch)) {
		const empty =
			(key === "glossaryAdditions" || key === "autoRedactTermsAdditions") &&
			typeof value === "string" &&
			value.trim() === "";
		if (value === undefined || empty) delete next[key];
		else next[key] = value;
	}
	const legacy: Record<string, unknown> = isRecord(doc.legacyEditor) ? { ...doc.legacyEditor } : {};
	if (Object.keys(next).length > 0) legacy[PROJECT_OVERRIDES_KEY] = next;
	else delete legacy[PROJECT_OVERRIDES_KEY];
	return { ...doc, legacyEditor: legacy };
}

function lines(text: string | undefined): string[] {
	return (text ?? "")
		.replace(/\r\n/g, "\n")
		.split("\n")
		.map((line) => line.trim())
		.filter(Boolean);
}

/** The term a glossary line corrects to, compared without case. Comments have none. */
function glossaryTerm(line: string): string | null {
	if (line.startsWith("#")) return null;
	const colon = line.indexOf(":");
	const term = (colon >= 0 ? line.slice(0, colon) : line).trim().toLowerCase();
	return term || null;
}

/**
 * The default glossary with a project's lines added. A project line for a term the defaults
 * already have replaces the default line; every other line keeps its place.
 */
export function mergeGlossary(defaults: string, additions: string | undefined): string {
	const extra = lines(additions);
	if (extra.length === 0) return defaults;
	const replaced = new Set(extra.map(glossaryTerm).filter((term): term is string => term !== null));
	const kept = lines(defaults).filter((line) => {
		const term = glossaryTerm(line);
		return term === null || !replaced.has(term);
	});
	return [...kept, ...extra].join("\n");
}

/** The default sensitive words with a project's added (`parseSensitiveTerms` drops repeats). */
export function mergeTermLists(defaults: string, additions: string | undefined): string {
	const extra = lines(additions);
	if (extra.length === 0) return defaults;
	return [...lines(defaults), ...extra].join("\n");
}

type Prefs = Pick<
	UserPreferences,
	| "glossary"
	| "autoRedactTerms"
	| "transcriptionVocabulary"
	| "transcriptionLanguage"
	| "transcriptionModel"
	| "transcribeGuestAudio"
	| "autoRedact"
>;

export interface ProjectTranscriptionSettings {
	/** The glossary this project's transcripts are corrected with: defaults + project lines. */
	glossary: string;
	/** The sensitive words this project's takes are blurred for: defaults + project words. */
	autoRedactTerms: string;
	/** The standing terms of the Whisper prompt. */
	transcriptionVocabulary: string;
	transcriptionLanguage: TranscriptLanguageCode;
	transcriptionModel: SttWhisperModelPreference;
	transcribeGuestAudio: boolean;
	autoRedact: boolean;
	/** Which values the project set itself. The lists are "project" once it adds anything. */
	sources: Record<OverridableField, SettingSource>;
}

/** The settings one project's transcription and blur run with. Null doc: the defaults. */
export function resolveProjectTranscriptionSettings(
	doc: Pick<AxcutDocument, "legacyEditor"> | null | undefined,
	prefs: Prefs = loadUserPreferences(),
	locale?: string,
): ProjectTranscriptionSettings {
	const o = readProjectOverrides(doc);
	const source = (field: OverridableField): SettingSource =>
		o[field] === undefined ? "default" : "project";
	return {
		glossary: mergeGlossary(prefs.glossary, o.glossaryAdditions),
		autoRedactTerms: mergeTermLists(prefs.autoRedactTerms, o.autoRedactTermsAdditions),
		transcriptionVocabulary: o.transcriptionVocabulary ?? prefs.transcriptionVocabulary,
		transcriptionLanguage:
			o.transcriptionLanguage ??
			(locale === undefined
				? effectiveTranscriptionLanguage(prefs)
				: effectiveTranscriptionLanguage(prefs, locale)),
		transcriptionModel: o.transcriptionModel ?? prefs.transcriptionModel,
		transcribeGuestAudio: o.transcribeGuestAudio ?? prefs.transcribeGuestAudio,
		autoRedact: o.autoRedact ?? prefs.autoRedact,
		sources: {
			glossaryAdditions: source("glossaryAdditions"),
			autoRedactTermsAdditions: source("autoRedactTermsAdditions"),
			transcriptionVocabulary: source("transcriptionVocabulary"),
			transcriptionLanguage: source("transcriptionLanguage"),
			transcriptionModel: source("transcriptionModel"),
			transcribeGuestAudio: source("transcribeGuestAudio"),
			autoRedact: source("autoRedact"),
		},
	};
}

/**
 * "Salvar como padrão": the preference patch that makes a project's value the default, and the
 * project with that override removed (it now follows the default it just set). A list
 * addition is folded into the default list.
 */
export function promoteOverrideToDefault<D extends Pick<AxcutDocument, "legacyEditor">>(
	doc: D,
	field: OverridableField,
	prefs: Prefs = loadUserPreferences(),
): { document: D; prefs: Partial<UserPreferences> } | null {
	const o = readProjectOverrides(doc);
	const value = o[field];
	if (value === undefined) return null;
	const document = withProjectOverrides(doc, { [field]: undefined });
	switch (field) {
		case "glossaryAdditions":
			return { document, prefs: { glossary: mergeGlossary(prefs.glossary, o.glossaryAdditions) } };
		case "autoRedactTermsAdditions":
			return {
				document,
				prefs: {
					autoRedactTerms: mergeTermLists(prefs.autoRedactTerms, o.autoRedactTermsAdditions),
				},
			};
		case "transcriptionVocabulary":
			return { document, prefs: { transcriptionVocabulary: o.transcriptionVocabulary } };
		case "transcriptionLanguage":
			return { document, prefs: { transcriptionLanguage: o.transcriptionLanguage } };
		case "transcriptionModel":
			return { document, prefs: { transcriptionModel: o.transcriptionModel } };
		case "transcribeGuestAudio":
			return { document, prefs: { transcribeGuestAudio: o.transcribeGuestAudio } };
		case "autoRedact":
			return { document, prefs: { autoRedact: o.autoRedact } };
	}
}
