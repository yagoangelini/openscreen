// @vitest-environment jsdom
// The "Padrões" dialog: the global defaults, edited with the editor's own controls.

import "@testing-library/jest-dom";
import { cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { TooltipProvider } from "@/components/ui/tooltip";
import { EditorDialogsProvider } from "@/contexts/EditorDialogsContext";
import { I18nProvider } from "@/contexts/I18nContext";
import { LOCALE_STORAGE_KEY } from "@/i18n/config";
import { loadEditorDefaults } from "@/lib/ai-edition/editorDefaultsStore";
import { createEmptyDocument } from "@/lib/ai-edition/schema";
import { useProjectStore } from "@/lib/ai-edition/store/projectStore";
import { DEFAULT_GLOSSARY } from "@/lib/ai-edition/transcription/glossary";
import { loadUserPreferences } from "@/lib/userPreferences";
import { DefaultsDialog } from "./DefaultsDialog";

vi.mock("sonner", () => ({ toast: { error: vi.fn(), success: vi.fn(), info: vi.fn() } }));
vi.mock("@/native/client", () => ({
	nativeBridgeClient: {
		presets: { list: vi.fn(async () => []), setForNewProjects: vi.fn(async () => ({})) },
	},
}));

function mount() {
	return render(
		<I18nProvider>
			<EditorDialogsProvider>
				<TooltipProvider>
					<DefaultsDialog open onClose={() => undefined} />
				</TooltipProvider>
			</EditorDialogsProvider>
		</I18nProvider>,
	);
}

beforeEach(() => {
	localStorage.clear();
	localStorage.setItem(LOCALE_STORAGE_KEY, "en");
	vi.stubGlobal(
		"ResizeObserver",
		class {
			observe = () => undefined;
			unobserve = () => undefined;
			disconnect = () => undefined;
		},
	);
	useProjectStore.setState({
		projectId: "p",
		document: {
			...createEmptyDocument({ projectId: "p", title: "Open" }),
			legacyEditor: { padding: 12, cursorSize: 4 },
		},
	});
});

afterEach(() => {
	cleanup();
	localStorage.clear();
	vi.unstubAllGlobals();
	useProjectStore.setState({ document: null, projectId: null });
});

describe("DefaultsDialog", () => {
	it("starts the glossary on the built-in list, saves an edit and restores the list", async () => {
		mount();
		const glossary = screen.getByTestId("defaults-glossary") as HTMLTextAreaElement;
		expect(glossary.value).toBe(DEFAULT_GLOSSARY);
		fireEvent.change(glossary, { target: { value: "Contoso: contozo" } });
		fireEvent.blur(glossary);
		expect(loadUserPreferences().glossary).toBe("Contoso: contozo");
		fireEvent.click(screen.getByTestId("defaults-glossary-reset"));
		expect(loadUserPreferences().glossary).toBe(DEFAULT_GLOSSARY);
		expect(glossary.value).toBe(DEFAULT_GLOSSARY);
	});

	it("edits the defaults, not the open project, through the editor's own panes", async () => {
		mount();
		fireEvent.click(screen.getByTestId("defaults-tab-look"));
		expect(screen.getByTestId("defaults-look-unset")).toBeInTheDocument();
		const style = await screen.findByRole("group", { name: "Style" });
		fireEvent.click(within(style).getByRole("button", { name: "Laptop" }));
		await waitFor(() => expect(loadEditorDefaults()?.frame).toBe("laptop"));
		// The project on screen is untouched.
		expect(useProjectStore.getState().document?.legacyEditor).toEqual({
			padding: 12,
			cursorSize: 4,
		});
		expect(screen.queryByTestId("defaults-look-unset")).toBeNull();
	});

	it("copies the open project's settings into the defaults, and forgets them on reset", async () => {
		mount();
		fireEvent.click(screen.getByTestId("defaults-tab-look"));
		fireEvent.click(screen.getByTestId("defaults-look-from-project"));
		expect(loadEditorDefaults()).toMatchObject({ padding: 12, cursorSize: 4 });
		fireEvent.click(screen.getByTestId("defaults-look-reset"));
		expect(loadEditorDefaults()).toBeNull();
	});

	it("saves the export defaults the export dialog opens with", () => {
		mount();
		fireEvent.click(screen.getByTestId("defaults-tab-export"));
		fireEvent.change(screen.getByTestId("defaults-export-fps"), { target: { value: "30" } });
		fireEvent.change(screen.getByTestId("defaults-export-quality"), {
			target: { value: "source" },
		});
		expect(loadUserPreferences().exportFps).toBe(30);
		expect(loadUserPreferences().exportQuality).toBe("source");
	});
});
