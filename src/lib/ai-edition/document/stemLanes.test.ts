import { describe, expect, it } from "vitest";
import { type AxcutDocument, axcutSchemaVersion, parseDocumentFile } from "../schema";
import { getEditorSettings } from "../store/editorSettings";
import {
	addStemMute,
	documentHasStemLanes,
	moveStemMute,
	removeStemMute,
	sceneStemMutes,
	setStemMuteFade,
	stemMuteGain,
	stemMutePills,
} from "./stemLanes";

const createdAt = "2026-10-28T00:00:00.000Z";

/** A 60 s take with stems, cut into two clips: source 0..20 at 0..20, then source 40..60 at 20..40. */
function doc(over: Partial<AxcutDocument> = {}): AxcutDocument {
	return {
		schemaVersion: axcutSchemaVersion,
		project: { id: "p", title: "T", createdAt, updatedAt: createdAt },
		assets: [
			{
				id: "take",
				kind: "video",
				label: "take",
				originalPath: "/take.mp4",
				durationSec: 60,
				cameraTrack: null,
				audioStems: { voicePath: "/take.voice.m4a", systemPath: "/take.system.m4a" },
			},
		],
		transcript: null,
		transcripts: [],
		timeline: {
			clips: [
				{
					id: "c1",
					assetId: "take",
					sourceStartSec: 0,
					sourceEndSec: 20,
					timelineStartSec: 0,
					timelineEndSec: 20,
					wordRefs: [],
					origin: "user",
					reason: "",
				},
				{
					id: "c2",
					assetId: "take",
					sourceStartSec: 40,
					sourceEndSec: 60,
					timelineStartSec: 20,
					timelineEndSec: 40,
					wordRefs: [],
					origin: "user",
					reason: "",
				},
			],
			gaps: [],
			trimRanges: [],
			muteRanges: [],
			speedRanges: [],
			captionRanges: [],
		},
		annotations: [],
		zoomRanges: [],
		audioTracks: [],
		cameraSegments: [],
		legacyEditor: null,
		...over,
	};
}

let n = 0;
const makeId = () => `m${++n}`;

describe("stem lanes", () => {
	it("exist only for a timeline showing a take with stems", () => {
		expect(documentHasStemLanes(doc())).toBe(true);
		const plain = doc();
		plain.assets = plain.assets.map(({ audioStems: _s, ...rest }) => rest);
		expect(documentHasStemLanes(plain)).toBe(false);
	});

	it("silences 2 s of the stem under the playhead, anchored in source seconds", () => {
		// 25 s on the ruler is 45 s of source, in the second clip.
		const added = addStemMute(doc(), "system", 25, makeId);
		expect(added).not.toBeNull();
		const mute = added?.document.audioStemMutes?.[0];
		expect(mute).toMatchObject({ assetId: "take", stem: "system", startSec: 45, endSec: 47 });
		// Drawn back on the ruler where it was made.
		const pills = stemMutePills(added?.document ?? doc(), "system");
		expect(pills).toEqual([expect.objectContaining({ clipId: "c2", startSec: 25, endSec: 27 })]);
		// And only on its own lane.
		expect(stemMutePills(added?.document ?? doc(), "voice")).toEqual([]);
	});

	it("stays inside the clip, and merges with a stretch it touches", () => {
		const first = addStemMute(doc(), "voice", 19, makeId);
		expect(first?.document.audioStemMutes?.[0]).toMatchObject({ startSec: 19, endSec: 20 });
		const second = addStemMute(first?.document ?? doc(), "voice", 18, makeId);
		expect(second?.document.audioStemMutes).toHaveLength(1);
		expect(second?.document.audioStemMutes?.[0]).toMatchObject({ startSec: 18, endSec: 20 });
	});

	it("follows a cut: a stretch over a removed part of the source shows only where the source plays", () => {
		const document = doc({
			audioStemMutes: [
				{
					id: "x",
					assetId: "take",
					stem: "voice",
					startSec: 15,
					endSec: 45,
					fadeMs: 30,
					origin: "user",
				},
			],
		});
		// 15..20 in the first clip, 40..45 in the second; 20..40 of the source is cut away.
		expect(stemMutePills(document, "voice").map((p) => [p.startSec, p.endSec])).toEqual([
			[15, 20],
			[20, 25],
		]);
	});

	it("moves keeping its length and resizes within the take", () => {
		const document = doc({
			audioStemMutes: [
				{
					id: "x",
					assetId: "take",
					stem: "voice",
					startSec: 10,
					endSec: 12,
					fadeMs: 30,
					origin: "user",
				},
			],
		});
		const moved = moveStemMute(document, "x", -15, -15, 60);
		expect(moved?.document.audioStemMutes?.[0]).toMatchObject({ startSec: 0, endSec: 2 });
		const widened = moveStemMute(document, "x", 0, 100, 60);
		expect(widened?.document.audioStemMutes?.[0]).toMatchObject({ startSec: 10, endSec: 60 });
		const crossed = moveStemMute(document, "x", 5, 0, 60);
		expect(crossed?.document.audioStemMutes?.[0].endSec).toBe(12);
		expect(crossed?.document.audioStemMutes?.[0].startSec).toBeCloseTo(11.95);
	});

	it("edits the fade and removes a stretch, leaving no empty key behind", () => {
		const document = doc({
			audioStemMutes: [
				{
					id: "x",
					assetId: "take",
					stem: "voice",
					startSec: 1,
					endSec: 2,
					fadeMs: 30,
					origin: "user",
				},
			],
		});
		expect(setStemMuteFade(document, "x", 9000).audioStemMutes?.[0].fadeMs).toBe(2000);
		const removed = removeStemMute(document, "x");
		expect("audioStemMutes" in removed).toBe(false);
		expect(removeStemMute(removed, "x")).toBe(removed);
	});

	it("hands the scene its take's stretches in source seconds, sorted", () => {
		const document = doc({
			audioStemMutes: [
				{
					id: "b",
					assetId: "take",
					stem: "voice",
					startSec: 5,
					endSec: 6,
					fadeMs: 0,
					origin: "user",
				},
				{
					id: "a",
					assetId: "take",
					stem: "voice",
					startSec: 1,
					endSec: 2,
					fadeMs: 50,
					origin: "user",
				},
				{
					id: "c",
					assetId: "take",
					stem: "system",
					startSec: 3,
					endSec: 4,
					fadeMs: 0,
					origin: "user",
				},
			],
		});
		expect(sceneStemMutes(document, "take", "voice")).toEqual([
			{ startSec: 1, endSec: 2, fadeSec: 0.05 },
			{ startSec: 5, endSec: 6, fadeSec: 0 },
		]);
	});
});

