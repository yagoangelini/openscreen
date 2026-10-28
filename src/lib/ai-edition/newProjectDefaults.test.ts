import { describe, expect, it } from "vitest";
import {
	applyEditorDefaults,
	composeNewProjectEditor,
	DEFAULTABLE_EDITOR_KEYS,
	NEW_PROJECT_FACTORY_EDITOR,
	pickEditorDefaults,
} from "./newProjectDefaults";
import { getEditorSettings } from "./store/editorSettings";
import { LOOK_LEGACY_EDITOR_KEYS } from "./stylePresets";

describe("pickEditorDefaults", () => {
	it("keeps the look, the format and the editing, never what belongs to the footage", () => {
		const picked = pickEditorDefaults({
			cursorSize: 3,
			padding: 20,
			aspectRatio: "9:16",
			autoZoom: { maxScale: 1.8 },
			voiceEnhance: true,
			cropRegion: { x: 0.1, y: 0, width: 0.8, height: 1 },
			webcamCropRegion: { x: 0, y: 0, width: 0.5, height: 0.5 },
			webcamCropPan: { x: 0.2, y: 0.5 },
			audioGainDb: 6,
			voiceGainDb: 3,
			projectOverrides: { transcriptionModel: "small" },
			zoomRanges: [],
		});
		expect(picked).toEqual({
			cursorSize: 3,
			padding: 20,
			aspectRatio: "9:16",
			autoZoom: { maxScale: 1.8 },
			voiceEnhance: true,
		});
	});

	it("keeps the caption style without the project's language and lane", () => {
		const picked = pickEditorDefaults({
			captions: { fontSize: 60, color: "#ff0", language: "en", captionLane: "voiceover" },
		});
		expect(picked).toEqual({ captions: { fontSize: 60, color: "#ff0" } });
	});

	it("carries the speaker-echo removal and its strength into a default", () => {
		expect(pickEditorDefaults({ echoCancel: false, echoCancelStrength: "strong" })).toEqual({
			echoCancel: false,
			echoCancelStrength: "strong",
		});
	});

	it("covers every look field a style preset carries", () => {
		for (const key of LOOK_LEGACY_EDITOR_KEYS) expect(DEFAULTABLE_EDITOR_KEYS).toContain(key);
	});

	it("reads nothing out of a value that is no object", () => {
		expect(pickEditorDefaults(null)).toEqual({});
		expect(pickEditorDefaults("x")).toEqual({});
		expect(pickEditorDefaults([1])).toEqual({});
	});
});

describe("composeNewProjectEditor", () => {
	const latestLook = { padding: 10, cursorSize: 4 };

	it("copies the latest project's look while no defaults are saved, as before", () => {
		expect(composeNewProjectEditor({ defaults: null, presetLook: null, latestLook })).toEqual({
			...NEW_PROJECT_FACTORY_EDITOR,
			...latestLook,
		});
	});

	it("starts a new project from the defaults once there are some, not from the latest project", () => {
		const result = composeNewProjectEditor({
			defaults: { cursorSize: 2.6 },
			presetLook: null,
			latestLook,
		});
		expect(result).toEqual({ ...NEW_PROJECT_FACTORY_EDITOR, cursorSize: 2.6 });
		expect(getEditorSettings({ legacyEditor: result } as never).cursor.size).toBe(2.6);
		expect(getEditorSettings({ legacyEditor: result } as never).padding).toBe(50);
	});

	it("lets a default switch off a factory choice", () => {
		const result = composeNewProjectEditor({
			defaults: { cursorClickRing: false },
			presetLook: null,
			latestLook: null,
		});
		expect(result.cursorClickRing).toBe(false);
		expect(result.cursorShowKeystrokes).toBe(true);
	});

	it("puts a preset marked for new projects over the defaults' look", () => {
		const result = composeNewProjectEditor({
			defaults: { cursorSize: 2.6, aspectRatio: "9:16" },
			presetLook: { cursorSize: 5 },
			latestLook,
		});
		expect(result.cursorSize).toBe(5);
		expect(result.aspectRatio).toBe("9:16");
	});
});

describe("applyEditorDefaults", () => {
	it("writes the defaults over a project and keeps everything else it has", () => {
		const next = applyEditorDefaults(
			{
				cursorSize: 4,
				cropRegion: { x: 0.1, y: 0, width: 0.9, height: 1 },
				captions: { language: "en", fontSize: 30 },
			},
			{ cursorSize: 2, captions: { fontSize: 60 } },
		);
		expect(next).toEqual({
			cursorSize: 2,
			cropRegion: { x: 0.1, y: 0, width: 0.9, height: 1 },
			captions: { language: "en", fontSize: 60 },
		});
	});
});
