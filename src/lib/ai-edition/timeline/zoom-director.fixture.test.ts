import { describe, expect, it } from "vitest";
import type { CursorTelemetryPoint } from "@/components/video-editor/types";
import type { AxcutClip } from "../schema";
import take from "./__fixtures__/edge-menus-take.json";
import { readScreenActivity } from "./screenActivity";
import { type AutoZoomSuggestion, buildAutoZoomSuggestionsForClips } from "./zoom-suggestions";

// A real 51 s take, distilled (`__fixtures__/edge-menus-take.json`): the Edge "..." menu
// walked by hovering (More tools → Apps), "View apps" clicked, a new page, the Gemini card's web
// dropdown, Uninstall and its dialog, the tab closed, stop. The first 12 s are the intro, the
// webcam full screen for most of it. The planner before this one zoomed twice: on the invisible
// HUD's button, and once loosely over the dropdown and the dialog. These are the moments an
// editor would zoom on (the director's cut behind the fork's auto-zoom).

type Rect = [number, number, number, number];

const MOMENTS: Array<{ id: string; fromMs: number; toMs: number; box: Rect; minScale: number }> = [
	{
		id: "settings button",
		fromMs: 14_700,
		toMs: 16_100,
		box: [0.93, 0.03, 0.97, 0.08],
		minScale: 1.5,
	},
	{
		id: "top of the menu",
		fromMs: 16_300,
		toMs: 18_000,
		box: [0.74, 0.04, 0.97, 0.3],
		minScale: 1.3,
	},
	{
		id: "More tools (hover)",
		fromMs: 19_600,
		toMs: 21_400,
		box: [0.74, 0.55, 0.96, 0.61],
		minScale: 1.3,
	},
	{
		id: "Apps (hover)",
		fromMs: 21_800,
		toMs: 23_000,
		box: [0.47, 0.48, 0.75, 0.53],
		minScale: 1.3,
	},
	{
		id: "View apps (hover, click)",
		fromMs: 24_200,
		toMs: 31_800,
		box: [0.73, 0.48, 0.86, 0.58],
		minScale: 1.5,
	},
	{
		id: "Gemini ... button",
		fromMs: 36_500,
		toMs: 37_000,
		box: [0.94, 0.17, 0.98, 0.22],
		minScale: 1.5,
	},
	{
		id: "Uninstall (hover)",
		fromMs: 37_000,
		toMs: 41_500,
		box: [0.81, 0.22, 0.97, 0.33],
		minScale: 1.5,
	},
	{ id: "the dialog", fromMs: 42_600, toMs: 45_200, box: [0.38, 0.07, 0.62, 0.34], minScale: 1.5 },
];

function telemetryOf(): CursorTelemetryPoint[] {
	const path = take.path.map(
		([timeMs, cx, cy, cursorType]) =>
			({
				timeMs,
				cx,
				cy,
				...(cursorType ? { cursorType } : {}),
			}) as CursorTelemetryPoint,
	);
	return [...path, ...(take.events as CursorTelemetryPoint[])].sort((a, b) => a.timeMs - b.timeMs);
}

const clip: AxcutClip = {
	id: "clip",
	assetId: "take",
	sourceStartSec: 0,
	sourceEndSec: take.durationMs / 1000,
	timelineStartSec: 0,
	timelineEndSec: take.durationMs / 1000,
	wordRefs: [],
	origin: "user",
	reason: "",
};

function plan(withFrames: boolean): AutoZoomSuggestion[] {
	return buildAutoZoomSuggestionsForClips({
		telemetryByAssetId: new Map([["take", telemetryOf()]]),
		clips: [clip],
		existingRegions: [],
		contextByAssetId: new Map([
			[
				"take",
				{
					activity: withFrames ? readScreenActivity(take.activity) : null,
					cameraLayout: take.cameraLayout as {
						initial: "screen" | "face";
						switches: { atSec: number; layout: "screen" | "face" }[];
					},
				},
			],
		]),
	});
}

const scaleOf = (s: AutoZoomSuggestion) =>
	s.customScale ?? { 1: 1.25, 2: 1.5, 3: 1.8, 4: 2.2, 5: 3.5, 6: 5 }[s.depth];

/** The zoom fully in at `t` (between two chained ones, during the pan, none is). */
function fullyIn(zooms: AutoZoomSuggestion[], t: number) {
	return zooms.find((s) => s.span.start <= t && t <= s.span.end);
}

function frames(s: AutoZoomSuggestion, [x0, y0, x1, y1]: Rect): boolean {
	const half = 0.5 / scaleOf(s);
	const cx = Math.min(1 - half, Math.max(half, s.focus.cx));
	const cy = Math.min(1 - half, Math.max(half, s.focus.cy));
	return x0 >= cx - half && x1 <= cx + half && y0 >= cy - half && y1 <= cy + half;
}

describe.each([
	["with the frames read", true],
	["from the pointer alone", false],
])("the Edge walkthrough take, %s", (_, withFrames) => {
	const zooms = plan(withFrames);

	it.each(MOMENTS)("zooms on $id, framed", (moment) => {
		let covered = 0;
		let samples = 0;
		for (let t = moment.fromMs; t <= moment.toMs; t += 100) {
			samples += 1;
			const zoom = fullyIn(zooms, t);
			if (zoom && frames(zoom, moment.box) && scaleOf(zoom) >= moment.minScale - 0.05) covered += 1;
		}
		expect(covered / samples).toBeGreaterThanOrEqual(0.6);
	});

	it("keeps the intro, the camera-only span and the HUD's clicks wide", () => {
		expect(zooms.every((s) => s.span.start > 13_000)).toBe(true);
	});

	it("ends on the whole screen: the tab closed and the take stopped wide", () => {
		// With the frames read, closing the tab is seen replacing the page: nothing to zoom on.
		// Without them that click looks like any other, but the last second is still wide.
		const lastEnd = Math.max(...zooms.map((s) => s.span.end));
		expect(lastEnd).toBeLessThan(withFrames ? 47_000 : take.durationMs - 2000);
	});

	it("moves the camera calmly: one move every few seconds at most", () => {
		expect(zooms.length).toBeLessThanOrEqual(6);
		for (const [i, zoom] of zooms.entries()) {
			const previous = zooms[i - 1];
			if (previous) expect(zoom.span.start - previous.span.end).toBeGreaterThanOrEqual(1000);
		}
	});
});

describe("the Edge walkthrough take, page changes", () => {
	it("goes wide after View apps opens a new page, and shows it whole before the next zoom", () => {
		const zooms = plan(true);
		const before = fullyIn(zooms, 31_000) as AutoZoomSuggestion;
		expect(before.span.end).toBeLessThanOrEqual(32_600);
		const after = zooms.find((s) => s.span.start > before.span.end) as AutoZoomSuggestion;
		// Out, the new page whole for a moment, back in.
		expect(after.span.start - before.span.end).toBeGreaterThanOrEqual(3000);
	});
});
