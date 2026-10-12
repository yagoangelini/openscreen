import { describe, expect, it } from "vitest";
import type { CursorTelemetryPoint } from "@/components/video-editor/types";
import type { CursorInputSignal, NormalizedRect } from "@/lib/cursor/inputSignals";
import type { ScreenActivity, ScreenActivityStep } from "./screenActivity";
import { isPageChange } from "./zoom-director";
import { DEFAULT_AUTO_ZOOM_SETTINGS } from "./zoom-motion";
import {
	type AutoZoomSuggestion,
	buildAutoZoomSuggestions,
	NAVIGATION_HOLD_MS,
	OVERVIEW_MS,
} from "./zoom-suggestions";

// The director's behaviours, one by one, on synthetic takes: the pointer's path, its input
// signals and what the frames show changing. `zoom-director.fixture.test.ts` runs a real take.

function rest(fromMs: number, toMs: number, at: [number, number], cursorType?: "pointer") {
	const out: CursorTelemetryPoint[] = [];
	for (let t = fromMs; t <= toMs; t += 33) {
		out.push({ timeMs: t, cx: at[0], cy: at[1], ...(cursorType ? { cursorType } : {}) });
	}
	return out;
}

function move(fromMs: number, toMs: number, from: [number, number], to: [number, number]) {
	const out: CursorTelemetryPoint[] = [];
	for (let t = fromMs; t <= toMs; t += 33) {
		const u = (t - fromMs) / (toMs - fromMs);
		out.push({
			timeMs: t,
			cx: from[0] + (to[0] - from[0]) * u,
			cy: from[1] + (to[1] - from[1]) * u,
		});
	}
	return out;
}

function press(
	timeMs: number,
	at: [number, number],
	target?: NormalizedRect,
): CursorTelemetryPoint {
	return {
		timeMs,
		cx: at[0],
		cy: at[1],
		interactionType: "click",
		input: { kind: "press", button: "left", ...(target ? { target } : {}) },
	};
}

function signal(timeMs: number, input: CursorInputSignal, at: [number, number]) {
	return { timeMs, cx: at[0], cy: at[1], interactionType: "move" as const, input };
}

const take = (...parts: CursorTelemetryPoint[][]) =>
	parts.flat().sort((a, b) => a.timeMs - b.timeMs);

/** A frame step: `boxes` changed at `t`; the share is their area unless given. */
function step(t: number, boxes: NormalizedRect[], share?: number): ScreenActivityStep {
	return {
		t,
		share: share ?? boxes.reduce((sum, b) => sum + b.width * b.height, 0),
		boxes: boxes.map((b) => ({ ...b, share: b.width * b.height })),
	};
}

function activity(...steps: ScreenActivityStep[]): ScreenActivity {
	return { version: 1, fps: 8, durationMs: 60_000, steps };
}

/** A still screen: the frames were read, and nothing changed. */
const STILL = activity();

const scaleOf = (s: AutoZoomSuggestion) =>
	s.customScale ?? { 1: 1.25, 2: 1.5, 3: 1.8, 4: 2.2, 5: 3.5, 6: 5 }[s.depth];

/** The part of the frame a suggestion shows once fully in. */
function viewOf(s: AutoZoomSuggestion) {
	const half = 0.5 / scaleOf(s);
	const cx = Math.min(1 - half, Math.max(half, s.focus.cx));
	const cy = Math.min(1 - half, Math.max(half, s.focus.cy));
	return { minX: cx - half, maxX: cx + half, minY: cy - half, maxY: cy + half };
}

function shows(s: AutoZoomSuggestion, rect: NormalizedRect): boolean {
	const v = viewOf(s);
	return (
		rect.x >= v.minX - 1e-6 &&
		rect.x + rect.width <= v.maxX + 1e-6 &&
		rect.y >= v.minY - 1e-6 &&
		rect.y + rect.height <= v.maxY + 1e-6
	);
}

/** The suggestion on screen at `t`, if any. */
const at = (plan: AutoZoomSuggestion[], t: number) =>
	plan.find((s) => s.span.start <= t && t <= s.span.end);

function direct(
	cursorTelemetry: CursorTelemetryPoint[],
	options: Partial<Parameters<typeof buildAutoZoomSuggestions>[0]> = {},
) {
	return buildAutoZoomSuggestions({
		cursorTelemetry,
		totalMs: 30_000,
		existingRegions: [],
		...options,
	});
}

