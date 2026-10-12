// How the automatic zooms move, and the project settings that shape them.
//
// The planner (`zoom-suggestions.ts`) writes automatic zooms with `source: "auto"` and a fixed
// focus on what it framed. Everything about how the camera then MOVES is read at render time
// from the project's auto-zoom settings, so one control switches every automatic zoom at once:
// `sceneDescription.ts` attaches `autoZoomMotion(settings)` to each automatic region and resolves
// its focus mode from `cameraMode`; the TS preview mirror (`zoom-preview.ts`) does the same.
// A zoom drawn by hand, or written before this existed, carries no motion and renders as it
// always did.
//
// Pure and relative-import only, like `zoom-scale.ts`: the main process may import it.

/** The ramp and pan easing: the classic front-loaded spring, or the calm smootherstep. */
export type ZoomEasing = "spring" | "smooth";

/**
 * How one zoom moves. Mirror of `SceneZoomMotion` (crates/compositor/src/scene.rs); every
 * duration is on the screen clock, like the classic constants it replaces.
 */
export interface ZoomMotion {
	easing: ZoomEasing;
	/** A ramp lasts `transitionBaseSec + transitionPerLnSec · ln(scale)`. */
	transitionBaseSec: number;
	transitionPerLnSec: number;
	/** Two zooms this close on screen are chained by a pan rather than a zoom out and in. */
	panGapSec: number;
	panDurationSec: number;
	/** Under a following camera: the share of the zoomed view the pointer moves in freely... */
	followDeadZone: number;
	/** ...and the time constant the view re-frames with once it leaves it. */
	followTauSec: number;
}

/**
 * What the camera does during an automatic zoom.
 * - `fixed`: holds the planned framing, and pans smoothly to the next one (the default).
 * - `hybrid`: holds until the pointer leaves a wide dead zone, then re-frames slowly.
 * - `follow`: follows the pointer, heavily smoothed.
 */
export type AutoZoomCameraMode = "fixed" | "hybrid" | "follow";
export const AUTO_ZOOM_CAMERA_MODES: readonly AutoZoomCameraMode[] = ["fixed", "hybrid", "follow"];

export interface AutoZoomSettings {
	cameraMode: AutoZoomCameraMode;
	/** The deepest an automatic zoom goes; a single tight target may go 20 % deeper. */
	maxScale: number;
	/** How long a ramp (and a pan) lasts at 1.5×, in seconds. */
	transitionSec: number;
	/** The shortest time an automatic zoom holds, fully in, in seconds. */
	holdSec: number;
	/**
	 * The shortest wide shot between two automatic zooms: 2.5 s, calm (actions a few seconds
	 * apart share one shot and pan), or 1.5 s, brisk (it opens out between them more often).
	 */
	minWideSec: number;
}

/** The two lengths offered for the wide shot between zooms. */
export const MIN_WIDE_SEC_OPTIONS = [2.5, 1.5] as const;

/** The "Tutorial" preset: calm, framing the whole action rather than chasing the pointer. */
export const DEFAULT_AUTO_ZOOM_SETTINGS: AutoZoomSettings = {
	cameraMode: "fixed",
	maxScale: 1.5,
	transitionSec: 1.1,
	holdSec: 2.5,
	minWideSec: 2.5,
};

/** The slider ranges, and the bounds a stored value is read into. */
export const AUTO_ZOOM_BOUNDS = {
	maxScale: { min: 1.25, max: 2.2, step: 0.05 },
	transitionSec: { min: 0.6, max: 2, step: 0.1 },
	holdSec: { min: 1.5, max: 5, step: 0.25 },
} as const;

/** The level a ramp's length is set at: `transitionSec` is the ramp to this scale. */
const REFERENCE_SCALE = 1.5;
/** How much longer a deeper zoom's ramp is, per e-fold, relative to `transitionSec`. */
const PER_LN_SHARE = 0.32;

const FOLLOW_LAWS: Record<AutoZoomCameraMode, { deadZone: number; tauSec: number }> = {
	// Unused by a fixed camera (its regions are manual), kept equal to the hybrid's so a region
	// switched by hand to auto still moves calmly.
	fixed: { deadZone: 0.7, tauSec: 0.5 },
	hybrid: { deadZone: 0.7, tauSec: 0.5 },
	follow: { deadZone: 0.2, tauSec: 0.8 },
};

