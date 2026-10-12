// Vitest setup (vitest.config.ts `setupFiles`), not app code.
//
// The fork's native language is pt-BR (`DEFAULT_LOCALE` in src/i18n/config.ts and the main
// process's starting locale in electron/i18n.ts), but the suite's assertions read the English
// copy, the reference set every locale is checked against. Every test therefore starts in
// English: the renderer through the stored choice, the main process through `setMainLocale`.
// A test about the default itself removes the stored key, or sets the main locale, on its own.

import { beforeEach } from "vitest";
import { setMainLocale } from "../../electron/i18n";
import { LOCALE_STORAGE_KEY } from "../i18n/config";

beforeEach(() => {
	setMainLocale("en");
	try {
		globalThis.localStorage?.setItem(LOCALE_STORAGE_KEY, "en");
	} catch {
		// No usable localStorage in this environment: nothing to pin.
	}
});
