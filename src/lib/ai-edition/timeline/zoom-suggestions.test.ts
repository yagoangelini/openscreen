import { describe, expect, it } from "vitest";
import type { CursorTelemetryPoint } from "@/components/video-editor/types";
import type { CursorInputSignal, NormalizedRect } from "@/lib/cursor/inputSignals";
import type { AxcutClip } from "../schema";
import { DEFAULT_AUTO_ZOOM_SETTINGS } from "./zoom-motion";
import {
	type AutoZoomSuggestion,
	buildAutoZoomSuggestions,
	buildAutoZoomSuggestionsForClips,
	NAVIGATION_HOLD_MS,
	SHOT_LEAD_MS,
	SHOT_TAIL_MS,
} from "./zoom-suggestions";

// A click = a single sample carrying recorded interaction metadata (issue #699).
function click(
	timeMs: number,
	cx: number,
	cy: number,
	interactionType: CursorTelemetryPoint["interactionType"] = "click",
	input?: CursorInputSignal,
): CursorTelemetryPoint {
	return { timeMs, cx, cy, interactionType, ...(input ? { input } : {}) };
}

/** A press as the Windows sampler records it, with the clicked element's bounds. */
function press(
	timeMs: number,
	cx: number,
	cy: number,
	target?: NormalizedRect,
	controlType?: number,
) {
	return click(timeMs, cx, cy, "click", {
		kind: "press",
		button: "left",
		...(target ? { target } : {}),
		...(controlType ? { controlType } : {}),
	});
}

// The pointer parked in one place, with no click.
function park(centerMs: number, cx: number, cy: number, count = 6, spanMs = 900) {
	const step = spanMs / (count - 1);
	return Array.from({ length: count }, (_, i) => ({
		timeMs: centerMs - spanMs / 2 + i * step,
		cx,
		cy,
	}));
}

/** The pointer still at `at` from `fromMs` to `toMs`, sampled at 30 Hz. */
function rest(fromMs: number, toMs: number, at: [number, number]): CursorTelemetryPoint[] {
	const out: CursorTelemetryPoint[] = [];
	for (let t = fromMs; t <= toMs; t += 33) out.push({ timeMs: t, cx: at[0], cy: at[1] });
	return out;
}

