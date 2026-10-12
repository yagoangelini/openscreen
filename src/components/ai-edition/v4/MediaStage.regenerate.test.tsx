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

describe("MediaStage transcription settings", () => {
	it("starts on the default language and remembers a new pick for later runs", async () => {
		// The app speaks pt-BR: transcriptions default to Portuguese.
		localStorage.setItem("openscreen-locale", "pt-BR");
		const regenerate = await openDetail();
		const language = screen.getByDisplayValue(/Portuguese|português/i) as HTMLSelectElement;
		expect(language.value).toBe("pt");
		fireEvent.change(language, { target: { value: "en" } });
		expect(loadUserPreferences().transcriptionLanguage).toBe("en");
		fireEvent.click(regenerate);
		await vi.waitFor(() => expect(transcription.request).toHaveBeenCalledWith("asset-1", "en"));
	});

	it("saves the model choice, offering the sizes it will download", async () => {
		await openDetail();
		const model = screen.getByTestId("media-stage-model") as HTMLSelectElement;
		expect(model.value).toBe("auto");
		expect([...model.options].map((o) => o.value)).toEqual(["auto", "large-v3-turbo", "small"]);
		fireEvent.change(model, { target: { value: "small" } });
		expect(loadUserPreferences().transcriptionModel).toBe("small");
	});

	it("edits the standing terms and restores the default list", async () => {
		await openDetail();
		const terms = screen.getByTestId("media-stage-standing-terms") as HTMLTextAreaElement;
		const reset = screen.getByTestId("media-stage-standing-terms-reset");
		expect(terms.value).toBe(DEFAULT_VOCABULARY);
		expect(reset).toBeDisabled();
		fireEvent.change(terms, { target: { value: "Contoso, Fabrikam" } });
		fireEvent.blur(terms);
		expect(loadUserPreferences().transcriptionVocabulary).toBe("Contoso, Fabrikam");
		fireEvent.click(reset);
		expect(terms.value).toBe(DEFAULT_VOCABULARY);
		expect(loadUserPreferences().transcriptionVocabulary).toBe(DEFAULT_VOCABULARY);
	});
});
