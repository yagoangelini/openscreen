// @vitest-environment jsdom
import "@testing-library/jest-dom";
import { act, cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";

// The magnet is a screen-pixel rule, so the panel needs a size: 900 px over a 100 s timeline
// is 9 px a second, and the 8 px radius is 0.889 s.
const VIEWPORT_PX = 900;
const TOTAL_SEC = 100;
const PX_PER_SEC = VIEWPORT_PX / TOTAL_SEC;
// Where a scrub leaves the playhead: any float, not a whole ms.
const PLAYHEAD_SEC = 30.4567891;

vi.mock("@/contexts/I18nContext", () => ({
	useScopedT: () => (key: string) => key,
}));
vi.mock("sonner", () => ({ toast: { error: vi.fn(), info: vi.fn(), success: vi.fn() } }));
vi.mock("@/hooks/useAudioPeaks", () => ({ useAudioPeaks: () => null }));

import { ShortcutsProvider } from "@/contexts/ShortcutsContext";
import { useProjectStore } from "@/lib/ai-edition/store/projectStore";
import type { useTimeline } from "@/lib/ai-edition/store/useTimeline";
import { V4Timeline } from "./V4Timeline";

beforeAll(() => {
	globalThis.ResizeObserver = class {
		observe() {
			/* noop */
		}
		unobserve() {
			/* noop */
		}
		disconnect() {
			/* noop */
		}
	} as unknown as typeof ResizeObserver;
	Object.defineProperty(HTMLElement.prototype, "clientWidth", {
		configurable: true,
		get: () => VIEWPORT_PX,
	});
	Object.defineProperty(HTMLElement.prototype, "getBoundingClientRect", {
		configurable: true,
		value: () => ({
			x: 0,
			y: 0,
			left: 0,
			top: 0,
			right: VIEWPORT_PX,
			bottom: 100,
			width: VIEWPORT_PX,
			height: 100,
			toJSON() {
				/* unused */
			},
		}),
	});
	vi.spyOn(HTMLCanvasElement.prototype, "getContext").mockImplementation(
		() =>
			({
				measureText: (text: string) => ({ width: text.length * 6 }),
			}) as unknown as CanvasRenderingContext2D,
	);
});

beforeEach(() => {
	useProjectStore.setState({ currentTimeSec: PLAYHEAD_SEC });
});

afterEach(() => {
	cleanup();
	useProjectStore.setState({ currentTimeSec: 0 });
});

function clip(startSec: number, endSec: number) {
	return {
		id: `c@${startSec}`,
		assetId: "a1",
		timelineStartSec: startSec,
		timelineEndSec: endSec,
		sourceStartSec: startSec,
		sourceEndSec: endSec,
	};
}

const ASSET = { id: "a1", label: "rec", durationSec: TOTAL_SEC };
const AUDIO_ASSET = { id: "aud", label: "voiceover", originalPath: "/vo.mp3", durationSec: 30 };
const CAMERA_ASSET = {
	...ASSET,
	cameraTrack: { sourcePath: "/tmp/cam.webm", startMs: 0, offsetMs: 0, visible: true },
};

function renderTimeline(overrides: Record<string, unknown> = {}) {
	const asyncNoop = () => vi.fn(async (..._args: unknown[]) => undefined);
	const tl = {
		clips: [clip(0, TOTAL_SEC)],
		transcripts: [],
		assets: [ASSET],
		annotationRegions: [{ id: "ann1", startMs: 10_000, endMs: 20_000 }],
		speedRegions: [],
		cameraFullscreenRegions: [],
		cameraPieces: [],
		zoomRegions: [],
		trimRanges: [],
		hasEditRegions: true,
		selection: null,
		multiSelection: [],
		clipSelection: null,
		audioTracks: [],
		selectedAudioTrackId: null,
		selectAudioTrack: vi.fn(),
		clearSelection: vi.fn(),
		selectRegion: vi.fn(),
		selectClip: vi.fn(),
		updateAnnotationSpan: asyncNoop(),
		updateZoomSpan: asyncNoop(),
		updateSpeedSpan: asyncNoop(),
		setTrimEntries: asyncNoop(),
		moveCameraEdge: asyncNoop(),
		placeAudioTrack: asyncNoop(),
		...overrides,
	};
	const view = render(
		<ShortcutsProvider>
			<V4Timeline
				tl={tl as unknown as ReturnType<typeof useTimeline>}
				setCurrentTime={vi.fn()}
				playing={false}
				onTogglePlay={vi.fn()}
				onEditClip={vi.fn()}
				onAddVoiceover={vi.fn()}
			/>
		</ShortcutsProvider>,
	);
	return { tl, container: view.container };
}

const px = (sec: number) => sec * PX_PER_SEC;
const pillOf = (container: HTMLElement, lane: string) =>
	container.querySelector(`[class*="lanePill"][class*="${lane}"]`) as HTMLElement;
const handles = (pill: HTMLElement) =>
	Array.from(pill.querySelectorAll<HTMLElement>('[class*="lanePillHandle"]'));
const playhead = () => screen.getByTestId("timeline-playhead");

/** Press on `el`, move by `dxPx` (with Alt, maybe), and keep the drag open. */
function pressAndMove(el: Element, dxPx: number, altKey = false) {
	fireEvent.pointerDown(el, { clientX: 0, clientY: 40 });
	act(() => {
		window.dispatchEvent(new MouseEvent("pointermove", { clientX: dxPx, clientY: 40, altKey }));
	});
}
/** Let go, and let the (mocked) write settle: the pill keeps its live drag geometry until it
 *  has, and the next grab would start from there. */
async function release(dxPx: number) {
	await act(async () => {
		window.dispatchEvent(new MouseEvent("pointerup", { clientX: dxPx, clientY: 40 }));
	});
}

describe("V4Timeline snapping: the playhead", () => {
	it("locks a resized annotation's end onto the playhead, lights it, and writes it once", async () => {
		const { container, tl } = renderTimeline();
		const [, right] = handles(pillOf(container, "laneAnnotation"));
		// 20 s + 93 px = 30.33 s: 1.1 px short of the playhead, well inside 8 px.
		pressAndMove(right, 93);
		expect(playhead()).toHaveAttribute("data-snapped", "true");
		expect(screen.getByTestId("timeline-snap-tip")).toHaveTextContent("snap.playhead");
		// The playhead lights instead of a second line drawn over it.
		expect(screen.queryByTestId("timeline-snap-guide")).not.toBeInTheDocument();
		await release(93);
		expect(tl.updateAnnotationSpan).toHaveBeenCalledTimes(1);
		expect(tl.updateAnnotationSpan).toHaveBeenCalledWith("ann1", 10_000, PLAYHEAD_SEC * 1000);
		// The cue goes with the drag.
		expect(playhead()).not.toHaveAttribute("data-snapped");
		expect(screen.queryByTestId("timeline-snap-tip")).not.toBeInTheDocument();
	});

	it("releases the edge once the pointer is past the radius", async () => {
		const { container, tl } = renderTimeline();
		const [, right] = handles(pillOf(container, "laneAnnotation"));
		pressAndMove(right, 93);
		act(() => {
			window.dispatchEvent(new MouseEvent("pointermove", { clientX: 80, clientY: 40 }));
		});
		expect(playhead()).not.toHaveAttribute("data-snapped");
		await release(80);
		const [, , endMs] = vi.mocked(tl.updateAnnotationSpan).mock.calls[0];
		expect(endMs).toBeCloseTo((20 + 80 / PX_PER_SEC) * 1000, 6);
	});

	it("feels the same zoomed in: the radius is pixels, not seconds", async () => {
		// 21 Ctrl+wheel notches show 9.3% of the timeline: ~97 px a second, so the 8 px magnet
		// is 0.082 s. 0.3 s off — which locks zoomed out — no longer does; 0.05 s off still does.
		// (jsdom keeps the canvas rect unzoomed, so the drag's own px→s map stays at 9 px/s.)
		const { container, tl } = renderTimeline();
		const panel = container.firstElementChild as HTMLElement;
		for (let i = 0; i < 21; i++)
			fireEvent.wheel(panel, { ctrlKey: true, deltaY: -100, clientX: 0 });
		const [, right] = handles(pillOf(container, "laneAnnotation"));
		const off = px(PLAYHEAD_SEC - 20 - 0.3);
		pressAndMove(right, off);
		expect(playhead()).not.toHaveAttribute("data-snapped");
		await release(off);
		const near = px(PLAYHEAD_SEC - 20 - 0.05);
		pressAndMove(right, near);
		expect(playhead()).toHaveAttribute("data-snapped", "true");
		await release(near);
		expect(tl.updateAnnotationSpan).toHaveBeenLastCalledWith("ann1", 10_000, PLAYHEAD_SEC * 1000);
	});

	it("does not snap while Alt is held, and Alt pressed mid-drag lets go at once", async () => {
		const { container, tl } = renderTimeline();
		const [, right] = handles(pillOf(container, "laneAnnotation"));
		pressAndMove(right, 93, true);
		expect(playhead()).not.toHaveAttribute("data-snapped");
		await release(93);
		expect(vi.mocked(tl.updateAnnotationSpan).mock.calls[0][2]).toBeCloseTo(
			(20 + 93 / PX_PER_SEC) * 1000,
			6,
		);

		pressAndMove(right, 93);
		expect(playhead()).toHaveAttribute("data-snapped", "true");
		// Alt down without the pointer moving: released, and the key does not reach the window
		// (a lone Alt there toggles the hidden menu bar).
		const down = new KeyboardEvent("keydown", { key: "Alt", altKey: true, cancelable: true });
		act(() => {
			window.dispatchEvent(down);
		});
		expect(down.defaultPrevented).toBe(true);
		expect(playhead()).not.toHaveAttribute("data-snapped");
		// Alt up: the magnet is back.
		act(() => {
			window.dispatchEvent(new KeyboardEvent("keyup", { key: "Alt", cancelable: true }));
		});
		expect(playhead()).toHaveAttribute("data-snapped", "true");
		await release(93);
		expect(tl.updateAnnotationSpan).toHaveBeenLastCalledWith("ann1", 10_000, PLAYHEAD_SEC * 1000);
	});

	it("moves a whole pill so either edge lands on the playhead, keeping its length", async () => {
		const { container, tl } = renderTimeline();
		const pill = pillOf(container, "laneAnnotation");
		// The end edge comes near the playhead.
		pressAndMove(pill, 95);
		await release(95);
		expect(tl.updateAnnotationSpan).toHaveBeenLastCalledWith(
			"ann1",
			(PLAYHEAD_SEC - 10) * 1000,
			PLAYHEAD_SEC * 1000,
		);
		// The start edge comes near it.
		pressAndMove(pill, px(PLAYHEAD_SEC - 10) - 3);
		await release(px(PLAYHEAD_SEC - 10) - 3);
		expect(tl.updateAnnotationSpan).toHaveBeenLastCalledWith(
			"ann1",
			PLAYHEAD_SEC * 1000,
			(PLAYHEAD_SEC + 10) * 1000,
		);
	});
});

describe("V4Timeline snapping: every lane", () => {
	it("zoom: the left edge locks onto the playhead", async () => {
		const { container, tl } = renderTimeline({
			annotationRegions: [],
			zoomRegions: [{ id: "z1", startMs: 40_000, endMs: 45_000, depth: 2 }],
		});
		const [left] = handles(pillOf(container, "laneZoom"));
		pressAndMove(left, -85);
		await release(-85);
		expect(tl.updateZoomSpan).toHaveBeenCalledTimes(1);
		expect(tl.updateZoomSpan).toHaveBeenCalledWith("z1", PLAYHEAD_SEC * 1000, 45_000);
	});

	it("speed: the right edge locks onto the playhead", async () => {
		useProjectStore.setState({ currentTimeSec: 60.25 });
		const { container, tl } = renderTimeline({
			annotationRegions: [],
			speedRegions: [{ id: "s1", startMs: 50_000, endMs: 55_000, speed: 2 }],
		});
		const [, right] = handles(pillOf(container, "laneSpeed"));
		pressAndMove(right, 47);
		await release(47);
		expect(tl.updateSpeedSpan).toHaveBeenCalledWith("s1", 50_000, 60_250);
	});

	it("trim: the right edge locks onto the playhead, in source time", async () => {
		useProjectStore.setState({ currentTimeSec: 70.25 });
		const { container, tl } = renderTimeline({
			annotationRegions: [],
			trimRanges: [{ id: "t1", assetId: "a1", startSec: 60, endSec: 65 }],
		});
		const [, right] = handles(pillOf(container, "laneTrim"));
		pressAndMove(right, 47);
		await release(47);
		expect(tl.setTrimEntries).toHaveBeenCalledTimes(1);
		const [entries] = vi.mocked(tl.setTrimEntries).mock.calls[0] as unknown as [
			Array<{ sourceStartSec: number; sourceEndSec: number }>,
		];
		expect(entries).toHaveLength(1);
		expect(entries[0].sourceStartSec).toBe(60);
		expect(entries[0].sourceEndSec).toBe(70.25);
	});

	it("camera: the edge between two pieces rolls onto the playhead", async () => {
		const { container, tl } = renderTimeline({
			assets: [CAMERA_ASSET],
			annotationRegions: [],
			cameraPieces: [
				{
					key: "cam1",
					ids: ["cam1"],
					startMs: 0,
					endMs: 20_000,
					mode: "fullscreen",
					implicit: false,
				},
				{
					key: "cam2",
					ids: ["cam2"],
					startMs: 20_000,
					endMs: 60_000,
					mode: "hidden",
					implicit: false,
				},
				{
					key: "implicit:60000",
					ids: [],
					startMs: 60_000,
					endMs: 100_000,
					mode: "pip",
					implicit: true,
				},
			],
		});
		const [edge] = Array.from(container.querySelectorAll('[class*="cameraEdge"]'));
		pressAndMove(edge, 93);
		expect(playhead()).toHaveAttribute("data-snapped", "true");
		await release(93);
		expect(tl.moveCameraEdge).toHaveBeenCalledTimes(1);
		expect(tl.moveCameraEdge).toHaveBeenCalledWith("cam1", PLAYHEAD_SEC * 1000);
	});

	it("audio: the out-point locks onto the playhead, and the head onto a pill's edge", async () => {
		useProjectStore.setState({ currentTimeSec: 75.4567891 });
		const track = {
			id: "trk1",
			assetId: "aud",
			startMs: 60_000,
			endMs: 70_000,
			offsetMs: 0,
			durationSec: 30,
			gainDb: 0,
			loop: false,
			fadeInMs: 0,
			fadeOutMs: 0,
			muted: false,
			label: "vo",
			origin: "user" as const,
		};
		const { tl } = renderTimeline({
			assets: [ASSET, AUDIO_ASSET],
			annotationRegions: [{ id: "ann1", startMs: 50_000, endMs: 55_000 }],
			audioTracks: [track],
		});
		const pill = screen.getByTitle((title) => title.startsWith("vo "));
		pressAndMove(pill.lastElementChild as Element, 49);
		await release(49);
		expect(tl.placeAudioTrack).toHaveBeenLastCalledWith("trk1", {
			startMs: 60_000,
			endMs: Math.round(75.4567891 * 1000),
			offsetMs: 0,
		});
		// Moved left until its head comes near the annotation's end at 55 s.
		pressAndMove(pill, -px(5) + 4);
		expect(screen.getByTestId("timeline-snap-guide")).toHaveAttribute("data-snap-kind", "edge");
		await release(-px(5) + 4);
		expect(tl.placeAudioTrack).toHaveBeenLastCalledWith("trk1", {
			startMs: 55_000,
			endMs: 65_000,
			offsetMs: 0,
		});
	});

	it("audio: Alt at the grab still slips the media, and shows no magnet", async () => {
		const track = {
			id: "trk1",
			assetId: "aud",
			startMs: 31_000,
			endMs: 41_000,
			offsetMs: 5_000,
			durationSec: 30,
			gainDb: 0,
			loop: false,
			fadeInMs: 0,
			fadeOutMs: 0,
			muted: false,
			label: "vo",
			origin: "user" as const,
		};
		const { tl } = renderTimeline({
			assets: [ASSET, AUDIO_ASSET],
			annotationRegions: [],
			audioTracks: [track],
		});
		const pill = screen.getByTitle((title) => title.startsWith("vo "));
		fireEvent.pointerDown(pill, { clientX: 0, clientY: 40, altKey: true });
		act(() => {
			window.dispatchEvent(
				new MouseEvent("pointermove", { clientX: -5, clientY: 40, altKey: true }),
			);
		});
		expect(screen.queryByTestId("timeline-snap-tip")).not.toBeInTheDocument();
		await release(-5);
		const [, placement] = vi.mocked(tl.placeAudioTrack).mock.calls[0] as unknown as [
			string,
			{ startMs: number; offsetMs: number },
		];
		// The span stayed put; only the window onto the file moved.
		expect(placement.startMs).toBe(31_000);
		expect(placement.offsetMs).not.toBe(5_000);
	});
});

describe("V4Timeline snapping: the other targets", () => {
	beforeEach(() => {
		// Out of reach of every drag below, so they show what else snaps.
		useProjectStore.setState({ currentTimeSec: 90 });
	});

	it("an edge on another lane", async () => {
		const { container, tl } = renderTimeline({
			zoomRegions: [{ id: "z1", startMs: 40_000, endMs: 45_000, depth: 2 }],
		});
		const [, right] = handles(pillOf(container, "laneAnnotation"));
		pressAndMove(right, px(25) - 3);
		expect(screen.getByTestId("timeline-snap-guide")).toHaveAttribute("data-snap-kind", "edge");
		expect(screen.getByTestId("timeline-snap-tip")).toHaveTextContent("snap.edge");
		await release(px(25) - 3);
		expect(tl.updateAnnotationSpan).toHaveBeenCalledWith("ann1", 10_000, 45_000);
	});

	it("a clip boundary, the timeline's end and a marker", async () => {
		const { container, tl } = renderTimeline({
			clips: [clip(0, 50), clip(50, TOTAL_SEC)],
			assets: [{ ...ASSET, markersSec: [25] }],
		});
		const [, right] = handles(pillOf(container, "laneAnnotation"));
		pressAndMove(right, px(30) - 2);
		expect(screen.getByTestId("timeline-snap-guide")).toHaveAttribute("data-snap-kind", "clip");
		await release(px(30) - 2);
		expect(tl.updateAnnotationSpan).toHaveBeenLastCalledWith("ann1", 10_000, 50_000);

		pressAndMove(right, px(80) - 3);
		expect(screen.getByTestId("timeline-snap-tip")).toHaveTextContent("snap.end");
		await release(px(80) - 3);
		expect(tl.updateAnnotationSpan).toHaveBeenLastCalledWith("ann1", 10_000, 100_000);

		pressAndMove(right, px(5) + 2);
		expect(screen.getByTestId("timeline-snap-guide")).toHaveAttribute("data-snap-kind", "marker");
		await release(px(5) + 2);
		expect(tl.updateAnnotationSpan).toHaveBeenLastCalledWith("ann1", 10_000, 25_000);
	});

	it("never its own edge", async () => {
		// The right edge dragged back next to where it started: nothing to lock onto.
		const { container, tl } = renderTimeline();
		const [, right] = handles(pillOf(container, "laneAnnotation"));
		pressAndMove(right, 3);
		expect(screen.queryByTestId("timeline-snap-tip")).not.toBeInTheDocument();
		await release(3);
		expect(vi.mocked(tl.updateAnnotationSpan).mock.calls[0][2]).toBeCloseTo(
			(20 + 3 / PX_PER_SEC) * 1000,
			6,
		);
	});

	it("teaches the Alt bypass in the hint row", async () => {
		renderTimeline();
		expect(screen.getByText("labels.noSnap")).toBeInTheDocument();
	});
});
