import { describe, expect, it } from "vitest";
import { translate } from "@/i18n/loader";
import { sourceDisplayName } from "./sourceDisplayName";

const ptBr = (key: string, vars?: Record<string, string | number>) =>
	translate("pt-BR", "common", key, vars);

describe("sourceDisplayName", () => {
	it("puts Chromium's display names in the UI language", () => {
		expect(sourceDisplayName("Screen 2", ptBr)).toBe("Tela 2");
		expect(sourceDisplayName("Entire Screen", ptBr)).toBe("Tela inteira");
		expect(sourceDisplayName("Screen", ptBr)).toBe("Tela");
	});

	it("leaves window titles alone", () => {
		expect(sourceDisplayName("Screen recording notes.txt - Notepad", ptBr)).toBe(
			"Screen recording notes.txt - Notepad",
		);
		expect(sourceDisplayName("Visual Studio Code", ptBr)).toBe("Visual Studio Code");
	});
});
