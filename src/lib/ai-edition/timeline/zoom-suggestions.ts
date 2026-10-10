// Cursor-telemetry-driven auto-zoom. Pure, no DOM/IPC.
//
// Ported from main's `src/components/video-editor/timeline/zoomSuggestionUtils.ts` (the legacy
// editor's "magic wand"), since rewritten as a planner, and rewritten again as a CALM one after
// the first real tutorial recorded with it: zooms "came in and out too fast" and "landed in the
// wrong place at the wrong time". This is NOT an AI feature: it is a deterministic pass over
// what a take recorded, which thinks in shots the way an editor would.
//
// The rules, in the order a viewer meets them:
// - The video opens and ends on the whole screen.
// - A zoom frames the whole ACTION, not the pointer: the clicked element (UI Automation), the
//   menu or popup it opens (WinEvents), the field being typed in, the list being scanned. The
//   camera then holds that framing; it does not chase the pointer (the camera mode decides how
//   it moves at render time, `zoom-motion.ts`).
// - It anticipates: the zoom starts with the hand's final approach to the target and is fully in
//   `SHOT_LEAD_MS` before the click.
// - Actions close in time whose union still fits share one held shot. A target too far for that
//   is reached with a smooth pan, never with a zoom out and back in; only a real pause brings
//   the camera back to the whole screen, and never for less than `MIN_WIDE_BETWEEN_MS`.
// - Hovering slowly over options without clicking (explaining a menu) gets a light zoom on the
//   whole explored area. Typing holds the shot on the field. A popup holds it while it is open.
// - The shot ends after a short tail, or as soon as the pointer travels away; a click that
//   changes most of the screen (a navigation) ends it at once rather than zooming into a page
//   that is gone.
//
// A take recorded without input signals (macOS, Linux, or a sidecar written before them) still
// plans on its clicks and the pointer's path alone.

import type { CursorTelemetryPoint, ZoomFocus } from "@/components/video-editor/types";
import {
	type CursorInputSignal,
	type NormalizedRect,
	UIA_CONTROL_TYPE,
} from "@/lib/cursor/inputSignals";
import { zoomTransitionMs } from "@/lib/zoomMath/constants";
import type { AxcutClip } from "../schema";
import {
	type AutoZoomSettings,
	autoZoomMotion,
	DEFAULT_AUTO_ZOOM_SETTINGS,
	motionTransitionSec,
} from "./zoom-motion";
import { DEFAULT_ZOOM_DEPTH, ZOOM_DEPTH_SCALES, type ZoomDepth } from "./zoom-scale";

/** The video opens on the whole screen: no zoom starts moving in before this. */
export const OPENING_WIDE_MS = 2500;
/** And it ends on it: the last zoom is fully back out this long before the end. */
export const CLOSING_WIDE_MS = 1000;
/**
 * A click this close to the end of the recording is the one that stopped it, on the HUD's
 * Stop button, which the video never shows. Any other click there has a result the video
 * never shows either.
 */
export const STOP_CLICK_GUARD_MS = 1000;
/** A zoom is fully in at the latest this long before its first click... */
export const SHOT_LEAD_MS = 700;
/** ...and up to this much earlier, when the hand starts its approach earlier. */
export const MAX_ANTICIPATION_MS = 800;
/** It holds this long after the last thing that happened in it, to show the result. */
export const SHOT_TAIL_MS = 2000;
/** A hover shot's tail: the pointer has already moved on when it ends. */
export const HOVER_TAIL_MS = 1000;
/** The shortest wide shot between two zooms, ramps excluded. Less reads as a yo-yo. */
export const MIN_WIDE_BETWEEN_MS = 2500;
/** Actions this close in time share one held shot, when their union fits in it. */
export const SHOT_MERGE_GAP_MS = 4000;
/** The margin kept around what a zoom frames, as a fraction of the frame. */
export const SHOT_FIT_MARGIN = 0.12;
/** A union must still fit at this scale (or the shot's own, if lower) to be one held shot. */
export const MERGE_MIN_SCALE = 1.5;
/** At most one camera move (ramp or pan) per this long. */
export const MIN_CAMERA_MOVE_GAP_MS = 1500;
/** A pan only when the next target leaves this central share of the current view. */
export const PAN_CENTRAL_SHARE = 0.6;
/** No action and no movement for this long: the hold is over. */
export const IDLE_RELEASE_MS = 2500;
/** The pointer travelling this far (share of the frame) without a click ends the shot. */
export const TRAVEL_END_SHARE = 0.35;
/** A popup or a change covering more of the frame than this is a navigation, not a menu. */
export const NAVIGATION_AREA = 0.45;
/** After a navigation click, the shot holds this long, then goes wide. */
export const NAVIGATION_HOLD_MS = 400;
/** A popup opening this long after a click is that click's doing. */
export const POPUP_AFTER_CLICK_MS = 1200;
/** A popup holds the shot at most this long. */
export const POPUP_HOLD_CAP_MS = 6000;
/** Typing: the first key within this long of the click... */
export const TYPING_START_MS = 2000;
/** ...and each next one within this long of the previous one... */
export const TYPING_GAP_MS = 1500;
/** ...at least this many plain keys. A lone shortcut is no typing. */
export const TYPING_MIN_KEYS = 3;
/** Hover: the pointer moving slower than this (frame widths per second)... */
export const HOVER_MAX_SPEED = 0.3;
/** ...for at least this long... */
export const HOVER_MIN_MS = 1500;
/** ...covering at least this much path (a pointer at rest is no reason to zoom)... */
export const HOVER_MIN_PATH = 0.05;
/** ...inside an area no larger than this on either axis. */
export const HOVER_MAX_EXTENT = 0.4;
/** The light zoom a hover gets. */
export const HOVER_SCALE = 1.3;
/** A shot that cannot zoom at least this much is not worth the camera move. */
export const MIN_USEFUL_SCALE = 1.15;
/** A single target whose element is smaller than this on both axes may zoom deeper... */
export const TIGHT_TARGET_SIDE = 0.15;
/** ...by this factor over the maximum. */
export const TIGHT_SCALE_FACTOR = 1.2;
/** The clicked element frames the shot only while it is a control, not a whole pane. */
export const TARGET_MAX_AREA = 0.12;
/** A text field frames a typing shot up to this size. */
export const TYPING_TARGET_MAX_AREA = 0.25;
/** The final approach: searched this far back from the click... */
export const APPROACH_WINDOW_MS = 3000;
/** ...it starts after the last rest (slower than this, frame widths per second)... */
export const APPROACH_REST_SPEED = 0.08;
/** ...of at least this long... */
export const APPROACH_REST_MS = 150;
/** ...not counting the settle on the target itself, within this radius of the click. */
export const APPROACH_SETTLE_RADIUS = 0.03;

