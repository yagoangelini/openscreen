import { describe, expect, it } from "vitest";
import type { CameraFullscreenRegion } from "@/components/video-editor/types";
import { computeCameraFullscreenProgress, computeCameraLookBlend } from "./cameraFullscreenUtils";
import { TRANSITION_WINDOW_MS } from "./constants";

function makeRegion(startMs: number, endMs: number): CameraFullscreenRegion {
	return { id: `camera-${startMs}-${endMs}`, startMs, endMs };
}

describe("computeCameraFullscreenProgress", () => {
	it("returns 0 for an empty regions array", () => {
		expect(computeCameraFullscreenProgress([], 1000)).toBe(0);
	});

	it("returns 0 well outside any region", () => {
		const region = makeRegion(5000, 8000);
		expect(computeCameraFullscreenProgress([region], 0)).toBe(0);
		expect(computeCameraFullscreenProgress([region], 20000)).toBe(0);
	});

	it("returns exactly 0 at startMs and at endMs", () => {
		const region = makeRegion(5000, 8000);
		expect(computeCameraFullscreenProgress([region], region.startMs)).toBe(0);
		expect(computeCameraFullscreenProgress([region], region.endMs)).toBe(0);
	});

	it("returns 1 in the middle (hold) of a region", () => {
		const region = makeRegion(5000, 8000);
		expect(computeCameraFullscreenProgress([region], 6500)).toBe(1);
	});

	it("holds at 1 for the full duration between the lead-in and lead-out windows", () => {
		const region = makeRegion(1000, 3000);
		const leadInEnd = region.startMs + TRANSITION_WINDOW_MS;
		const leadOutStart = region.endMs - TRANSITION_WINDOW_MS;
		expect(computeCameraFullscreenProgress([region], leadInEnd)).toBeCloseTo(1, 5);
		expect(computeCameraFullscreenProgress([region], leadOutStart)).toBeCloseTo(1, 5);
		expect(computeCameraFullscreenProgress([region], (leadInEnd + leadOutStart) / 2)).toBe(1);
	});

	it("eases in from 0 (at startMs) toward 1 entirely within the region", () => {
		const region = makeRegion(5000, 8000);
		const leadInEnd = region.startMs + TRANSITION_WINDOW_MS;

		const atStart = computeCameraFullscreenProgress([region], region.startMs);
		const midway = computeCameraFullscreenProgress([region], (region.startMs + leadInEnd) / 2);
		const atLeadInEnd = computeCameraFullscreenProgress([region], leadInEnd);

		expect(atStart).toBe(0);
		expect(midway).toBeGreaterThan(0);
		expect(midway).toBeLessThan(1);
		expect(atLeadInEnd).toBeCloseTo(1, 5);
		// Monotonically increasing during ease-in.
		expect(midway).toBeGreaterThan(atStart);
		expect(atLeadInEnd).toBeGreaterThan(midway);
	});

	it("eases out from 1 toward 0, landing exactly at endMs", () => {
		const region = makeRegion(5000, 8000);
		const leadOutWindow = Math.min(TRANSITION_WINDOW_MS * 1.5, (region.endMs - region.startMs) / 2);
		const leadOutStart = region.endMs - leadOutWindow;

		const atLeadOutStart = computeCameraFullscreenProgress([region], leadOutStart);
		const midway = computeCameraFullscreenProgress([region], (leadOutStart + region.endMs) / 2);
		const atEndMs = computeCameraFullscreenProgress([region], region.endMs);

		expect(atLeadOutStart).toBeCloseTo(1, 5);
		expect(midway).toBeGreaterThan(0);
		expect(midway).toBeLessThan(1);
		expect(atEndMs).toBe(0);
		// Monotonically decreasing during ease-out.
		expect(midway).toBeLessThan(atLeadOutStart);
		expect(atEndMs).toBeLessThan(midway);
	});

	it("eases out over a longer window than it eases in (slower return to normal)", () => {
		// Long region so neither window is clamped: lead-in is TRANSITION_WINDOW_MS,
		// lead-out is 1.5x that. At TRANSITION_WINDOW_MS from the start the ease-in has
		// finished, but at the mirrored offset from the end the ease-out is still going.
		const region = makeRegion(5000, 15000);
		const atLeadInEnd = computeCameraFullscreenProgress(
			[region],
			region.startMs + TRANSITION_WINDOW_MS,
		);
		const mirroredNearEnd = computeCameraFullscreenProgress(
			[region],
			region.endMs - TRANSITION_WINDOW_MS,
		);
		expect(atLeadInEnd).toBeCloseTo(1, 5);
		expect(mirroredNearEnd).toBeLessThan(1);
		expect(mirroredNearEnd).toBeGreaterThan(0);
	});

	it("returns exactly 0 just past endMs and just before startMs", () => {
		const region = makeRegion(5000, 8000);
		expect(computeCameraFullscreenProgress([region], region.endMs + 1)).toBe(0);
		expect(computeCameraFullscreenProgress([region], region.startMs - 1)).toBe(0);
	});

	it("clamps the transition windows to half the region duration for short regions", () => {
		// Region shorter than 2x TRANSITION_WINDOW_MS: lead-in and lead-out windows must
		// each shrink to half the duration so they still meet exactly at the midpoint,
		// staying fully contained within [startMs, endMs].
		const region = makeRegion(1000, 1000 + TRANSITION_WINDOW_MS); // duration < 2x window
		const midpoint = (region.startMs + region.endMs) / 2;

		expect(computeCameraFullscreenProgress([region], region.startMs)).toBe(0);
		expect(computeCameraFullscreenProgress([region], region.endMs)).toBe(0);
		expect(computeCameraFullscreenProgress([region], midpoint)).toBeCloseTo(1, 5);
	});

	it("picks the strongest of multiple overlapping regions", () => {
		// Two regions that don't normally overlap in the UI, but the function should be
		// defensive: whichever region yields the higher strength wins for that instant.
		const early = makeRegion(0, 2000);
		const late = makeRegion(1800, 5000);
		const timeMs = 1900; // inside early's ease-out and late's ease-in
		const combinedStrongest = Math.max(
			computeCameraFullscreenProgress([early], timeMs),
			computeCameraFullscreenProgress([late], timeMs),
		);
		expect(computeCameraFullscreenProgress([early, late], timeMs)).toBeCloseTo(
			combinedStrongest,
			10,
		);
	});

	it("holds a span that opens the video from its first frame, easing out at its end only", () => {
		const opening = makeRegion(0, 3000);
		expect(computeCameraFullscreenProgress([opening], 0)).toBe(1);
		expect(computeCameraFullscreenProgress([opening], 1000)).toBe(1);
		expect(computeCameraFullscreenProgress([opening], 2900)).toBeLessThan(1);
		expect(computeCameraFullscreenProgress([opening], 3000)).toBe(0);
	});

	it("handles multiple disjoint regions independently", () => {
		const first = makeRegion(1000, 2000);
		const second = makeRegion(10000, 12000);
		expect(computeCameraFullscreenProgress([first, second], 1500)).toBe(1);
		expect(computeCameraFullscreenProgress([first, second], 5000)).toBe(0);
		expect(computeCameraFullscreenProgress([first, second], 11000)).toBe(1);
	});
});