function bounded(value: unknown, range: { min: number; max: number }, fallback: number): number {
	if (typeof value !== "number" || !Number.isFinite(value)) return fallback;
	return Math.min(range.max, Math.max(range.min, value));
}

/** A stored settings object, read into range; anything missing or invalid takes its default. */
export function readAutoZoomSettings(raw: unknown): AutoZoomSettings {
	const value = (raw && typeof raw === "object" ? raw : {}) as Record<string, unknown>;
	const defaults = DEFAULT_AUTO_ZOOM_SETTINGS;
	return {
		cameraMode: AUTO_ZOOM_CAMERA_MODES.includes(value.cameraMode as AutoZoomCameraMode)
			? (value.cameraMode as AutoZoomCameraMode)
			: defaults.cameraMode,
		maxScale: bounded(value.maxScale, AUTO_ZOOM_BOUNDS.maxScale, defaults.maxScale),
		transitionSec: bounded(
			value.transitionSec,
			AUTO_ZOOM_BOUNDS.transitionSec,
			defaults.transitionSec,
		),
		holdSec: bounded(value.holdSec, AUTO_ZOOM_BOUNDS.holdSec, defaults.holdSec),
		minWideSec: (MIN_WIDE_SEC_OPTIONS as readonly unknown[]).includes(value.minWideSec)
			? (value.minWideSec as number)
			: defaults.minWideSec,
	};
}

/** The motion every automatic zoom of a project with these settings carries. */
export function autoZoomMotion(settings: AutoZoomSettings): ZoomMotion {
	const perLn = PER_LN_SHARE * settings.transitionSec;
	const law = FOLLOW_LAWS[settings.cameraMode];
	return {
		easing: "smooth",
		transitionBaseSec: settings.transitionSec - perLn * Math.log(REFERENCE_SCALE),
		transitionPerLnSec: perLn,
		// The planner chains two shots with a gap of exactly one pan; the margin keeps a chain
		// it built from falling apart over a rounding, and stays well under the shortest gap it
		// leaves for a real wide shot (two ramps and `MIN_WIDE_BETWEEN_MS`).
		panGapSec: settings.transitionSec + 0.9,
		panDurationSec: settings.transitionSec,
		followDeadZone: law.deadZone,
		followTauSec: law.tauSec,
	};
}

/** The focus mode an automatic zoom renders with under `cameraMode`. */
export function autoZoomFocusMode(cameraMode: AutoZoomCameraMode): "manual" | "auto" {
	return cameraMode === "fixed" ? "manual" : "auto";
}

/**
 * How one stored zoom renders: every zoom takes the project's camera mode and motion (the
 * fork's choice, 2026-10-10: one control moves them all, the ones drawn by hand included);
 * a zoom whose own focus mode was set in its inspector keeps that one. An automatic zoom the
 * planner made to follow the pointer (`focusMode: "auto"`, a run no one framing holds) follows
 * under every camera mode, with the mode's own law. The global Auto-Focus toggle still forces
 * every zoom to follow the pointer.
 * The one rule both renderers apply (`sceneDescription.ts`, `zoom-preview.ts`).
 */
export function resolveZoomRendering(
	region: { source?: "auto" | "manual"; focusMode?: "manual" | "auto" },
	autoZoom: AutoZoomSettings,
	autoFocusAll: boolean,
): { focusMode: "manual" | "auto" | null; motion?: ZoomMotion } {
	if (region.source !== "auto") {
		return {
			focusMode: autoFocusAll
				? "auto"
				: (region.focusMode ?? autoZoomFocusMode(autoZoom.cameraMode)),
			motion: autoZoomMotion(autoZoom),
		};
	}
	return {
		focusMode:
			autoFocusAll || region.focusMode === "auto" ? "auto" : autoZoomFocusMode(autoZoom.cameraMode),
		motion: autoZoomMotion(autoZoom),
	};
}

/** Seconds a ramp to `scale` lasts under `motion`. Mirror of `motion_transition_s` (Rust). */
export function motionTransitionSec(motion: ZoomMotion, scale: number): number {
	return Math.max(
		0.05,
		motion.transitionBaseSec + motion.transitionPerLnSec * Math.log(Math.max(1, scale)),
	);
}
