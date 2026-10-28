// @vitest-environment jsdom
import "@testing-library/jest-dom";
import { act, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { type AxcutDocument, axcutSchemaVersion } from "@/lib/ai-edition/schema";
import { useProjectStore } from "@/lib/ai-edition/store/projectStore";
import { StemLanes } from "./StemLanes";

vi.mock("@/contexts/I18nContext", () => ({
	useScopedT: () => (key: string) => key,
	useI18n: () => ({ locale: "en", setLocale: () => undefined }),
}));
// No audio decoding in jsdom: the lanes draw without their waveforms.
vi.mock("@/hooks/useAudioPeaks", () => ({ useAudioPeaks: () => null }));

const createdAt = "2026-10-28T00:00:00.000Z";

function doc(over: Partial<AxcutDocument> = {}): AxcutDocument {
	return {
		schemaVersion: axcutSchemaVersion,
		project: { id: "p", title: "T", createdAt, updatedAt: createdAt },
		assets: [
			{
				id: "take",
				kind: "video",
				label: "take",
				originalPath: "/take.mp4",
				durationSec: 40,
				cameraTrack: null,
				audioStems: { voicePath: "/take.voice.m4a", systemPath: "/take.system.m4a" },
			},
		],
		transcript: null,
		transcripts: [],
		timeline: {
			clips: [
				{
					id: "c1",
					assetId: "take",
					sourceStartSec: 0,
					sourceEndSec: 40,
					timelineStartSec: 0,
					timelineEndSec: 40,
					wordRefs: [],
					origin: "user",
					reason: "",
				},
			],
			gaps: [],
			trimRanges: [],
			muteRanges: [],
			speedRanges: [],
			captionRanges: [],
		},
		annotations: [],
		zoomRanges: [],
		audioTracks: [],
		cameraSegments: [],
		legacyEditor: null,
		...over,
	};
}

const saveDocument = vi.fn(async (next: AxcutDocument) => {
	useProjectStore.setState({ document: next });
	return true;
});
const setDocument = vi.fn((next: AxcutDocument) => {
	useProjectStore.setState({ document: next });
});

beforeEach(() => {
	saveDocument.mockClear();
	setDocument.mockClear();
	useProjectStore.setState({
		projectId: "p",
		document: doc({
			audioStemMutes: [
				{
					id: "m1",
					assetId: "take",
					stem: "voice",
					startSec: 10,
					endSec: 12,
					fadeMs: 30,
					origin: "user",
				},
			],
		}),
		selectedStem: null,
		selectedAudioTrackId: null,
		saveDocument: saveDocument as never,
		setDocument: setDocument as never,
	});
});

afterEach(() => {
	useProjectStore.setState({ document: null, projectId: null, selectedStem: null });
});

// 10 px per second over a 40 s timeline: a ruler second is 2.5 %.
const props = { pctOf: (sec: number) => (sec / 40) * 100, pxPerSec: 10, visibleStartPct: 0 };

describe("StemLanes", () => {
	it("draws the microphone and the computer sound as two lanes, the stretch on its own lane", () => {
		render(<StemLanes {...props} />);
		expect(screen.getByTestId("stem-lane-voice")).toBeInTheDocument();
		expect(screen.getByTestId("stem-lane-system")).toBeInTheDocument();
		const pill = screen.getByTestId("stem-mute-voice");
		expect(pill.style.left).toBe("25%");
		expect(pill.style.width).toBe("5%");
		expect(screen.queryByTestId("stem-mute-system")).toBeNull();
	});

	it("shows nothing for a timeline without stems", () => {
		const plain = doc();
		plain.assets = plain.assets.map(({ audioStems: _s, ...rest }) => rest);
		useProjectStore.setState({ document: plain });
		const { container } = render(<StemLanes {...props} />);
		expect(container).toBeEmptyDOMElement();
	});

	it("selects a lane on click, and a stretch on a click on it", () => {
		render(<StemLanes {...props} />);
		fireEvent.click(screen.getByTestId("stem-lane-system"));
		expect(useProjectStore.getState().selectedStem).toEqual({ lane: "system", muteId: null });
		const pill = screen.getByTestId("stem-mute-voice");
		fireEvent.pointerDown(pill, { clientX: 100, pointerId: 1 });
		fireEvent.pointerUp(pill, { clientX: 101, pointerId: 1 });
		expect(useProjectStore.getState().selectedStem).toEqual({ lane: "voice", muteId: "m1" });
		expect(saveDocument).not.toHaveBeenCalled();
	});

	it("moves a stretch by its drag, in source seconds, as one write", async () => {
		render(<StemLanes {...props} />);
		const pill = screen.getByTestId("stem-mute-voice");
		await act(async () => {
			fireEvent.pointerDown(pill, { clientX: 100, pointerId: 1 });
			fireEvent.pointerMove(pill, { clientX: 150, pointerId: 1 });
			fireEvent.pointerUp(pill, { clientX: 150, pointerId: 1 });
		});
		expect(saveDocument).toHaveBeenCalledTimes(1);
		expect(useProjectStore.getState().document?.audioStemMutes?.[0]).toMatchObject({
			startSec: 15,
			endSec: 17,
		});
	});

	it("mutes a whole lane from its name chip", async () => {
		render(<StemLanes {...props} />);
		await act(async () => {
			fireEvent.click(screen.getByTestId("stem-lane-mute-system"));
		});
		const legacy = useProjectStore.getState().document?.legacyEditor as Record<string, unknown>;
		expect(legacy.systemMuted).toBe(true);
		expect(screen.getByTestId("stem-lane-system")).toHaveAttribute("data-muted", "true");
	});
});