describe("zoom director: menus that open on hover", () => {
	const menu = { x: 0.6, y: 0.3, width: 0.2, height: 0.25 };

	it("zooms on a menu the pointer opens by resting on it, with no click at all", () => {
		const telemetry = take(
			rest(0, 2900, [0.3, 0.6]),
			move(2933, 3900, [0.3, 0.6], [0.62, 0.28]),
			rest(3933, 9000, [0.62, 0.28]),
			[signal(4200, { kind: "popup-open", id: "m", rect: menu }, [0.62, 0.28])],
			[signal(8800, { kind: "popup-close", id: "m" }, [0.62, 0.28])],
			move(9033, 9600, [0.62, 0.28], [0.2, 0.8]),
			rest(9633, 20_000, [0.2, 0.8]),
		);
		const plan = direct(telemetry, { activity: STILL });
		expect(plan).toHaveLength(1);
		expect(shows(plan[0], menu)).toBe(true);
		expect(scaleOf(plan[0])).toBeGreaterThan(1.4);
		// In as the menu opens, out once it is gone.
		expect(plan[0].span.start).toBeLessThanOrEqual(4400);
		expect(plan[0].span.end).toBeLessThan(11_000);
	});

	it("sees a menu drawn by a web page in the frames, where UI Automation sees nothing", () => {
		const webMenu = { x: 0.62, y: 0.3, width: 0.15, height: 0.2 };
		const telemetry = take(
			rest(0, 2900, [0.3, 0.6]),
			move(2933, 3900, [0.3, 0.6], [0.63, 0.28]),
			rest(3933, 8000, [0.63, 0.28]),
			move(8033, 8600, [0.63, 0.28], [0.2, 0.8]),
			rest(8633, 20_000, [0.2, 0.8]),
		);
		const plan = direct(telemetry, {
			activity: activity(
				step(4125, [{ x: 0.6, y: 0.26, width: 0.06, height: 0.03 }]),
				step(4250, [webMenu]),
			),
		});
		expect(plan).toHaveLength(1);
		expect(shows(plan[0], webMenu)).toBe(true);
	});

	it("does not zoom on a hand resting where nothing answers it", () => {
		// Still frames: the speaker introduces the video, the pointer parked on the HUD's buttons.
		const telemetry = take(
			rest(0, 2900, [0.5, 0.5]),
			rest(2933, 9000, [0.45, 0.93], "pointer"),
			rest(9033, 20_000, [0.5, 0.5]),
		);
		expect(direct(telemetry, { activity: STILL })).toEqual([]);
		// Without frames to read, a hand that rests on one spot is worth a look.
		expect(direct(telemetry)).toHaveLength(1);
	});

	it("does not zoom on a pointer resting while the screen stays still", () => {
		const telemetry = take(
			rest(0, 2900, [0.5, 0.5]),
			move(2933, 3500, [0.5, 0.5], [0.7, 0.4]),
			rest(3533, 20_000, [0.7, 0.4]),
		);
		expect(direct(telemetry, { activity: STILL })).toEqual([]);
	});
});

describe("zoom director: how close", () => {
	it("shows a small target closer than a wide area", () => {
		const button = { x: 0.7, y: 0.2, width: 0.04, height: 0.03 };
		const small = direct(
			take(
				rest(0, 5966, [0.72, 0.21]),
				[press(6000, [0.72, 0.21], button)],
				rest(6033, 20_000, [0.72, 0.21]),
			),
		);
		expect(scaleOf(small[0])).toBe(2);
		// A dialog-sized area, from a popup the click opened: framed whole, less deep.
		const panel = { x: 0.2, y: 0.15, width: 0.6, height: 0.5 };
		const wide = direct(
			take(
				rest(0, 5966, [0.3, 0.2]),
				[press(6000, [0.3, 0.2])],
				[signal(6200, { kind: "popup-open", id: "p", rect: panel }, [0.3, 0.2])],
				rest(6033, 20_000, [0.3, 0.2]),
			),
		);
		expect(shows(wide[0], panel)).toBe(true);
		expect(scaleOf(wide[0])).toBeLessThan(1.5);
	});

	it("follows the settings' maximum, and a third past it only for a small target", () => {
		const button = { x: 0.7, y: 0.2, width: 0.04, height: 0.03 };
		const telemetry = take(
			rest(0, 5966, [0.72, 0.21]),
			[press(6000, [0.72, 0.21], button)],
			rest(6033, 20_000, [0.72, 0.21]),
		);
		const settings = { ...DEFAULT_AUTO_ZOOM_SETTINGS, maxScale: 1.25 };
		expect(scaleOf(direct(telemetry, { settings })[0])).toBeCloseTo(1.25 * (4 / 3), 2);
	});
});

