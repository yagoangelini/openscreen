import { describe, expect, it } from "vitest";
import { DEFAULT_PREFS } from "../userPreferences";
import {
	mergeGlossary,
	mergeTermLists,
	PROJECT_OVERRIDES_KEY,
	promoteOverrideToDefault,
	readProjectOverrides,
	resolveProjectTranscriptionSettings,
	withProjectOverrides,
} from "./projectTranscriptionSettings";
import { createEmptyDocument } from "./schema";
import { DEFAULT_GLOSSARY } from "./transcription/glossary";
import { DEFAULT_VOCABULARY } from "./transcription/vocabulary";

const doc = () => createEmptyDocument({ projectId: "p", title: "t" });
const prefs = { ...DEFAULT_PREFS };

describe("the default glossary", () => {
	it("is seeded with the built-in M365 and AI list", () => {
		expect(DEFAULT_PREFS.glossary).toBe(DEFAULT_GLOSSARY);
		expect(DEFAULT_PREFS.transcriptionVocabulary).toBe(DEFAULT_VOCABULARY);
		expect(DEFAULT_GLOSSARY).toContain("SharePoint:");
		expect(DEFAULT_GLOSSARY).toContain("Copilot Studio:");
	});
});

describe("mergeGlossary", () => {
	it("adds the project's lines after the defaults", () => {
		expect(mergeGlossary("A: a\nB: b", "C: c")).toBe("A: a\nB: b\nC: c");
	});

	it("replaces the default line for a term the project redefines, ignoring case", () => {
		expect(mergeGlossary("Teams: tims\nOutlook: autlook", "teams: timz, times")).toBe(
			"Outlook: autlook\nteams: timz, times",
		);
	});

	it("leaves the defaults as they are with nothing added", () => {
		expect(mergeGlossary(DEFAULT_GLOSSARY, undefined)).toBe(DEFAULT_GLOSSARY);
		expect(mergeGlossary(DEFAULT_GLOSSARY, "  \n ")).toBe(DEFAULT_GLOSSARY);
	});

	it("keeps comment lines", () => {
		expect(mergeGlossary("# products\nA: a", "# mine\nA: x")).toBe("# products\n# mine\nA: x");
	});
});

describe("mergeTermLists", () => {
	it("is the default words plus the project's", () => {
		expect(mergeTermLists("Contoso", "Fabrikam\n4021")).toBe("Contoso\nFabrikam\n4021");
		expect(mergeTermLists("", "Fabrikam")).toBe("Fabrikam");
		expect(mergeTermLists("Contoso", undefined)).toBe("Contoso");
	});
});

describe("resolveProjectTranscriptionSettings", () => {
	it("follows the defaults for a project with no overrides, as every older project is", () => {
		const resolved = resolveProjectTranscriptionSettings(doc(), prefs, "pt-BR");
		expect(resolved.glossary).toBe(DEFAULT_GLOSSARY);
		expect(resolved.transcriptionVocabulary).toBe(DEFAULT_VOCABULARY);
		expect(resolved.transcriptionLanguage).toBe("pt");
		expect(resolved.transcriptionModel).toBe("auto");
		expect(resolved.autoRedact).toBe(true);
		expect(Object.values(resolved.sources).every((s) => s === "default")).toBe(true);
	});

	it("follows a change of the defaults, for every project that did not override", () => {
		const resolved = resolveProjectTranscriptionSettings(
			doc(),
			{ ...prefs, transcriptionModel: "small", glossary: "X: x" },
			"pt-BR",
		);
		expect(resolved.transcriptionModel).toBe("small");
		expect(resolved.glossary).toBe("X: x");
	});

	it("takes the project's own value where it set one, and says so", () => {
		const project = withProjectOverrides(doc(), {
			transcriptionLanguage: "en",
			transcriptionModel: "large-v3-turbo",
			transcribeGuestAudio: true,
			autoRedact: false,
			glossaryAdditions: "Contoso: contozo",
			autoRedactTermsAdditions: "Fabrikam",
		});
		const resolved = resolveProjectTranscriptionSettings(
			project,
			{ ...prefs, autoRedactTerms: "Northwind" },
			"pt-BR",
		);
		expect(resolved.transcriptionLanguage).toBe("en");
		expect(resolved.transcriptionModel).toBe("large-v3-turbo");
		expect(resolved.transcribeGuestAudio).toBe(true);
		expect(resolved.autoRedact).toBe(false);
		expect(resolved.glossary.endsWith("\nContoso: contozo")).toBe(true);
		expect(resolved.glossary.startsWith(DEFAULT_GLOSSARY.split("\n")[0])).toBe(true);
		expect(resolved.autoRedactTerms).toBe("Northwind\nFabrikam");
		expect(resolved.sources.transcriptionLanguage).toBe("project");
		expect(resolved.sources.transcriptionVocabulary).toBe("default");
	});
});

describe("withProjectOverrides", () => {
	it("stores an override, and removing the last one leaves legacyEditor as it was", () => {
		const base = { ...doc(), legacyEditor: { padding: 30 } };
		const set = withProjectOverrides(base, { transcriptionModel: "small" });
		expect(set.legacyEditor).toEqual({
			padding: 30,
			[PROJECT_OVERRIDES_KEY]: { transcriptionModel: "small" },
		});
		const reset = withProjectOverrides(set, { transcriptionModel: undefined });
		expect(reset.legacyEditor).toEqual({ padding: 30 });
	});

	it("drops an empty list addition", () => {
		const set = withProjectOverrides(doc(), { glossaryAdditions: "  " });
		expect(readProjectOverrides(set)).toEqual({});
	});

	it("reads past a malformed value without losing the others", () => {
		const raw = {
			...doc(),
			legacyEditor: {
				[PROJECT_OVERRIDES_KEY]: {
					transcriptionModel: "huge",
					autoRedact: "yes",
					glossaryAdditions: "A",
				},
			},
		};
		expect(readProjectOverrides(raw)).toEqual({ glossaryAdditions: "A" });
		expect(readProjectOverrides({ legacyEditor: null })).toEqual({});
	});
});

describe("promoteOverrideToDefault", () => {
	it("folds the project's glossary lines into the default and clears them on the project", () => {
		const project = withProjectOverrides(doc(), { glossaryAdditions: "Contoso: contozo" });
		const result = promoteOverrideToDefault(project, "glossaryAdditions", {
			...prefs,
			glossary: "A: a",
		});
		expect(result?.prefs).toEqual({ glossary: "A: a\nContoso: contozo" });
		expect(readProjectOverrides(result?.document)).toEqual({});
	});

	it("makes a plain value the default", () => {
		const project = withProjectOverrides(doc(), { transcriptionLanguage: "en" });
		const result = promoteOverrideToDefault(project, "transcriptionLanguage", prefs);
		expect(result?.prefs).toEqual({ transcriptionLanguage: "en" });
		expect(
			resolveProjectTranscriptionSettings(result?.document, { ...prefs, ...result?.prefs }).sources
				.transcriptionLanguage,
		).toBe("default");
	});

	it("has nothing to promote on a value that already is the default", () => {
		expect(promoteOverrideToDefault(doc(), "autoRedact", prefs)).toBeNull();
	});
});