describe("computeCameraLookBlend", () => {
	const run = (startMs: number, endMs: number, name: string) => ({ startMs, endMs, name });

	it("is null outside every span, and holds the look in the middle of one", () => {
		const runs = [run(4000, 8000, "a")];
		expect(computeCameraLookBlend(runs, 3000)).toBeNull();
		expect(computeCameraLookBlend(runs, 4000)).toBeNull();
		expect(computeCameraLookBlend(runs, 8000)).toBeNull();
		expect(computeCameraLookBlend(runs, 6000)).toEqual({ from: null, to: runs[0], k: 1 });
	});

	it("eases in from the global look and back out, within the span", () => {
		const runs = [run(4000, 8000, "a")];
		const rising = computeCameraLookBlend(runs, 4000 + TRANSITION_WINDOW_MS / 2);
		expect(rising?.from).toBeNull();
		expect(rising?.k).toBeCloseTo(0.5, 5);
		const falling = computeCameraLookBlend(runs, 8000 - TRANSITION_WINDOW_MS / 2);
		expect(falling?.k).toBeCloseTo(0.5, 5);
	});

	it("goes straight from one touching look to the next", () => {
		const runs = [run(4000, 8000, "a"), run(8000, 12000, "b")];
		// The first holds to its end.
		expect(computeCameraLookBlend(runs, 7999)?.k).toBe(1);
		expect(computeCameraLookBlend(runs, 8000)).toEqual({ from: null, to: runs[0], k: 1 });
		const across = computeCameraLookBlend(runs, 8000 + TRANSITION_WINDOW_MS / 2);
		expect(across?.from).toBe(runs[0]);
		expect(across?.to).toBe(runs[1]);
		expect(across?.k).toBeCloseTo(0.5, 5);
	});
});
