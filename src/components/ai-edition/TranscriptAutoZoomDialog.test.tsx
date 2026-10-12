// @vitest-environment jsdom
import { act, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("@/contexts/I18nContext", () => ({
	useScopedT: () => (key: string, vars?: Record<string, unknown>) =>
		vars ? `${key} ${JSON.stringify(vars)}` : key,
}));
vi.mock("sonner", () => ({
	toast: { error: vi.fn(), success: vi.fn(), info: vi.fn(), warning: vi.fn() },
}));
const replanAutoZooms = vi.fn(async () => 3);
vi.mock("./autoZoomReplan", () => ({ replanAutoZooms: () => replanAutoZooms() }));
const handOff = vi.fn();
vi.mock("./recordingImport", () => ({
	handFreshRecordingAutoZoomsToTranscript: () => handOff(),
	whenAssetDurationProbed: async () => true,
}));
const request = vi.fn(async (_assetId: string, _language: string) => undefined);
vi.mock("@/lib/ai-edition/store/transcriptionStore", () => ({
	useTranscriptionStore: Object.assign(
		(select: (s: { jobs: Record<string, unknown> }) => unknown) => select({ jobs: {} }),
		{ getState: () => ({ request }) },
	),
}));
vi.mock("@/lib/ai-edition/store/projectStore", () => ({
	useProjectStore: Object.assign(
		(select: (s: { document: null }) => unknown) => select({ document: null }),
		{ getState: () => ({ document: null }) },
	),
}));
vi.mock("@/lib/ai-edition/transcription/status", () => ({
	findAssetTranscript: () => ({ words: [] }),
}));

import {
	estimateTranscription,
	formatRemaining,
	TranscriptAutoZoomDialog,
} from "./TranscriptAutoZoomDialog";

describe("estimateTranscription", () => {
	it("moves on between the engine's reports, never past the end", () => {
		const early = estimateTranscription({
			totalSec: 300,
			completedSec: 0,
			rtf: 0.1,
			elapsedSec: 6,
		});
		expect(early.fraction).toBeCloseTo(0.2, 5);
		expect(early.remainingSec).toBeCloseTo(24, 5);
		const late = estimateTranscription({
			totalSec: 300,
			completedSec: 90,
			rtf: 0.1,
			elapsedSec: 90,
		});
		expect(late.fraction).toBeLessThan(1);
	});

	it("formats what is left", () => {
		expect(formatRemaining(42.4)).toBe("42 s");
		expect(formatRemaining(125)).toBe("2 min 05 s");
	});
});

describe("TranscriptAutoZoomDialog", () => {
	beforeEach(() => {
		localStorage.clear();
		replanAutoZooms.mockClear();
		handOff.mockClear();
		request.mockClear();
	});

	it("transcribes, then plans the zooms, then hands the editor back", async () => {
		const onClose = vi.fn();
		render(<TranscriptAutoZoomDialog offer={{ assetId: "a1" }} onClose={onClose} />);
		await act(async () => {
			fireEvent.click(screen.getByTestId("transcript-autozoom-yes"));
		});
		await waitFor(() => expect(onClose).toHaveBeenCalled());
		expect(handOff).toHaveBeenCalled();
		// No language: the store's default (Portuguese while the app speaks it).
		expect(request).toHaveBeenCalledWith("a1");
		expect(replanAutoZooms).toHaveBeenCalled();
	});

	it("leaves the zooms to the cursor when the answer is no, and remembers it if asked", () => {
		const onClose = vi.fn();
		render(<TranscriptAutoZoomDialog offer={{ assetId: "a1" }} onClose={onClose} />);
		fireEvent.click(screen.getByRole("checkbox"));
		fireEvent.click(screen.getByTestId("transcript-autozoom-no"));
		expect(onClose).toHaveBeenCalled();
		expect(request).not.toHaveBeenCalled();
		expect(JSON.parse(localStorage.getItem("openscreen_user_preferences") ?? "{}")).toMatchObject({
			autoZoomAfterRecording: "cursor",
		});
	});

	it("skips the question when the user chose the transcript for good", async () => {
		localStorage.setItem(
			"openscreen_user_preferences",
			JSON.stringify({ autoZoomAfterRecording: "transcript" }),
		);
		const onClose = vi.fn();
		render(<TranscriptAutoZoomDialog offer={{ assetId: "a1" }} onClose={onClose} />);
		await waitFor(() => expect(onClose).toHaveBeenCalled());
		expect(request).toHaveBeenCalled();
		expect(screen.queryByTestId("transcript-autozoom-yes")).toBeNull();
	});
});
