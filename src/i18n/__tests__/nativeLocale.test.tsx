// @vitest-environment jsdom
// The fork speaks Brazilian Portuguese natively: with no stored choice the app starts in pt-BR,
// whatever the system language, and a key pt-BR lacks falls back to English.

import { cleanup, render, screen } from "@testing-library/react";
import i18next from "i18next";
import { afterEach, describe, expect, it, vi } from "vitest";
import { I18nProvider, useI18n } from "@/contexts/I18nContext";
import { DEFAULT_LOCALE, FALLBACK_LOCALE, LOCALE_STORAGE_KEY } from "@/i18n/config";
import { getAvailableLocales, translate } from "@/i18n/loader";
import { toastText } from "@/i18n/toastText";

function LocaleProbe() {
	const { locale, t, systemLocaleSuggestion } = useI18n();
	return (
		<p>
			{locale}|{t("common.actions.cancel")}|{systemLocaleSuggestion ?? "no-suggestion"}
		</p>
	);
}

const SYSTEM_PROMPT_SEEN_KEY = "openscreen-system-language-prompt-seen";

function renderFresh(languages: string[]) {
	localStorage.removeItem(LOCALE_STORAGE_KEY);
	localStorage.removeItem(SYSTEM_PROMPT_SEEN_KEY);
	vi.spyOn(navigator, "languages", "get").mockReturnValue(languages);
	render(
		<I18nProvider>
			<LocaleProbe />
		</I18nProvider>,
	);
}

afterEach(() => {
	cleanup();
	vi.restoreAllMocks();
});

describe("native language", () => {
	it("is pt-BR, with English as the fallback", () => {
		expect(DEFAULT_LOCALE).toBe("pt-BR");
		expect(FALLBACK_LOCALE).toBe("en");
	});

	it("lists pt-BR first in the language pickers", () => {
		expect(getAvailableLocales()[0]).toBe("pt-BR");
	});

	it("starts in pt-BR on an English system with no stored choice, offering English once", () => {
		renderFresh(["en-US", "en"]);
		expect(screen.getByText("pt-BR|Cancelar|en")).toBeTruthy();
	});

	it("does not offer English when Portuguese is anywhere in the system's languages", () => {
		// What Chromium reports on the user's Windows: en-US first, then the OS language.
		renderFresh(["en-US", "pt-BR"]);
		expect(screen.getByText("pt-BR|Cancelar|no-suggestion")).toBeTruthy();
	});

	it("still offers the system language when it is not Portuguese", () => {
		renderFresh(["de-DE", "de"]);
		expect(screen.getByText("pt-BR|Cancelar|de")).toBeTruthy();
	});

	it("keeps a stored choice", () => {
		localStorage.setItem(LOCALE_STORAGE_KEY, "de");
		render(
			<I18nProvider>
				<LocaleProbe />
			</I18nProvider>,
		);
		expect(screen.getByText("de|Abbrechen|no-suggestion")).toBeTruthy();
	});

	it("words toasts fired outside React in pt-BR when nothing is stored", () => {
		localStorage.removeItem(LOCALE_STORAGE_KEY);
		expect(toastText("common", "actions.cancel")).toBe("Cancelar");
	});

	it("falls back to English for a key pt-BR does not have", () => {
		i18next.addResource("en", "common", "fallbackProbe", "English only");
		expect(translate("pt-BR", "common", "fallbackProbe")).toBe("English only");
	});
});

describe("main process", () => {
	it("starts in pt-BR before any renderer reports a choice", async () => {
		vi.resetModules();
		const fresh = await import("../../../electron/i18n");
		expect(fresh.getMainLocale()).toBe("pt-BR");
		expect(fresh.mainT("common", "actions.quit")).toBe("Sair");
	});
});
