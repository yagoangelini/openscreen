// @vitest-environment jsdom
// The Media tab's cards: a take in the open project shows once (the library's name, its real
// thumbnail, every file's size), any card opens the details, a take the project does not have
// offers to be added, imported media keeps its own card, and a drag shows the drop strip.

import "@testing-library/jest-dom";
import { cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("@/lib/ai-edition/store/transcriptionStore", async (importOriginal) => {
	const actual = await importOriginal<typeof import("@/lib/ai-edition/store/transcriptionStore")>();
	return {
		...actual,
		useAssetTranscriptions: () => ({}),
		useTranscriptionStore: (select: (state: { request: unknown }) => unknown) =>
			select({ request: vi.fn() }),
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
import { MediaStage } from "./MediaStage";

class StubResizeObserver {
	observe = vi.fn();
	unobserve = vi.fn();
	disconnect = vi.fn();
}

const TAKE = "C:\\Rec\\Aula 1\\recording-1791899316937.mp4";
const OTHER = "C:\\Rec\\Outra\\recording-1791899999999.mp4";
const recording = (name: string, screen: string, sizeBytes: number) => ({
	key: `folder:${name}`,
	kind: "folder",
	name,
	folderPath: screen.replace(/\\[^\\]+$/, ""),
	screenVideoPath: screen,
	files: [screen, screen.replace(".mp4", "-webcam.mp4")],
	sizeBytes,
	createdAt: 1791899316937,
	busy: false,
	projects: [],
});

const addAsset = vi.fn();

beforeEach(() => {
	vi.stubGlobal("ResizeObserver", StubResizeObserver);
	addAsset.mockReset();
	addAsset.mockImplementation(async (originalPath: string, label: string) => {
		const added = assetSchema.parse({ id: "asset-new", label, originalPath });
		const document = useProjectStore.getState().document;
		if (document) {
			useProjectStore.setState({ document: { ...document, assets: [...document.assets, added] } });
		}
		return added;
	});
	window.electronAPI = {
		recordingsLibraryList: async () => ({
			success: true,
			folder: "C:\\Rec",
			recordings: [recording("Outra", OTHER, 5_000_000), recording("Aula 1", TAKE, 12_000_000)],
		}),
		recordingsLibraryPreview: async (key: string) => ({
			success: true,
			durationSec: key === "folder:Aula 1" ? 4.7 : 9,
			thumbnailDataUrl: "data:image/jpeg;base64,AAAA",
		}),
		recordingsLibraryWatch: async () => ({ success: true }),
		onRecordingsLibraryChanged: () => () => undefined,
	} as unknown as typeof window.electronAPI;
	const document = createEmptyDocument({ projectId: "p", title: "t" });
	useProjectStore.setState({
		projectId: "p",
		addAsset,
		document: {
			...document,
			assets: [
				assetSchema.parse({
					id: "asset-1",
					label: "recording-1791899316937.mp4",
					originalPath: TAKE,
					sizeBytes: 3_000_000,
					durationSec: 4.7,
				}),
				assetSchema.parse({
					id: "asset-2",
					label: "intro.mp4",
					originalPath: "D:\\Clips\\intro.mp4",
					sizeBytes: 1000,
				}),
			],
		},
	});
});

afterEach(() => {
	cleanup();
	vi.unstubAllGlobals();
	(window as { electronAPI?: unknown }).electronAPI = undefined;
	useProjectStore.setState({ document: null });
});

function renderStage() {
	return render(
		<TooltipProvider>
			<MediaStage onAddToTimeline={vi.fn(async () => undefined)} />
		</TooltipProvider>,
	);
}

const cardNames = () => screen.getAllByTestId("media-card-name").map((node) => node.textContent);

describe("MediaStage cards", () => {
	it("shows the project's take once, under its library name, then imported media and the rest", async () => {
		renderStage();
		await waitFor(() => expect(cardNames()).toEqual(["Aula 1", "intro.mp4", "Outra"]));
		const cards = screen.getAllByTestId("media-card");
		expect(screen.queryAllByTestId("library-card")).toHaveLength(0);
		// The take's card: real thumbnail, every file's size, the "in this project" badge.
		await waitFor(() => expect(cards[0].querySelector("img")).not.toBeNull());
		expect(cards[0]).toHaveTextContent("library.usedHere");
		expect(cards[0]).toHaveTextContent("11 MB");
		expect(cards[0]).toHaveAttribute("data-in-project", "true");
		expect(within(cards[0]).getByTestId("library-delete")).toBeInTheDocument();
		// Imported media: its own card, no library actions.
		expect(within(cards[1]).queryByTestId("library-delete")).toBeNull();
		expect(cards[2]).toHaveAttribute("data-in-project", "false");
	});

	it("opens the details from the take's card", async () => {
		renderStage();
		fireEvent.click(await screen.findByRole("button", { name: /Aula 1/ }));
		const detail = await screen.findByTestId("media-detail");
		expect(detail).toHaveTextContent("mediaStage.sourceTranscript");
		expect(detail).toHaveTextContent("Aula 1");
	});

	it("offers to add a take the project does not have, and then shows its details", async () => {
		renderStage();
		fireEvent.click(await screen.findByRole("button", { name: /Outra/ }));
		const detail = await screen.findByTestId("media-detail");
		expect(detail).toHaveTextContent("mediaStage.notInProject");
		fireEvent.click(screen.getByTestId("media-detail-add-to-project"));
		await waitFor(() => expect(addAsset).toHaveBeenCalledWith(OTHER, "Outra"));
		await waitFor(() =>
			expect(screen.getByTestId("media-detail")).toHaveTextContent("mediaStage.sourceTranscript"),
		);
	});

	it("shows the drop strip only while a card is dragged", async () => {
		renderStage();
		const main = await screen.findByRole("button", { name: /intro\.mp4/ });
		expect(screen.queryByTestId("media-drop-zone")).toBeNull();
		const data = { setData: vi.fn(), effectAllowed: "" };
		fireEvent.dragStart(main, { dataTransfer: data });
		expect(data.setData).toHaveBeenCalledWith("application/x-axcut-asset", "asset-2");
		expect(screen.getByTestId("media-drop-zone")).toBeInTheDocument();
		fireEvent.dragEnd(main);
		expect(screen.queryByTestId("media-drop-zone")).toBeNull();
	});
});
