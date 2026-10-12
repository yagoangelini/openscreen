// @vitest-environment jsdom
// The auto-zoom settings switch every automatic zoom at once: the camera mode is one project
// setting, which the scene then applies to each automatic region.

import "@testing-library/jest-dom";
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { I18nProvider } from "@/contexts/I18nContext";
import { LOCALE_STORAGE_KEY } from "@/i18n/config";
import { createEmptyDocument } from "@/lib/ai-edition/schema";
import { getEditorSettings } from "@/lib/ai-edition/store/editorSettings";
import { useProjectStore } from "@/lib/ai-edition/store/projectStore";
import { buildSceneDescription } from "@/native/sceneDescription";
import { AutoZoomSettings } from "./AutoZoomSettings";

vi.mock("sonner", () => ({ toast: { error: vi.fn(), success: vi.fn(), info: vi.fn() } }));

beforeEach(() => {
	localStorage.clear();
	// The app starts in pt-BR; these assertions read the English copy.
	localStorage.setItem(LOCALE_STORAGE_KEY, "en");
	const base = createEmptyDocument({ title: "T", projectId: "p1" });
	useProjectStore.setState({
		document: {
			...base,
			zoomRanges: [
				{ id: "a", startMs: 0, endMs: 1000, depth: 2, focus: { cx: 0.5, cy: 0.5 }, source: "auto" },
				{
					id: "b",
					startMs: 4000,
					endMs: 5000,
					depth: 2,
					focus: { cx: 0.5, cy: 0.5 },
					source: "auto",
				},
			],
		},
	});
});
afterEach(() => {
	cleanup();
	localStorage.clear();
});

describe("AutoZoomSettings", () => {
	it("switches the camera of every automatic zoom at once", async () => {
		render(
			<I18nProvider>
				<AutoZoomSettings />
			</I18nProvider>,
		);
		expect(screen.getByText("Automatic zooms")).toBeInTheDocument();
		fireEvent.click(screen.getByRole("button", { name: "Hybrid" }));
		await waitFor(() =>
			expect(getEditorSettings(useProjectStore.getState().document).autoZoom.cameraMode).toBe(
				"hybrid",
			),
		);
		const document = useProjectStore.getState().document;
		if (!document) throw new Error("no document");
		expect(buildSceneDescription(document).zoomRegions.map((z) => z.focusMode)).toEqual([
			"auto",
			"auto",
		]);
	});
});
