import { beforeEach, describe, expect, it } from "vitest";
import { DEFAULT_GLOSSARY } from "@/lib/ai-edition/transcription/glossary";
import { DEFAULT_VOCABULARY } from "@/lib/ai-edition/transcription/vocabulary";
import {
	DEFAULT_PREFS,
	effectiveTranscriptionLanguage,
	getProjectFolder,
	loadUserPreferences,
	parentDirectoryOf,
	saveUserPreferences,
} from "./userPreferences";

describe("parentDirectoryOf", () => {
	it("returns the directory for a POSIX path", () => {
		expect(parentDirectoryOf("/Users/me/Movies/clip.mp4")).toBe("/Users/me/Movies");
	});

	it("returns the directory for a Windows path", () => {
		expect(parentDirectoryOf("C:\\Users\\me\\Movies\\clip.mp4")).toBe("C:\\Users\\me\\Movies");
	});

	it("preserves the POSIX root when the file is at /", () => {
		expect(parentDirectoryOf("/video.mp4")).toBe("/");
	});

	it("preserves the Windows drive root with its trailing separator", () => {
		expect(parentDirectoryOf("C:\\video.mp4")).toBe("C:\\");
		expect(parentDirectoryOf("D:/video.mp4")).toBe("D:/");
	});

	it("returns null when no separator is present", () => {
		expect(parentDirectoryOf("video.mp4")).toBeNull();
		expect(parentDirectoryOf("")).toBeNull();
	});
});

describe("projectFolder preference", () => {
	// jsdom's localStorage isn't exposed as a global in this vitest setup, so
	// stub it with an in-memory shim before each test. Mirrors what the real
	// browser localStorage exposes, scoped to the keys we touch.
	beforeEach(() => {
		const store = new Map<string, string>();
		const stub = {
			getItem: (key: string) => store.get(key) ?? null,
			setItem: (key: string, value: string) => {
				store.set(key, String(value));
			},
			removeItem: (key: string) => {
				store.delete(key);
			},
			clear: () => store.clear(),
			key: (i: number) => Array.from(store.keys())[i] ?? null,
			get length() {
				return store.size;
			},
		};
		Object.defineProperty(globalThis, "localStorage", {
			value: stub,
			configurable: true,
		});
	});

	it("defaults to null when nothing is persisted", () => {
		expect(loadUserPreferences().projectFolder).toBeNull();
		expect(getProjectFolder()).toBeUndefined();
	});

	it("round-trips a saved project folder", () => {
		saveUserPreferences({ projectFolder: "/Users/me/Projects/demos" });
		expect(loadUserPreferences().projectFolder).toBe("/Users/me/Projects/demos");
		expect(getProjectFolder()).toBe("/Users/me/Projects/demos");
	});

	it("ignores non-string persisted values and falls back to the default", () => {
		localStorage.setItem("openscreen_user_preferences", JSON.stringify({ projectFolder: 42 }));
		expect(loadUserPreferences().projectFolder).toBe(DEFAULT_PREFS.projectFolder);
	});

	it("ignores empty-string persisted values and falls back to the default", () => {
		localStorage.setItem("openscreen_user_preferences", JSON.stringify({ projectFolder: "" }));
		expect(loadUserPreferences().projectFolder).toBe(DEFAULT_PREFS.projectFolder);
	});

	it("is independent of exportFolder", () => {
		saveUserPreferences({ exportFolder: "/Users/me/Downloads" });
		saveUserPreferences({ projectFolder: "/Users/me/Projects/demos" });
		const prefs = loadUserPreferences();
		expect(prefs.exportFolder).toBe("/Users/me/Downloads");
		expect(prefs.projectFolder).toBe("/Users/me/Projects/demos");
	});
});

