// The automatic zooms' director: from what a take recorded to a list of shots. Pure, no DOM/IPC.
//
// Written after a real tutorial where the planner before it zoomed twice in 51 s and missed the
// whole Edge menu walkthrough: the menus opened on hover, nothing was clicked until the last
// item, and the tall menu could not be fitted in one zoom. It thinks the way an editor cuts a
// screen tutorial, in four passes:
//
// 1. BEATS. Every moment the viewer should look at one place: a click (what is pressed, and
//    apart from it, what the click opened), the pointer resting where the UI answers (a menu
//    opening on hover, a row lighting up, a tooltip, a hand over a link, the speaker saying
//    "aqui"), a slow sweep over a menu, typing. Each beat carries the box that must be seen
//    and the scale it deserves on its own: a small target is shown closer, a wide area gently.
//    The frames (`screenActivity.ts`) show what UI Automation cannot: a web page's menus, a
//    dialog over a dimmed page, a page replaced by the next (a navigation, which ends a shot).
// 2. SHOTS. The beats, in time order, are cut into shots by dynamic programming: every shot is
//    the one framing that shows all its beats, each beat loses what it is shown smaller than it
//    deserves, and every cut costs a camera move. So nearby beats share one calm framing, and a
//    target that needs it gets its own. A run of beats that no single framing holds, with the
//    hand moving through them, may be one shot that follows the pointer instead.
// 3. TIMING. A shot is fully in before its first action (the hand's approach, or the word that
//    announces it), holds while the user acts and talks, and ends after a short tail, as soon as
//    the pointer leaves the view, or right after the page it shows is replaced.
// 4. CAMERA. Between two shots the camera goes back to the whole screen only for a real wide
//    shot (the settings' minimum); otherwise it pans, zoomed, from one framing to the next, and
//    never moves twice within `MIN_CAMERA_MOVE_GAP_MS`. A page replaced by another gets a
//    moment of overview before the next zoom.

import type { CursorTelemetryPoint, ZoomFocus } from "@/components/video-editor/types";
import { type NormalizedRect, UIA_CONTROL_TYPE } from "@/lib/cursor/inputSignals";
import type { ScreenActivityStep, ScreenChangeBox } from "./screenActivity";
import {
	pointingWordsBetween,
	type Speech,
	scrollingWordBetween,
	sentenceAt,
	wordAt,
} from "./speechCues";
import type { AutoZoomSettings } from "./zoom-motion";
import {
	type Box,
	boxAround,
	boxInside,
	boxOfRect,
	burstAfter,
	bursts,
	centreOf,
	distance,
	distanceToBox,
	fitScale,
	heightOf,
	pointAt,
	pointInside,
	type RecordedClick,
	rectArea,
	rectContains,
	rectNear,
	type Signals,
	sampleIndexAt,
	stepsBetween,
	union,
	viewOf,
	widthOf,
} from "./zoom-signals";

// ── Tuning knobs ────────────────────────────────────────────────────────────

/** A zoom is fully in at the latest this long before its first click... */
export const SHOT_LEAD_MS = 700;
/** ...and up to this much earlier, when the hand starts its approach earlier. */
export const MAX_ANTICIPATION_MS = 800;
/** It holds this long after a click's result, to show it. */
export const SHOT_TAIL_MS = 2000;
/** A hover's tail: the pointer has already moved on when it ends. */
export const HOVER_TAIL_MS = 1000;
/** After picking an item from a menu that then closes: the shot ends soon. */
export const MENU_PICK_TAIL_MS = 700;
/** After a click that replaces the page, the shot holds this long, then goes wide. */
export const NAVIGATION_HOLD_MS = 400;
/** A zoom ended by a navigation shows what came before it at least this long, or is not made. */
export const NAVIGATION_MIN_SHOW_MS = 1500;
/** The whole new page is shown at least this long after a navigation, before the next zoom. */
export const OVERVIEW_MS = 1500;
/** The shortest wide shot between two zooms, ramps excluded. Less reads as a yo-yo. */
export const MIN_WIDE_BETWEEN_MS = 2500;
/** At most one camera move (ramp or pan) per this long. */
export const MIN_CAMERA_MOVE_GAP_MS = 1500;
/** A shot reached by a pan holds at least this long before the next pan. */
export const CHAIN_MIN_HOLD_MS = 1500;

/** The margin kept around what a zoom frames, per side, as a share of the frame. */
export const FRAME_MARGIN = 0.1;
/** A shot that cannot zoom at least this much is not worth the camera move. */
export const MIN_USEFUL_SCALE = 1.15;
/** A beat whose box is known (a control, a menu, a change seen in the frames, not just padding
 *  around a click) and at most this on both axes is a small target: it may be shown closer... */
export const SMALL_TARGET_SIDE = 0.3;
/** ...up to the settings' maximum times this... */
export const CLOSE_UP_FACTOR = 4 / 3;
/** ...and never past this. */
export const CLOSE_UP_MAX_SCALE = 2.2;

/** What a click frames at least, around the pointer, per side. */
export const CLICK_PAD = 0.03;
/** What a resting pointer frames at least, per side. */
export const DWELL_PAD = 0.04;
/** The clicked element frames the shot only while it is a control, not a whole pane. */
export const TARGET_MAX_AREA = 0.12;
/** A text field frames a typing shot up to this size. */
export const TYPING_TARGET_MAX_AREA = 0.25;
/** A popup at most this big on both axes is framed whole... */
export const WHOLE_POPUP_SIDE = 0.45;
/** ...and so is a bigger one that still zooms this much whole... */
export const WHOLE_POPUP_MIN_SCALE = 1.2;
/** ...anything bigger only within this reach of the pointer: a tall menu is followed down. */
export const POPUP_REACH = 0.3;
/** Inside a big open menu, a resting pointer frames its surroundings this far. */
export const POPUP_NEAR = 0.12;
/** A popup, or a change, covering more of the frame than this is a page, not a menu. */
export const NAVIGATION_AREA = 0.45;
/** A frame step changing this share of the frame replaces the page (or dims it for a dialog)... */
export const NAVIGATION_SHARE = 0.4;
/** ...and so does one changing this much, spread over this much of the frame: a dark page
 *  replaced by another dark page changes fewer cells, but all over. */
export const NAVIGATION_SPREAD_SHARE = 0.2;
export const NAVIGATION_SPREAD_AREA = 0.5;
/** A popup opening this long after a click is that click's doing. */
export const POPUP_AFTER_CLICK_MS = 1200;
/** What a click changed on screen is looked for this long after it. */
export const RESULT_WINDOW_MS = 900;
/** A change this close to the pointer (share of the frame) is its doing. */
export const LOCAL_REACH = 0.2;
/** A frame-seen result holds the shot this long. */
export const RESULT_HOLD_MS = 1500;
/** A popup holds the shot at most this long. */
export const POPUP_HOLD_CAP_MS = 6000;

/** The pointer rests when it stays within this radius (share of the frame)... */
export const DWELL_RADIUS = 0.012;
/** ...for at least this long. */
export const DWELL_MIN_MS = 500;
/** A popup opening this close to a resting pointer opened on hover. */
export const HOVER_POPUP_REACH = 0.15;
/** A change this close to a resting pointer is the UI answering it (a highlight, a tooltip). */
export const HOVER_FEEDBACK_REACH = 0.06;
/** A change at least this big next to the pointer opened something. */
export const OPENED_AREA = 0.01;
/** The evidence a resting pointer needs to be worth a look (see `dwellBeats`). */
export const DWELL_EVIDENCE = 0.5;
/** A rest the UI answered stays relevant this long after it answered, in silence... */
export const DWELL_QUIET_HOLD_MS = 3000;
/** ...one with only a hand cursor to show for it, this long; and either holds on while the
 *  speaker keeps talking. */
