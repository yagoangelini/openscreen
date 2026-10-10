// Live-preview zoom transform for the new editor's CSS-based preview stack.
//
// Reuses the legacy editor's region math (`findDominantRegion`,
// `computeZoomTransform`) so zoom-in/out easing, region priority, and focus
// resolution stay identical between the two editors — only the output
// differs: a CSS translate/scale pair instead of a Pixi container transform.
//
// `computeZoomTransform` is called with a unit stage ({width:1, height:1}),
// which makes its pixel-space output already a fraction of the preview
// box — exactly what CSS `translate(x%, y%)` expects (percentages resolve
// against the transformed element's own layout box).

import type {
	CursorTelemetryPoint,
	ZoomRegion as LegacyZoomRegion,
} from "@/components/video-editor/types";
import { getZoomScale } from "@/components/video-editor/types";
import type { AxcutZoomRegion } from "@/lib/ai-edition/schema";
import { findDominantRegion } from "@/lib/zoomMath/zoomRegionUtils";
import { computeZoomTransform } from "@/lib/zoomMath/zoomTransform";
import type { SpeedRegion } from "./speed";
import {
	type AutoZoomSettings,
	DEFAULT_AUTO_ZOOM_SETTINGS,
	resolveZoomRendering,
} from "./zoom-motion";

export interface ZoomPreviewTransform {
	scale: number;
	translateXPercent: number;
	translateYPercent: number;
}

export const IDENTITY_ZOOM_TRANSFORM: ZoomPreviewTransform = {
	scale: 1,
	translateXPercent: 0,
	translateYPercent: 0,
};

const UNIT_STAGE = { width: 1, height: 1 };
const UNIT_MASK = { x: 0, y: 0, width: 1, height: 1 };

export interface ZoomPreviewOptions {
	/** Chain zooms close in time with a pan, as the compositor always does. Default true. */
	connectZooms?: boolean;
	/** The project's auto-zoom settings: an automatic zoom moves by them, like in the scene. */
	autoZoom?: AutoZoomSettings;
	/** The global Auto-Focus toggle (`resolveZoomRendering`). */
	autoFocusAll?: boolean;
}

function toLegacyZoomRegion(
	region: AxcutZoomRegion,
	autoZoom: AutoZoomSettings,
	autoFocusAll: boolean,
): LegacyZoomRegion {
	const rendering = resolveZoomRendering(region, autoZoom, autoFocusAll);
	return {
		id: region.id,
		startMs: region.startMs,
		endMs: region.endMs,
		depth: region.depth,
		focus: region.focus,
		focusMode: rendering.focusMode ?? undefined,
		rotationPreset: region.rotationPreset,
		customScale: region.customScale,
		source: region.source,
		...(rendering.motion ? { motion: rendering.motion } : {}),
	};
}

// Regions are converted once per input array: `findDominantRegion` caches on the identity of
// the array it is handed, and a fresh one every frame would defeat that cache.
let legacyRegionsCache: {
	regions: AxcutZoomRegion[];
	autoZoom: AutoZoomSettings;
	autoFocusAll: boolean;
	result: LegacyZoomRegion[];
} | null = null;

/** By value: the settings are re-read into a fresh object on every render. */
function sameAutoZoom(a: AutoZoomSettings, b: AutoZoomSettings): boolean {
	return (
		a.cameraMode === b.cameraMode &&
		a.maxScale === b.maxScale &&
		a.transitionSec === b.transitionSec &&
		a.holdSec === b.holdSec
	);
}

function legacyRegionsOf(
	regions: AxcutZoomRegion[],
	autoZoom: AutoZoomSettings,
	autoFocusAll: boolean,
): LegacyZoomRegion[] {
	const cached = legacyRegionsCache;
	if (
		cached &&
		cached.regions === regions &&
		sameAutoZoom(cached.autoZoom, autoZoom) &&
		cached.autoFocusAll === autoFocusAll
	) {
		return cached.result;
	}
	const result = regions.map((region) => toLegacyZoomRegion(region, autoZoom, autoFocusAll));
	legacyRegionsCache = { regions, autoZoom, autoFocusAll, result };
	return result;
}

/**
 * Resolves the zoom transform to apply to the preview at a given point on
 * the virtual (edited) timeline. `virtualTimeMs` must be in the same
 * coordinate space as `zoomRegion.startMs`/`endMs` (the timeline shown in
 * the ruler, not raw source-media time).
 *
 * `speedRegions` (same time space) keep the zoom-in/out transitions at their
 * on-screen duration while the footage under them is sped up.
 */
export function computeZoomPreviewTransform(
	zoomRegions: AxcutZoomRegion[],
	virtualTimeMs: number,
	cursorTelemetry?: CursorTelemetryPoint[],
	speedRegions?: SpeedRegion[],
	options: ZoomPreviewOptions = {},
): ZoomPreviewTransform {
	if (zoomRegions.length === 0) return IDENTITY_ZOOM_TRANSFORM;

	const legacyRegions = legacyRegionsOf(
		zoomRegions,
		options.autoZoom ?? DEFAULT_AUTO_ZOOM_SETTINGS,
		options.autoFocusAll ?? false,
	);
	// The compositor chains every pair of zooms close enough (`connected_pairs`): the preview
	// standing in for it did not, and zoomed out and back in where the export panned.
	const dominant = findDominantRegion(legacyRegions, virtualTimeMs, {
		cursorTelemetry,
		speedRegions,
		connectZooms: options.connectZooms ?? true,
	});
	if (!dominant.region || dominant.strength <= 0) return IDENTITY_ZOOM_TRANSFORM;

	const zoomScale = dominant.blendedScale ?? getZoomScale(dominant.region);
	const transform = computeZoomTransform({
		stageSize: UNIT_STAGE,
		baseMask: UNIT_MASK,
		zoomScale,
		zoomProgress: dominant.strength,
		focusX: dominant.region.focus.cx,
		focusY: dominant.region.focus.cy,
	});

	return {
		scale: transform.scale,
		translateXPercent: transform.x * 100,
		translateYPercent: transform.y * 100,
	};
}
