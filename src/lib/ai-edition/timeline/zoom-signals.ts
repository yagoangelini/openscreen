// What a take recorded, read for the automatic zooms: the pointer's path, its clicks and the
// input signals around them (`inputSignals.ts`), the popups UI Automation saw, and what the
// frames show changing (`screenActivity.ts`). Plus the frame geometry the planner reasons in.
// Pure, no DOM/IPC.

import type { CursorTelemetryPoint, ZoomFocus } from "@/components/video-editor/types";
import type { CursorInputSignal, NormalizedRect } from "@/lib/cursor/inputSignals";
import type { ScreenActivityStep, ScreenChangeBox } from "./screenActivity";

// ── Geometry ────────────────────────────────────────────────────────────────

/** A box in frame fractions: 0..1 on both axes. */
export interface Box {
	minX: number;
	maxX: number;
	minY: number;
	maxY: number;
}

export function boxAround(focus: ZoomFocus, pad = 0): Box {
	return {
		minX: Math.max(0, focus.cx - pad),
		maxX: Math.min(1, focus.cx + pad),
		minY: Math.max(0, focus.cy - pad),
		maxY: Math.min(1, focus.cy + pad),
	};
}

export function boxOfRect(rect: NormalizedRect | ScreenChangeBox): Box {
	return {
		minX: Math.max(0, rect.x),
		maxX: Math.min(1, rect.x + rect.width),
		minY: Math.max(0, rect.y),
		maxY: Math.min(1, rect.y + rect.height),
	};
}

export function union(a: Box, b: Box): Box {
	return {
		minX: Math.min(a.minX, b.minX),
		maxX: Math.max(a.maxX, b.maxX),
		minY: Math.min(a.minY, b.minY),
		maxY: Math.max(a.maxY, b.maxY),
	};
}

export function intersect(a: Box, b: Box): Box | null {
	const box = {
		minX: Math.max(a.minX, b.minX),
		maxX: Math.min(a.maxX, b.maxX),
		minY: Math.max(a.minY, b.minY),
		maxY: Math.min(a.maxY, b.maxY),
	};
	return box.minX <= box.maxX && box.minY <= box.maxY ? box : null;
}

export function centreOf(box: Box): ZoomFocus {
	return { cx: (box.minX + box.maxX) / 2, cy: (box.minY + box.maxY) / 2 };
}

export function widthOf(box: Box): number {
	return box.maxX - box.minX;
}

export function heightOf(box: Box): number {
	return box.maxY - box.minY;
}

export function areaOf(box: Box): number {
	return Math.max(0, widthOf(box)) * Math.max(0, heightOf(box));
}

export function rectArea(rect: NormalizedRect): number {
	return areaOf(boxOfRect(rect));
}

export function rectContains(rect: NormalizedRect, point: ZoomFocus, slack = 0.01): boolean {
	return (
		point.cx >= rect.x - slack &&
		point.cx <= rect.x + rect.width + slack &&
		point.cy >= rect.y - slack &&
		point.cy <= rect.y + rect.height + slack
	);
}

export function distance(a: ZoomFocus, b: ZoomFocus): number {
	return Math.hypot(a.cx - b.cx, a.cy - b.cy);
}

/** How far `point` is from `box` (0 inside it). */
export function distanceToBox(point: ZoomFocus, box: Box): number {
	const dx = Math.max(box.minX - point.cx, 0, point.cx - box.maxX);
	const dy = Math.max(box.minY - point.cy, 0, point.cy - box.maxY);
	return Math.hypot(dx, dy);
}

/**
 * The deepest scale that shows the whole box with `margin` around it, per side. No margin past
 * the frame's edge: a menu at the top-left has nothing to keep clear above or beside it, and
 * the view is clamped to the frame anyway.
 */
export function fitScale(box: Box, margin: number): number {
	const side = (lo: number, hi: number) =>
		hi - lo + Math.min(margin, Math.max(0, lo)) + Math.min(margin, Math.max(0, 1 - hi));
	const size = Math.max(side(box.minX, box.maxX), side(box.minY, box.maxY), 1e-3);
	return 1 / size;
}

/** The view a zoom at `scale` framing `box` really shows: centred on it, kept inside the frame. */
export function viewOf(box: Box, scale: number): Box {
	const half = 0.5 / Math.max(1, scale);
	const centre = centreOf(box);
	const clampAxis = (v: number) => Math.min(1 - half, Math.max(half, v));
	const cx = clampAxis(centre.cx);
	const cy = clampAxis(centre.cy);
	return { minX: cx - half, maxX: cx + half, minY: cy - half, maxY: cy + half };
}

/** `inner` lies inside `outer`, shrunk by `inset` per side. */
export function boxInside(inner: Box, outer: Box, inset = 0): boolean {
	return (
		inner.minX >= outer.minX + inset - 1e-9 &&
		inner.maxX <= outer.maxX - inset + 1e-9 &&
		inner.minY >= outer.minY + inset - 1e-9 &&
		inner.maxY <= outer.maxY - inset + 1e-9
	);
}

