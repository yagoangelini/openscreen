// Where the global editor defaults ("Padrões") are kept, on the renderer side.
//
// localStorage, like every other user preference, but under a key of its own: a custom wallpaper
// is an inline image of several MB, and sharing `openscreen_user_preferences` with it would let one
// over-quota write make every other preference stop saving.
//
// The stored value is a sparse `legacyEditor` object, run through `pickEditorDefaults` on the
// way in and out. Null means the user never saved defaults: a new project then copies the
// latest project's look, as it did before the defaults existed (`composeNewProjectEditor`).

import { NEW_PROJECT_FACTORY_EDITOR, pickEditorDefaults } from "./newProjectDefaults";
import { type AxcutDocument, createEmptyDocument } from "./schema";

export const EDITOR_DEFAULTS_STORAGE_KEY = "openscreen_editor_defaults";

/** The saved defaults, or null when there are none (or storage is unavailable). */
export function loadEditorDefaults(): Record<string, unknown> | null {
	try {
		const raw = localStorage.getItem(EDITOR_DEFAULTS_STORAGE_KEY);
		if (!raw) return null;
		const picked = pickEditorDefaults(JSON.parse(raw));
		return Object.keys(picked).length > 0 ? picked : null;
	} catch {
		return null;
	}
}

/** Saves the defaults; null forgets them. False when the browser refused the write (quota). */
export function saveEditorDefaults(defaults: Record<string, unknown> | null): boolean {
	try {
		const picked = defaults ? pickEditorDefaults(defaults) : {};
		if (Object.keys(picked).length === 0) {
			localStorage.removeItem(EDITOR_DEFAULTS_STORAGE_KEY);
		} else {
			localStorage.setItem(EDITOR_DEFAULTS_STORAGE_KEY, JSON.stringify(picked));
		}
		return true;
	} catch {
		return false;
	}
}

export const DEFAULTS_DOCUMENT_ID = "openscreen-defaults";

/**
 * A document holding nothing but the defaults, for the editor panes to read and patch through
 * `getEditorSettings` / `patchEditorSettings` exactly as they do a project. Under the stored
 * values sit the fork's factory choices for a new project, so the panes show what a new project
 * actually gets.
 */
export function editorDefaultsDocument(defaults: Record<string, unknown> | null): AxcutDocument {
	return {
		...createEmptyDocument({ projectId: DEFAULTS_DOCUMENT_ID, title: "Defaults" }),
		legacyEditor: { ...NEW_PROJECT_FACTORY_EDITOR, ...(defaults ?? {}) },
	};
}
