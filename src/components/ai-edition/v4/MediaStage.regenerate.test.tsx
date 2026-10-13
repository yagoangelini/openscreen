// @vitest-environment jsdom
// The Regenerate button is a bare refresh icon beside a language list. While a transcription runs
// it is greyed, but it stays focusable and hoverable so its tooltip still opens: a natively
// disabled button takes neither, which is what `aria-disabled` is for.

import "@testing-library/jest-dom";
import { act, cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const transcription = vi.hoisted(() => ({
	status: "idle" as "idle" | "running",
	request: vi.fn(),
}));

vi.mock("@/lib/ai-edition/store/transcriptionStore", async (importOriginal) => {
	const actual = await importOriginal<typeof import("@/lib/ai-edition/store/transcriptionStore")>();
	return {
		...actual,
		useAssetTranscriptions: () => ({
			"asset-1": { assetId: "asset-1", status: transcription.status },
		}),
		useTranscriptionStore: (select: (state: { request: unknown }) => unknown) =>
			select({ request: transcription.request }),
	};
});

// An echoing translator: the assertions read against keys, not prose that drifts with copy edits.
vi.mock("@/contexts/I18nContext", () => ({
	useI18n: () => ({ locale: "en", setLocale: vi.fn() }),
	useScopedT: () => (key: string) => key,
}));

vi.mock("sonner", () => ({ toast: { success: vi.fn(), error: vi.fn(), info: vi.fn() } }));

import { TooltipProvider } from "@/components/ui/tooltip";
import { readProjectOverrides } from "@/lib/ai-edition/projectTranscriptionSettings";
import { assetSchema, createEmptyDocument } from "@/lib/ai-edition/schema";
import { useProjectStore } from "@/lib/ai-edition/store/projectStore";
import { DEFAULT_VOCABULARY } from "@/lib/ai-edition/transcription/vocabulary";
import { loadUserPreferences } from "@/lib/userPreferences";
import { MediaStage } from "./MediaStage";

class StubResizeObserver {
	observe = vi.fn();
	unobserve = vi.fn();
	disconnect = vi.fn();
}

beforeEach(() => {
	vi.stubGlobal("ResizeObserver", StubResizeObserver);
	transcription.status = "idle";
	transcription.request.mockClear();
	const document = createEmptyDocument({ projectId: "p", title: "t" });
	useProjectStore.setState({
		projectId: "p",
		// No native bridge here: a save is the document landing in the store.
		saveDocument: async (next) => {
			useProjectStore.setState({ document: next });
			return true;
		},
		document: {
			...document,
			assets: [assetSchema.parse({ id: "asset-1", label: "take", originalPath: "/rec/take.mp4" })],
		},
	});
});

afterEach(() => {
	cleanup();
	localStorage.removeItem("openscreen_user_preferences");
	localStorage.setItem("openscreen-locale", "en");
	vi.unstubAllGlobals();
	useProjectStore.setState({ document: null });
});

async function openDetail() {
	render(
		<TooltipProvider>
			<MediaStage onAddToTimeline={vi.fn(async () => undefined)} />
		</TooltipProvider>,
	);
	fireEvent.click(await screen.findByRole("button", { name: /take/ }));
	return screen.findByRole("button", { name: "mediaStage.regenerate" });
}

describe("MediaStage Regenerate button", () => {
	it("asks for a new transcription, and says what it redoes in its tooltip", async () => {
		const regenerate = await openDetail();
		expect(regenerate).not.toHaveAttribute("title");
		// A keyboard focus: one the mouse gave opens no tooltip.
		fireEvent.keyDown(window, { key: "Tab" });
		act(() => regenerate.focus());
		expect((await screen.findByRole("tooltip")).textContent).toBe("mediaStage.regenerateTip");
		fireEvent.click(regenerate);
		await vi.waitFor(() => expect(transcription.request).toHaveBeenCalledWith("asset-1", "auto"));
	});

	it("stays focusable and keeps its tooltip while a transcription runs, and fires nothing", async () => {
		transcription.status = "running";
		const regenerate = await openDetail();

		// Greyed and announced as disabled, but not natively disabled.
		expect(regenerate).toHaveAttribute("aria-disabled", "true");
		expect(regenerate).not.toBeDisabled();
		expect(regenerate).toHaveStyle({ opacity: "0.6", cursor: "not-allowed" });
		expect(regenerate.querySelector("svg")).toHaveClass("animate-spin");

		// A keyboard focus: one the mouse gave opens no tooltip.
		fireEvent.keyDown(window, { key: "Tab" });
		act(() => regenerate.focus());
		expect(regenerate).toHaveFocus();
		expect((await screen.findByRole("tooltip")).textContent).toBe("mediaStage.regenerateTip");

		fireEvent.click(regenerate);
		expect(transcription.request).not.toHaveBeenCalled();
	});
});

// The settings follow the global defaults until the project changes one: the change is the
// project's own (`legacyEditor.projectOverrides`), and the defaults stay as they were.
describe("MediaStage transcription settings", () => {
	const overrides = () => readProjectOverrides(useProjectStore.getState().document);

	it("starts on the default language, and a pick is this project's for later runs", async () => {
		// The app speaks pt-BR: transcriptions default to Portuguese.
		localStorage.setItem("openscreen-locale", "pt-BR");
		const regenerate = await openDetail();
		const language = screen.getByDisplayValue(/Portuguese|português/i) as HTMLSelectElement;
		expect(language.value).toBe("pt");
		expect(screen.getByTestId("project-setting-language")).toHaveTextContent(
			"projectSettings.sourceDefault",
		);
		fireEvent.change(language, { target: { value: "en" } });
		await vi.waitFor(() => expect(overrides().transcriptionLanguage).toBe("en"));
		// The default did not move.
		expect(loadUserPreferences().transcriptionLanguage).toBeNull();
		expect(screen.getByTestId("project-setting-language")).toHaveTextContent(
			"projectSettings.sourceProject",
		);
		fireEvent.click(regenerate);
		await vi.waitFor(() => expect(transcription.request).toHaveBeenCalledWith("asset-1", "en"));
	});

	it("saves the model choice for this project, offering the sizes it will download", async () => {
		await openDetail();
		const model = screen.getByTestId("media-stage-model") as HTMLSelectElement;
		expect(model.value).toBe("auto");
		expect([...model.options].map((o) => o.value)).toEqual(["auto", "large-v3-turbo", "small"]);
		fireEvent.change(model, { target: { value: "small" } });
		await vi.waitFor(() => expect(overrides().transcriptionModel).toBe("small"));
		expect(loadUserPreferences().transcriptionModel).toBe("auto");
	});

	it("overrides the standing terms, then goes back to the default", async () => {
		await openDetail();
		const terms = screen.getByTestId("media-stage-standing-terms") as HTMLTextAreaElement;
		expect(terms.value).toBe(DEFAULT_VOCABULARY);
		expect(screen.queryByTestId("project-setting-standing-terms-reset")).toBeNull();
		fireEvent.change(terms, { target: { value: "Contoso, Fabrikam" } });
		fireEvent.blur(terms);
		await vi.waitFor(() => expect(overrides().transcriptionVocabulary).toBe("Contoso, Fabrikam"));
		expect(loadUserPreferences().transcriptionVocabulary).toBe(DEFAULT_VOCABULARY);
		fireEvent.click(await screen.findByTestId("project-setting-standing-terms-reset"));
		await vi.waitFor(() => expect(overrides().transcriptionVocabulary).toBeUndefined());
		await vi.waitFor(() =>
			expect((screen.getByTestId("media-stage-standing-terms") as HTMLTextAreaElement).value).toBe(
				DEFAULT_VOCABULARY,
			),
		);
	});

	it("adds glossary lines for this project and saves them as the default", async () => {
		await openDetail();
		const glossary = screen.getByTestId("media-stage-glossary") as HTMLTextAreaElement;
		expect(glossary.value).toBe("");
		fireEvent.change(glossary, { target: { value: "Contoso: contozo" } });
		fireEvent.blur(glossary);
		await vi.waitFor(() => expect(overrides().glossaryAdditions).toBe("Contoso: contozo"));
		expect(loadUserPreferences().glossary).not.toContain("Contoso");
		fireEvent.click(await screen.findByTestId("project-setting-glossary-promote"));
		await vi.waitFor(() => expect(overrides().glossaryAdditions).toBeUndefined());
		expect(loadUserPreferences().glossary.split("\n").at(-1)).toBe("Contoso: contozo");
	});
});