describe("stemMuteGain", () => {
	// The same points as Rust `the_stem_mute_envelope_is_silent_inside_and_ramps_outside`
	// (`audio_stream.rs`): the preview and the export evaluate one function.
	it("is silent inside, ramps outside, and multiplies overlapping ramps", () => {
		const mutes = [{ startSec: 1, endSec: 2, fadeSec: 0.1 }];
		expect(stemMuteGain(mutes, 0.5)).toBe(1);
		expect(stemMuteGain(mutes, 0.95)).toBeCloseTo(0.5, 5);
		expect(stemMuteGain(mutes, 1)).toBe(0);
		expect(stemMuteGain(mutes, 1.5)).toBe(0);
		expect(stemMuteGain(mutes, 2.025)).toBeCloseTo(0.25, 5);
		expect(stemMuteGain(mutes, 2.2)).toBe(1);
		const close = [
			{ startSec: 1, endSec: 2, fadeSec: 0.2 },
			{ startSec: 2.3, endSec: 3, fadeSec: 0.2 },
		];
		expect(stemMuteGain(close, 2.15)).toBeCloseTo(0.75 * 0.75, 5);
	});
});

describe("the document change", () => {
	it("is backward compatible: a document without stretches parses without the key", () => {
		const parsed = parseDocumentFile(JSON.parse(JSON.stringify(doc())));
		expect(parsed.audioStemMutes).toBeUndefined();
		const withOne = parseDocumentFile(
			structuredClone(
				doc({
					audioStemMutes: [
						{
							id: "x",
							assetId: "take",
							stem: "voice",
							startSec: 1,
							endSec: 2,
							fadeMs: 30,
							origin: "user",
						},
					],
				}),
			),
		);
		expect(withOne.audioStemMutes).toHaveLength(1);
	});

	it("defaults the lanes unmuted and the echo removal on, for a project from before them", () => {
		const settings = getEditorSettings(doc());
		expect(settings.voiceMuted).toBe(false);
		expect(settings.systemMuted).toBe(false);
		expect(settings.echoCancel).toBe(true);
		expect(getEditorSettings(doc({ legacyEditor: { echoCancel: false } })).echoCancel).toBe(false);
	});
});