describe("zoom director: moving between areas", () => {
	const left = { x: 0.1, y: 0.2, width: 0.05, height: 0.03 };
	const right = { x: 0.75, y: 0.6, width: 0.05, height: 0.03 };

	it("pans, zoomed, to a target that needs its own framing a few seconds later", () => {
		const telemetry = take(
			rest(0, 3966, [0.12, 0.21]),
			[press(4000, [0.12, 0.21], left)],
			rest(4033, 6900, [0.12, 0.21]),
			move(6933, 7500, [0.12, 0.21], [0.77, 0.61]),
			rest(7533, 7966, [0.77, 0.61]),
			[press(8000, [0.77, 0.61], right)],
			rest(8033, 20_000, [0.77, 0.61]),
		);
		const [a, b] = direct(telemetry);
		expect(shows(a, left)).toBe(true);
		expect(shows(b, right)).toBe(true);
		// Chained: no wide shot between them, one pan long.
		expect(b.span.start - a.span.end).toBe(DEFAULT_AUTO_ZOOM_SETTINGS.transitionSec * 1000);
	});

	it("goes back to the whole screen between two areas far apart in time", () => {
		const telemetry = take(
			rest(0, 3966, [0.12, 0.21]),
			[press(4000, [0.12, 0.21], left)],
			rest(4033, 14_900, [0.12, 0.21]),
			move(14_933, 15_500, [0.12, 0.21], [0.77, 0.61]),
			rest(15_533, 15_966, [0.77, 0.61]),
			[press(16_000, [0.77, 0.61], right)],
			rest(16_033, 28_000, [0.77, 0.61]),
		);
		const [a, b] = direct(telemetry);
		const ramp = DEFAULT_AUTO_ZOOM_SETTINGS.transitionSec * 1000;
		expect(b.span.start - a.span.end).toBeGreaterThanOrEqual(2 * ramp + 2500);
	});

	it("holds one framing for nearby actions instead of nudging the camera", () => {
		const a = { x: 0.4, y: 0.4, width: 0.05, height: 0.03 };
		const b = { x: 0.45, y: 0.44, width: 0.05, height: 0.03 };
		const telemetry = take(
			rest(0, 3966, [0.42, 0.41]),
			[press(4000, [0.42, 0.41], a)],
			move(4033, 4800, [0.42, 0.41], [0.47, 0.45]),
			rest(4833, 5966, [0.47, 0.45]),
			[press(6000, [0.47, 0.45], b)],
			rest(6033, 20_000, [0.47, 0.45]),
		);
		const plan = direct(telemetry);
		expect(plan).toHaveLength(1);
		expect(shows(plan[0], a) && shows(plan[0], b)).toBe(true);
	});

	it("pans from what was clicked to the dialog it opens, without going wide", () => {
		// "Uninstall" picked at the right of a dropdown; the confirmation opens in the middle,
		// over a dimmed page (a frame change of nearly everything that is NOT a navigation).
		const item = { x: 0.81, y: 0.3, width: 0.15, height: 0.03 };
		const dialog = { x: 0.38, y: 0.07, width: 0.24, height: 0.27 };
		const telemetry = take(
			rest(0, 5966, [0.85, 0.31]),
			[press(6000, [0.85, 0.31], item)],
			[signal(6300, { kind: "popup-open", id: "d", rect: dialog }, [0.85, 0.31])],
			rest(6033, 6900, [0.85, 0.31]),
			move(6933, 7500, [0.85, 0.31], [0.5, 0.22]),
			rest(7533, 9966, [0.5, 0.22]),
			[press(10_000, [0.5, 0.22], { x: 0.4, y: 0.2, width: 0.2, height: 0.03 })],
			rest(10_033, 20_000, [0.5, 0.22]),
		);
		const plan = direct(telemetry, {
			activity: activity(step(6500, [{ x: 0, y: 0, width: 1, height: 0.96 }], 0.95)),
		});
		const first = at(plan, 5500);
		const second = at(plan, 8500);
		expect(first && shows(first, item)).toBe(true);
		expect(second && shows(second, dialog)).toBe(true);
		expect(first).not.toBe(second);
		expect((second as AutoZoomSuggestion).span.start - (first as AutoZoomSuggestion).span.end).toBe(
			DEFAULT_AUTO_ZOOM_SETTINGS.transitionSec * 1000,
		);
	});
});

