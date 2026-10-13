import { describe, expect, it } from "vitest";
import {
	isAutomaticLabel,
	RECORDING_NAME_MAX_LENGTH,
	sanitizeRecordingName,
	uniqueRecordingName,
} from "./recordingName";

describe("sanitizeRecordingName", () => {
	it("keeps accents, spaces and commas", () => {
		expect(sanitizeRecordingName("Gravação de hoje, parte 1")).toBe("Gravação de hoje, parte 1");
	});

	it("replaces what Windows refuses in a file name", () => {
		expect(sanitizeRecordingName('Aula 3: Copilot <no> "Teams" / SharePoint | ok?*')).toBe(
			"Aula 3- Copilot -no- -Teams- - SharePoint - ok-",
		);
		expect(sanitizeRecordingName("Gravação 13/10/2026, 14:05:11")).toBe(
			"Gravação 13-10-2026, 14-05-11",
		);
	});

	it("drops control characters and collapses whitespace", () => {
		expect(sanitizeRecordingName("a\tb\n\nc\u0007d")).toBe("a b c-d");
	});

	it("strips the trailing dots and spaces Windows would drop, and leading dots", () => {
		expect(sanitizeRecordingName("  ..aula..  ")).toBe("aula");
		expect(sanitizeRecordingName("..")).toBeNull();
		expect(sanitizeRecordingName(" . ")).toBeNull();
	});

	it("refuses reserved device names, with or without an extension", () => {
		for (const name of [
			"CON",
			"con",
			"Prn",
			"AUX",
			"nul",
			"COM1",
			"lpt9",
			"con.aula",
			"NUL .txt",
		]) {
			expect(sanitizeRecordingName(name)).toBeNull();
		}
		expect(sanitizeRecordingName("console")).toBe("console");
		expect(sanitizeRecordingName("COM10")).toBe("COM10");
	});

	it("refuses an empty name", () => {
		expect(sanitizeRecordingName("")).toBeNull();
		expect(sanitizeRecordingName("   ")).toBeNull();
		expect(sanitizeRecordingName(null)).toBeNull();
	});

	it("cuts a long name by code point", () => {
		const long = "😀".repeat(RECORDING_NAME_MAX_LENGTH + 10);
		const result = sanitizeRecordingName(long);
		expect(Array.from(result ?? "")).toHaveLength(RECORDING_NAME_MAX_LENGTH);
	});
});

describe("uniqueRecordingName", () => {
	it("keeps a free name", () => {
		expect(uniqueRecordingName("Aula", ["Outra"])).toBe("Aula");
	});

	it("numbers a taken name, without case", () => {
		expect(uniqueRecordingName("Aula", ["aula"])).toBe("Aula (2)");
		expect(uniqueRecordingName("Aula", ["AULA", "Aula (2)", "aula (3)"])).toBe("Aula (4)");
	});

	it("never collides with the folder being renamed", () => {
		expect(uniqueRecordingName("Aula", ["aula", "Outra"], "aula")).toBe("Aula");
	});

	it("keeps the numbered name within the length limit", () => {
		const desired = "a".repeat(RECORDING_NAME_MAX_LENGTH);
		const result = uniqueRecordingName(desired, [desired]);
		expect(result.endsWith(" (2)")).toBe(true);
		expect(result.length).toBe(RECORDING_NAME_MAX_LENGTH);
	});
});

describe("isAutomaticLabel", () => {
	const file = "C:\\V\\Aula\\recording-1.mp4";
	it("is true for no label, the file name and the folder's old name", () => {
		expect(isAutomaticLabel(undefined, file)).toBe(true);
		expect(isAutomaticLabel("", file)).toBe(true);
		expect(isAutomaticLabel("recording-1.mp4", file)).toBe(true);
		expect(isAutomaticLabel("Aula", file, "Aula")).toBe(true);
	});
	it("is false for a label the user typed", () => {
		expect(isAutomaticLabel("Aula", file)).toBe(false);
		expect(isAutomaticLabel("Abertura", file, "Aula")).toBe(false);
	});
});
