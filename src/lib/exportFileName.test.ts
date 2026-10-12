import { describe, expect, it } from "vitest";
import { exportBaseName } from "./exportFileName";

describe("exportBaseName", () => {
	it("keeps accents, spaces and commas, and replaces what Windows refuses", () => {
		expect(exportBaseName("Gravação 11/10/2026, 23:27:06")).toBe("Gravação 11-10-2026, 23-27-06");
	});

	it("replaces every character invalid in a Windows file name", () => {
		expect(exportBaseName('a<b>c:d"e/f\\g|h?i*j')).toBe("a-b-c-d-e-f-g-h-i-j");
		expect(exportBaseName("tab\there\u0001")).toBe("tab here");
	});

	it("drops the trailing dots and spaces Windows would strip", () => {
		expect(exportBaseName("  Aula final...  ")).toBe("Aula final");
	});

	it("falls back for an empty or reserved name", () => {
		expect(exportBaseName("")).toBe("export");
		expect(exportBaseName(undefined)).toBe("export");
		expect(exportBaseName("???")).toBe("export");
		expect(exportBaseName("CON")).toBe("export");
		expect(exportBaseName("lpt1", "OpenScreen")).toBe("OpenScreen");
	});

	it("caps the length without cutting a character in half", () => {
		const name = exportBaseName(`${"ç".repeat(59)}😀😀`);
		expect(Array.from(name)).toHaveLength(60);
		expect(name.endsWith("😀")).toBe(true);
	});
});
