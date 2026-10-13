import { describe, expect, it } from "vitest";
import { cameraPieces, moveCameraBoundary } from "../document/cameraSegments";
import type { AxcutCameraSegment, AxcutClip } from "../schema";
import {
	buildSnapTargets,
	findSnap,
	landedOn,
	SNAP_RADIUS_PX,
	type SnapTarget,
	snapEdge,
	snapRadiusSec,
	snapSpan,
} from "./snap";
import { anchoredToRawSpanSec, replacePillSpan } from "./timelineMap";
import { ventilateTimelineSpanToTrims } from "./trim-mapping";

const target = (sec: number, kind: SnapTarget["kind"] = "edge"): SnapTarget => ({ sec, kind });

describe("snapRadiusSec", () => {
	it("is the same number of screen pixels at every zoom", () => {
		// 900 px showing 100 s, then the same panel zoomed 10x onto 10 s.
		expect(snapRadiusSec(9)).toBeCloseTo(SNAP_RADIUS_PX / 9, 12);
		expect(snapRadiusSec(90)).toBeCloseTo(SNAP_RADIUS_PX / 90, 12);
		// Zoomed in 10x, the magnet covers a tenth of the time: the same 8 px on screen.
		expect(snapRadiusSec(90) * 90).toBeCloseTo(snapRadiusSec(9) * 9, 12);
	});

	it("is off while the panel is unmeasured", () => {
		expect(snapRadiusSec(0)).toBe(0);
		expect(snapRadiusSec(Number.NaN)).toBe(0);
		expect(snapRadiusSec(Number.POSITIVE_INFINITY)).toBe(0);
		expect(findSnap(1, [target(1, "playhead")], 0)).toBeNull();
	});
});

describe("findSnap", () => {
	const radius = snapRadiusSec(9); // ~0.889 s

	it("locks onto a target inside the radius, exactly, and lets go outside it", () => {
		const targets = [target(30.4567891, "playhead")];
		expect(findSnap(30.0, targets, radius)?.sec).toBe(30.4567891);
		expect(findSnap(31.3, targets, radius)?.sec).toBe(30.4567891);
		// Past 8 px on either side: released.
		expect(findSnap(30.4567891 - radius - 0.001, targets, radius)).toBeNull();
		expect(findSnap(30.4567891 + radius + 0.001, targets, radius)).toBeNull();
		// The radius itself is already outside.
		expect(findSnap(30.4567891 + radius, targets, radius)).toBeNull();
	});

	it("gives the playhead priority over a nearer target", () => {
		const targets = [target(10.1, "clip"), target(10.6, "playhead"), target(10.05, "edge")];
		const hit = findSnap(10, targets, radius);
		expect(hit?.target.kind).toBe("playhead");
		expect(hit?.sec).toBe(10.6);
	});

	it("takes the nearest of the rest when the playhead is out of reach", () => {
		const targets = [target(20, "playhead"), target(10.4, "clip"), target(10.2, "edge")];
		expect(findSnap(10, targets, radius)?.sec).toBe(10.2);
		expect(findSnap(10.35, targets, radius)?.sec).toBe(10.4);
	});
});

describe("snapEdge", () => {
	const radius = snapRadiusSec(9);
	const targets = [target(5, "playhead"), target(0, "bound")];

	it("bypasses the magnet while Alt is held", () => {
		expect(snapEdge(5.2, targets, radius)).toEqual({ sec: 5, hit: { sec: 5, target: targets[0] } });
		expect(snapEdge(5.2, targets, radius, true)).toEqual({ sec: 5.2, hit: null });
	});

	it("leaves an edge alone with nothing in reach", () => {
		expect(snapEdge(2.5, targets, radius)).toEqual({ sec: 2.5, hit: null });
	});
});

describe("snapSpan", () => {
	const radius = snapRadiusSec(9);

	it("locks either edge of a moved span, keeping its length", () => {
		// The END comes near the playhead: the whole span shifts so the end lands on it.
		const byEnd = snapSpan(3, 5.7, [target(6, "playhead")], radius);
		expect(byEnd.edge).toBe("end");
		expect(byEnd.deltaSec).toBeCloseTo(0.3, 12);
		const byStart = snapSpan(5.8, 8.5, [target(6, "playhead")], radius);
		expect(byStart.edge).toBe("start");
		expect(byStart.deltaSec).toBeCloseTo(0.2, 12);
	});

	it("prefers the playhead on one edge over a nearer target on the other", () => {
		const out = snapSpan(10.02, 12.5, [target(10, "clip"), target(12, "playhead")], radius);
		expect(out.edge).toBe("end");
		expect(out.hit?.target.kind).toBe("playhead");
	});

	it("does nothing while Alt is held", () => {
		expect(snapSpan(3, 5.7, [target(6, "playhead")], radius, true)).toEqual({
			deltaSec: 0,
			hit: null,
			edge: null,
		});
	});
});