/** The pointer moving in a straight line, sampled at 30 Hz. */
function sweep(
	fromMs: number,
	toMs: number,
	from: [number, number],
	to: [number, number],
): CursorTelemetryPoint[] {
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

function signal(timeMs: number, input: CursorInputSignal, at: [number, number] = [0.5, 0.5]) {
	return { timeMs, cx: at[0], cy: at[1], interactionType: "move" as const, input };
}

const plan = (cursorTelemetry: CursorTelemetryPoint[], totalMs = 5000) =>
	buildAutoZoomSuggestions({ cursorTelemetry, totalMs, existingRegions: [] });

const scaleOf = (s: AutoZoomSuggestion) =>
	s.customScale ?? { 1: 1.25, 2: 1.5, 3: 1.8, 4: 2.2, 5: 3.5, 6: 5 }[s.depth];

/** A whole take: `samples` sorted, on a pointer that otherwise rests where it last was. */
const take = (...parts: CursorTelemetryPoint[][]) =>
	parts.flat().sort((a, b) => a.timeMs - b.timeMs);

describe("buildAutoZoomSuggestions: which clicks count", () => {
	it("ignores a click made while the cursor is hidden", () => {
		expect(plan([{ ...click(2000, 0.5, 0.5), visible: false }])).toEqual([]);
	});

	it("ignores a visible mouse-down when the cursor hides during that drag", () => {
		const suggestions = plan([
			{ ...click(1000, 0.5, 0.5), visible: true },
			{ timeMs: 1016, cx: 0.5, cy: 0.5, visible: false, interactionType: "move" },
			{ timeMs: 1600, cx: 0.7, cy: 0.5, visible: false, interactionType: "mouseup" },
		]);
		expect(suggestions).toEqual([]);
	});

	it("keeps a click released before the cursor later hides", () => {
		const suggestions = plan([
			{ ...click(1000, 0.5, 0.5), visible: true },
			{ timeMs: 1050, cx: 0.5, cy: 0.5, visible: true, interactionType: "mouseup" },
			{ timeMs: 1400, cx: 0.5, cy: 0.5, visible: false, interactionType: "move" },
		]);
		expect(suggestions.map((s) => s.focus)).toEqual([{ cx: 0.5, cy: 0.5 }]);
	});

	it("keeps a later visible click after a hidden drag", () => {
		const suggestions = plan(
			[
				{ ...click(1000, 0.5, 0.5), visible: true },
				{ timeMs: 1100, cx: 0.6, cy: 0.5, visible: false, interactionType: "move" },
				{ timeMs: 1600, cx: 0.7, cy: 0.5, visible: true, interactionType: "mouseup" },
				{ ...click(4000, 0.2, 0.8), visible: true },
			],
			7000,
		);
		expect(suggestions.map((s) => s.focus)).toEqual([{ cx: 0.2, cy: 0.8 }]);
	});

	it("keeps a legacy click without mouseup when the cursor hides much later", () => {
		const suggestions = plan(
			[
				{ ...click(1000, 0.2, 0.8), visible: true },
				{ timeMs: 1050, cx: 0.2, cy: 0.79, visible: true, interactionType: "move" },
				{ timeMs: 2000, cx: 0.2, cy: 0.8, visible: false, interactionType: "move" },
			],
			4000,
		);
		expect(suggestions.map((s) => s.focus)).toEqual([{ cx: 0.2, cy: 0.8 }]);
	});

	it("rejects a legacy click when the cursor hides on the next sampler tick", () => {
		const suggestions = plan(
			[
				{ ...click(1000, 0.2, 0.8), visible: true },
				{ timeMs: 1033, cx: 0.25, cy: 0.75, visible: false, interactionType: "move" },
			],
			4000,
		);
		expect(suggestions).toEqual([]);
	});

	it("keeps a tap whose release shares its press sample when the cursor hides later", () => {
		// The take records mouse-ups, but the second tap was released within one sampler tick.
		const suggestions = plan(
			[
				{ ...click(500, 0.8, 0.2), visible: true },
				{ timeMs: 600, cx: 0.8, cy: 0.2, visible: true, interactionType: "mouseup" },
				{ ...click(12000, 0.2, 0.8), visible: true },
				{ timeMs: 12500, cx: 0.2, cy: 0.8, visible: false, interactionType: "move" },
			],
			16000,
		);
		expect(suggestions.map((s) => s.focus)).toEqual([
			{ cx: 0.8, cy: 0.2 },
			{ cx: 0.2, cy: 0.8 },
		]);
	});

	it("keeps a click whose mouse-up sample is already hidden", () => {
		// Released, then typing hid the pointer before the next sampler tick.
		const suggestions = plan(
			[
				{ ...click(1000, 0.5, 0.5), visible: true },
				{ timeMs: 1033, cx: 0.5, cy: 0.5, visible: false, interactionType: "mouseup" },
			],
			4000,
		);
		expect(suggestions.map((s) => s.focus)).toEqual([{ cx: 0.5, cy: 0.5 }]);
	});

	it("accepts every click kind the telemetry records: right, middle and double clicks count", () => {
		for (const kind of ["click", "double-click", "right-click", "middle-click"] as const) {
			const suggestions = plan([click(2000, 0.3, 0.7, kind), { timeMs: 4000, cx: 0.3, cy: 0.7 }]);
			expect(
				suggestions.map((s) => s.focus),
				kind,
			).toEqual([{ cx: 0.3, cy: 0.7 }]);
		}
	});

	it("ignores move and mouseup: they are not clicks", () => {
		const telemetry: CursorTelemetryPoint[] = Array.from({ length: 10 }, (_, i) => ({
			timeMs: i * 500,
			cx: i / 10,
			cy: i / 10,
			interactionType: i === 4 ? "mouseup" : "move",
		}));
		expect(plan(telemetry)).toEqual([]);
	});

	it("places no zoom where the pointer only sits still", () => {
		expect(plan(park(2000, 0.5, 0.5))).toEqual([]);
		expect(plan(rest(0, 6000, [0.5, 0.5]), 8000)).toEqual([]);
	});

	it("returns nothing without telemetry, or for a lone move or mouseup", () => {
		expect(plan([])).toEqual([]);
		for (const kind of ["move", "mouseup"] as const) {
			expect(plan([{ timeMs: 2000, cx: 0.3, cy: 0.7, interactionType: kind }]), kind).toEqual([]);
		}
	});
});

describe("buildAutoZoomSuggestions: a calm shot", () => {
	it("zooms to 1.5× at most, in place 0.7 s before the click, holding at least 2.5 s", () => {
		const [shot] = plan([click(3000, 0.4, 0.6), { timeMs: 9000, cx: 0.4, cy: 0.6 }], 10000);
		expect(shot).toEqual({
			span: { start: 3000 - SHOT_LEAD_MS, end: 3000 + SHOT_TAIL_MS },
			focus: { cx: 0.4, cy: 0.6 },
			depth: 2,
		});
		expect(shot.span.end - shot.span.start).toBeGreaterThanOrEqual(2500);
	});

	it("anticipates: starts with the hand's final approach, fully in well before the click", () => {
		// At rest on the far side until 1.5 s, then a long reach to the target, a settle, a click.
		const telemetry = take(
			rest(0, 1500, [0.1, 0.9]),
			sweep(1533, 3800, [0.1, 0.9], [0.7, 0.3]),
			rest(3833, 4466, [0.7, 0.3]),
			[click(4500, 0.7, 0.3)],
			rest(4533, 9000, [0.7, 0.3]),
		);
		const [shot] = plan(telemetry, 10000);
		// Set off at 1.5 s: the 1.1 s ramp rides the hand, capped 1.5 s before the click.
		expect(shot.span.start).toBe(4500 - SHOT_LEAD_MS - 800);
		// No approach to ride (the pointer was already there): in place 0.7 s before.
		const [still] = plan(take(rest(0, 4466, [0.7, 0.3]), [click(4500, 0.7, 0.3)]), 10000);
		expect(still.span.start).toBe(4500 - SHOT_LEAD_MS);
	});

	it("goes 20% deeper on a single tight target, and only there", () => {
		const button = { x: 0.68, y: 0.29, width: 0.05, height: 0.03 };
		const [tight] = plan(
			[press(3000, 0.7, 0.3, button), { timeMs: 9000, cx: 0.7, cy: 0.3 }],
			10000,
		);
		expect(scaleOf(tight)).toBe(1.8);
		const [plain] = plan([click(3000, 0.7, 0.3), { timeMs: 9000, cx: 0.7, cy: 0.3 }], 10000);
		expect(scaleOf(plain)).toBe(1.5);
	});

	it("follows the settings' maximum", () => {
		const [shot] = buildAutoZoomSuggestions({
			cursorTelemetry: [click(3000, 0.4, 0.6), { timeMs: 9000, cx: 0.4, cy: 0.6 }],
			totalMs: 10000,
			existingRegions: [],
			settings: { ...DEFAULT_AUTO_ZOOM_SETTINGS, maxScale: 1.25 },
		});
		expect(shot.depth).toBe(1);
		expect(shot.customScale).toBeUndefined();
	});

	it("ends early when the pointer travels away, but never under the minimum hold", () => {
		const telemetry = take(
			rest(2000, 2966, [0.2, 0.2]),
			[click(3000, 0.2, 0.2)],
			sweep(3033, 3400, [0.2, 0.2], [0.8, 0.8]),
			rest(3433, 9000, [0.8, 0.8]),
		);
		const settings = { ...DEFAULT_AUTO_ZOOM_SETTINGS, holdSec: 1.5 };
		const [shot] = buildAutoZoomSuggestions({
			cursorTelemetry: telemetry,
			totalMs: 10000,
			existingRegions: [],
			settings,
		});
		// In at 2.3 s; the pointer is 35% away by ~3.3 s, but the shot holds 1.5 s.
		expect(shot.span).toEqual({ start: 2300, end: 3800 });
	});
});

describe("buildAutoZoomSuggestions: several actions", () => {
	it("frames a burst of nearby clicks with one zoom that holds through it", () => {
		const suggestions = plan(
			[click(2000, 0.3, 0.3), click(3500, 0.36, 0.33), click(5000, 0.4, 0.35)],
			9000,
		);
		expect(suggestions).toHaveLength(1);
		expect(suggestions[0].span).toEqual({ start: 1300, end: 7000 });
		expect(suggestions[0].focus.cx).toBeCloseTo(0.35, 5);
		expect(suggestions[0].focus.cy).toBeCloseTo(0.325, 5);
	});

	it("zooms in less when what it frames spreads wider", () => {
		// With a 12% margin each side, 0.4 of the frame fits at 1.56× and 0.5 only at 1.35×.
		const wider = plan([click(2000, 0.2, 0.5), click(3000, 0.6, 0.5)], 9000);
		expect(wider.map(scaleOf)).toEqual([1.5]);
		const nearby = plan([click(2000, 0.2, 0.5), click(3000, 0.3, 0.5)], 9000);
		expect(nearby.map(scaleOf)).toEqual([1.5]);
	});

	it("pans to a far target close in time instead of zooming out and back in", () => {
		const telemetry = take(
			[click(3000, 0.2, 0.3)],
			rest(3033, 6466, [0.2, 0.3]),
			sweep(6500, 7200, [0.2, 0.3], [0.8, 0.7]),
			rest(7233, 7966, [0.8, 0.7]),
			[click(8000, 0.8, 0.7)],
			rest(8033, 14000, [0.8, 0.7]),
		);
		const [a, b] = plan(telemetry, 15000);
		expect(a.focus).toEqual({ cx: 0.2, cy: 0.3 });
		expect(b.focus).toEqual({ cx: 0.8, cy: 0.7 });
		// Chained: the pan (one ramp long) leaves A and lands on B, in place before its click.
		expect(b.span.start - a.span.end).toBe(DEFAULT_AUTO_ZOOM_SETTINGS.transitionSec * 1000);
		expect(b.span.start).toBeLessThanOrEqual(8000 - SHOT_LEAD_MS);
	});

	it("holds still for a target that stays near the middle of the view", () => {
		// 5 s apart, too far for one shot, too close for a wide one: the second click is in view.
		const suggestions = plan(
			take(
				[click(3000, 0.4, 0.4)],
				rest(3033, 7966, [0.42, 0.41]),
				[click(8000, 0.5, 0.45)],
				rest(8033, 14000, [0.5, 0.45]),
			),
			15000,
		);
		expect(suggestions).toHaveLength(1);
		expect(suggestions[0].span).toEqual({ start: 2300, end: 10000 });
		expect(suggestions[0].focus).toEqual({ cx: 0.4, cy: 0.4 });
	});

	it("makes at most one camera move per 1.5 s", () => {
		// A far target 1.2 s after the first: no pan can leave in time, so it is not chased.
		const rushed = plan([click(4000, 0.15, 0.2), click(5200, 0.85, 0.8)], 12000);
		expect(rushed.map((s) => s.focus)).toEqual([{ cx: 0.15, cy: 0.2 }]);
		// With 2.5 s, the pan leaves 1.5 s after the zoom landed and arrives before the click.
		const [a, b] = plan([click(4000, 0.15, 0.2), click(6500, 0.85, 0.8)], 12000);
		expect(b.span.start - a.span.end).toBe(1100);
		expect(a.span.end - a.span.start).toBeGreaterThanOrEqual(1500);
		expect(b.span.start).toBeLessThanOrEqual(6500 + 200);
	});

	it("leaves a real wide shot between two zooms far apart in time", () => {
		const suggestions = plan([click(2000, 0.1, 0.1), click(14000, 0.9, 0.9)], 18000);
		expect(suggestions.map((s) => s.span)).toEqual([
			{ start: 1300, end: 4000 },
			{ start: 13300, end: 16000 },
		]);
	});

	it("keeps clear of a zoom already on the timeline, its ramps and a wide shot included", () => {
		const existingRegions = [{ startMs: 3000, endMs: 5000 }];
		const near = buildAutoZoomSuggestions({
			cursorTelemetry: [click(8000, 0.5, 0.5)],
			totalMs: 14000,
			existingRegions,
		});
		expect(near).toEqual([]);
		const clear = buildAutoZoomSuggestions({
			cursorTelemetry: [click(10500, 0.5, 0.5)],
			totalMs: 14000,
			existingRegions,
		});
		expect(clear.map((s) => s.span)).toEqual([{ start: 9800, end: 12500 }]);
	});

	it("lets a brisk wide shot (1.5 s) sit where the calm one (2.5 s) would not fit", () => {
		const existingRegions = [{ startMs: 3000, endMs: 5000 }];
		const at = (minWideSec: number) =>
			buildAutoZoomSuggestions({
				cursorTelemetry: [click(9500, 0.5, 0.5)],
				totalMs: 14000,
				existingRegions,
				settings: { ...DEFAULT_AUTO_ZOOM_SETTINGS, minWideSec },
			});
		expect(at(2.5)).toEqual([]);
		expect(at(1.5)).toHaveLength(1);
	});

	it("keeps clear of a placed zoom that reaches past the next one", () => {
		const suggestions = buildAutoZoomSuggestions({
			cursorTelemetry: [click(12000, 0.5, 0.5)],
			totalMs: 30000,
			existingRegions: [
				{ startMs: 0, endMs: 20000 },
				{ startMs: 5000, endMs: 8000 },
			],
		});
		expect(suggestions).toEqual([]);
	});

	it("measures an existing zoom's ramps at its own depth", () => {
		// A 5× zoom takes 1.5 s to come back out, so the wide shot after it starts later.
		const suggestions = buildAutoZoomSuggestions({
			cursorTelemetry: [click(9500, 0.5, 0.5)],
			totalMs: 14000,
			existingRegions: [{ startMs: 3000, endMs: 5000, scale: 5 }],
		});
		expect(suggestions).toEqual([]);
	});

	it("keeps a zoom for a click at either end of the axis", () => {
		expect(plan([click(100, 0.1, 0.1)]).map((s) => s.span)).toEqual([{ start: 0, end: 2500 }]);
		// Near the end, the zoom arrives earlier rather than holding too briefly.
		expect(plan([click(4800, 0.9, 0.9)]).map((s) => s.span)).toEqual([{ start: 2500, end: 5000 }]);
	});
});

describe("buildAutoZoomSuggestions: hover, typing, popups", () => {
	// The pointer scanning a list of options top to bottom, slowly, without clicking.
	const scan = (fromMs: number, toMs: number) => {
		const out: CursorTelemetryPoint[] = [];
		for (let t = fromMs; t <= toMs; t += 33) {
			const u = (t - fromMs) / (toMs - fromMs);
			out.push({ timeMs: t, cx: 0.6 + 0.03 * Math.sin(u * 12), cy: 0.3 + 0.25 * u });
		}
		return out;
	};

	it("frames the whole explored area lightly, and holds it still", () => {
		const telemetry = take(
			rest(0, 2966, [0.2, 0.8]),
			sweep(3000, 3300, [0.2, 0.8], [0.6, 0.3]),
			scan(3333, 6333),
			sweep(6366, 6666, [0.6, 0.55], [0.1, 0.9]),
			rest(6700, 12000, [0.1, 0.9]),
		);
		const suggestions = plan(telemetry, 13000);
		expect(suggestions).toHaveLength(1);
		const [shot] = suggestions;
		expect(scaleOf(shot)).toBeCloseTo(1.3, 5);
		expect(shot.focus.cx).toBeCloseTo(0.6, 2);
		expect(shot.focus.cy).toBeCloseTo(0.425, 2);
		expect(shot.span.start).toBeLessThan(4000);
		expect(shot.span.end).toBeGreaterThan(6333);
	});

	it("does not zoom on a hand drifting while the speaker introduces the video", () => {
		// A slow 6% drift for three seconds, no click anywhere near it: the greeting of a real take.
		const telemetry = take(
			rest(0, 2966, [0.5, 0.48]),
			sweep(3000, 6000, [0.5, 0.48], [0.56, 0.48]),
			rest(6033, 12000, [0.56, 0.48]),
		);
		expect(plan(telemetry, 13000)).toEqual([]);
	});

	it("frames the menu the pointer explores, whole", () => {
		const menu = { x: 0.55, y: 0.25, width: 0.2, height: 0.4 };
		const telemetry = take(
			rest(0, 2966, [0.6, 0.27]),
			[signal(3000, { kind: "popup-open", id: "m", rect: menu }, [0.6, 0.27])],
			scan(3333, 6333),
			[signal(6400, { kind: "popup-close", id: "m" }, [0.6, 0.55])],
			rest(6433, 12000, [0.6, 0.55]),
		);
		const [shot] = plan(telemetry, 13000);
		expect(shot.focus.cx).toBeCloseTo(0.65, 5);
		expect(shot.focus.cy).toBeCloseTo(0.45, 5);
	});

	it("holds the shot while the user types after clicking a field, framing the field", () => {
		const field = { x: 0.3, y: 0.48, width: 0.3, height: 0.04 };
		const keys = Array.from({ length: 16 }, (_, i) =>
			signal(4400 + i * 300, { kind: "key" }, [0.35, 0.5]),
		);
		const telemetry = take(
			rest(0, 3966, [0.35, 0.5]),
			[press(4000, 0.35, 0.5, field, 50004)],
			keys,
			rest(4033, 14000, [0.35, 0.5]),
		);
		const [shot] = plan(telemetry, 16000);
		const lastKey = 4400 + 15 * 300;
		expect(shot.span.end).toBe(lastKey + SHOT_TAIL_MS);
		expect(shot.focus.cx).toBeCloseTo(0.45, 5);
		// Shortcuts are not typing: the same keys as chords do not hold it.
		const chords = keys.map((k) => ({ ...k, input: { kind: "key" as const, combo: "Ctrl+Z" } }));
		const [short] = plan(
			take(rest(0, 3966, [0.35, 0.5]), [press(4000, 0.35, 0.5, field, 50004)], chords),
			16000,
		);
		expect(short.span.end).toBe(4000 + SHOT_TAIL_MS);
	});

	it("frames the popup a click opens from the start, so it never re-frames", () => {
		const popup = { x: 0.3, y: 0.32, width: 0.2, height: 0.3 };
		const telemetry = take(
			rest(0, 3966, [0.3, 0.3]),
			[click(4000, 0.3, 0.3)],
			[signal(4150, { kind: "popup-open", id: "p", rect: popup }, [0.3, 0.3])],
			sweep(4200, 5000, [0.3, 0.3], [0.4, 0.5]),
			[click(5200, 0.4, 0.5)],
			[signal(5300, { kind: "popup-close", id: "p" }, [0.4, 0.5])],
			rest(5333, 12000, [0.4, 0.5]),
		);
		const suggestions = plan(telemetry, 13000);
		expect(suggestions).toHaveLength(1);
		expect(suggestions[0].focus.cx).toBeCloseTo(0.4, 5);
		expect(suggestions[0].focus.cy).toBeCloseTo(0.46, 5);
		expect(suggestions[0].span.start).toBeLessThanOrEqual(4000 - SHOT_LEAD_MS);
	});

	it("eases back out once nothing moves for a while, even with a popup still open", () => {
		const popup = { x: 0.3, y: 0.32, width: 0.2, height: 0.3 };
		const idle = plan(
			take(
				[click(4000, 0.3, 0.3)],
				[signal(4100, { kind: "popup-open", id: "p", rect: popup }, [0.3, 0.3])],
				rest(4133, 15000, [0.3, 0.3]),
			),
			16000,
		);
		expect(idle[0].span.end).toBe(4100 + SHOT_TAIL_MS);
	});

	it("goes wide instead of zooming into a click that replaces most of the screen", () => {
		const page = { x: 0, y: 0.05, width: 1, height: 0.9 };
		const navigation = plan(
			take(
				[click(4000, 0.3, 0.3)],
				[signal(4300, { kind: "popup-open", id: "w", rect: page }, [0.3, 0.3])],
				rest(4333, 12000, [0.3, 0.3]),
			),
			13000,
		);
		expect(navigation).toEqual([]);
		// Inside a shot, the navigation ends it straight away.
		const [shot] = plan(
			take(
				[click(4000, 0.3, 0.3)],
				rest(4033, 5466, [0.31, 0.3]),
				[click(5500, 0.32, 0.31)],
				[signal(5700, { kind: "popup-open", id: "w", rect: page }, [0.32, 0.31])],
				rest(5733, 12000, [0.32, 0.31]),
			),
			13000,
		);
		expect(shot.span.end).toBe(5500 + NAVIGATION_HOLD_MS);
	});
});

describe("buildAutoZoomSuggestionsForClips", () => {
	const clip = (
		id: string,
		assetId: string,
		sourceStartSec: number,
		sourceEndSec: number,
		timelineStartSec: number,
	): AxcutClip => ({
		id,
		assetId,
		sourceStartSec,
		sourceEndSec,
		timelineStartSec,
		timelineEndSec: timelineStartSec + (sourceEndSec - sourceStartSec),
		wordRefs: [],
		origin: "user",
		reason: "",
	});
	const telemetryOf = (samples: CursorTelemetryPoint[], assetId = "a1") =>
		new Map([[assetId, samples]]);

	// The bug this covers: telemetry is in the recording's SOURCE time, zoom regions are
	// authored in RAW TIMELINE ms, and the two only coincide for a single clip starting at
	// 0. Every other layout put all the zooms on the first clip's stretch of ruler.
	it("gives a click to EVERY clip that replays it, not just the first", () => {
		// One recording, laid down twice: source 0-10 at ruler 0-10, then again at 10-20.
		const suggestions = buildAutoZoomSuggestionsForClips({
			telemetryByAssetId: telemetryOf([click(5000, 0.3, 0.7), { timeMs: 9500, cx: 0.3, cy: 0.7 }]),
			clips: [clip("clip_1", "a1", 0, 10, 0), clip("clip_2", "a1", 0, 10, 10)],
			existingRegions: [],
		});
		expect(suggestions.map((s) => s.span)).toEqual([
			{ start: 4300, end: 7000 }, // clip_1: source 5s sits at ruler 5s
			{ start: 14300, end: 17000 }, // clip_2: the SAME source 5s sits at ruler 15s
		]);
		for (const suggestion of suggestions) {
			expect(suggestion.focus).toEqual({ cx: 0.3, cy: 0.7 });
		}
	});

	it("shifts a click by the clip's own source in-point", () => {
		// A clip that starts 30s into the recording: source 35s is ruler 5s.
		const suggestions = buildAutoZoomSuggestionsForClips({
			telemetryByAssetId: telemetryOf([
				click(35000, 0.5, 0.5),
				{ timeMs: 60000, cx: 0.6, cy: 0.4 },
			]),
			clips: [clip("clip_1", "a1", 30, 40, 0)],
			existingRegions: [],
		});
		expect(suggestions.map((s) => s.span)).toEqual([{ start: 4300, end: 7000 }]);
	});

	it("ignores a click that falls outside every clip's source window", () => {
		const suggestions = buildAutoZoomSuggestionsForClips({
			telemetryByAssetId: telemetryOf([
				click(45000, 0.5, 0.5),
				{ timeMs: 60000, cx: 0.6, cy: 0.4 },
			]),
			clips: [clip("clip_1", "a1", 0, 10, 0)],
			existingRegions: [],
		});
		expect(suggestions).toEqual([]);
	});

	it("reserves an existing zoom on the clip it actually sits on, and only there", () => {
		const suggestions = buildAutoZoomSuggestionsForClips({
			telemetryByAssetId: telemetryOf([click(5000, 0.5, 0.5), { timeMs: 9500, cx: 0.5, cy: 0.5 }]),
			clips: [clip("clip_1", "a1", 0, 10, 0), clip("clip_2", "a1", 0, 10, 10)],
			existingRegions: [{ startMs: 4500, endMs: 5500 }],
		});
		expect(suggestions.map((s) => s.span)).toEqual([{ start: 14300, end: 17000 }]);
	});

	it("only reads the clips of the recordings it has telemetry for", () => {
		const suggestions = buildAutoZoomSuggestionsForClips({
			telemetryByAssetId: telemetryOf(
				[click(5000, 0.5, 0.5), { timeMs: 9500, cx: 0.5, cy: 0.5 }],
				"a2",
			),
			clips: [clip("clip_1", "a1", 0, 10, 0), clip("clip_2", "a2", 0, 10, 10)],
			existingRegions: [],
		});
		expect(suggestions.map((s) => s.span)).toEqual([{ start: 14300, end: 17000 }]);
	});

	it("skips a clip whose duration has not been probed yet", () => {
		const suggestions = buildAutoZoomSuggestionsForClips({
			telemetryByAssetId: telemetryOf([click(4000, 0.5, 0.5), { timeMs: 9500, cx: 0.6, cy: 0.4 }]),
			clips: [clip("clip_1", "a1", 0, 0, 0)],
			existingRegions: [],
		});
		expect(suggestions).toEqual([]);
	});

	it("zooms a clip whose source window trims the telemetry down to a single click", () => {
		const suggestions = buildAutoZoomSuggestionsForClips({
			telemetryByAssetId: telemetryOf([
				{ timeMs: 5000, cx: 0.1, cy: 0.9 },
				click(35000, 0.5, 0.5),
				{ timeMs: 60000, cx: 0.1, cy: 0.9 },
			]),
			clips: [clip("clip_1", "a1", 30, 40, 0)],
			existingRegions: [],
		});
		expect(suggestions.map((s) => [s.span, s.focus])).toEqual([
			[
				{ start: 4300, end: 7000 },
				{ cx: 0.5, cy: 0.5 },
			],
		]);
	});

	it("does not hold a zoom across a cut: of two clips' clashing zooms, one stays", () => {
		const suggestions = buildAutoZoomSuggestionsForClips({
			telemetryByAssetId: new Map([
				["a1", [click(7000, 0.5, 0.5), { timeMs: 9900, cx: 0.5, cy: 0.5 }]],
				["a2", [click(1000, 0.5, 0.5), { timeMs: 9900, cx: 0.5, cy: 0.5 }]],
			]),
			clips: [clip("clip_1", "a1", 0, 10, 0), clip("clip_2", "a2", 0, 10, 10)],
			existingRegions: [],
		});
		expect(suggestions.map((s) => s.span)).toEqual([{ start: 6300, end: 9000 }]);
	});

	// The video opens and closes on the whole screen. At 1.5× a ramp lasts 1.1 s, so a zoom is
	// fully in at 2500 + 1100 → 3600 ms at the earliest, and on a 10 s edit it must be back out
	// by 10000 − 1000 → 9000 ms, so fully in until 7900 ms at the latest.
	describe("wide opening and ending", () => {
		const restOfTake = { timeMs: 30000, cx: 0.5, cy: 0.5 };

		it("keeps the first seconds of the edit wide: an early click gets no zoom", () => {
			const suggestions = buildAutoZoomSuggestionsForClips({
				telemetryByAssetId: telemetryOf([click(1000, 0.3, 0.3), restOfTake]),
				clips: [clip("clip_1", "a1", 0, 10, 0)],
				existingRegions: [],
			});
			expect(suggestions).toEqual([]);
		});

		it("holds a zoom back until the opening is over when it still covers its click", () => {
			const suggestions = buildAutoZoomSuggestionsForClips({
				telemetryByAssetId: telemetryOf([click(3700, 0.3, 0.3), restOfTake]),
				clips: [clip("clip_1", "a1", 0, 10, 0)],
				existingRegions: [],
			});
			expect(suggestions.map((s) => s.span)).toEqual([{ start: 3600, end: 6100 }]);
		});

		it("brings the last zoom back out a second before the end of the edit", () => {
			const zoomed = buildAutoZoomSuggestionsForClips({
				telemetryByAssetId: telemetryOf([click(7000, 0.3, 0.3), restOfTake]),
				clips: [clip("clip_1", "a1", 0, 10, 0)],
				existingRegions: [],
			});
			expect(zoomed.map((s) => s.span)).toEqual([{ start: 5400, end: 7900 }]);
			const tooLate = buildAutoZoomSuggestionsForClips({
				telemetryByAssetId: telemetryOf([click(8500, 0.3, 0.3), restOfTake]),
				clips: [clip("clip_1", "a1", 0, 10, 0)],
				existingRegions: [],
			});
			expect(tooLate).toEqual([]);
		});

		it("lets a clip after a cut open on a zoom: the bounds belong to the edit", () => {
			const suggestions = buildAutoZoomSuggestionsForClips({
				telemetryByAssetId: telemetryOf([
					click(1000, 0.3, 0.3),
					{ timeMs: 9500, cx: 0.3, cy: 0.3 },
				]),
				clips: [clip("clip_1", "a1", 0, 10, 0), clip("clip_2", "a1", 0, 10, 10)],
				existingRegions: [],
			});
			expect(suggestions.map((s) => s.span)).toEqual([{ start: 10300, end: 13000 }]);
		});

		it("ignores the click that stopped the recording", () => {
			const suggestions = buildAutoZoomSuggestionsForClips({
				telemetryByAssetId: telemetryOf([
					click(6000, 0.3, 0.3),
					click(19800, 0.5, 0.92),
					{ timeMs: 19900, cx: 0.5, cy: 0.92 },
				]),
				clips: [clip("clip_1", "a1", 0, 20, 0), clip("clip_2", "a2", 0, 20, 20)],
				existingRegions: [],
			});
			expect(suggestions.map((s) => s.focus)).toEqual([{ cx: 0.3, cy: 0.3 }]);
		});

		it("ignores the pointer resting on Stop before that click", () => {
			const hover = Array.from({ length: 34 }, (_, i) => ({
				timeMs: 18800 + i * 33,
				cx: 0.5,
				cy: 0.92,
			}));
			const suggestions = buildAutoZoomSuggestionsForClips({
				telemetryByAssetId: telemetryOf([
					click(6000, 0.3, 0.3),
					...hover,
					click(19800, 0.5, 0.92),
					{ timeMs: 19900, cx: 0.5, cy: 0.92 },
				]),
				clips: [clip("clip_1", "a1", 0, 20, 0), clip("clip_2", "a2", 0, 20, 20)],
				existingRegions: [],
			});
			expect(suggestions.map((s) => s.focus)).toEqual([{ cx: 0.3, cy: 0.3 }]);
		});
	});
});
