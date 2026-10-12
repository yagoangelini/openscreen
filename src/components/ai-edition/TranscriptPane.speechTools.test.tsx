// @vitest-environment jsdom
// The transcript pane's "Limpar fala" review list and its speaker labels.

import "@testing-library/jest-dom";
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { I18nProvider } from "@/contexts/I18nContext";
import {
	type AxcutAsset,
	type AxcutClip,
	type AxcutTranscript,
	createEmptyDocument,
} from "@/lib/ai-edition/schema";
import { useProjectStore } from "@/lib/ai-edition/store/projectStore";
import { TranscriptPane } from "./RightPanes";

vi.mock("@/native/client", () => ({ nativeBridgeClient: { aiEdition: {} } }));
vi.mock("sonner", () => ({ toast: { error: vi.fn(), info: vi.fn(), success: vi.fn() } }));

const ASSET: AxcutAsset = {
	id: "asset_1",
	kind: "video",
	label: "call.mp4",
	originalPath: "/call.mp4",
	durationSec: 12,
	cameraTrack: null,
	audioStems: { voicePath: "/call.voice.m4a", systemPath: "/call.system.m4a" },
};

const CLIP: AxcutClip = {
	id: "clip_1",
	assetId: "asset_1",
	sourceStartSec: 0,
	sourceEndSec: 12,
	timelineStartSec: 0,
	timelineEndSec: 12,
	wordRefs: [],
	origin: "user",
	reason: "",
};

const spoken: Array<[string, number, number, "mic" | "system"]> = [
	["Abre", 0, 0.4, "mic"],
	["né", 0.5, 0.7, "mic"],
	["o", 0.8, 0.9, "mic"],
	["Teams.", 0.95, 1.4, "mic"],
	["Oi,", 4.0, 4.4, "system"],
	["tudo", 4.5, 4.8, "system"],
	["bem?", 4.85, 5.2, "system"],
	["Vamos", 5.6, 5.9, "mic"],
	["lá.", 5.95, 6.3, "mic"],
];

const TRANSCRIPT: AxcutTranscript = {
	assetId: "asset_1",
	language: "pt",
	segments: [],
	words: spoken.map(([text, startSec, endSec, speaker], i) => ({
		id: `w${i}`,
		segmentId: "s",
		startSec,
		endSec,
		text,
		speaker,
	})),
};

function renderPane(props: Partial<Parameters<typeof TranscriptPane>[0]> = {}) {
	return render(
		<I18nProvider>
			<TranscriptPane
				clips={[CLIP]}
				audioTracks={[]}
				transcripts={[TRANSCRIPT]}
				assets={[ASSET]}
				trimRanges={[]}
				busyAssetIds={[]}
				onSeek={vi.fn()}
				onTrimTimelineSpan={vi.fn()}
				onRemoveTrimRanges={vi.fn()}
				onSetWordText={vi.fn()}
				onInsertWord={vi.fn()}
				onRemoveWords={vi.fn()}
				onTranscribe={vi.fn()}
				canTranscribe
				isTranscribing={false}
				{...props}
			/>
		</I18nProvider>,
	);
}

beforeEach(() => {
	const base = createEmptyDocument({ projectId: "p", title: "t" });
	useProjectStore.setState({
		document: {
			...base,
			assets: [ASSET],
			transcripts: [TRANSCRIPT],
			timeline: { ...base.timeline, clips: [CLIP] },
		},
	});
});

afterEach(() => {
	cleanup();
	useProjectStore.getState().clear();
});

describe("speaker labels in the transcript", () => {
	it("mark each change of speaker, and only the changes", () => {
		const { container } = renderPane();
		const labels = [...container.querySelectorAll<HTMLElement>("[data-speaker-label]")];
		expect(labels.map((l) => [l.dataset.speakerLabel, l.textContent])).toEqual([
			["mic", "You"],
			["system", "Guest"],
			["mic", "You"],
		]);
		// Not words: nothing a cut or the caret could land on.
		for (const label of labels) expect(label).not.toHaveAttribute("data-word-id");
	});
});

describe("'Limpar fala' in the transcript pane", () => {
	it("is absent without a handler", () => {
		renderPane();
		expect(screen.queryByTestId("speech-cleanup-open")).toBeNull();
	});

	it("lists what it would cut and applies only what stays ticked", () => {
		const onApply = vi.fn();
		renderPane({ onApplySpeechCleanup: onApply });
		fireEvent.click(screen.getByTestId("speech-cleanup-open"));
		const items = screen.getAllByTestId("speech-cleanup-item");
		// "né", the 2.6 s silence before the guest.
		expect(items.map((i) => i.dataset.kind)).toEqual(["filler", "silence"]);
		expect(items[0]).toHaveTextContent("né");
		fireEvent.click(items[1].querySelector("input") as HTMLInputElement);
		expect(screen.getByTestId("speech-cleanup-summary")).toHaveTextContent("1 of 2 picked");
		fireEvent.click(screen.getByTestId("speech-cleanup-apply"));
		expect(onApply).toHaveBeenCalledTimes(1);
		const [ids, options] = onApply.mock.calls[0];
		expect(ids).toEqual(["clip_1:500"]);
		expect(options).toMatchObject({ aggressive: false, silenceMinSec: 0.8 });
		// Back to the transcript.
		expect(screen.queryByTestId("speech-cleanup")).toBeNull();
	});
});