describe("buildSnapTargets and landedOn", () => {
	it("lists the playhead, the two ends, clip boundaries, edges and markers", () => {
		const targets = buildSnapTargets({
			playheadSec: 4.2,
			totalSec: 20,
			clipBoundariesSec: [0, 10, 10, 20],
			edgesSec: [3],
			markersSec: [7],
		});
		expect(targets.map((t) => `${t.kind}:${t.sec}`)).toEqual([
			"playhead:4.2",
			"bound:0",
			"bound:20",
			"clip:0",
			"clip:10",
			"clip:10",
			"clip:20",
			"edge:3",
			"marker:7",
		]);
		expect(buildSnapTargets({ playheadSec: null, totalSec: 5 }).map((t) => t.kind)).toEqual([
			"bound",
			"bound",
		]);
	});

	it("only claims a lock the clamp kept", () => {
		const hit = { sec: 5, target: target(5, "playhead") };
		expect(landedOn(hit, 5)).toBe(hit);
		expect(landedOn(hit, 5.001)).toBeNull();
		expect(landedOn(null, 5)).toBeNull();
	});
});

// The snapped edge has to survive the trip into storage: zooms, annotations and camera pieces
// keep a clip anchor in SOURCE seconds next to their ruler ms, and trims are source-only. A
// second clip that plays source 20–30 s at 10–20 s on the ruler makes the mapping a real one.
describe("a snapped edge through the source mapping", () => {
	const clip = (id: string, sourceStartSec: number, timelineStartSec: number): AxcutClip => ({
		id,
		assetId: "a",
		sourceStartSec,
		sourceEndSec: sourceStartSec + 10,
		timelineStartSec,
		timelineEndSec: timelineStartSec + 10,
		wordRefs: [],
		origin: "user",
		reason: "",
	});
	const clips = [clip("c1", 0, 0), clip("c2", 20, 10)];
	// Where a scrub leaves the playhead: any float, not a whole ms.
	const playheadSec = 13.4567891;
	const playheadMs = Math.round(playheadSec * 1000);
	const radius = snapRadiusSec(9);
	const targets = buildSnapTargets({ playheadSec, totalSec: 20 });
	let n = 0;
	const makeId = () => `frag${++n}`;

	it("stores a zoom's end on the playhead's ms, and its anchor maps back to it", () => {
		const zoom = { id: "z1", startMs: 11_000, endMs: 12_800, depth: 2 };
		const { sec } = snapEdge(13.2, targets, radius);
		expect(sec).toBe(playheadSec);
		const [stored] = replacePillSpan([zoom], "z1", 11_000, sec * 1000, clips, makeId) as Array<
			typeof zoom & { clipId: string; sourceStartSec: number; sourceEndSec: number }
		>;
		expect(stored.endMs).toBe(playheadMs);
		expect(stored.clipId).toBe("c2");
		expect(stored.sourceEndSec).toBeCloseTo(20 + (playheadMs / 1000 - 10), 12);
		const back = anchoredToRawSpanSec(stored, clips);
		expect(Math.round((back?.endSec ?? 0) * 1000)).toBe(playheadMs);
		expect(Math.abs((back?.endSec ?? 0) - playheadMs / 1000)).toBeLessThan(1e-9);
	});

	it("stores a moved annotation's start on the playhead's ms", () => {
		const ann = { id: "n1", startMs: 13_000, endMs: 15_000, type: "text" };
		const len = 2;
		const moved = snapSpan(13.3, 13.3 + len, targets, radius);
		expect(moved.edge).toBe("start");
		const [stored] = replacePillSpan(
			[ann],
			"n1",
			playheadSec * 1000,
			(playheadSec + len) * 1000,
			clips,
			makeId,
		) as Array<typeof ann & { clipId: string; sourceStartSec: number; sourceEndSec: number }>;
		expect(stored.startMs).toBe(playheadMs);
		const back = anchoredToRawSpanSec(stored, clips);
		expect(Math.abs((back?.startSec ?? 0) - playheadMs / 1000)).toBeLessThan(1e-9);
	});

	it("rolls a camera edge onto the playhead's ms, anchored in source time", () => {
		const onC2 = (
			id: string,
			startMs: number,
			endMs: number,
			mode: AxcutCameraSegment["mode"],
		): AxcutCameraSegment => ({
			id,
			segmentId: `seg_${id}`,
			startMs,
			endMs,
			clipId: "c2",
			sourceStartSec: 20 + (startMs / 1000 - 10),
			sourceEndSec: 20 + (endMs / 1000 - 10),
			mode,
			origin: "user",
		});
		const segments = [onC2("a", 11_000, 12_500, "fullscreen"), onC2("b", 12_500, 16_000, "hidden")];
		const { sec } = snapEdge(13.0, targets, radius);
		const rolled = moveCameraBoundary(segments, clips, "a", sec * 1000) ?? [];
		const pieces = cameraPieces(rolled, 20_000).filter((p) => !p.implicit);
		expect(pieces.map((p) => [p.startMs, p.endMs])).toEqual([
			[11_000, playheadMs],
			[playheadMs, 16_000],
		]);
		const left = rolled.find((s) => s.mode === "fullscreen");
		expect(left?.sourceEndSec).toBeCloseTo(20 + (playheadMs / 1000 - 10), 9);
	});

	it("ventilates a trim to the playhead in source time and back", () => {
		const { sec } = snapEdge(12.9, targets, radius);
		const [range] = ventilateTimelineSpanToTrims(11, sec, clips);
		expect(range.clipId).toBe("c2");
		// Trims are not on the ms grid: the source end is the playhead itself, mapped.
		expect(Math.abs(10 + (range.sourceEndSec - 20) - playheadSec)).toBeLessThan(1e-9);
	});
});