describe("zoom director: pages replaced", () => {
	it("knows a page change from the frames, even when only part of the cells change", () => {
		// A dark page replaced by another dark page: a quarter of the cells, all over the frame.
		expect(
			isPageChange(
				step(
					0,
					[
						{ x: 0.01, y: 0.11, width: 0.32, height: 0.83 },
						{ x: 0.57, y: 0.31, width: 0.19, height: 0.34 },
					],
					0.27,
				),
			),
		).toBe(true);
		// A menu opening is not one.
		expect(isPageChange(step(0, [{ x: 0.74, y: 0.39, width: 0.11, height: 0.2 }]))).toBe(false);
	});

	it("goes wide right after a click that replaces the page, and shows it whole before the next zoom", () => {
		const link = { x: 0.3, y: 0.3, width: 0.08, height: 0.03 };
		const button = { x: 0.7, y: 0.6, width: 0.05, height: 0.03 };
		const telemetry = take(
			rest(0, 3966, [0.32, 0.31]),
			move(3000, 3900, [0.5, 0.5], [0.32, 0.31]),
			[press(6000, [0.32, 0.31], link)],
			rest(4000, 7500, [0.32, 0.31]),
			move(7533, 8200, [0.32, 0.31], [0.72, 0.61]),
			rest(8233, 9966, [0.72, 0.61]),
			[press(10_000, [0.72, 0.61], button)],
			rest(10_033, 20_000, [0.72, 0.61]),
		).filter((s, i, all) => i === 0 || s.timeMs !== all[i - 1].timeMs);
		const pageChange = step(6250, [{ x: 0, y: 0.05, width: 1, height: 0.9 }], 0.6);
		const plan = direct(telemetry, { activity: activity(pageChange) });
		const before = at(plan, 5500) as AutoZoomSuggestion;
		expect(before).toBeDefined();
		expect(before.span.end).toBe(6000 + NAVIGATION_HOLD_MS);
		const after = plan.find((s) => s.span.start > before.span.end);
		if (after) {
			const ramp = DEFAULT_AUTO_ZOOM_SETTINGS.transitionSec * 1000;
			expect(after.span.start - before.span.end).toBeGreaterThanOrEqual(
				OVERVIEW_MS + 2 * ramp - 300,
			);
		}
	});

	it("does not zoom in on a lone click that replaces the page", () => {
		const telemetry = take(
			rest(0, 5966, [0.3, 0.3]),
			[press(6000, [0.3, 0.3], { x: 0.28, y: 0.29, width: 0.06, height: 0.03 })],
			rest(6033, 20_000, [0.3, 0.3]),
		);
		const plan = direct(telemetry, {
			activity: activity(step(6250, [{ x: 0, y: 0.05, width: 1, height: 0.9 }], 0.6)),
		});
		expect(plan).toEqual([]);
	});
});

