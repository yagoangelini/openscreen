import { describe, expect, it } from "vitest";
import { type AxcutDocument, createEmptyDocument } from "../schema";
import { replacePillSpan } from "../timeline/timelineMap";
import { inferHistoryLabel } from "./historyLabels";

const base = (): AxcutDocument => ({
	...createEmptyDocument({ projectId: "p", title: "Projeto" }),
	timeline: {
		clips: [
			{
				id: "c1",
				assetId: "a",
				sourceStartSec: 0,
				sourceEndSec: 10,
				timelineStartSec: 0,
				timelineEndSec: 10,
				wordRefs: [],
				origin: "system",
				reason: "",
			},
		],
		gaps: [],
		trimRanges: [],
		muteRanges: [],
		speedRanges: [],
		captionRanges: [],
	},
});

const zoom = (id: string, startMs: number, depth: 1 | 2 = 2, source?: "auto") =>
	({
		id,
		startMs,
		endMs: startMs + 1000,
		depth,
		focus: { cx: 0.5, cy: 0.5 },
		...(source ? { source } : {}),
	}) as AxcutDocument["zoomRanges"][number];

describe("inferHistoryLabel", () => {
	it("names zoom edits: add, move, restyle, remove, and a batch of automatic ones", () => {
		const doc = base();
		const one = { ...doc, zoomRanges: [zoom("z1", 1000)] };
		expect(inferHistoryLabel(doc, one)).toBe("addZoom");
		expect(inferHistoryLabel(one, { ...one, zoomRanges: [zoom("z1", 3000)] })).toBe("moveZoom");
		expect(inferHistoryLabel(one, { ...one, zoomRanges: [zoom("z1", 1000, 1)] })).toBe("editZoom");
		expect(inferHistoryLabel(one, doc)).toBe("removeZoom");
		expect(
			inferHistoryLabel(doc, {
				...doc,
				zoomRanges: [zoom("a1", 0, 2, "auto"), zoom("a2", 4000, 2, "auto")],
			}),
		).toBe("autoZooms");
	});

	it("names a cut, a split and a speed change", () => {
		const doc = base();
		const trim = { id: "t", assetId: "a", startSec: 1, endSec: 2, reason: "", origin: "user" };
		expect(
			inferHistoryLabel(doc, {
				...doc,
				timeline: { ...doc.timeline, trimRanges: [trim as never] },
			}),
		).toBe("addTrim");
		const [c] = doc.timeline.clips;
		const split = [
			{ ...c, sourceEndSec: 5, timelineEndSec: 5 },
			{ ...c, id: "c2", sourceStartSec: 5, timelineStartSec: 5 },
		];
		expect(inferHistoryLabel(doc, { ...doc, timeline: { ...doc.timeline, clips: split } })).toBe(
			"splitClip",
		);
		expect(inferHistoryLabel(doc, { ...doc, legacyEditor: { speedRegions: [{ id: "s" }] } })).toBe(
			"speed",
		);
	});

	it("puts a clip edit ahead of the regions it re-derives", () => {
		const doc = { ...base(), zoomRanges: [zoom("z1", 1000)] };
		const [c] = doc.timeline.clips;
		const next = {
			...doc,
			timeline: { ...doc.timeline, clips: [{ ...c, sourceEndSec: 8, timelineEndSec: 8 }] },
			zoomRanges: [zoom("z1", 900)],
		};
		expect(inferHistoryLabel(doc, next)).toBe("editClip");
	});

	it("names settings, a rename, and falls back to a plain edit", () => {
		const doc = base();
		expect(inferHistoryLabel(doc, { ...doc, legacyEditor: { padding: 30 } })).toBe("settings");
		expect(inferHistoryLabel(doc, { ...doc, project: { ...doc.project, title: "Novo" } })).toBe(
			"renameProject",
		);
		// A copy equal by value: nothing to name.
		expect(inferHistoryLabel(doc, structuredClone(doc))).toBe("edit");
	});
	it("tells a camera piece's own look from a split", () => {
		const doc = base();
		const seg = (id: string, startMs: number, endMs: number, overrides?: object) =>
			({
				id,
				segmentId: id,
				startMs,
				endMs,
				mode: "pip",
				origin: "user",
				...(overrides ? { overrides } : {}),
			}) as AxcutDocument["cameraSegments"][number];
		const one = { ...doc, cameraSegments: [seg("s1", 0, 10000)] };
		expect(
			inferHistoryLabel(one, {
				...one,
				cameraSegments: [seg("s1", 0, 10000, { webcamMirrored: true })],
			}),
		).toBe("cameraLook");
		expect(
			inferHistoryLabel(doc, {
				...doc,
				cameraSegments: [seg("s1", 0, 10000, { webcamMirrored: true })],
			}),
		).toBe("cameraLook");
		expect(
			inferHistoryLabel(one, {
				...one,
				cameraSegments: [seg("s1", 0, 4000), seg("s2", 4000, 10000)],
			}),
		).toBe("splitCamera");
		// A full-screen stretch where there was none (the import's face span) is not a split.
		expect(
			inferHistoryLabel(doc, {
				...doc,
				cameraSegments: [{ ...seg("f", 4000, 7000), mode: "fullscreen" }],
			}),
		).toBe("camera");
	});
	it("names an edge snapped onto the playhead a move of that region, in one step", () => {
		// The timeline magnet only changes WHERE an edge lands: the write is the same
		// replacePillSpan a free drag makes, read back the same way.
		const doc = { ...base(), zoomRanges: [zoom("z1", 1000)] };
		const playheadMs = 4567.891;
		const zoomRanges = replacePillSpan(
			doc.zoomRanges,
			"z1",
			1000,
			playheadMs,
			doc.timeline.clips,
			() => "z1b",
		) as AxcutDocument["zoomRanges"];
		expect(zoomRanges.map((z) => z.endMs)).toEqual([Math.round(playheadMs)]);
		expect(inferHistoryLabel(doc, { ...doc, zoomRanges })).toBe("moveZoom");
	});
});