export function pointInside(point: ZoomFocus, box: Box, inset = 0): boolean {
	return (
		point.cx >= box.minX + inset &&
		point.cx <= box.maxX - inset &&
		point.cy >= box.minY + inset &&
		point.cy <= box.maxY - inset
	);
}

/**
 * `rect` as much of it as lies within `reach` of `point`: a tall menu contributes the part near
 * the pointer, not all of it. The camera follows the hand down it rather than fitting it whole.
 */
export function rectNear(rect: NormalizedRect | ScreenChangeBox, point: ZoomFocus, reach: number) {
	return intersect(boxOfRect(rect), boxAround(point, reach));
}

// ── Telemetry ───────────────────────────────────────────────────────────────

function normalizeTelemetrySample(
	sample: CursorTelemetryPoint,
	totalMs: number,
): CursorTelemetryPoint {
	return {
		timeMs: Math.max(0, Math.min(sample.timeMs, totalMs)),
		cx: Math.max(0, Math.min(sample.cx, 1)),
		cy: Math.max(0, Math.min(sample.cy, 1)),
		visible: sample.visible,
		interactionType: sample.interactionType,
		...(sample.input ? { input: sample.input } : {}),
		...(sample.cursorType ? { cursorType: sample.cursorType } : {}),
	};
}

export function normalizeCursorTelemetry(
	telemetry: CursorTelemetryPoint[],
	totalMs: number,
): CursorTelemetryPoint[] {
	return [...telemetry]
		.filter(
			(sample) =>
				Number.isFinite(sample.timeMs) && Number.isFinite(sample.cx) && Number.isFinite(sample.cy),
		)
		.sort((a, b) => a.timeMs - b.timeMs)
		.map((sample) => normalizeTelemetrySample(sample, totalMs));
}

export type PressSignal = Extract<CursorInputSignal, { kind: "press" }>;

export interface RecordedClick {
	timeMs: number;
	focus: ZoomFocus;
	press?: PressSignal;
}

/** The recorded interactions that count as a click; `move` and `mouseup` do not. */
const CLICK_INTERACTION_TYPES: ReadonlySet<NonNullable<CursorTelemetryPoint["interactionType"]>> =
	new Set(["click", "double-click", "right-click", "middle-click"]);

/**
 * The clicks a viewer sees (issue #699), at the click's own time and position. A press the
 * cursor hides during is a drag the app took over, a slider or a scrubbed field, not a click.
 */
export function detectClicks(samples: CursorTelemetryPoint[]): RecordedClick[] {
	const clicks: RecordedClick[] = [];
	// A press without its own mouse-up sample has no known release: PipeWire and older sidecars
	// record none, and the Windows and macOS samplers fold a release into the press sample when both
	// land in one tick. A hidden sample on the next sampler tick still identifies a slider press; a
	// much later hidden interval (typing, leaving the display) must not erase a completed click.
	const UNRELEASED_PRESS_GRACE_MS = 150;

	let pendingClick: CursorTelemetryPoint | null = null;
	let hiddenAtMs: number | null = null;
	const finishPress = (released: boolean) => {
		if (!pendingClick) return;
		const hiddenDuringPress =
			hiddenAtMs !== null &&
			(released || hiddenAtMs - pendingClick.timeMs <= UNRELEASED_PRESS_GRACE_MS);
		if (!hiddenDuringPress) {
			const press = pendingClick.input?.kind === "press" ? pendingClick.input : undefined;
			clicks.push({
				timeMs: pendingClick.timeMs,
				focus: { cx: pendingClick.cx, cy: pendingClick.cy },
				...(press ? { press } : {}),
			});
		}
		pendingClick = null;
		hiddenAtMs = null;
	};

	for (const sample of samples) {
		if (sample.interactionType && CLICK_INTERACTION_TYPES.has(sample.interactionType)) {
			finishPress(false);
			pendingClick = sample.visible === false ? null : sample;
		} else if (sample.interactionType === "mouseup") {
			// Sampled after the release: its visibility says nothing about the press.
			finishPress(true);
		} else if (pendingClick && sample.visible === false && hiddenAtMs === null) {
			hiddenAtMs = sample.timeMs;
		}
	}
	finishPress(false);
	return clicks;
}

/** When the recording stopped: its telemetry runs until the take ends. */
export function lastSampleMs(samples: CursorTelemetryPoint[]): number {
	let last = 0;
	for (const sample of samples) {
		if (Number.isFinite(sample.timeMs)) last = Math.max(last, sample.timeMs);
	}
	return last;
}

export interface Popup {
	openMs: number;
	closeMs: number;
	rect: NormalizedRect;
}

/** A popup gone again this fast is a tooltip flashing past, not something shown. */
const POPUP_MIN_LIFE_MS = 150;

