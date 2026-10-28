// The editor settings a NEW project starts from ("Padrões", the global defaults).
//
// Imported by the main process (electron/ai-edition/document-service.ts), so this module stays
// main-process safe: relative imports only.
//
// The model is COPY AT CREATION. A project's editor settings live in its own `legacyEditor`, and
// a key missing there reads as the factory value (`getEditorSettings`). Inheriting the global
// defaults at read time would therefore restyle every project already on disk the moment a
// default changed; copying them into the new project's `legacyEditor` when it is created leaves
// every existing project exactly as it was, and each project stays editable on its own.
//
// What can be a default is an allow-list: the look (`LOOK_LEGACY_EDITOR_KEYS`, the style preset
// fields), the format, the 3D camera moves, the voice enhancement, the cursor overlays, the
// automatic zoom settings and the caption style. Never anything tied to one recording's footage:
// crop, camera framing and pan, audio gains, the caption language or lane.

import { LOOK_LEGACY_EDITOR_KEYS } from "./stylePresets";

/** `legacyEditor` keys, besides the look, that a default may set. */
const BEHAVIOUR_KEYS = [
	"aspectRatio",
	"formatFollowCursor",
	"dollyAmount",
	"leanToClicks",
	"webcamAnchor",
	"voiceEnhance",
	"voiceEnhanceStrength",
	"echoCancel",
	"echoCancelStrength",
	"cursorShowKeystrokes",
	"cursorClickRing",
	"cursorSpotlight",
	"autoFocusAll",
	"autoZoom",
	"captions",
] as const;

export const DEFAULTABLE_EDITOR_KEYS: readonly string[] = [
	...LOOK_LEGACY_EDITOR_KEYS,
	...BEHAVIOUR_KEYS,
];

/**
 * The caption fields that are style, not content. `language` picks a translation of THIS
 * project's transcript and `captionLane` one of its lanes: both name things another project
 * does not have.
 */
const CAPTION_CONTENT_KEYS = new Set(["language", "captionLane"]);

/**
 * What the fork gives every new project under any look: the shortcuts pressed while recording
 * show on screen, and every click gets a ring (2026-10-09). A default or a look that says
 * otherwise wins.
 */
export const NEW_PROJECT_FACTORY_EDITOR: Readonly<Record<string, unknown>> = {
	cursorShowKeystrokes: true,
	cursorClickRing: true,
};

type Fields = Record<string, unknown>;

function isRecord(value: unknown): value is Fields {
	return typeof value === "object" && value !== null && !Array.isArray(value);
}

/**
 * The defaultable fields out of a `legacyEditor` (a project's, or a stored defaults object):
 * everything else is dropped, and the captions keep their style only. Undefined values are
 * dropped too, so the result is always plain JSON.
 */
export function pickEditorDefaults(legacyEditor: unknown): Fields {
	if (!isRecord(legacyEditor)) return {};
	const out: Fields = {};
	for (const key of DEFAULTABLE_EDITOR_KEYS) {
		const value = legacyEditor[key];
		if (value === undefined) continue;
		if (key === "captions") {
			if (!isRecord(value)) continue;
			const style = Object.fromEntries(
				Object.entries(value).filter(([k, v]) => !CAPTION_CONTENT_KEYS.has(k) && v !== undefined),
			);
			if (Object.keys(style).length > 0) out.captions = style;
			continue;
		}
		out[key] = value;
	}
	return out;
}

/**
 * The `legacyEditor` of a new project.
 *
 * - `defaults`: the user's global defaults, or null while they have saved none.
 * - `presetLook`: the look of the style preset marked "for new projects", if any. It is an
 *   explicit choice of a look for new projects, so it wins over the defaults' look fields.
 * - `latestLook`: the most recently edited project's look, the fallback used before the
 *   defaults existed. Only consulted while there are no saved defaults: once the user has
 *   chosen defaults, a new project follows them rather than whatever was edited last.
 */
export function composeNewProjectEditor(input: {
	defaults: Fields | null;
	presetLook: Fields | null;
	latestLook: Fields | null;
}): Fields {
	const defaults = input.defaults ? pickEditorDefaults(input.defaults) : null;
	const hasDefaults = defaults !== null && Object.keys(defaults).length > 0;
	return {
		...NEW_PROJECT_FACTORY_EDITOR,
		...(hasDefaults ? defaults : (input.latestLook ?? {})),
		...(input.presetLook ?? {}),
	};
}

/**
 * A project's `legacyEditor` with the defaults written over it ("Aplicar ao projeto aberto"):
 * every defaultable field the defaults hold, the caption style merged into the project's own
 * captions (its language and lane stay). Everything else of the project is left alone.
 */
export function applyEditorDefaults(legacyEditor: unknown, defaults: Fields): Fields {
	const base: Fields = isRecord(legacyEditor) ? { ...legacyEditor } : {};
	const picked = pickEditorDefaults(defaults);
	const { captions, ...rest } = picked;
	const next: Fields = { ...base, ...rest };
	if (isRecord(captions)) {
		next.captions = { ...(isRecord(base.captions) ? base.captions : {}), ...captions };
	}
	return next;
}