export const HAND_HOLD_MS = 3000;
/** A pause in speech this long ends a stretch of talking. */
export const TALK_PAUSE_MS = 700;

/** The end of the stretch of talking going on at `fromMs` (or `fromMs` if silent then). */
function talkingUntil(speech: Speech, fromMs: number): number {
	let end = fromMs;
	for (const word of speech.words) {
		if (word.endMs < end) continue;
		if (word.startMs - end > TALK_PAUSE_MS) break;
		end = Math.max(end, word.endMs);
	}
	return end;
}
/** After a page change, the frames keep changing this long as the page settles. */
export const PAGE_SETTLE_MS = 900;

/** Hover sweep: the pointer moving slower than this (frame widths per second)... */
export const SWEEP_MAX_SPEED = 0.3;
/** ...for at least this long... */
export const SWEEP_MIN_MS = 1500;
/** ...covering at least this much path... */
export const SWEEP_MIN_PATH = 0.05;
/** ...inside an area no larger than this on either axis. */
export const SWEEP_MAX_EXTENT = 0.4;
/** Slower than this (frame widths per second), the pointer is standing still. */
export const SWEEP_STILL_SPEED = 0.005;
/** A sweep wider than `SWEEP_MAX_EXTENT` is read in stretches this wide at most... */
export const SWEEP_CHUNK_EXTENT = 0.25;
/** ...and this long at most... */
export const SWEEP_CHUNK_MS = 2000;
/** ...each lasting at least this long. */
export const SWEEP_CHUNK_MIN_MS = 600;
/** The light zoom a sweep gets. */
export const SWEEP_SCALE = 1.3;
/** Without frames to read, a sweep this wide on one axis explores the screen by itself. */
export const SWEEP_EXPLORE_EXTENT = 0.15;

/** Typing: the first key within this long of the click... */
export const TYPING_START_MS = 2000;
/** ...and each next one within this long of the previous one... */
export const TYPING_GAP_MS = 1500;
/** ...at least this many plain keys. A lone shortcut is no typing. */
export const TYPING_MIN_KEYS = 3;

/** The final approach to a click: searched this far back... */
export const APPROACH_WINDOW_MS = 3000;
/** ...it starts after the last rest (slower than this, frame widths per second)... */
export const APPROACH_REST_SPEED = 0.08;
/** ...of at least this long... */
export const APPROACH_REST_MS = 150;
/** ...not counting the settle on the target itself, within this radius of the click. */
export const APPROACH_SETTLE_RADIUS = 0.03;

/** One shot never holds through this long with nothing happening and nothing said... */
export const MAX_IDLE_HOLD_MS = 4000;
/** ...nor through this long while the speaker talks: they are explaining what is shown. */
export const MAX_TALKING_HOLD_MS = 9000;
/** What a camera move costs, against framing loss (natural log of the scale a beat loses). */
export const MOVE_COST = 0.35;
/** A framing on screen for less than this before the next makes the cut feel rushed... */
export const CALM_SHOT_MS = 3000;
/** ...costing up to this many extra moves (a following shot moves continuously instead). */
export const PACE_FACTOR = 3;
/** A follow shot instead of fixed framings costs this much more than one move. */
export const FOLLOW_COST = 0.45;
/** A follow shot frames at most this deep: the view moves, so it stays wide enough to read. */
export const FOLLOW_SCALE = 1.4;
/** A follow shot glides between beats at most this far apart, in views (half a view). */
export const FOLLOW_MAX_STEP = 0.5;
/** A follow shot lasts at least this long. */
export const FOLLOW_MIN_MS = 3500;
/** Two consecutive framings this similar are one: no camera move for a nudge. */
export const SAME_VIEW_SHIFT = 0.04;
export const SAME_VIEW_SCALE_RATIO = 1.12;

/** With a transcript: a pointing word ("clica aqui") this long before a click brings the zoom in
 *  with the word, instead of with the hand. */
export const SPEECH_LEAD_MAX_MS = 2500;
/** A shot ending mid-sentence holds to the sentence's end, if that is at most this much later. */
export const SENTENCE_HOLD_MAX_MS = 3000;
/** A zoom-out landing inside a word waits for the word's end, if that is at most this much later. */
export const WORD_SNAP_MS = 600;

// ── Beats ───────────────────────────────────────────────────────────────────

type BeatKind = "press" | "result" | "dwell" | "sweep" | "typing";

export interface Beat {
	kind: BeatKind;
	/** Its moment: beats are ordered by it. */
	anchorMs: number;
	/** The zoom is fully in by then. */
	fullyInByMs: number;
	/** The last moment it is still relevant. */
	untilMs: number;
	/** What must be seen. */
	box: Box;
	/** The scale it deserves on its own. */
	ideal: number;
	/** The deepest it may go: the settings' maximum, closer for a small target of known size. */
	cap: number;
	/** How much it matters, 0..1. */
	weight: number;
	clicks: number;
	/** The page is replaced right after it: the shot ends there. */
	navigation: boolean;
	/** It picked an item of a menu that then closed: a short tail. */
	menuPick: boolean;
	/** Where the pointer is when it is over. */
	endPoint: ZoomFocus;
}

export interface DirectorContext {
	settings: AutoZoomSettings;
	rampMs: (scale: number) => number;
	minHoldMs: number;
	minWideMs: number;
}

/**
 * The deepest a beat may go: the settings' maximum, closer for a small target whose size is
 * known. A bare click says nothing about how big what it pressed is: it never goes closer.
 */
function capFor(box: Box, settings: AutoZoomSettings, known: boolean): number {
	const small = widthOf(box) <= SMALL_TARGET_SIDE && heightOf(box) <= SMALL_TARGET_SIDE;
	return known && small
		? Math.min(CLOSE_UP_MAX_SCALE, Math.max(settings.maxScale, settings.maxScale * CLOSE_UP_FACTOR))
		: settings.maxScale;
}

/** The scale and the cap a beat framing `box` deserves on its own. */
function framingFor(
	box: Box,
	settings: AutoZoomSettings,
	known: boolean,
): { ideal: number; cap: number } {
	const cap = capFor(box, settings, known);
	return { ideal: Math.min(cap, fitScale(box, FRAME_MARGIN)), cap };
}

function usableRect(rect: NormalizedRect | undefined, point: ZoomFocus, maxArea: number) {
	if (!rect || rectArea(rect) > maxArea || !rectContains(rect, point)) return undefined;
	return rect;
}

/** A popup or a change, framed whole when it is modest, near the pointer when it is big. */
function framed(rect: NormalizedRect | ScreenChangeBox, point: ZoomFocus): Box | null {
	if (framesWhole(rect)) return boxOfRect(rect);
	return rectNear(rect, point, POPUP_REACH);
}

/** A popup small enough to frame whole, or one that still makes a useful zoom whole. */
function framesWhole(rect: NormalizedRect | ScreenChangeBox): boolean {
	return (
		(rect.width <= WHOLE_POPUP_SIDE && rect.height <= WHOLE_POPUP_SIDE) ||
		fitScale(boxOfRect(rect), FRAME_MARGIN) >= WHOLE_POPUP_MIN_SCALE
	);
}

/** A frame step that replaces the page (or dims all of it, under a dialog). */
export function isPageChange(step: ScreenActivityStep): boolean {
	if (step.share >= NAVIGATION_SHARE) return true;
	if (step.share < NAVIGATION_SPREAD_SHARE) return false;
	let spread: Box | null = null;
	for (const change of step.boxes) {
		spread = spread ? union(spread, boxOfRect(change)) : boxOfRect(change);
	}
	return spread !== null && widthOf(spread) * heightOf(spread) >= NAVIGATION_SPREAD_AREA;
}

