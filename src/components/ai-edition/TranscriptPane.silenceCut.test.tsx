// @vitest-environment jsdom
// Cutting a `[silence]` chip in the transcript. It used to cut the whole gap, word end to
// word start, which glued the two words around it together; it now leaves the same breath
// next to the speech that a word cut does (`breatheCut`).

import "@testing-library/jest-dom";
import { cleanup, fireEvent, render } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { I18nProvider } from "@/contexts/I18nContext";
import type { AxcutAsset, AxcutClip, AxcutTranscript } from "@/lib/ai-edition/schema";
import { CUT_BREATH_SEC } from "@/lib/ai-edition/timeline/cut-breath";
import { TranscriptPane } from "./RightPanes";

vi.mock("@/native/client", () => ({ nativeBridgeClient: { aiEdition: {} } }));
vi.mock("sonner", () => ({ toast: { error: vi.fn() } }));

const ASSET: AxcutAsset = {
	id: "asset_1",
	kind: "video",
	label: "recording.mp4",
	originalPath: "/rec.mp4",
	durationSec: 6,
	cameraTrack: null,
};

const CLIP: AxcutClip = {
	id: "clip_1",
	assetId: "asset_1",
	sourceStartSec: 0,
	sourceEndSec: 6,
	timelineStartSec: 0,
	timelineEndSec: 6,
	wordRefs: [],
	origin: "user",
	reason: "",
};

// Two seconds of nothing between the words: a silence chip of its own.
const TRANSCRIPT: AxcutTranscript = {
	assetId: "asset_1",
	language: "pt",
	segments: [],
	words: [
		{ id: "w1", segmentId: "s", startSec: 0, endSec: 1, text: "olá" },
		{ id: "w2", segmentId: "s", startSec: 3, endSec: 4, text: "pessoal" },
	],
};

afterEach(() => cleanup());

describe("cutting a silence chip", () => {
	it("keeps breath next to the words on both sides", () => {
		const onTrimTimelineSpan = vi.fn();
		const { container } = render(
			<I18nProvider>
				<TranscriptPane
					clips={[CLIP]}
					audioTracks={[]}
					transcripts={[TRANSCRIPT]}
					assets={[ASSET]}
					trimRanges={[]}
					busyAssetIds={[]}
					onSeek={vi.fn()}
					onTrimTimelineSpan={onTrimTimelineSpan}
					onRemoveTrimRanges={vi.fn()}
					onSetWordText={vi.fn()}
					onInsertWord={vi.fn()}
					onRemoveWords={vi.fn()}
					onTranscribe={vi.fn()}
					canTranscribe
					isTranscribing={false}
				/>
			</I18nProvider>,
		);
		const chip = container.querySelector<HTMLElement>('[data-silence="true"]');
		if (!chip) throw new Error("silence chip not rendered");
		fireEvent.click(chip);
		expect(onTrimTimelineSpan).toHaveBeenCalledTimes(1);
		const [startSec, endSec] = onTrimTimelineSpan.mock.calls[0];
		expect(startSec).toBeCloseTo(1 + CUT_BREATH_SEC, 6);
		expect(endSec).toBeCloseTo(3 - CUT_BREATH_SEC, 6);
	});
});
