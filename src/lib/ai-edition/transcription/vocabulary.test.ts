import { describe, expect, it } from "vitest";

import { buildTranscriptionPrompt, DEFAULT_VOCABULARY, PROMPT_MAX_CHARS } from "./vocabulary";

describe("DEFAULT_VOCABULARY", () => {
	it("names the Microsoft 365 and AI terms of the user's tutorials, within the budget", () => {
		for (const term of [
			"Microsoft 365 Copilot",
			"Copilot Studio",
			"Power Automate",
			"SharePoint",
			"Dataverse",
			"Entra ID",
			"Azure OpenAI",
			"ChatGPT",
			"IA generativa",
			"MCP",
			"tenant",
		]) {
			expect(DEFAULT_VOCABULARY.split(", ")).toContain(term);
		}
		expect(DEFAULT_VOCABULARY.length).toBeLessThanOrEqual(PROMPT_MAX_CHARS);
	});
});

describe("buildTranscriptionPrompt", () => {
	it("puts the project's terms after the standing ones, nearest the audio", () => {
		expect(buildTranscriptionPrompt("Contoso, Yago", "SharePoint, Teams")).toBe(
			"SharePoint, Teams, Contoso, Yago",
		);
	});

	it("says each term once, whatever its case, keeping the project's spelling", () => {
		expect(buildTranscriptionPrompt("sharepoint, Contoso", "SharePoint, Teams")).toBe(
			"Teams, sharepoint, Contoso",
		);
	});

	it("reads commas, semicolons and lines, and drops a trailing full stop", () => {
		expect(buildTranscriptionPrompt("Contoso;\nFabrikam.", "Teams.\nOutlook")).toBe(
			"Teams, Outlook, Contoso, Fabrikam",
		);
	});

	it("is undefined when there is nothing to say", () => {
		expect(buildTranscriptionPrompt(undefined, "")).toBeUndefined();
		expect(buildTranscriptionPrompt("  ", " , ")).toBeUndefined();
	});

	it("keeps every project term and drops standing terms from the end to fit", () => {
		const project = Array.from({ length: 40 }, (_, i) => `Projeto${i}`).join(", ");
		const prompt = buildTranscriptionPrompt(project, DEFAULT_VOCABULARY) ?? "";
		expect(prompt.length).toBeLessThanOrEqual(PROMPT_MAX_CHARS);
		expect(prompt.endsWith(project)).toBe(true);
		// The first standing terms are the ones that stay.
		expect(prompt.startsWith("Microsoft 365, ")).toBe(true);
		expect(prompt).not.toContain("licença E3");
	});

	it("leaves the standing list whole when it fits", () => {
		expect(buildTranscriptionPrompt(undefined, DEFAULT_VOCABULARY)).toBe(DEFAULT_VOCABULARY);
	});
});
