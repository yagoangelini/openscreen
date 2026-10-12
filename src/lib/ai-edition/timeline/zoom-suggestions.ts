// Cursor-telemetry-driven auto-zoom: the planner's public face. Pure, no DOM/IPC.
//
// Ported from main's `src/components/video-editor/timeline/zoomSuggestionUtils.ts` (the legacy
// editor's "magic wand"), rewritten as a calm shot planner, and rewritten again as a director
// (`zoom-director.ts`) after a real Edge tutorial where hover-opened menus, a tall menu and a
// modal dialog all went unzoomed. This is NOT an AI feature: it is a deterministic pass over
// what a take recorded (`zoom-signals.ts`), the frames included (`screenActivity.ts`).
//
// This file holds what the director does not: the video's wide opening and ending, the stop
// click, a timeline's clips (each clip reads its own window of the recording), and settling the
// plan against the zooms already on the timeline and between recordings.
//
// A take recorded without input signals or frames (macOS, Linux, or a sidecar written before
// them) still plans on its clicks and the pointer's path alone.

import type { CursorTelemetryPoint, ZoomFocus } from "@/components/video-editor/types";
import { zoomTransitionMs } from "@/lib/zoomMath/constants";
import { type RecordingLayoutOnAsset, recordingFaceSpansSec } from "../../recordingLayout";
import type { AxcutClip } from "../schema";
import { activityWindow, type ScreenActivity, type ScreenActivityStep } from "./screenActivity";
import { readSpeech, type SpokenWord, speechWindow } from "./speechCues";
import {
	type AxisBounds,
	type Chain,
	type DirectorContext,
	directAxis,
	MIN_WIDE_BETWEEN_MS,
	OVERVIEW_MS,
} from "./zoom-director";
import {
	type AutoZoomSettings,
	autoZoomMotion,
	DEFAULT_AUTO_ZOOM_SETTINGS,
	motionTransitionSec,
} from "./zoom-motion";
import { DEFAULT_ZOOM_DEPTH, ZOOM_DEPTH_SCALES, type ZoomDepth } from "./zoom-scale";
import { centreOf, lastSampleMs, normalizeCursorTelemetry, readSignals } from "./zoom-signals";

export {
	CHAIN_MIN_HOLD_MS,
	MIN_CAMERA_MOVE_GAP_MS,
	MIN_USEFUL_SCALE,
	MIN_WIDE_BETWEEN_MS,
	NAVIGATION_HOLD_MS,
	OVERVIEW_MS,
	SHOT_LEAD_MS,
	SHOT_TAIL_MS,
} from "./zoom-director";
export { normalizeCursorTelemetry } from "./zoom-signals";

/** The video opens on the whole screen: no zoom starts moving in before this. */
export const OPENING_WIDE_MS = 2500;
/** And it ends on it: the last zoom is fully back out this long before the end. */
export const CLOSING_WIDE_MS = 1000;
/**
 * A click this close to the end of the recording is the one that stopped it, on the HUD's
 * Stop button, which the video never shows. Any other click there has a result the video
 * never shows either. (Measured: the sampler ran on 1.2 s past a real stop click.)
 */
export const STOP_CLICK_GUARD_MS = 1500;

export interface AutoZoomSuggestion {
	span: { start: number; end: number };
	focus: ZoomFocus;
	depth: ZoomDepth;
	/** The exact scale when it is not one of the depth table's. */
	customScale?: number;
	/** The view follows the pointer through it (the shot holds a run no one framing fits). */
	follow?: boolean;
}

/** A zoom already on the timeline: the plan keeps clear of it and never moves it. */
export interface ReservedZoom {
	startMs: number;
	endMs: number;
	/** Its effective scale, which sets how long its ramps last. The default depth's if omitted. */
	scale?: number;
	/** Its ramp length, when it moves with a motion of its own (an automatic zoom). */
	rampMs?: number;
	/** The wide shot kept on either side of it, when not the settings' minimum (a camera-only
	 *  span: the cut back to the screen is a scene change of its own). */
	wideMs?: number;
}

/** What else is known about one recording: its frames' activity and how its camera was laid out. */
export interface AssetZoomContext {
	activity?: ScreenActivity | null;
	cameraLayout?: RecordingLayoutOnAsset;
}

/** A camera-only span's wide margins: the screen shows whole for this long around it. */
export const CAMERA_SPAN_WIDE_MS = 1000;

/**
 * Between chains (two clips, two recordings) and against the zooms already on the timeline: a
 * real wide shot or none at all. The chain with fewer clicks goes, the later one on a tie; a
 * zoom already on the timeline never moves, so a chain too close to it goes.
 *
 * ponytail: the gap is measured in timeline ms, while the renderer plays ramps on the screen
 * clock, so inside a speed region the real wide shot differs. Map through `screenTimeMs` if a
 * take with speed regions ever shows a yo-yo.
 */
