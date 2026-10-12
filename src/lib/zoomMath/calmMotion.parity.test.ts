import { describe, expect, it } from "vitest";
import type { CursorTelemetryPoint, ZoomRegion } from "@/components/video-editor/types";
import type { ZoomMotion } from "@/lib/ai-edition/timeline/zoom-motion";
import { followViewAt } from "./cursorFollowUtils";
import { findDominantRegion } from "./zoomRegionUtils";
import { computeZoomTransform } from "./zoomTransform";

// The same scenario and the same numbers as `calm_motion_tests` in
// crates/compositor/src/regions.rs. The preview's mirror and the renderer must agree on them:
// change one side deliberately, regenerate there (`print_the_parity_tables`), copy here.

const CALM: ZoomMotion = {
	easing: "smooth",
	transitionBaseSec: 0.95,
	transitionPerLnSec: 0.35,
	panGapSec: 2,
	panDurationSec: 1.1,
	followDeadZone: 0.7,
	followTauSec: 0.5,
};

function region(
	id: string,
	startSec: number,
	endSec: number,
	scale: number,
	focus: [number, number],
	motion?: ZoomMotion,
): ZoomRegion {
	return {
		id,
		startMs: startSec * 1000,
		endMs: endSec * 1000,
		depth: 3,
		customScale: scale,
		focus: { cx: focus[0], cy: focus[1] },
		focusMode: "manual",
		...(motion ? { motion } : {}),
	};
}

const REGIONS: ZoomRegion[] = [
	region("a", 2, 4, 1.5, [0.35, 0.4], CALM),
	region("b", 5.1, 7, 1.5, [0.65, 0.6], CALM),
	region("c", 10, 12, 1.8, [0.7, 0.3]),
];

/** `(t, scale, centre x, centre y)`, the centre being the source point at the frame's middle. */
const PARITY_STATES: [number, number, number, number][] = [
	[0.5, 1.0, 0.5, 0.5],
	[1.2, 1.0509847, 0.47521925, 0.4834795],
	[1.6, 1.3493418, 0.37902012, 0.41934675],
	[2.0, 1.5, 0.35, 0.4],
	[3.0, 1.5, 0.35, 0.4],
	[4.3, 1.5, 0.3886766, 0.42578444],
	[4.55, 1.5, 0.5, 0.5],
	[4.8, 1.5, 0.6113235, 0.5742157],
	[5.1, 1.5, 0.65, 0.6],
	[6.0, 1.5, 0.65, 0.6],
	[7.4, 1.3493416, 0.6209798, 0.58065325],
	[9.4, 1.5158176, 0.6614285, 0.33857152],
	[11.0, 1.8, 0.7, 0.3],
	[12.6, 1.0309031, 0.5160408, 0.48395923],
];

/** `(t, hybrid x, hybrid y, follow x)`. */
const PARITY_VIEWS: [number, number, number, number][] = [
	[1.0, 0.50445145, 0.5, 0.55258596],
	[2.0, 0.5715253, 0.5, 0.6666666],
	[3.0, 0.55421567, 0.5, 0.5314189],
	[4.0, 0.4243046, 0.5, 0.33333334],
	[5.0, 0.4243046, 0.5, 0.37268084],
	[7.0, 0.5438855, 0.5, 0.6156579],
];

const TRACK: CursorTelemetryPoint[] = Array.from({ length: 181 }, (_, i) => {
	const t = i / 30;
	return {
		timeMs: t * 1000,
		cx: 0.5 + 0.35 * Math.sin(t * 1.3),
		cy: 0.5 + 0.1 * Math.cos(t * 0.9),
	};
});

describe("calm zoom motion: TS mirror against the renderer's golden table", () => {
	it("frames every instant like the compositor", () => {
		for (const [t, scale, x, y] of PARITY_STATES) {
			const dominant = findDominantRegion(REGIONS, t * 1000, { connectZooms: true });
			const zoomScale =
				dominant.blendedScale ?? (dominant.region?.customScale as number | undefined) ?? 1;
			const transform = computeZoomTransform({
				stageSize: { width: 1, height: 1 },
				baseMask: { x: 0, y: 0, width: 1, height: 1 },
				zoomScale,
				zoomProgress: dominant.region ? dominant.strength : 0,
				focusX: dominant.region?.focus.cx ?? 0.5,
				focusY: dominant.region?.focus.cy ?? 0.5,
			});
			expect(transform.scale, `scale at ${t}`).toBeCloseTo(scale, 4);
			expect((0.5 - transform.x) / transform.scale, `x at ${t}`).toBeCloseTo(x, 4);
			expect((0.5 - transform.y) / transform.scale, `y at ${t}`).toBeCloseTo(y, 4);
		}
	});

	it("follows the pointer like the compositor under both following cameras", () => {
		for (const [t, hx, hy, fx] of PARITY_VIEWS) {
			const hybrid = followViewAt(TRACK, { cx: 0.4, cy: 0.5 }, 500, t * 1000, 6000, 1.5, 0.7, 0.5);
			const follow = followViewAt(TRACK, { cx: 0.4, cy: 0.5 }, 500, t * 1000, 6000, 1.5, 0.2, 0.8);
			expect(hybrid?.cx, `hybrid x at ${t}`).toBeCloseTo(hx, 4);
			expect(hybrid?.cy, `hybrid y at ${t}`).toBeCloseTo(hy, 4);
			expect(follow?.cx, `follow x at ${t}`).toBeCloseTo(fx, 4);
		}
	});
});

describe("a following automatic zoom chained to the next one", () => {
	it("pans from where its following view is, not from the raw pointer", () => {
		const following: ZoomRegion = {
			...region("f", 1, 3, 1.5, [0.4, 0.5], CALM),
			focusMode: "auto",
		};
		const next = region("n", 4.1, 6, 1.5, [0.7, 0.3], CALM);
		const regions = [following, next];
		const before = findDominantRegion(regions, 2999, {
			connectZooms: true,
			cursorTelemetry: TRACK,
		});
		const after = findDominantRegion(regions, 3001, { connectZooms: true, cursorTelemetry: TRACK });
		const pointer = TRACK[Math.round(3 * 30)];
		// The pan starts on the view the hold showed: no jump onto the pointer at its first frame.
		expect(after.region?.focus.cx).toBeCloseTo(before.region?.focus.cx as number, 2);
		expect(after.region?.focus.cy).toBeCloseTo(before.region?.focus.cy as number, 2);
		expect(Math.abs((before.region?.focus.cx as number) - pointer.cx)).toBeGreaterThan(0.02);
	});
});