export interface AutoZoomSuggestion {
	span: { start: number; end: number };
	focus: ZoomFocus;
	depth: ZoomDepth;
	/** The exact scale when it is not one of the depth table's. */
	customScale?: number;
}

/** A zoom already on the timeline: the plan keeps clear of it and never moves it. */
export interface ReservedZoom {
	startMs: number;
	endMs: number;
	/** Its effective scale, which sets how long its ramps last. The default depth's if omitted. */
	scale?: number;
	/** Its ramp length, when it moves with a motion of its own (an automatic zoom). */
	rampMs?: number;
}

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

type PressSignal = Extract<CursorInputSignal, { kind: "press" }>;

interface RecordedClick {
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
function detectClicks(samples: CursorTelemetryPoint[]): RecordedClick[] {
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
function lastSampleMs(samples: CursorTelemetryPoint[]): number {
	let last = 0;
	for (const sample of samples) {
		if (Number.isFinite(sample.timeMs)) last = Math.max(last, sample.timeMs);
	}
	return last;
}

// ── Geometry ────────────────────────────────────────────────────────────────

interface Box {
	minX: number;
	maxX: number;
	minY: number;
	maxY: number;
}

function boxAround(focus: ZoomFocus): Box {
	return { minX: focus.cx, maxX: focus.cx, minY: focus.cy, maxY: focus.cy };
}

function boxOfRect(rect: NormalizedRect): Box {
	return {
		minX: Math.max(0, rect.x),
		maxX: Math.min(1, rect.x + rect.width),
		minY: Math.max(0, rect.y),
		maxY: Math.min(1, rect.y + rect.height),
	};
}

function union(a: Box, b: Box): Box {
	return {
		minX: Math.min(a.minX, b.minX),
		maxX: Math.max(a.maxX, b.maxX),
		minY: Math.min(a.minY, b.minY),
		maxY: Math.max(a.maxY, b.maxY),
	};
}

function centreOf(box: Box): ZoomFocus {
	return { cx: (box.minX + box.maxX) / 2, cy: (box.minY + box.maxY) / 2 };
}

function rectArea(rect: NormalizedRect): number {
	const box = boxOfRect(rect);
	return Math.max(0, box.maxX - box.minX) * Math.max(0, box.maxY - box.minY);
}

function rectContains(rect: NormalizedRect, point: ZoomFocus, slack = 0.01): boolean {
	return (
		point.cx >= rect.x - slack &&
		point.cx <= rect.x + rect.width + slack &&
		point.cy >= rect.y - slack &&
		point.cy <= rect.y + rect.height + slack
	);
}

/** The deepest scale that shows the whole box with its margin. */
function fitScale(box: Box): number {
	const size = Math.max(box.maxX - box.minX, box.maxY - box.minY) + 2 * SHOT_FIT_MARGIN;
	return 1 / size;
}

function distance(a: ZoomFocus, b: ZoomFocus): number {
	return Math.hypot(a.cx - b.cx, a.cy - b.cy);
}

/** Where a view at `scale` framing `box` really sits: its centre, kept inside the frame. */
function viewOf(box: Box, scale: number): { centre: ZoomFocus; half: number } {
	const half = 0.5 / Math.max(1, scale);
	const clampAxis = (v: number) => Math.min(1 - half, Math.max(half, v));
	const centre = centreOf(box);
	return { centre: { cx: clampAxis(centre.cx), cy: clampAxis(centre.cy) }, half };
}

// ── Signals ─────────────────────────────────────────────────────────────────

interface Popup {
	openMs: number;
	closeMs: number;
	rect: NormalizedRect;
}

interface Signals {
	/** Visible samples, for the pointer's path. */
	path: CursorTelemetryPoint[];
	clicks: RecordedClick[];
	/** Plain key-downs (a chord is a shortcut, not typing). */
	keys: number[];
	wheels: number[];
	popups: Popup[];
}

function readSignals(samples: CursorTelemetryPoint[], ignoreClicksFromMs: number): Signals {
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
	return {
		path: samples.filter((sample) => sample.visible !== false),
		clicks: detectClicks(samples).filter((click) => click.timeMs < ignoreClicksFromMs),
		keys,
		wheels,
		popups,
	};
}

/** Index of the last sample at or before `timeMs` (binary search), or -1. */
function sampleIndexAt(path: CursorTelemetryPoint[], timeMs: number): number {
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

function pointAt(path: CursorTelemetryPoint[], timeMs: number, fallback: ZoomFocus): ZoomFocus {
	const i = sampleIndexAt(path, timeMs);
	return i < 0 ? fallback : { cx: path[i].cx, cy: path[i].cy };
}

/**
 * When the hand set off on its final approach to a click at `click`: after the last rest of at
 * least `APPROACH_REST_MS` before it, not counting the settle on the target itself. Null when the
 * pointer never left the target in the window (nothing to anticipate).
 */
function approachStartMs(path: CursorTelemetryPoint[], click: RecordedClick): number | null {
	const from = click.timeMs - APPROACH_WINDOW_MS;
	let i = sampleIndexAt(path, click.timeMs);
	while (
		i >= 0 &&
		path[i].timeMs >= from &&
		distance(path[i] as ZoomFocus, click.focus) <= APPROACH_SETTLE_RADIUS
	) {
		i -= 1;
	}
	if (i < 0 || path[i].timeMs < from) return null;
	let restEnd: number | null = null;
	let j = i;
	for (; j > 0 && path[j - 1].timeMs >= from; j -= 1) {
		const a = path[j - 1];
		const b = path[j];
		const dt = (b.timeMs - a.timeMs) / 1000;
		const speed = dt > 0 ? distance(a as ZoomFocus, b as ZoomFocus) / dt : 0;
		if (speed < APPROACH_REST_SPEED) {
			restEnd = restEnd ?? b.timeMs;
			if (restEnd - a.timeMs >= APPROACH_REST_MS) return restEnd;
		} else {
			restEnd = null;
		}
	}
	return Math.max(path[j].timeMs, from);
}

/** The first moment after `fromMs` the pointer is `share` of the frame away from `origin`. */
function travelAwayMs(
	path: CursorTelemetryPoint[],
	fromMs: number,
	untilMs: number,
	origin: ZoomFocus,
	share: number,
): number | null {
	for (let i = Math.max(0, sampleIndexAt(path, fromMs)); i < path.length; i += 1) {
		const sample = path[i];
		if (sample.timeMs > untilMs) break;
		if (sample.timeMs > fromMs && distance(sample as ZoomFocus, origin) > share) {
			return sample.timeMs;
		}
	}
	return null;
}

/** When the pointer last stops for `IDLE_RELEASE_MS` after `fromMs`: the start of that rest. */
function idleFromMs(path: CursorTelemetryPoint[], fromMs: number, untilMs: number): number | null {
	let restStart: number | null = null;
	let anchor: ZoomFocus | null = null;
	for (let i = Math.max(0, sampleIndexAt(path, fromMs)); i < path.length; i += 1) {
		const sample = path[i];
		if (sample.timeMs > untilMs) break;
		if (anchor && distance(sample as ZoomFocus, anchor) <= 0.01) {
			if (restStart !== null && sample.timeMs - restStart >= IDLE_RELEASE_MS) return restStart;
		} else {
			anchor = { cx: sample.cx, cy: sample.cy };
			restStart = Math.max(sample.timeMs, fromMs);
		}
	}
	return null;
}

/** The end of a burst of `times` that starts within `startWithinMs` of `fromMs`, each next
 *  one within `gapMs`, before `beforeMs`; with how many it holds. */
function burstAfter(
	times: number[],
	fromMs: number,
	beforeMs: number,
	startWithinMs: number,
	gapMs: number,
): { endMs: number; count: number } | null {
	let endMs: number | null = null;
	let count = 0;
	for (const time of times) {
		if (time < fromMs) continue;
		if (time >= beforeMs) break;
		if (endMs === null) {
			if (time - fromMs > startWithinMs) break;
		} else if (time - endMs > gapMs) {
			break;
		}
		endMs = time;
		count += 1;
	}
	return endMs === null ? null : { endMs, count };
}

// ── Actions ─────────────────────────────────────────────────────────────────

interface Action {
	kind: "click" | "hover";
	/** The click, or the start of a hover. */
	anchorMs: number;
	/** The zoom is fully in by then. */
	fullyInByMs: number;
	/** The last moment something happens in it (the click, the typing, the open popup). */
	activityEndMs: number;
	box: Box;
	/** The scale it asks for, before its box's fit. */
	wantScale: number;
	clicks: number;
	/** A click that changed most of the screen: the shot ends right after it. */
	navigation: boolean;
	/** Where the pointer is when the action is over, for the travel rule. */
	endPoint: ZoomFocus;
}

interface PlanContext {
	settings: AutoZoomSettings;
	rampMs: (scale: number) => number;
	minHoldMs: number;
}

function usableRect(rect: NormalizedRect | undefined, point: ZoomFocus, maxArea: number) {
	if (!rect || rectArea(rect) > maxArea || !rectContains(rect, point)) return undefined;
	return rect;
}

function clickAction(
	click: RecordedClick,
	nextClickMs: number,
	signals: Signals,
	ctx: PlanContext,
): Action {
	const at = click.timeMs;
	const maxScale = ctx.settings.maxScale;
	const target = usableRect(click.press?.target, click.focus, TARGET_MAX_AREA);
	let box = target ? union(boxAround(click.focus), boxOfRect(target)) : boxAround(click.focus);
	let navigation = false;
	let activityEndMs = at;
	let framedPopup = false;

	for (const popup of signals.popups) {
		const opened = popup.openMs >= at - 150 && popup.openMs <= at + POPUP_AFTER_CLICK_MS;
		const under =
			popup.openMs < at - 150 && popup.closeMs > at && rectContains(popup.rect, click.focus);
		if (!opened && !under) continue;
		if (rectArea(popup.rect) > NAVIGATION_AREA) {
			if (opened) navigation = true;
			continue;
		}
		// The menu enters the framing from the start: no re-frame when it opens.
		box = union(box, boxOfRect(popup.rect));
		framedPopup = true;
		if (opened) {
			const cap = Math.min(popup.closeMs, popup.openMs + POPUP_HOLD_CAP_MS);
			const idle = idleFromMs(signals.path, popup.openMs, cap);
			activityEndMs = Math.max(activityEndMs, idle ?? cap);
		}
	}

	// Typing into what was clicked holds the shot on it, framing the field when it is known.
	const typing = burstAfter(signals.keys, at, nextClickMs, TYPING_START_MS, TYPING_GAP_MS);
	let typed = false;
	if (typing && typing.count >= TYPING_MIN_KEYS) {
		typed = true;
		activityEndMs = Math.max(activityEndMs, typing.endMs);
		const field = usableRect(click.press?.target, click.focus, TYPING_TARGET_MAX_AREA);
		const textControl =
			click.press?.controlType === UIA_CONTROL_TYPE.edit ||
			click.press?.controlType === UIA_CONTROL_TYPE.document ||
			click.press?.controlType === UIA_CONTROL_TYPE.comboBox;
		if (field && (textControl || !target)) {
			const withField = union(box, boxOfRect(field));
			if (fitScale(withField) >= ZOOM_DEPTH_SCALES[1]) box = withField;
		}
	}

	// Scrolling inside what was just clicked (a long dropdown, a list) keeps it alive.
	const scroll = burstAfter(signals.wheels, at, nextClickMs, TYPING_START_MS, TYPING_GAP_MS);
	if (scroll) activityEndMs = Math.max(activityEndMs, scroll.endMs);

	const tight =
		!!target &&
		!framedPopup &&
		!typed &&
		target.width <= TIGHT_TARGET_SIDE &&
		target.height <= TIGHT_TARGET_SIDE;
	const wantScale = tight ? Math.min(2.2, maxScale * TIGHT_SCALE_FACTOR) : maxScale;

	// Anticipation: fully in SHOT_LEAD_MS before the click at the latest, earlier with the hand.
	const latest = at - SHOT_LEAD_MS;
	const approach = approachStartMs(signals.path, click);
	const ramp = ctx.rampMs(Math.min(wantScale, fitScale(box)));
	const fullyInByMs =
		approach === null
			? latest
			: Math.min(latest, Math.max(latest - MAX_ANTICIPATION_MS, approach + ramp));

	return {
		kind: "click",
		anchorMs: at,
		fullyInByMs,
		activityEndMs,
		box,
		wantScale,
		clicks: 1,
		navigation,
		endPoint: pointAt(signals.path, activityEndMs, click.focus),
	};
}

/**
 * Slow exploration without a click: the pointer scanning a menu or a list of options to show
 * them. A light zoom frames the whole area it covered (and the popup it was in), static.
 */
function hoverActions(signals: Signals, untilMs: number, ctx: PlanContext): Action[] {
	const { path, clicks } = signals;
	const actions: Action[] = [];
	const clickTimes = clicks.map((click) => click.timeMs);
	let runStart = -1;

	const closeRun = (endIndex: number) => {
		if (runStart < 0) return;
		const startIndex = runStart;
		runStart = -1;
		const first = path[startIndex];
		const last = path[endIndex];
		if (last.timeMs - first.timeMs < HOVER_MIN_MS) return;
		let box = boxAround(first as ZoomFocus);
		let travelled = 0;
		for (let i = startIndex + 1; i <= endIndex; i += 1) {
			box = union(box, boxAround(path[i] as ZoomFocus));
			travelled += distance(path[i - 1] as ZoomFocus, path[i] as ZoomFocus);
		}
		if (travelled < HOVER_MIN_PATH) return;
		if (box.maxX - box.minX > HOVER_MAX_EXTENT || box.maxY - box.minY > HOVER_MAX_EXTENT) return;
		// The menu or list it was scanning, whole.
		for (const popup of signals.popups) {
			if (popup.openMs <= last.timeMs && popup.closeMs >= first.timeMs) {
				const inside = rectContains(popup.rect, centreOf(box), 0.02);
				if (inside && rectArea(popup.rect) <= NAVIGATION_AREA)
					box = union(box, boxOfRect(popup.rect));
			}
		}
		const wantScale = Math.min(HOVER_SCALE, ctx.settings.maxScale);
		actions.push({
			kind: "hover",
			anchorMs: first.timeMs,
			// The zoom completes as the exploration settles in, not before the pointer arrives.
			fullyInByMs: first.timeMs + 400,
			activityEndMs: last.timeMs,
			box,
			wantScale,
			clicks: 0,
			navigation: false,
			endPoint: { cx: last.cx, cy: last.cy },
		});
	};

	let clickIndex = 0;
	let lastIndex = 0;
	for (let i = 1; i < path.length; i += 1) {
		const a = path[i - 1];
		const b = path[i];
		if (b.timeMs > untilMs) break;
		lastIndex = i;
		// A click splits a run: what comes before it is its approach, what follows its result.
		let clicked = false;
		while (clickIndex < clickTimes.length && clickTimes[clickIndex] <= b.timeMs) {
			if (clickTimes[clickIndex] > a.timeMs) clicked = true;
			clickIndex += 1;
		}
		const dt = (b.timeMs - a.timeMs) / 1000;
		const speed = dt > 0 ? distance(a as ZoomFocus, b as ZoomFocus) / dt : 0;
		if (clicked || speed > HOVER_MAX_SPEED || dt > 1) {
			closeRun(i - 1);
			if (!clicked && speed <= HOVER_MAX_SPEED) runStart = i;
			continue;
		}
		if (runStart < 0) runStart = i - 1;
	}
	if (runStart >= 0) closeRun(lastIndex);
	return actions;
}

// ── Shots ───────────────────────────────────────────────────────────────────

interface Shot {
	start: number;
	end: number;
	scale: number;
	box: Box;
	clicks: number;
	firstAnchorMs: number;
	lastAnchorMs: number;
	lastActivityMs: number;
	/** When the camera last moved into this framing (its ramp in, or the pan to it). */
	arrivedMs: number;
	/** Reached by a pan from the previous shot, not by a ramp from the whole screen. */
	chained: boolean;
	/** A navigation click ended it: it goes wide right after. */
	navigationEndMs?: number;
	endPoint: ZoomFocus;
	wantScale: number;
	actions: number;
	/** The latest it may end and still be back out before the axis's wide ending. */
	latestEnd: number;
	/** Two shots merge only on one clip: a zoom does not hold across a cut. */
	clip?: string;
}

function shotScale(shot: Pick<Shot, "box" | "wantScale">): number {
	return Math.min(shot.wantScale, fitScale(shot.box));
}

/** Groups the axis's actions into held shots, in time order. */
function groupShots(actions: Action[], ctx: PlanContext): Shot[] {
	const shots: Shot[] = [];
	let open: Shot | null = null;
	const mergeScale = Math.min(ctx.settings.maxScale, MERGE_MIN_SCALE);
	for (const action of [...actions].sort((a, b) => a.anchorMs - b.anchorMs)) {
		if (open && open.navigationEndMs === undefined) {
			const near = action.anchorMs - open.lastActivityMs <= SHOT_MERGE_GAP_MS;
			const box = union(open.box, action.box);
			// A deeper zoom is for a single tight target only: it never survives a merge.
			const maxScale = ctx.settings.maxScale;
			const want = Math.max(
				Math.min(open.wantScale, maxScale),
				Math.min(action.wantScale, maxScale),
			);
			if (near && fitScale(box) >= Math.min(mergeScale, want) - 1e-9) {
				open.box = box;
				open.wantScale = want;
				open.start = Math.min(open.start, action.fullyInByMs);
				open.clicks += action.clicks;
				open.actions += 1;
				open.lastAnchorMs = action.anchorMs;
				if (action.activityEndMs >= open.lastActivityMs) {
					open.lastActivityMs = action.activityEndMs;
					open.endPoint = action.endPoint;
				}
				if (action.navigation) open.navigationEndMs = action.anchorMs + NAVIGATION_HOLD_MS;
				continue;
			}
		}
		if (action.navigation) {
			// A page that is about to be replaced is no place to zoom into. A shot still holding
			// over it goes wide with it.
			if (open && action.anchorMs < open.lastActivityMs + SHOT_TAIL_MS) {
				open.navigationEndMs = Math.max(open.lastActivityMs, action.anchorMs) + NAVIGATION_HOLD_MS;
			}
			continue;
		}
		open = {
			start: action.fullyInByMs,
			end: action.activityEndMs,
			scale: 1,
			box: action.box,
			clicks: action.clicks,
			firstAnchorMs: action.anchorMs,
			lastAnchorMs: action.anchorMs,
			lastActivityMs: action.activityEndMs,
			arrivedMs: action.fullyInByMs,
			chained: false,
			endPoint: action.endPoint,
			wantScale: action.wantScale,
			actions: 1,
			latestEnd: Number.POSITIVE_INFINITY,
		};
		shots.push(open);
		open.start = action.fullyInByMs;
	}
	for (const shot of shots) shot.scale = shotScale(shot);
	return shots.filter((shot) => shot.scale >= MIN_USEFUL_SCALE);
}

/**
 * Times each shot inside the axis's bounds. `wideUntilMs` and `wideFromMs` keep the ends of the
 * video on the whole screen: a zoom starts moving in no earlier than the first and is back out
 * by the second, ramps included. A shot left too short a hold, or none of its actions, goes.
 */
function timeShots(
	shots: Shot[],
	path: CursorTelemetryPoint[],
	actionsTail: (shot: Shot) => number,
	totalMs: number,
	wideUntilMs: number,
	wideFromMs: number,
	ctx: PlanContext,
): Shot[] {
	const timed: Shot[] = [];
	for (const shot of shots) {
		const ramp = ctx.rampMs(shot.scale);
		const earliest = Math.max(0, Math.ceil(wideUntilMs + ramp));
		const latest = Math.min(totalMs, Math.floor(wideFromMs - ramp));
		const minHold = shot.navigationEndMs !== undefined ? 0 : ctx.minHoldMs;
		let end = shot.lastActivityMs + actionsTail(shot);
		// The pointer leaving for elsewhere ends the shot early: the tail would show nothing.
		const away = travelAwayMs(path, shot.lastActivityMs, end, shot.endPoint, TRAVEL_END_SHARE);
		if (away !== null) end = Math.min(end, away);
		if (shot.navigationEndMs !== undefined) end = Math.min(end, shot.navigationEndMs);
		// Near the end of the axis, the zoom arrives earlier rather than holding too briefly.
		const start = Math.max(Math.min(Math.round(shot.start), latest - minHold), earliest);
		end = Math.min(Math.max(Math.round(end), start + minHold), latest);
		if (end - start < Math.max(minHold, 1)) continue;
		// A zoom arriving after the fact shows nothing: after its last click, or, for a hover, too
		// late to show most of the exploration.
		const startBy =
			shot.clicks > 0 ? shot.lastAnchorMs : Math.max(shot.lastAnchorMs, shot.lastActivityMs - 1000);
		if (start > startBy || end < shot.firstAnchorMs) continue;
		timed.push({ ...shot, start, end, arrivedMs: start, latestEnd: latest });
	}
	return timed;
}

/** `inner` fits inside a view at `scale` framing `outer`, centred within its central share. */
function holdsIn(outer: Shot, inner: Box): boolean {
	const { centre, half } = viewOf(outer.box, outer.scale);
	const inside =
		inner.minX >= centre.cx - half &&
		inner.maxX <= centre.cx + half &&
		inner.minY >= centre.cy - half &&
		inner.maxY <= centre.cy + half;
	const c = centreOf(inner);
	const central = half * PAN_CENTRAL_SHARE;
	return inside && Math.abs(c.cx - centre.cx) <= central && Math.abs(c.cy - centre.cy) <= central;
}

/**
 * No yo-yo: two consecutive shots too close for a real wide shot between them are joined. The
 * next target still inside the current view, near its centre, extends the shot; one outside it
 * is reached with a pan that arrives when that shot wants to be fully in, leaving at least
 * `MIN_CAMERA_MOVE_GAP_MS` after the previous move. A pan that cannot make it in time is not
 * made: the next target is held if it is in view, otherwise it goes.
 */
function chainShots(shots: Shot[], ctx: PlanContext): Shot[] {
	const out: Shot[] = [];
	const panMs = ctx.settings.transitionSec * 1000;
	for (const shot of shots) {
		const prev = out[out.length - 1];
		if (!prev) {
			out.push({ ...shot });
			continue;
		}
		const wide = shot.start - ctx.rampMs(shot.scale) - (prev.end + ctx.rampMs(prev.scale));
		if (wide >= MIN_WIDE_BETWEEN_MS) {
			out.push({ ...shot });
			continue;
		}
		const absorb = () => {
			prev.end = Math.max(prev.end, shot.end);
			prev.clicks += shot.clicks;
			prev.lastAnchorMs = Math.max(prev.lastAnchorMs, shot.lastAnchorMs);
			prev.lastActivityMs = Math.max(prev.lastActivityMs, shot.lastActivityMs);
		};
		if (holdsIn(prev, shot.box)) {
			absorb();
			continue;
		}
		const panStart = Math.max(
			shot.start - panMs,
			prev.arrivedMs + MIN_CAMERA_MOVE_GAP_MS,
			prev.lastActivityMs + 300,
		);
		const arrive = Math.round(panStart + panMs);
		const end = Math.min(Math.max(shot.end, arrive + ctx.minHoldMs), shot.latestEnd);
		if (arrive > shot.firstAnchorMs + 200 || end - arrive < NAVIGATION_HOLD_MS) {
			const { centre, half } = viewOf(prev.box, prev.scale);
			const c = centreOf(shot.box);
			if (Math.abs(c.cx - centre.cx) <= half && Math.abs(c.cy - centre.cy) <= half) absorb();
			continue;
		}
		prev.end = Math.round(panStart);
		out.push({ ...shot, start: arrive, end, arrivedMs: arrive, chained: true });
	}
	return out;
}

interface Chain {
	shots: Shot[];
	clicks: number;
	clip?: string;
}

function toChains(shots: Shot[], clip?: string): Chain[] {
	const chains: Chain[] = [];
	for (const shot of shots) {
		const last = chains[chains.length - 1];
		const tagged = clip === undefined ? shot : { ...shot, clip };
		if (shot.chained && last) {
			last.shots.push(tagged);
			last.clicks += shot.clicks;
		} else {
			chains.push({ shots: [tagged], clicks: shot.clicks, clip });
		}
	}
	return chains;
}

/** Plans one axis (one clip's window, or a bare recording) into chains of shots. */
function planAxis(
	samples: CursorTelemetryPoint[],
	totalMs: number,
	wideUntilMs: number,
	wideFromMs: number,
	ignoreClicksFromMs: number,
	ctx: PlanContext,
	clip?: string,
): Chain[] {
	const signals = readSignals(normalizeCursorTelemetry(samples, totalMs), ignoreClicksFromMs);
	const actions: Action[] = signals.clicks.map((click, i) =>
		clickAction(click, signals.clicks[i + 1]?.timeMs ?? Number.POSITIVE_INFINITY, signals, ctx),
	);
	actions.push(...hoverActions(signals, Math.min(ignoreClicksFromMs, totalMs), ctx));
	const tailOf = (shot: Shot) => (shot.clicks > 0 ? SHOT_TAIL_MS : HOVER_TAIL_MS);
	const shots = timeShots(
		groupShots(actions, ctx),
		signals.path,
		tailOf,
		totalMs,
		wideUntilMs,
		wideFromMs,
		ctx,
	);
	return toChains(chainShots(shots, ctx), clip);
}

/**
 * Between chains (two clips, two recordings) and against the zooms already on the timeline: a
 * real wide shot or none at all. The chain with fewer clicks goes, the later one on a tie; a
 * zoom already on the timeline never moves, so a chain too close to it goes.
 *
 * ponytail: the gap is measured in timeline ms, while the renderer plays ramps on the screen
 * clock, so inside a speed region the real wide shot differs. Map through `screenTimeMs` if a
 * take with speed regions ever shows a yo-yo.
 */
function resolveChains(chains: Chain[], reserved: ReservedZoom[], ctx: PlanContext): Chain[] {
	const plan = [...chains];
	const fixed = reserved.map((zoom) => {
		const ramp =
			zoom.rampMs ?? zoomTransitionMs(zoom.scale ?? ZOOM_DEPTH_SCALES[DEFAULT_ZOOM_DEPTH]);
		return { start: zoom.startMs, end: zoom.endMs, rampIn: ramp, rampOut: ramp, chain: null };
	});
	for (;;) {
		const spans = [
			...plan.map((chain) => {
				const first = chain.shots[0];
				const last = chain.shots[chain.shots.length - 1];
				return {
					start: first.start,
					end: last.end,
					rampIn: ctx.rampMs(first.scale),
					rampOut: ctx.rampMs(last.scale),
					chain,
				};
			}),
			...fixed,
		].sort((a, b) => a.start - b.start);
		// Each span against the one before it that ends latest, ramp included: a long zoom
		// reaches past its neighbours, and two placed zooms may even overlap each other.
		const outOf = (span: (typeof spans)[number]) => span.end + span.rampOut;
		let reach: (typeof spans)[number] | undefined;
		let clash: [(typeof spans)[number], (typeof spans)[number]] | undefined;
		for (const span of spans) {
			if (reach && (reach.chain || span.chain)) {
				const wide = span.start - outOf(reach) - span.rampIn;
				if (wide < MIN_WIDE_BETWEEN_MS) {
					clash = [reach, span];
					break;
				}
			}
			if (!reach || outOf(span) > outOf(reach)) reach = span;
		}
		if (!clash) return plan;
		const a = clash[0].chain;
		const b = clash[1].chain;
		const loser = a && b ? (a.clicks >= b.clicks ? b : a) : (a ?? b);
		if (!loser) return plan; // unreachable: a clash always involves a chain
		plan.splice(plan.indexOf(loser), 1);
	}
}

const TABLE_DEPTHS: readonly ZoomDepth[] = [1, 2, 3, 4, 5, 6];

/** The depth table's level for `scale`, or the one below it plus the exact scale. */
function depthOf(scale: number): Pick<AutoZoomSuggestion, "depth" | "customScale"> {
	const rounded = Math.round(scale * 100) / 100;
	let depth: ZoomDepth = 1;
	for (const level of TABLE_DEPTHS) {
		if (Math.abs(ZOOM_DEPTH_SCALES[level] - rounded) < 0.005) return { depth: level };
		if (ZOOM_DEPTH_SCALES[level] <= rounded) depth = level;
	}
	return { depth, customScale: rounded };
}

function toSuggestions(chains: Chain[]): AutoZoomSuggestion[] {
	return chains
		.flatMap((chain) => chain.shots)
		.sort((a, b) => a.start - b.start)
		.map((shot) => ({
			span: { start: shot.start, end: shot.end },
			focus: centreOf(shot.box),
			...depthOf(shot.scale),
		}));
}

function contextOf(settings: AutoZoomSettings = DEFAULT_AUTO_ZOOM_SETTINGS): PlanContext {
	const motion = autoZoomMotion(settings);
	return {
		settings,
		rampMs: (scale) => motionTransitionSec(motion, scale) * 1000,
		minHoldMs: settings.holdSec * 1000,
	};
}

/**
 * Plan the zooms of one recording laid on the timeline from 0, straight from its telemetry.
 * `wideUntilMs` and `wideFromMs` are the video's opening and ending, `ignoreClicksFromMs` drops
 * the stop click; all three are on the telemetry's axis and default to no bound. A caller
 * holding an `AxcutDocument` wants `buildAutoZoomSuggestionsForClips`.
 */
export function buildAutoZoomSuggestions(options: {
	cursorTelemetry: CursorTelemetryPoint[];
	totalMs: number;
	existingRegions: ReservedZoom[];
	wideUntilMs?: number;
	wideFromMs?: number;
	ignoreClicksFromMs?: number;
	settings?: AutoZoomSettings;
}): AutoZoomSuggestion[] {
	const { cursorTelemetry, totalMs, existingRegions } = options;
	if (totalMs <= 0 || cursorTelemetry.length === 0) return [];
	const ctx = contextOf(options.settings);
	const chains = planAxis(
		cursorTelemetry,
		totalMs,
		options.wideUntilMs ?? Number.NEGATIVE_INFINITY,
		options.wideFromMs ?? Number.POSITIVE_INFINITY,
		options.ignoreClicksFromMs ?? Number.POSITIVE_INFINITY,
		ctx,
	);
	return toSuggestions(resolveChains(chains, existingRegions, ctx));
}

/**
 * The same planner, run over a TIMELINE instead of over a bare media file — and the only entry
 * point a caller holding an `AxcutDocument` should use.
 *
 * Cursor telemetry is recorded against the ORIGINAL media file, so `timeMs` is the asset's
 * SOURCE time (the same axis `cursor-track.ts` maps through `locateSourcePosition`, and the same
 * one trims are stored in). Zoom regions are authored in RAW TIMELINE ms — that is what
 * `anchorRegionsWithDerivedMs` ventilates across the clips. The two axes coincide for exactly
 * one layout: a single clip, starting at 0, covering the whole recording. Two clips over ONE
 * recording make it plain: the second replays source time the first already used, so a click
 * belongs to BOTH, and gets a zoom on each.
 *
 * So each clip reads only the samples inside its own source window, shifted onto the ruler: a
 * raw clip is identity between its source time and its raw-virtual time (see
 * timeline/timelineMap.ts). Shots are planned per clip, since a zoom does not hold across a cut,
 * then settled over the whole timeline at once, every recording included, against the zooms
 * already on it (`existingRegions`, RAW TIMELINE ms). Clips with no telemetry or no probed
 * source window get nothing.
 *
 * The wide opening and ending belong to the whole edit, not to each clip: a cut may land
 * straight on a zoom, but the video's first and last seconds show the whole screen. The stop
 * click belongs to its recording: that recording's last second.
 */
export function buildAutoZoomSuggestionsForClips(options: {
	/** Each recording's samples, in its own SOURCE time, by asset id. */
	telemetryByAssetId: ReadonlyMap<string, CursorTelemetryPoint[]>;
	clips: AxcutClip[];
	existingRegions: ReservedZoom[];
	settings?: AutoZoomSettings;
}): AutoZoomSuggestion[] {
	const { telemetryByAssetId, clips, existingRegions } = options;
	if (clips.length === 0) return [];
	const ctx = contextOf(options.settings);
	const editStartMs = Math.min(...clips.map((clip) => clip.timelineStartSec)) * 1000;
	const editEndMs = Math.max(...clips.map((clip) => clip.timelineEndSec)) * 1000;
	const chains: Chain[] = [];
	for (const clip of clips) {
		const telemetry = telemetryByAssetId.get(clip.assetId);
		const sourceEndSec = clip.sourceEndSec ?? clip.sourceStartSec;
		const windowMs = (sourceEndSec - clip.sourceStartSec) * 1000;
		if (!telemetry?.length || windowMs <= 0) continue;
		const sourceOffsetMs = clip.sourceStartSec * 1000;
		const timelineOffsetMs = clip.timelineStartSec * 1000;
		const clipTelemetry = telemetry
			.filter(
				(sample) => sample.timeMs >= sourceOffsetMs && sample.timeMs <= sourceOffsetMs + windowMs,
			)
			.map((sample) => ({ ...sample, timeMs: sample.timeMs - sourceOffsetMs }));
		if (clipTelemetry.length === 0) continue;
		const clipChains = planAxis(
			clipTelemetry,
			windowMs,
			editStartMs + OPENING_WIDE_MS - timelineOffsetMs,
			editEndMs - CLOSING_WIDE_MS - timelineOffsetMs,
			lastSampleMs(telemetry) - STOP_CLICK_GUARD_MS - sourceOffsetMs,
			ctx,
			clip.id,
		);
		for (const chain of clipChains) {
			chains.push({
				...chain,
				shots: chain.shots.map((shot) => ({
					...shot,
					start: shot.start + timelineOffsetMs,
					end: shot.end + timelineOffsetMs,
				})),
			});
		}
	}
	return toSuggestions(resolveChains(chains, existingRegions, ctx));
}