function resolveChains(chains: Chain[], reserved: ReservedZoom[], ctx: DirectorContext): Chain[] {
	const plan = [...chains];
	const fixed = reserved.map((zoom) => {
		const ramp =
			zoom.rampMs ?? zoomTransitionMs(zoom.scale ?? ZOOM_DEPTH_SCALES[DEFAULT_ZOOM_DEPTH]);
		return {
			start: zoom.startMs,
			end: zoom.endMs,
			rampIn: ramp,
			rampOut: ramp,
			wide: zoom.wideMs,
			wideAfter: zoom.wideMs,
			chain: null,
		};
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
					wide: undefined as number | undefined,
					// A chain that ends on a page replaced by another needs only the overview after it.
					wideAfter: last.navigationEndMs !== undefined ? OVERVIEW_MS : undefined,
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
				const needed = reach.wideAfter ?? span.wide ?? ctx.minWideMs;
				// A millisecond of slack: the planner rounds the spans it times to whole ms.
				if (wide < needed - 1) {
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
			// What it frames; the renderer keeps the view inside the frame.
			focus: centreOf(shot.box),
			...depthOf(shot.scale),
			...(shot.follow ? { follow: true } : {}),
		}));
}

function contextOf(settings: AutoZoomSettings = DEFAULT_AUTO_ZOOM_SETTINGS): DirectorContext {
	const motion = autoZoomMotion(settings);
	return {
		settings,
		rampMs: (scale) => motionTransitionSec(motion, scale) * 1000,
		minHoldMs: settings.holdSec * 1000,
		minWideMs: (settings.minWideSec ?? MIN_WIDE_BETWEEN_MS / 1000) * 1000,
	};
}

/** One axis: a clip's window of a recording, or a bare recording laid from 0. */
function planAxis(
	samples: CursorTelemetryPoint[],
	bounds: AxisBounds,
	ignoreClicksFromMs: number,
	ctx: DirectorContext,
	options: {
		clip?: string;
		words?: readonly SpokenWord[];
		activity?: readonly ScreenActivityStep[];
		hudActionsMs?: readonly number[];
	},
): Chain[] {
	const signals = readSignals(normalizeCursorTelemetry(samples, bounds.totalMs), {
		ignoreClicksFromMs,
		hudActionsMs: options.hudActionsMs,
		activity: options.activity,
	});
	const speech = options.words?.length ? readSpeech(options.words) : undefined;
	return directAxis(signals, bounds, ctx, options.clip, speech);
}

/** A recording's camera-only spans and its layout switches, in its source ms. */
function cameraLayoutSpans(layout: RecordingLayoutOnAsset | undefined) {
	if (!layout) return { faceMs: [], switchesMs: [] };
	return {
		faceMs: recordingFaceSpansSec(layout, Number.POSITIVE_INFINITY).map((span) => ({
			startMs: span.startSec * 1000,
			endMs: span.endSec * 1000,
		})),
		switchesMs: layout.switches.map((entry) => entry.atSec * 1000),
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
	/** What the speaker said, on the telemetry's axis: the zooms follow it too. */
	words?: readonly SpokenWord[];
	/** What the frames show changing, on the telemetry's axis. */
	activity?: ScreenActivity | null;
	/** How the camera was laid out while recording (camera-only spans get no zoom). */
	cameraLayout?: RecordingLayoutOnAsset;
}): AutoZoomSuggestion[] {
	const { cursorTelemetry, totalMs, existingRegions } = options;
	if (totalMs <= 0 || cursorTelemetry.length === 0) return [];
	const ctx = contextOf(options.settings);
	const layout = cameraLayoutSpans(options.cameraLayout);
	const chains = planAxis(
		cursorTelemetry,
		{
			totalMs,
			wideUntilMs: options.wideUntilMs ?? Number.NEGATIVE_INFINITY,
			wideFromMs: options.wideFromMs ?? Number.POSITIVE_INFINITY,
			blocked: layout.faceMs,
		},
		options.ignoreClicksFromMs ?? Number.POSITIVE_INFINITY,
		ctx,
		{
			words: options.words,
			activity: options.activity ? options.activity.steps : undefined,
			hudActionsMs: layout.switchesMs,
		},
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
	/** Each recording's transcript words, in its own SOURCE time, by asset id. */
	wordsByAssetId?: ReadonlyMap<string, readonly SpokenWord[]>;
	/** Each recording's frame activity and camera layout, in its own SOURCE time, by asset id. */
	contextByAssetId?: ReadonlyMap<string, AssetZoomContext>;
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
		const words = options.wordsByAssetId?.get(clip.assetId);
		const clipWords = words?.length
			? speechWindow(words, sourceOffsetMs, sourceOffsetMs + windowMs, sourceOffsetMs)
			: [];
		const context = options.contextByAssetId?.get(clip.assetId);
		const layout = cameraLayoutSpans(context?.cameraLayout);
		const clipChains = planAxis(
			clipTelemetry,
			{
				totalMs: windowMs,
				wideUntilMs: editStartMs + OPENING_WIDE_MS - timelineOffsetMs,
				wideFromMs: editEndMs - CLOSING_WIDE_MS - timelineOffsetMs,
				blocked: layout.faceMs.map((span) => ({
					startMs: span.startMs - sourceOffsetMs,
					endMs: span.endMs - sourceOffsetMs,
				})),
			},
			lastSampleMs(telemetry) - STOP_CLICK_GUARD_MS - sourceOffsetMs,
			ctx,
			{
				clip: clip.id,
				words: clipWords,
				activity: context?.activity
					? activityWindow(
							context.activity,
							sourceOffsetMs,
							sourceOffsetMs + windowMs,
							sourceOffsetMs,
						)
					: undefined,
				hudActionsMs: layout.switchesMs.map((at) => at - sourceOffsetMs),
			},
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