describe("user preferences", () => {
	beforeEach(() => {
		localStorage.clear();
	});

	it("persists the tray layout preference", () => {
		saveUserPreferences({ trayLayout: "vertical" });

		expect(loadUserPreferences().trayLayout).toBe("vertical");
	});

	it("falls back to the default tray layout for invalid stored values", () => {
		localStorage.setItem("openscreen_user_preferences", JSON.stringify({ trayLayout: "diagonal" }));

		expect(loadUserPreferences().trayLayout).toBe("horizontal");
	});

	it("persists the software encoder preference", () => {
		saveUserPreferences({ preferSoftwareEncoder: true });

		expect(loadUserPreferences().preferSoftwareEncoder).toBe(true);
	});

	it("falls back to the default software encoder preference for invalid stored values", () => {
		localStorage.setItem(
			"openscreen_user_preferences",
			JSON.stringify({ preferSoftwareEncoder: "yes" }),
		);

		expect(loadUserPreferences().preferSoftwareEncoder).toBe(false);
	});

	it("persists the software encoder fallback notice suppression", () => {
		saveUserPreferences({ hideSoftwareEncoderFallbackNotice: true });

		expect(loadUserPreferences().hideSoftwareEncoderFallbackNotice).toBe(true);
	});

	it("falls back to showing the software encoder fallback notice for invalid stored values", () => {
		localStorage.setItem(
			"openscreen_user_preferences",
			JSON.stringify({ hideSoftwareEncoderFallbackNotice: "yes" }),
		);

		expect(loadUserPreferences().hideSoftwareEncoderFallbackNotice).toBe(false);
	});
});

describe("transcription preferences", () => {
	beforeEach(() => {
		const store = new Map<string, string>();
		Object.defineProperty(globalThis, "localStorage", {
			value: {
				getItem: (key: string) => store.get(key) ?? null,
				setItem: (key: string, value: string) => {
					store.set(key, String(value));
				},
				removeItem: (key: string) => {
					store.delete(key);
				},
				clear: () => store.clear(),
			},
			configurable: true,
		});
	});

	it("defaults to the automatic model, the app's language and the Microsoft and AI terms", () => {
		const prefs = loadUserPreferences();
		expect(prefs.transcriptionModel).toBe("auto");
		expect(prefs.transcriptionLanguage).toBeNull();
		expect(prefs.transcriptionVocabulary).toBe(DEFAULT_VOCABULARY);
	});

	it("transcribes in Portuguese while the app speaks it, and detects otherwise", () => {
		expect(effectiveTranscriptionLanguage({ transcriptionLanguage: null }, "pt-BR")).toBe("pt");
		expect(effectiveTranscriptionLanguage({ transcriptionLanguage: null }, "en")).toBe("auto");
		// With no stored locale the app is in pt-BR, its native language.
		expect(effectiveTranscriptionLanguage({ transcriptionLanguage: null })).toBe("pt");
		localStorage.setItem("openscreen-locale", "de");
		expect(effectiveTranscriptionLanguage({ transcriptionLanguage: null })).toBe("auto");
	});

	it("a language picked by the user wins, auto included", () => {
		saveUserPreferences({ transcriptionLanguage: "auto" });
		expect(effectiveTranscriptionLanguage(loadUserPreferences(), "pt-BR")).toBe("auto");
		saveUserPreferences({ transcriptionLanguage: "en" });
		expect(effectiveTranscriptionLanguage(loadUserPreferences(), "pt-BR")).toBe("en");
	});

	it("round-trips the model and the standing terms, and refuses unknown values", () => {
		saveUserPreferences({
			transcriptionModel: "large-v3-turbo",
			transcriptionVocabulary: "Contoso",
		});
		expect(loadUserPreferences().transcriptionModel).toBe("large-v3-turbo");
		expect(loadUserPreferences().transcriptionVocabulary).toBe("Contoso");
		localStorage.setItem(
			"openscreen_user_preferences",
			JSON.stringify({ transcriptionModel: "medium", transcriptionLanguage: "xx" }),
		);
		expect(loadUserPreferences().transcriptionModel).toBe("auto");
		expect(loadUserPreferences().transcriptionLanguage).toBeNull();
	});

	it("moves a stored glossary that is still an older default to the new one", () => {
		const shipped = DEFAULT_GLOSSARY.split("\n").filter(
			(line) =>
				!/^(Teams|Purview|Intune|Azure|Fabric|tenant|licença|ChatGPT|GPT|LLM|Claude|Model)/.test(
					line,
				),
		);
		localStorage.setItem(
			"openscreen_user_preferences",
			JSON.stringify({
				glossary: shipped
					.join("\n")
					.replace(", power automeit", "")
					.replace(", andrile, andraive", ""),
			}),
		);
		expect(loadUserPreferences().glossary).toBe(DEFAULT_GLOSSARY);
		saveUserPreferences({ glossary: "Contoso: contozo" });
		expect(loadUserPreferences().glossary).toBe("Contoso: contozo");
	});
});