export interface Signals {
	/** Visible samples, for the pointer's path. */
	path: CursorTelemetryPoint[];
	clicks: RecordedClick[];
	/** Plain key-downs (a chord is a shortcut, not typing). */
	keys: number[];
	wheels: number[];
	popups: Popup[];
	/** What the frames show changing, on the same axis; empty when the take was not scanned. */
	activity: ScreenActivityStep[];
	/** Whether the frames were scanned at all (an empty scan is a still screen). */
	scanned: boolean;
}

export function readSignals(
	samples: CursorTelemetryPoint[],
	options: {
		ignoreClicksFromMs: number;
		/** Clicks this close before one of these times are on the HUD (a layout switch). */
		hudActionsMs?: readonly number[];
		activity?: readonly ScreenActivityStep[];
	},
): Signals {
	const keys: number[] = [];
	const wheels: number[] = [];
	const open = new Map<string, Popup>();
	const popups: Popup[] = [];
	for (const sample of samples) {
		const input = sample.input;
		if (!input) continue;
		if (input.kind === "key" && !input.combo) keys.push(sample.timeMs);
		else if (input.kind === "wheel") wheels.push(sample.timeMs);
		else if (input.kind === "popup-open") {
			const popup = { openMs: sample.timeMs, closeMs: Number.POSITIVE_INFINITY, rect: input.rect };
			open.set(input.id, popup);
			popups.push(popup);
		} else if (input.kind === "popup-close") {
			const popup = open.get(input.id);
			if (popup) {
				popup.closeMs = sample.timeMs;
				open.delete(input.id);
			}
		}
	}
	const hud = options.hudActionsMs ?? [];
	return {
		path: samples.filter((sample) => sample.visible !== false),
		clicks: detectClicks(samples).filter(
			(click) =>
				click.timeMs < options.ignoreClicksFromMs &&
				// A click right before the camera layout switched pressed the HUD's own button: the
				// HUD is never in the video, so there is nothing there to show.
				!hud.some((at) => at - click.timeMs >= -50 && at - click.timeMs <= 700),
		),
		keys,
		wheels,
		popups: popups.filter((popup) => popup.closeMs - popup.openMs >= POPUP_MIN_LIFE_MS),
		activity: [...(options.activity ?? [])].sort((a, b) => a.t - b.t),
		scanned: options.activity !== undefined,
	};
}

/** Index of the last sample at or before `timeMs` (binary search), or -1. */
export function sampleIndexAt(path: CursorTelemetryPoint[], timeMs: number): number {
	let lo = 0;
	let hi = path.length - 1;
	let found = -1;
	while (lo <= hi) {
		const mid = (lo + hi) >>> 1;
		if (path[mid].timeMs <= timeMs) {
			found = mid;
			lo = mid + 1;
		} else {
			hi = mid - 1;
		}
	}
	return found;
}

export function pointAt(
	path: CursorTelemetryPoint[],
	timeMs: number,
	fallback: ZoomFocus,
): ZoomFocus {
	const i = sampleIndexAt(path, timeMs);
	return i < 0 ? fallback : { cx: path[i].cx, cy: path[i].cy };
}

/** The steps of `activity` in `[fromMs, toMs]` (binary search on the sorted steps). */
export function stepsBetween(
	activity: readonly ScreenActivityStep[],
	fromMs: number,
	toMs: number,
): ScreenActivityStep[] {
	let lo = 0;
	let hi = activity.length;
	while (lo < hi) {
		const mid = (lo + hi) >>> 1;
		if (activity[mid].t < fromMs) lo = mid + 1;
		else hi = mid;
	}
	const out: ScreenActivityStep[] = [];
	for (let i = lo; i < activity.length && activity[i].t <= toMs; i += 1) out.push(activity[i]);
	return out;
}

/** The end of a burst of `times` that starts within `startWithinMs` of `fromMs`, each next
 *  one within `gapMs`, before `beforeMs`; with how many it holds. */
export function burstAfter(
	times: number[],
	fromMs: number,
	beforeMs: number,
	startWithinMs: number,
	gapMs: number,
): { startMs: number; endMs: number; count: number } | null {
	let startMs: number | null = null;
	let endMs: number | null = null;
	let count = 0;
	for (const time of times) {
		if (time < fromMs) continue;
		if (time >= beforeMs) break;
		if (endMs === null) {
			if (time - fromMs > startWithinMs) break;
			startMs = time;
		} else if (time - endMs > gapMs) {
			break;
		}
		endMs = time;
		count += 1;
	}
	return endMs === null || startMs === null ? null : { startMs, endMs, count };
}

/** Bursts of `times`: runs whose consecutive entries are at most `gapMs` apart. */
export function bursts(
	times: number[],
	gapMs: number,
): Array<{ startMs: number; endMs: number; count: number }> {
	const out: Array<{ startMs: number; endMs: number; count: number }> = [];
	for (const time of times) {
		const last = out[out.length - 1];
		if (last && time - last.endMs <= gapMs) {
			last.endMs = time;
			last.count += 1;
		} else {
			out.push({ startMs: time, endMs: time, count: 1 });
		}
	}
	return out;
}