describe("zoom director: following the pointer", () => {
	// The pointer gliding across a chart from corner to corner in 4.8 s, a tooltip answering it
	// all the way: one exploration no single framing holds, too quick for a framing per stretch.
	const glide = take(
		rest(0, 2966, [0.05, 0.1]),
		move(3000, 7800, [0.05, 0.1], [0.95, 0.9]),
		move(7833, 8400, [0.95, 0.9], [0.5, 0.97]),
		rest(8433, 25_000, [0.5, 0.97]),
	);
	const tooltips: ScreenActivityStep[] = [];
	for (let t = 3125; t <= 7800; t += 250) {
		const u = (t - 3000) / 4800;
		tooltips.push(step(t, [{ x: 0.07 + 0.9 * u, y: 0.06 + 0.8 * u, width: 0.06, height: 0.03 }]));
	}

	it("follows a long exploration across the screen instead of panning after every stretch", () => {
		const plan = direct(glide, { activity: activity(...tooltips) });
		const follow = plan.find((s) => s.follow);
		expect(follow).toBeDefined();
		expect(scaleOf(follow as AutoZoomSuggestion)).toBeGreaterThanOrEqual(1.15);
		expect(scaleOf(follow as AutoZoomSuggestion)).toBeLessThanOrEqual(1.4);
		// It starts where the exploration starts, and covers most of it.
		expect((follow as AutoZoomSuggestion).focus.cx).toBeLessThan(0.4);
		expect(
			(follow as AutoZoomSuggestion).span.end - (follow as AutoZoomSuggestion).span.start,
		).toBeGreaterThan(5000);
	});

	it("holds fixed framings when the actions fit a few of them, at a calm pace", () => {
		// Eight fields down a form, a click every 0.8 s: the top half, then the bottom half.
		const parts: CursorTelemetryPoint[][] = [rest(0, 2966, [0.5, 0.05])];
		for (let i = 0; i < 8; i += 1) {
			const y = 0.1 + i * 0.11;
			const t = 3000 + i * 800;
			parts.push(move(t, t + 400, [0.5, Math.max(0.05, y - 0.11)], [0.5, y]));
			parts.push(rest(t + 433, t + 766, [0.5, y]));
			parts.push([press(t + 600, [0.5, y], { x: 0.4, y: y - 0.015, width: 0.2, height: 0.03 })]);
		}
		parts.push(rest(9_400, 20_000, [0.5, 0.87]));
		const plan = direct(
			take(...parts).filter((s, i, all) => i === 0 || s.timeMs !== all[i - 1].timeMs),
		);
		expect(plan.some((s) => s.follow)).toBe(false);
		expect(plan).toHaveLength(2);
		expect(plan[1].span.start - plan[0].span.end).toBe(
			DEFAULT_AUTO_ZOOM_SETTINGS.transitionSec * 1000,
		);
	});
});

describe("zoom director: the rest of the timeline", () => {
	it("plans nothing inside a camera-only span, and ignores the HUD click that switched to it", () => {
		const telemetry = take(
			rest(0, 2900, [0.5, 0.5]),
			move(2933, 3900, [0.5, 0.5], [0.43, 0.93]),
			rest(3933, 4600, [0.43, 0.93], "pointer"),
			[press(4665, [0.43, 0.93], { x: 0.42, y: 0.91, width: 0.02, height: 0.03 })],
			rest(4700, 12_000, [0.43, 0.93], "pointer"),
			[press(12_010, [0.43, 0.93], { x: 0.42, y: 0.91, width: 0.02, height: 0.03 })],
			move(12_100, 13_000, [0.43, 0.93], [0.7, 0.3]),
			rest(13_033, 25_000, [0.7, 0.3]),
		);
		const cameraLayout = {
			initial: "screen" as const,
			switches: [
				{ atSec: 4.768, layout: "face" as const },
				{ atSec: 12.12, layout: "screen" as const },
			],
		};
		expect(direct(telemetry, { cameraLayout, activity: STILL })).toEqual([]);
	});

	it("ends a shot a moment before a camera-only span, and starts one a moment after", () => {
		const button = { x: 0.7, y: 0.3, width: 0.04, height: 0.03 };
		const telemetry = take(
			rest(0, 14_966, [0.72, 0.31]),
			[press(15_000, [0.72, 0.31], button)],
			rest(15_033, 25_000, [0.72, 0.31]),
		);
		const plan = direct(telemetry, {
			cameraLayout: {
				initial: "screen",
				switches: [
					{ atSec: 5, layout: "face" },
					{ atSec: 12, layout: "screen" },
				],
			},
		});
		expect(plan).toHaveLength(1);
		const ramp = DEFAULT_AUTO_ZOOM_SETTINGS.transitionSec * 1000 * 1.5;
		// The screen back for a second, then the ramp: in before the click.
		expect(plan[0].span.start).toBeGreaterThanOrEqual(12_000 + 1000);
		expect(plan[0].span.start).toBeLessThanOrEqual(15_000);
		expect(plan[0].span.start - 12_000).toBeLessThan(1000 + ramp + 800);
	});
});