/** A thin strip across the frame (a tab strip or a toolbar repainting), not a thing shown. */
function isBar(box: ScreenChangeBox): boolean {
	return box.width >= 0.3 && box.height <= 0.04;
}

/**
 * When the hand set off on its final approach to a click: after the last rest of at least
 * `APPROACH_REST_MS` before it, not counting the settle on the target itself. Null when the
 * pointer never left the target in the window (nothing to anticipate).
 */
function approachStartMs(path: CursorTelemetryPoint[], at: number, target: ZoomFocus) {
	const from = at - APPROACH_WINDOW_MS;
	let i = sampleIndexAt(path, at);
	while (
		i >= 0 &&
		path[i].timeMs >= from &&
		distance(path[i] as ZoomFocus, target) <= APPROACH_SETTLE_RADIUS
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

/** Fully in by: `SHOT_LEAD_MS` before the moment, earlier with the hand, or with the words. */
function leadFor(
	signals: Signals,
	at: number,
	point: ZoomFocus,
	ideal: number,
	ctx: DirectorContext,
	speech: Speech | undefined,
): number {
	const latest = at - SHOT_LEAD_MS;
	const approach = approachStartMs(signals.path, at, point);
	let lead =
		approach === null
			? latest
			: Math.min(latest, Math.max(latest - MAX_ANTICIPATION_MS, approach + ctx.rampMs(ideal)));
	// "Clica aqui, nesse botão": the zoom arrives with the words, not seconds later with the hand.
	if (speech) {
		const [said] = pointingWordsBetween(speech, at - SPEECH_LEAD_MAX_MS, at);
		if (said) lead = Math.min(lead, Math.max(at - SPEECH_LEAD_MAX_MS, said.startMs + 300));
	}
	return lead;
}

/** No action and no movement for this long: the hold on an open popup is over. */
export const IDLE_RELEASE_MS = 2500;

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

/**
 * How long an open popup holds the shot: while the pointer works in it, until it closes, at
 * most `POPUP_HOLD_CAP_MS`. A pointer gone still releases it, unless the speaker is still
 * talking about it then.
 */
function popupHoldEnd(
	signals: Signals,
	openMs: number,
	capMs: number,
	speech: Speech | undefined,
): number {
	const idle = idleFromMs(signals.path, openMs, capMs);
	if (idle === null) return capMs;
	if (!speech) return idle;
	let end = idle;
	for (const word of speech.words) {
		if (word.endMs < end || word.startMs > capMs) continue;
		if (word.startMs - end > 700) break;
		end = Math.min(capMs, Math.max(end, word.endMs));
	}
	return end;
}

/** A small popup the point lies in frames whole; a big one, its surroundings. */
function containerBox(rect: NormalizedRect, point: ZoomFocus): Box | null {
	if (framesWhole(rect)) return boxOfRect(rect);
	return rectNear(rect, point, POPUP_NEAR);
}

/**
 * A click is two beats when it opens something: what was pressed (the control, and the menu or
 * dialog it was picked from) and, apart from it, what it opened. The camera may need to move
 * from one to the other: the item clicked at the right, the dialog it opens in the middle.
 */
function clickBeats(
	click: RecordedClick,
	nextClickMs: number,
	signals: Signals,
	ctx: DirectorContext,
	speech: Speech | undefined,
): Beat[] {
	const at = click.timeMs;
	const p = click.focus;
	const settings = ctx.settings;
	const target = usableRect(click.press?.target, p, TARGET_MAX_AREA);
	let pressBox = boxAround(p, CLICK_PAD);
	let pressKnown = target !== undefined;
	if (target) pressBox = union(pressBox, boxOfRect(target));

	// The menu or dialog it was picked from: framed with it, and closing with it ends the shot.
	let menuPick = false;
	for (const popup of signals.popups) {
		if (popup.openMs >= at - 150 || popup.closeMs <= at || !rectContains(popup.rect, p)) continue;
		if (popup.closeMs <= at + 400) menuPick = true;
		if (rectArea(popup.rect) > NAVIGATION_AREA) continue;
		const around = containerBox(popup.rect, p);
		if (around) {
			pressBox = union(pressBox, around);
			pressKnown = true;
		}
	}

	// What it opened, as UI Automation saw it...
	let navigation = false;
	let resultBox: Box | null = null;
	let resultAt = Number.POSITIVE_INFINITY;
	let resultUntil = at;
	let openedSmallPopupAt: number | null = null;
	for (const popup of signals.popups) {
		if (popup.openMs < at - 150 || popup.openMs > at + POPUP_AFTER_CLICK_MS) continue;
		if (rectArea(popup.rect) > NAVIGATION_AREA) {
			navigation = true;
			continue;
		}
		const box = framed(popup.rect, p);
		if (!box) continue;
		openedSmallPopupAt = popup.openMs;
		resultBox = resultBox ? union(resultBox, box) : box;
		resultAt = Math.min(resultAt, popup.openMs);
		const cap = Math.min(popup.closeMs, popup.openMs + POPUP_HOLD_CAP_MS, nextClickMs);
		resultUntil = Math.max(resultUntil, popupHoldEnd(signals, popup.openMs, cap, speech));
	}
	// ...and as the frames show it: a page's own menus, a page replaced by another.
	const steps = stepsBetween(signals.activity, at, at + RESULT_WINDOW_MS + 600);
	const big = steps.find(isPageChange);
	// A dialog dims the whole page as it opens: a huge change that is not a navigation.
	const modal =
		big !== undefined && openedSmallPopupAt !== null && Math.abs(big.t - openedSmallPopupAt) <= 700;
	if (big && !modal) navigation = true;
	// After picking from a menu, what changes is the menu going away: not a result to frame.
	if (openedSmallPopupAt === null && !navigation && !menuPick) {
		for (const step of steps) {
			if (step.t > at + RESULT_WINDOW_MS) break;
			for (const change of step.boxes) {
				if (change.width * change.height > NAVIGATION_AREA || isBar(change)) continue;
				const box = boxOfRect(change);
				if (distanceToBox(p, box) > LOCAL_REACH) continue;
				const near = framed(change, p);
				if (!near) continue;
				resultBox = resultBox ? union(resultBox, near) : near;
				resultAt = Math.min(resultAt, step.t);
				resultUntil = Math.max(resultUntil, step.t + RESULT_HOLD_MS);
			}
		}
	}

	// Typing into what was clicked holds the shot on it, framing the field when it is known.
	let pressUntil = at;
	const typing = burstAfter(signals.keys, at, nextClickMs, TYPING_START_MS, TYPING_GAP_MS);
	if (typing && typing.count >= TYPING_MIN_KEYS) {
		pressUntil = Math.max(pressUntil, typing.endMs);
		const field = usableRect(click.press?.target, p, TYPING_TARGET_MAX_AREA);
		const textControl =
			click.press?.controlType === UIA_CONTROL_TYPE.edit ||
			click.press?.controlType === UIA_CONTROL_TYPE.document ||
			click.press?.controlType === UIA_CONTROL_TYPE.comboBox;
		if (field && (textControl || !target)) {
			const withField = union(pressBox, boxOfRect(field));
			if (fitScale(withField, FRAME_MARGIN) >= MIN_USEFUL_SCALE) {
				pressBox = withField;
				pressKnown = true;
			}
		}
	}
	// Scrolling inside what was just clicked (a long dropdown, a list) keeps it alive.
	const scroll = burstAfter(signals.wheels, at, nextClickMs, TYPING_START_MS, TYPING_GAP_MS);
	if (scroll) resultUntil = Math.max(resultUntil, scroll.endMs);

	const pressFraming = framingFor(pressBox, settings, pressKnown);
	const beats: Beat[] = [];
	const press: Beat = {
		kind: "press",
		anchorMs: at,
		fullyInByMs: leadFor(signals, at, p, pressFraming.ideal, ctx, speech),
		untilMs: pressUntil,
		box: pressBox,
		...pressFraming,
		weight: 1,
		clicks: 1,
		navigation,
		menuPick: menuPick && resultBox === null,
		endPoint: pointAt(signals.path, pressUntil, p),
	};
	beats.push(press);
	if (resultBox && !navigation) {
		const until = Math.max(resultUntil, resultAt + 300);
		beats.push({
			kind: "result",
			anchorMs: Math.max(at + 1, resultAt),
			fullyInByMs: resultAt + 300,
			untilMs: until,
			box: resultBox,
			...framingFor(resultBox, settings, true),
			weight: 1,
			clicks: 0,
			navigation: false,
			menuPick: false,
			endPoint: pointAt(signals.path, until, p),
		});
	}
	return beats;
}

interface Rest {
	fromMs: number;
	toMs: number;
	point: ZoomFocus;
	/** Indices into the path. */
	first: number;
	last: number;
}

/** Where the pointer stays put for at least `DWELL_MIN_MS`. */
function rests(path: CursorTelemetryPoint[], clickTimes: number[]): Rest[] {
	const out: Rest[] = [];
	let first = 0;
	let nextClick = 0;
	while (first < path.length) {
		const anchor = path[first] as ZoomFocus;
		while (nextClick < clickTimes.length && clickTimes[nextClick] <= path[first].timeMs) {
			nextClick += 1;
		}
		// A click ends a rest: before it the hand settles on the target, after it the user looks
		// at what the click did.
		const splitAt = clickTimes[nextClick] ?? Number.POSITIVE_INFINITY;
		let last = first;
		while (
			last + 1 < path.length &&
			path[last + 1].timeMs < splitAt &&
			distance(path[last + 1] as ZoomFocus, anchor) <= DWELL_RADIUS
		) {
			last += 1;
		}
		if (path[last].timeMs - path[first].timeMs >= DWELL_MIN_MS) {
			out.push({
				fromMs: path[first].timeMs,
				toMs: path[last].timeMs,
				point: { cx: path[last].cx, cy: path[last].cy },
				first,
				last,
			});
			first = last + 1;
		} else {
			first += 1;
		}
	}
	return out;
}

/**
 * The pointer resting where the screen answers it: hovering opens a menu (most of Microsoft 365
 * does), lights a row up, shows a tooltip; or it rests in an open menu, on a hand cursor (a link,
 * a button), while the speaker points at it. A hand resting while the speaker introduces the
 * video, with nothing answering it, is no reason to zoom.
 */
function dwellBeats(
	signals: Signals,
	ctx: DirectorContext,
	speech: Speech | undefined,
	pageChanges: number[],
): Beat[] {
	const beats: Beat[] = [];
	const clickTimes = signals.clicks.map((click) => click.timeMs);
	for (const rest of rests(signals.path, clickTimes)) {
		const p = rest.point;
		let evidence = 0;
		let box = boxAround(p, DWELL_PAD);
		// What made it worth a look also says how long it matters (`holdUntil`).
		let until = Number.NEGATIVE_INFINITY;
		const holdUntil = (atMs: number) => {
			until = Math.max(until, Math.min(rest.toMs, atMs));
		};
		let opened = false;
		// When the first piece of evidence arrived: the rest matters from then.
		let since = Number.POSITIVE_INFINITY;
		const seen = (atMs: number) => {
			since = Math.min(since, atMs);
		};
		// A menu opening on hover.
		for (const popup of signals.popups) {
			if (popup.openMs < rest.fromMs - 300 || popup.openMs > rest.toMs) continue;
			if (rectArea(popup.rect) > NAVIGATION_AREA) continue;
			if (distanceToBox(p, boxOfRect(popup.rect)) > HOVER_POPUP_REACH) continue;
			const near = framed(popup.rect, p);
			if (!near) continue;
			box = union(box, near);
			evidence += 1;
			opened = true;
			seen(popup.openMs);
			holdUntil(Math.min(popup.closeMs, popup.openMs + DWELL_QUIET_HOLD_MS));
		}
		// Resting inside an open menu: reading it, or about to pick from it.
		let inside = false;
		for (const popup of signals.popups) {
			if (popup.openMs > rest.fromMs || popup.closeMs < rest.fromMs + 200) continue;
			if (rectArea(popup.rect) > NAVIGATION_AREA || !rectContains(popup.rect, p)) continue;
			const around = containerBox(popup.rect, p);
			if (around) box = union(box, around);
			evidence += 0.6;
			inside = true;
			seen(rest.fromMs);
			holdUntil(Math.min(popup.closeMs, rest.fromMs + DWELL_QUIET_HOLD_MS));
		}
		// The frames: a highlight, a tooltip, a web menu opening next to the pointer. Not the
		// new page still arriving after a navigation, which changes everywhere for a moment.
		let feedback = false;
		for (const step of stepsBetween(
			signals.activity,
			rest.fromMs - 400,
			Math.min(rest.toMs, rest.fromMs + 1500),
		)) {
			if (pageChanges.some((t) => step.t >= t - 150 && step.t <= t + PAGE_SETTLE_MS)) continue;
			for (const change of step.boxes) {
				if (isBar(change) || change.width * change.height > NAVIGATION_AREA) continue;
				const changeBox = boxOfRect(change);
				if (distanceToBox(p, changeBox) > HOVER_FEEDBACK_REACH) continue;
				const near = framed(change, p);
				if (!near) continue;
				box = union(box, near);
				if (!feedback) evidence += 0.5;
				feedback = true;
				seen(step.t);
				holdUntil(step.t + DWELL_QUIET_HOLD_MS);
				if (!opened && change.width * change.height >= OPENED_AREA) {
					evidence += 0.5;
					opened = true;
				}
			}
		}
		// A hand over a link or a button.
		let hands = 0;
		for (let i = rest.first; i <= rest.last; i += 1) {
			if (signals.path[i].cursorType === "pointer") hands += 1;
		}
		const handShare = hands / (rest.last - rest.first + 1);
		if (handShare >= 0.6 && rest.toMs - rest.fromMs >= 700) {
			// With the frames read, a hand alone is not enough: the HUD's buttons show one too,
			// and the HUD is never in the video.
			evidence += signals.scanned ? 0.3 : 0.5;
			seen(rest.fromMs);
			holdUntil(rest.fromMs + HAND_HOLD_MS);
		}
		// The speaker pointing at it.
		if (speech) {
			const [strict] = pointingWordsBetween(speech, rest.fromMs - 800, rest.toMs + 300, true);
			const [loose] = pointingWordsBetween(speech, rest.fromMs - 800, rest.toMs + 300);
			const word = strict ?? loose;
			if (word) {
				evidence += strict ? 0.5 : 0.25;
				seen(word.startMs);
				// As long as the sentence that points at it.
				holdUntil(sentenceAt(speech, word.startMs)?.endMs ?? word.endMs);
			}
		}
		if (evidence < DWELL_EVIDENCE) continue;
		const anchorMs = Math.max(rest.fromMs, Math.min(since, rest.toMs) - 300);
		until = Math.max(until, anchorMs);
		// While the speaker goes on, the pointer resting on it is what they are talking about.
		if (speech) until = Math.min(rest.toMs, Math.max(until, talkingUntil(speech, until)));
		// Its size is known when something answered it; a hand or a word alone frames the pointer.
		const known = opened || feedback || inside;
		beats.push({
			kind: "dwell",
			anchorMs,
			// The camera lands as the hand settles: its ramp runs during the approach.
			fullyInByMs: anchorMs + 150,
			untilMs: until,
			box,
			...framingFor(box, ctx.settings, known),
			weight: Math.min(1, evidence),
			clicks: 0,
			navigation: false,
			menuPick: false,
			endPoint: p,
		});
	}
	return beats;
}

/**
 * Slow exploration without a click: the pointer scanning a menu or a list of options to show
 * them. Worth a zoom inside an open menu, with the rows lighting up under it, or with the speaker
 * pointing; without frames to read, a wide enough sweep counts by itself.
 */
function sweepBeats(
	signals: Signals,
	untilMs: number,
	ctx: DirectorContext,
	speech: Speech | undefined,
): Beat[] {
	const { path, clicks } = signals;
	const beats: Beat[] = [];
	const clickTimes = clicks.map((click) => click.timeMs);
	let runStart = -1;

	const closeRun = (endIndex: number) => {
		if (runStart < 0) return;
		let startIndex = runStart;
		let lastIndex = endIndex;
		runStart = -1;
		const moving = (i: number) =>
			distance(path[i - 1] as ZoomFocus, path[i] as ZoomFocus) /
				Math.max(1e-3, (path[i].timeMs - path[i - 1].timeMs) / 1000) >
			SWEEP_STILL_SPEED;
		while (startIndex < lastIndex && !moving(startIndex + 1)) startIndex += 1;
		while (lastIndex > startIndex && !moving(lastIndex)) lastIndex -= 1;
		if (path[lastIndex].timeMs - path[startIndex].timeMs < SWEEP_MIN_MS) return;
		const whole = boxOfPath(startIndex, lastIndex);
		if (widthOf(whole) <= SWEEP_MAX_EXTENT && heightOf(whole) <= SWEEP_MAX_EXTENT) {
			evaluate(startIndex, lastIndex, SWEEP_MIN_MS, false);
			return;
		}
		// A long exploration across the screen: one local stretch at a time, so the camera can
		// follow it (or frame each stretch) instead of giving up on it.
		let chunkStart = startIndex;
		let chunk = boxAround(path[startIndex] as ZoomFocus);
		for (let i = startIndex + 1; i <= lastIndex; i += 1) {
			chunk = union(chunk, boxAround(path[i] as ZoomFocus));
			if (
				widthOf(chunk) > SWEEP_CHUNK_EXTENT ||
				heightOf(chunk) > SWEEP_CHUNK_EXTENT ||
				path[i].timeMs - path[chunkStart].timeMs > SWEEP_CHUNK_MS
			) {
				evaluate(chunkStart, i - 1, SWEEP_CHUNK_MIN_MS, true);
				chunkStart = i;
				chunk = boxAround(path[i] as ZoomFocus);
			}
		}
		evaluate(chunkStart, lastIndex, SWEEP_CHUNK_MIN_MS, true);
	};

	const boxOfPath = (from: number, to: number): Box => {
		let box = boxAround(path[from] as ZoomFocus);
		for (let i = from + 1; i <= to; i += 1) box = union(box, boxAround(path[i] as ZoomFocus));
		return box;
	};

	/** One stretch of slow movement, judged on its own evidence. */
	const evaluate = (startIndex: number, lastIndex: number, minMs: number, stretch: boolean) => {
		const first = path[startIndex];
		const last = path[lastIndex];
		if (last.timeMs - first.timeMs < minMs) return;
		let box = boxOfPath(startIndex, lastIndex);
		let travelled = 0;
		for (let i = startIndex + 1; i <= lastIndex; i += 1) {
			travelled += distance(path[i - 1] as ZoomFocus, path[i] as ZoomFocus);
		}
		if (travelled < SWEEP_MIN_PATH) return;
		const centre = centreOf(box);
		let inPopup = false;
		for (const popup of signals.popups) {
			if (popup.openMs <= last.timeMs && popup.closeMs >= first.timeMs) {
				if (rectContains(popup.rect, centre, 0.02) && rectArea(popup.rect) <= NAVIGATION_AREA) {
					inPopup = true;
					// A small menu frames whole; in a big one, the rows the pointer went over do.
					if (popup.rect.width <= WHOLE_POPUP_SIDE && popup.rect.height <= WHOLE_POPUP_SIDE) {
						box = union(box, boxOfRect(popup.rect));
					}
				}
			}
		}
		let feedback = 0;
		for (const step of stepsBetween(signals.activity, first.timeMs, last.timeMs)) {
			if (isPageChange(step)) continue;
			if (
				step.boxes.some(
					(change) => !isBar(change) && distanceToBox(centre, boxOfRect(change)) <= 0.15,
				)
			) {
				feedback += 1;
			}
		}
		const pointed =
			speech !== undefined &&
			pointingWordsBetween(speech, first.timeMs - 1000, last.timeMs + 500, true).length > 0;
		const loosely =
			speech !== undefined &&
			pointingWordsBetween(speech, first.timeMs - 1000, last.timeMs + 500).length > 0;
		// A stretch of a long sweep is travel unless something answers it: wide enough is not enough.
		const explores =
			(!stretch && Math.max(widthOf(box), heightOf(box)) >= SWEEP_EXPLORE_EXTENT) ||
			clicks.some(
				(click) =>
					click.timeMs >= first.timeMs &&
					click.timeMs <= last.timeMs + 4000 &&
					distance(click.focus, centre) <= 0.45,
			);
		const worth = signals.scanned
			? inPopup || feedback >= 2 || pointed || (loosely && explores && feedback >= 1)
			: speech
				? inPopup || pointed || (loosely && explores)
				: inPopup || explores;
		if (!worth) return;
		const framing = framingFor(box, ctx.settings, false);
		// A light zoom: the pointer is still moving over it.
		const ideal = Math.min(framing.ideal, SWEEP_SCALE);
		beats.push({
			kind: "sweep",
			anchorMs: first.timeMs,
			// The zoom completes as the exploration settles in, not before the pointer arrives.
			fullyInByMs: first.timeMs + 400,
			untilMs: last.timeMs,
			box,
			ideal,
			cap: framing.cap,
			weight: inPopup || pointed ? 0.8 : 0.6,
			clicks: 0,
			navigation: false,
			menuPick: false,
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
		if (clicked || speed > SWEEP_MAX_SPEED || dt > 1) {
			closeRun(i - 1);
			if (!clicked && speed <= SWEEP_MAX_SPEED) runStart = i;
			continue;
		}
		if (runStart < 0) runStart = i - 1;
	}
	if (runStart >= 0) closeRun(lastIndex);
	return beats;
}

/** Typing with no click before it (a field already focused): framed where the text appears. */
function typingBeats(signals: Signals, ctx: DirectorContext): Beat[] {
	const beats: Beat[] = [];
	for (const burst of bursts(signals.keys, TYPING_GAP_MS)) {
		if (burst.count < TYPING_MIN_KEYS) continue;
		if (
			signals.clicks.some(
				(c) => c.timeMs <= burst.startMs && burst.startMs - c.timeMs <= TYPING_START_MS,
			)
		) {
			continue;
		}
		const p = pointAt(signals.path, burst.startMs, { cx: 0.5, cy: 0.5 });
		let box: Box | null = null;
		let known = true;
		for (const step of stepsBetween(signals.activity, burst.startMs, burst.endMs + 300)) {
			if (isPageChange(step)) continue;
			for (const change of step.boxes) {
				if (isBar(change) || change.width * change.height > 0.1) continue;
				box = box ? union(box, boxOfRect(change)) : boxOfRect(change);
			}
		}
		if (!box) {
			if (signals.scanned) continue;
			box = boxAround(p, DWELL_PAD);
			known = false;
		}
		if (widthOf(box) > 0.6 || heightOf(box) > 0.6) continue;
		beats.push({
			kind: "typing",
			anchorMs: burst.startMs,
			fullyInByMs: burst.startMs + 200,
			untilMs: burst.endMs,
			box,
			...framingFor(box, ctx.settings, known),
			weight: 0.8,
			clicks: 0,
			navigation: false,
			menuPick: false,
			endPoint: p,
		});
	}
	return beats;
}

/** Big changes no click explains (a page loading, a view switching, scrolling): cuts to wide. */
function pageChanges(signals: Signals): number[] {
	const cuts: number[] = [];
	for (const step of signals.activity) {
		if (!isPageChange(step)) continue;
		// A dialog opening dims the whole page: that is the dialog, not a page change.
		const dialog = signals.popups.some(
			(popup) => rectArea(popup.rect) <= NAVIGATION_AREA && Math.abs(popup.openMs - step.t) <= 700,
		);
		if (dialog) continue;
		const last = cuts[cuts.length - 1];
		if (last === undefined || step.t - last > 1000) cuts.push(step.t);
	}
	return cuts;
}

// ── Shots ───────────────────────────────────────────────────────────────────

export interface Shot {
	start: number;
	end: number;
	scale: number;
	box: Box;
	/** The view follows the pointer (a following camera), from `box`'s framing. */
	follow: boolean;
	beats: Beat[];
	clicks: number;
	firstAnchorMs: number;
	lastAnchorMs: number;
	lastActivityMs: number;
	/** When the camera last moved into this framing (its ramp in, or the pan to it). */
	arrivedMs: number;
	/** Reached by a pan from the previous shot, not by a ramp from the whole screen. */
	chained: boolean;
	/** A navigation ended it: the page it showed is gone. */
	navigationEndMs?: number;
	/** What it showed is over before its tail ran out (a pick, a navigation, the pointer gone):
	 *  holding it longer shows something stale. */
	endsOnCut: boolean;
	endPoint: ZoomFocus;
	/** The latest it may end and still be back out before the axis's wide ending. */
	latestEnd: number;
}

export interface Segment {
	beats: Beat[];
	scale: number;
	box: Box;
	follow: boolean;
	/** No zoom is worth it: the beats stay on the whole screen. */
	wide: boolean;
}

function weightOf(beat: Beat): number {
	const seconds = Math.max(0, beat.untilMs - beat.anchorMs) / 1000;
	return beat.weight * Math.min(2, Math.max(0.5, 0.5 + seconds / 2));
}

/** What the beats lose when shown at `scale` rather than at what each deserves. */
function framingLoss(beats: Beat[], scale: number): number {
	let loss = 0;
	for (const beat of beats) {
		if (beat.ideal > scale) loss += weightOf(beat) * Math.log(beat.ideal / scale);
	}
	return loss;
}

/**
 * Cuts the beats into shots: the segmentation that minimises the framing every beat loses plus
 * `MOVE_COST` per camera move (dynamic programming over the beats in time order). A shot cannot
 * hold through a long idle stretch, nor past a page that is replaced.
 */
function segmentBeats(beats: Beat[], ctx: DirectorContext, speech: Speech | undefined): Segment[] {
	const n = beats.length;
	if (n === 0) return [];
	const best = new Array<number>(n + 1).fill(Number.POSITIVE_INFINITY);
	const choice = new Array<Segment | null>(n + 1).fill(null);
	const from = new Array<number>(n + 1).fill(0);
	best[0] = 0;
	const followScale = Math.min(ctx.settings.maxScale, FOLLOW_SCALE);
	for (let j = 1; j <= n; j += 1) {
		let box = beats[j - 1].box;
		let want = beats[j - 1].ideal;
		let latestUntil = beats[j - 1].untilMs;
		for (let i = j; i >= 1; i -= 1) {
			const beat = beats[i - 1];
			if (i < j) {
				// Extending back to `beat`: the shot holds from it to beat j-1.
				const next = beats[i];
				const idle = next.anchorMs - Math.max(beat.untilMs, beat.anchorMs);
				const talking =
					speech !== undefined &&
					speech.words.some((word) => word.startMs < next.anchorMs && word.endMs > beat.untilMs);
				if (idle > (talking ? MAX_TALKING_HOLD_MS : MAX_IDLE_HOLD_MS)) break;
				if (beat.navigation) break;
				box = union(box, beat.box);
				want = Math.max(want, beat.ideal);
				latestUntil = Math.max(latestUntil, beat.untilMs);
			}
			const segmentBeatsList = beats.slice(i - 1, j);
			const fit = fitScale(box, FRAME_MARGIN);
			const scale = Math.min(want, fit);
			const moveCost = i > 1 ? MOVE_COST : 0;
			// How long this framing would be on screen before the next one takes over.
			const firstLead = Math.min(...segmentBeatsList.map((b) => b.fullyInByMs));
			const ownEnd = Math.max(...segmentBeatsList.map((b) => b.untilMs + tailOf(b)));
			const onScreen = Math.min(ownEnd, beats[j]?.fullyInByMs ?? ownEnd) - firstLead;
			const rush =
				j < n ? MOVE_COST * PACE_FACTOR * Math.max(0, (CALM_SHOT_MS - onScreen) / CALM_SHOT_MS) : 0;
			const candidates: Segment[] = [];
			if (scale >= MIN_USEFUL_SCALE) {
				candidates.push({ beats: segmentBeatsList, scale, box, follow: false, wide: false });
			}
			const span = latestUntil - segmentBeatsList[0].fullyInByMs;
			if (
				segmentBeatsList.length > 1 &&
				followScale >= MIN_USEFUL_SCALE &&
				scale < followScale &&
				span >= FOLLOW_MIN_MS &&
				segmentBeatsList.every((b) => fitScale(b.box, FRAME_MARGIN) >= followScale) &&
				segmentBeatsList.every(
					(b, k) =>
						k === 0 ||
						distance(centreOf(segmentBeatsList[k - 1].box), centreOf(b.box)) <=
							FOLLOW_MAX_STEP / followScale,
				)
			) {
				candidates.push({
					beats: segmentBeatsList,
					scale: followScale,
					box: segmentBeatsList[0].box,
					follow: true,
					wide: false,
				});
			}
			if (i === j && candidates.length === 0) {
				candidates.push({ beats: segmentBeatsList, scale: 1, box, follow: false, wide: true });
			}
			for (const candidate of candidates) {
				const cost =
					best[i - 1] +
					moveCost +
					(candidate.wide
						? framingLoss(candidate.beats, 1)
						: framingLoss(candidate.beats, candidate.scale)) +
					(candidate.follow ? FOLLOW_COST : rush);
				if (cost < best[j]) {
					best[j] = cost;
					choice[j] = candidate;
					from[j] = i - 1;
				}
			}
		}
	}
	const segments: Segment[] = [];
	for (let j = n; j > 0; j = from[j]) {
		const segment = choice[j];
		if (segment) segments.push(segment);
	}
	return segments.reverse();
}

/** The framing a segment shows: centred on its box, at its scale, clamped to the frame. */
function segmentView(segment: Pick<Segment, "box" | "scale">): Box {
	return viewOf(segment.box, segment.scale);
}

/** Two consecutive framings this similar are one: no camera move for a nudge. */
function sameView(a: Segment, b: Segment): boolean {
	if (a.follow || b.follow) return false;
	const ratio = Math.max(a.scale, b.scale) / Math.min(a.scale, b.scale);
	return (
		ratio <= SAME_VIEW_SCALE_RATIO &&
		distance(centreOf(segmentView(a)), centreOf(segmentView(b))) <= SAME_VIEW_SHIFT
	);
}

function mergeSimilar(segments: Segment[]): Segment[] {
	const out: Segment[] = [];
	for (const segment of segments) {
		const prev = out[out.length - 1];
		const lastBeat = prev?.beats[prev.beats.length - 1];
		if (prev && !prev.wide && !segment.wide && !lastBeat?.navigation && sameView(prev, segment)) {
			const box = union(prev.box, segment.box);
			const scale = Math.min(
				Math.max(prev.scale, segment.scale),
				fitScale(box, FRAME_MARGIN),
				Math.max(...prev.beats.map((b) => b.cap), ...segment.beats.map((b) => b.cap)),
			);
			if (scale >= MIN_USEFUL_SCALE) {
				out[out.length - 1] = { ...prev, beats: [...prev.beats, ...segment.beats], box, scale };
				continue;
			}
		}
		out.push(segment);
	}
	return out;
}

/** The first moment after `fromMs` the pointer leaves `view` (shrunk by a small inset). */
function leavesViewMs(
	path: CursorTelemetryPoint[],
	fromMs: number,
	untilMs: number,
	view: Box,
): number | null {
	for (let i = Math.max(0, sampleIndexAt(path, fromMs)); i < path.length; i += 1) {
		const sample = path[i];
		if (sample.timeMs > untilMs) break;
		if (sample.timeMs > fromMs && !pointInside(sample as ZoomFocus, view, -0.01)) {
			return sample.timeMs;
		}
	}
	return null;
}

/**
 * Where a shot ends once the speaker is heard: wide as soon as they say the view moves on
 * ("vamos rolar"), otherwise not mid-sentence (held to its end, within `SENTENCE_HOLD_MAX_MS`)
 * and not mid-word. A shot the pointer or a page change already ended keeps that end.
 */
function speechAwareEnd(speech: Speech, activityEndMs: number, end: number, cut: boolean): number {
	let out = end;
	const scrolling = scrollingWordBetween(speech, activityEndMs, out + SENTENCE_HOLD_MAX_MS);
	if (scrolling && scrolling.startMs < out + SENTENCE_HOLD_MAX_MS) {
		return Math.min(out, Math.max(activityEndMs, scrolling.startMs));
	}
	if (!cut) {
		const sentence = sentenceAt(speech, out);
		if (sentence && sentence.endMs - out <= SENTENCE_HOLD_MAX_MS) out = sentence.endMs + 250;
	}
	const word = wordAt(speech, out);
	if (word && word.endMs - out <= WORD_SNAP_MS && (!cut || word.endMs - out <= 200)) {
		out = word.endMs + 100;
	}
	return out;
}

export interface AxisBounds {
	totalMs: number;
	/** No zoom starts moving in before this (the video's wide opening)... */
	wideUntilMs: number;
	/** ...and every zoom is back out by this (its wide ending). */
	wideFromMs: number;
	/** Spans that show no screen (the camera full screen): no zoom in, near, or across them. */
	blocked: ReadonlyArray<{ startMs: number; endMs: number }>;
}

/** The screen comes back from a camera-only span: this long on the whole screen first. */
export const BLOCKED_EDGE_WIDE_MS = 1000;

function tailOf(beat: Beat): number {
	if (beat.navigation) return NAVIGATION_HOLD_MS;
	if (beat.menuPick) return MENU_PICK_TAIL_MS;
	return beat.kind === "press" || beat.kind === "result" || beat.kind === "typing"
		? SHOT_TAIL_MS
		: HOVER_TAIL_MS;
}

/**
 * Times each segment as a shot inside the axis's bounds. A shot left too short a hold, or one
 * arriving after its last action, goes.
 */
function timeShots(
	segments: Segment[],
	signals: Signals,
	cuts: number[],
	bounds: AxisBounds,
	ctx: DirectorContext,
	speech: Speech | undefined,
): Shot[] {
	const timed: Shot[] = [];
	for (const [index, segment] of segments.entries()) {
		if (segment.wide) continue;
		const ramp = ctx.rampMs(segment.scale);
		const beats = segment.beats;
		// What the next framing shows takes over when it wants to be in: a beat of this one that
		// lingers past then (a pointer still sweeping) does not hold this one on screen.
		const next = segments.slice(index + 1).find((other) => !other.wide);
		const nextLead = next
			? Math.min(...next.beats.map((b) => b.fullyInByMs))
			: Number.POSITIVE_INFINITY;
		const untilOf = (beat: Beat) => Math.max(beat.anchorMs, Math.min(beat.untilMs, nextLead));
		const firstAnchorMs = Math.min(...beats.map((b) => b.anchorMs));
		const lastAnchorMs = Math.max(...beats.map((b) => b.anchorMs));
		const lastBeat = beats.reduce((a, b) =>
			untilOf(b) + tailOf(b) >= untilOf(a) + tailOf(a) ? b : a,
		);
		const lastActivityMs = Math.max(...beats.map(untilOf));
		const navigationBeat = beats.find((b) => b.navigation);
		let earliest = Math.max(0, Math.ceil(bounds.wideUntilMs + ramp));
		let latest = Math.min(bounds.totalMs, Math.floor(bounds.wideFromMs - ramp));
		for (const span of bounds.blocked) {
			if (span.endMs <= firstAnchorMs + 1) {
				earliest = Math.max(earliest, Math.ceil(span.endMs + BLOCKED_EDGE_WIDE_MS + ramp));
			} else if (span.startMs >= lastAnchorMs) {
				latest = Math.min(latest, Math.floor(span.startMs - BLOCKED_EDGE_WIDE_MS - ramp));
			}
		}
		const minHold = navigationBeat ? 0 : ctx.minHoldMs;
		let end = navigationBeat
			? navigationBeat.anchorMs + NAVIGATION_HOLD_MS
			: untilOf(lastBeat) + tailOf(lastBeat);
		// Picking an item from a menu that then closes is the end of what the shot showed.
		const pick = beats.find((b) => b.menuPick && b.anchorMs >= lastAnchorMs - 1);
		const view = segmentView(segment);
		let cut = navigationBeat !== undefined;
		if (pick) {
			end = Math.min(end, pick.anchorMs + MENU_PICK_TAIL_MS);
			cut = true;
		}
		if (!segment.follow) {
			// The pointer leaving for elsewhere ends the shot early: the tail would show nothing.
			const away = leavesViewMs(signals.path, lastActivityMs, end, view);
			if (away !== null && away < end) {
				end = away;
				cut = true;
			}
		}
		// A page replaced by another ends it too.
		const pageCut = cuts.find((t) => t > lastAnchorMs && t < end);
		if (pageCut !== undefined) {
			end = Math.min(end, pageCut + NAVIGATION_HOLD_MS);
			cut = true;
		}
		if (speech) end = speechAwareEnd(speech, lastActivityMs, end, cut);
		// Near the end of the axis, the zoom arrives earlier rather than holding too briefly.
		const wantStart = Math.min(...beats.map((b) => b.fullyInByMs));
		const start = Math.max(Math.min(Math.round(wantStart), latest - minHold), earliest);
		end = Math.min(Math.max(Math.round(end), start + minHold), latest);
		if (end - start < Math.max(minHold, 1)) continue;
		if (navigationBeat && navigationBeat.anchorMs - start < NAVIGATION_MIN_SHOW_MS) continue;
		// A zoom arriving after the fact shows nothing: after its last click, or, for a hover, too
		// late to show most of it.
		const clicks = beats.reduce((sum, b) => sum + b.clicks, 0);
		const startBy =
			clicks > 0
				? Math.max(...beats.filter((b) => b.clicks > 0).map((b) => b.anchorMs))
				: Math.max(lastAnchorMs, lastActivityMs - 1000);
		if (start > startBy || end < firstAnchorMs) continue;
		timed.push({
			start,
			end,
			scale: segment.scale,
			box: segment.box,
			follow: segment.follow,
			beats,
			clicks,
			firstAnchorMs,
			lastAnchorMs,
			lastActivityMs,
			arrivedMs: start,
			chained: false,
			...(navigationBeat || pageCut !== undefined ? { navigationEndMs: end } : {}),
			endsOnCut: cut,
			endPoint: lastBeat.endPoint,
			latestEnd: latest,
		});
	}
	return timed;
}

/** `inner` sits inside the view `outer` shows, near enough its centre to need no pan. */
function holdsIn(outer: Shot, inner: Shot): boolean {
	if (outer.follow) return false;
	const view = viewOf(outer.box, outer.scale);
	const half = (view.maxX - view.minX) / 2;
	const c = centreOf(inner.box);
	const centre = centreOf(view);
	const central = half * 0.6;
	return (
		boxInside(inner.box, view) &&
		Math.abs(c.cx - centre.cx) <= central &&
		Math.abs(c.cy - centre.cy) <= central &&
		Math.max(inner.scale, outer.scale) / Math.min(inner.scale, outer.scale) <= 1.25
	);
}

/**
 * No yo-yo: two consecutive shots too close for a real wide shot between them are joined. The
 * next shot already in view, near its centre, extends the current one; one elsewhere is reached
 * with a pan (zoomed, its scale eased on the way) that arrives when that shot wants to be fully
 * in, at least `MIN_CAMERA_MOVE_GAP_MS` after the previous move. A pan that cannot make it in
 * time is not made: the next shot is held if it is in view, otherwise it goes. After a page is
 * replaced, the new page is shown whole for `OVERVIEW_MS` before the next zoom.
 */
function chainShots(shots: Shot[], ctx: DirectorContext): Shot[] {
	const out: Shot[] = [];
	const panMs = ctx.settings.transitionSec * 1000;
	for (const original of shots) {
		const shot = { ...original };
		const prev = out[out.length - 1];
		if (!prev) {
			out.push(shot);
			continue;
		}
		if (prev.navigationEndMs !== undefined) {
			// The new page first, whole.
			const earliest = prev.end + ctx.rampMs(prev.scale) + OVERVIEW_MS + ctx.rampMs(shot.scale);
			if (shot.start < earliest) {
				const startBy = shot.clicks > 0 ? shot.lastAnchorMs : shot.lastActivityMs - 500;
				if (earliest > startBy || shot.end - earliest < Math.min(ctx.minHoldMs, 1200)) continue;
				shot.start = Math.round(earliest);
				shot.arrivedMs = shot.start;
			}
			out.push(shot);
			continue;
		}
		const wide = shot.start - ctx.rampMs(shot.scale) - (prev.end + ctx.rampMs(prev.scale));
		if (wide >= ctx.minWideMs) {
			out.push(shot);
			continue;
		}
		const absorb = () => {
			prev.end = Math.max(prev.end, shot.end);
			prev.clicks += shot.clicks;
			prev.beats = [...prev.beats, ...shot.beats];
			prev.lastAnchorMs = Math.max(prev.lastAnchorMs, shot.lastAnchorMs);
			prev.lastActivityMs = Math.max(prev.lastActivityMs, shot.lastActivityMs);
			if (shot.navigationEndMs !== undefined) prev.navigationEndMs = shot.navigationEndMs;
			prev.endPoint = shot.endPoint;
		};
		if (holdsIn(prev, shot)) {
			absorb();
			continue;
		}
		const earliestPan = Math.max(
			prev.arrivedMs + Math.max(MIN_CAMERA_MOVE_GAP_MS, CHAIN_MIN_HOLD_MS),
			prev.firstAnchorMs,
		);
		// Holding a shot whose content is over shows something stale: pan as it ends instead,
		// and let the next framing wait for the hand.
		const panStart = Math.max(
			prev.endsOnCut ? Math.min(shot.start - panMs, prev.end) : shot.start - panMs,
			earliestPan,
		);
		const arrive = Math.round(panStart + panMs);
		const end = Math.min(Math.max(shot.end, arrive + CHAIN_MIN_HOLD_MS), shot.latestEnd);
		const startBy = shot.clicks > 0 ? shot.lastAnchorMs + 200 : shot.lastActivityMs;
		if (arrive > startBy || end - arrive < NAVIGATION_HOLD_MS) {
			// Too late to pan there: hold, if it is in view at all.
			if (!prev.follow && boxInside(shot.box, viewOf(prev.box, prev.scale), -0.02)) absorb();
			continue;
		}
		prev.end = Math.round(panStart);
		out.push({ ...shot, start: arrive, end, arrivedMs: arrive, chained: true });
	}
	return out;
}

export interface Chain {
	shots: Shot[];
	clicks: number;
	clip?: string;
}

function toChains(shots: Shot[], clip?: string): Chain[] {
	const chains: Chain[] = [];
	for (const shot of shots) {
		const last = chains[chains.length - 1];
		if (shot.chained && last) {
			last.shots.push(shot);
			last.clicks += shot.clicks;
		} else {
			chains.push({ shots: [shot], clicks: shot.clicks, clip });
		}
	}
	return chains;
}

/** Whether a beat falls mostly inside a span that shows no screen. */
function blockedBeat(beat: Beat, blocked: AxisBounds["blocked"]): boolean {
	const from = Math.min(beat.anchorMs, beat.untilMs);
	const to = Math.max(beat.anchorMs, beat.untilMs);
	return blocked.some((span) => {
		if (beat.anchorMs >= span.startMs && beat.anchorMs <= span.endMs) return true;
		const overlap = Math.min(to, span.endMs) - Math.max(from, span.startMs);
		return to > from && overlap > (to - from) / 2;
	});
}

/** Every stage of one axis's plan, for diagnostics and tests: what was seen, how it was cut. */
export interface AxisPlan {
	beats: Beat[];
	/** Page changes no click explains, in ms. */
	cuts: number[];
	segments: Segment[];
	/** The shots as timed, before the camera joined them. */
	timed: Shot[];
	chains: Chain[];
}

/** Everything one axis (one clip's window, or a bare recording) asks of the camera. */
export function explainAxis(
	signals: Signals,
	bounds: AxisBounds,
	ctx: DirectorContext,
	clip?: string,
	speech?: Speech,
): AxisPlan {
	const cuts = pageChanges(signals);
	const beats = [
		...signals.clicks.flatMap((click, i) =>
			clickBeats(
				click,
				signals.clicks[i + 1]?.timeMs ?? Number.POSITIVE_INFINITY,
				signals,
				ctx,
				speech,
			),
		),
		...dwellBeats(signals, ctx, speech, cuts),
		...sweepBeats(signals, bounds.totalMs, ctx, speech),
		...typingBeats(signals, ctx),
	]
		.filter((beat) => !blockedBeat(beat, bounds.blocked))
		.sort((a, b) => a.anchorMs - b.anchorMs || a.untilMs - b.untilMs);
	const segments = mergeSimilar(segmentBeats(beats, ctx, speech));
	const timed = timeShots(segments, signals, cuts, bounds, ctx, speech);
	const chains = toChains(chainShots(timed, ctx), clip);
	return { beats, cuts, segments, timed, chains };
}

export function directAxis(
	signals: Signals,
	bounds: AxisBounds,
	ctx: DirectorContext,
	clip?: string,
	speech?: Speech,
): Chain[] {
	return explainAxis(signals, bounds, ctx, clip, speech).chains;
}
