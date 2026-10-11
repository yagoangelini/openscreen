// @vitest-environment jsdom
// The fork speaks Brazilian Portuguese natively: with no stored choice the app starts in pt-BR,
// whatever the system language, and a key pt-BR lacks falls back to English.

import { render, screen } from "@testing-library/react";
import i18next from "i18next";
import { afterEach, describe, expect, it, vi } from "vitest";
import { I18nProvider, useI18n } from "@/contexts/I18nContext";
import { DEFAULT_LOCALE, FALLBACK_LOCALE, LOCALE_STORAGE_KEY } from "@/i18n/config";
import { getAvailableLocales, translate } from "@/i18n/loader";
import { toastText } from "@/i18n/toastText";

function LocaleProbe() {
	const { locale, t } = useI18n();
	return (
		<p>
			{locale}|{t("common.actions.cancel")}
		</p>
	);
}

afterEach(() => {
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

	it("starts in pt-BR on an English system with no stored choice", () => {
		localStorage.removeItem(LOCALE_STORAGE_KEY);
		vi.spyOn(navigator, "languages", "get").mockReturnValue(["en-US", "en"]);
		render(
			<I18nProvider>
				<LocaleProbe />
			</I18nProvider>,
		);
		expect(screen.getByText("pt-BR|Cancelar")).toBeTruthy();
	});

	it("keeps a stored choice", () => {
		localStorage.setItem(LOCALE_STORAGE_KEY, "de");
		render(
			<I18nProvider>
				<LocaleProbe />
			</I18nProvider>,
		);
		expect(screen.getByText("de|Abbrechen")).toBeTruthy();
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
