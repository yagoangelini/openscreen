// "Rosto / Tela + câmera": how the take is meant to show the camera, chosen on the HUD
// before the take and switched during it. Capture never changes -- screen and camera are
// always both recorded. The main process logs the switches on the take's media clock
// (the same clock as the markers) and writes them beside the video; the import turns
// them into camera pieces: full screen over each "face" span, the default
// picture-in-picture elsewhere.
//
// Relative imports only (none needed): the main process imports this module.

/** Sidecar beside a take's screen video: its initial layout and the switches. */
export const RECORDING_LAYOUT_SUFFIX = ".layout.json";

/** "face": only the camera, full screen. "screen": the screen with the camera in a corner. */
export const RECORDING_CAMERA_LAYOUTS = ["screen", "face"] as const;
export type RecordingCameraLayout = (typeof RECORDING_CAMERA_LAYOUTS)[number];

export const DEFAULT_RECORDING_CAMERA_LAYOUT: RecordingCameraLayout = "screen";

export function isRecordingCameraLayout(value: unknown): value is RecordingCameraLayout {
	return (RECORDING_CAMERA_LAYOUTS as readonly unknown[]).includes(value);
}

export function otherRecordingCameraLayout(layout: RecordingCameraLayout): RecordingCameraLayout {
	return layout === "face" ? "screen" : "face";
}

export interface RecordingLayoutSwitch {
	/** Media time of the take (ms since its first frame, pauses left out). */
	atMs: number;
	layout: RecordingCameraLayout;
}

/** What `<take>.mp4.layout.json` holds. */
export interface RecordingLayoutFile {
	version: 1;
	initial: RecordingCameraLayout;
	/** Sorted by time; each one changes the layout. */
	switches: RecordingLayoutSwitch[];
}

/** A take's layout as the document keeps it on the asset, in source seconds. */
export interface RecordingLayoutOnAsset {
	initial: RecordingCameraLayout;
	switches: { atSec: number; layout: RecordingCameraLayout }[];
}

/**
 * Reads a layout file, tolerant of everything a hand edit or a truncated write can do:
 * an unknown layout drops the switch, times are clamped at 0 and sorted, and a switch
 * that does not change the layout is dropped. `null` when nothing usable is there.
 */
export function parseRecordingLayout(raw: unknown): RecordingLayoutFile | null {
	if (!raw || typeof raw !== "object" || Array.isArray(raw)) return null;
	const candidate = raw as { initial?: unknown; switches?: unknown };
	if (!isRecordingCameraLayout(candidate.initial)) return null;
	const switches = (Array.isArray(candidate.switches) ? candidate.switches : [])
		.filter(
			(entry): entry is RecordingLayoutSwitch =>
				!!entry &&
				typeof entry === "object" &&
				typeof (entry as RecordingLayoutSwitch).atMs === "number" &&
				Number.isFinite((entry as RecordingLayoutSwitch).atMs) &&
				isRecordingCameraLayout((entry as RecordingLayoutSwitch).layout),
		)
		.map((entry) => ({ atMs: Math.max(0, Math.round(entry.atMs)), layout: entry.layout }))
		.sort((a, b) => a.atMs - b.atMs);
	return {
		version: 1,
		initial: candidate.initial,
		switches: compactSwitches(candidate.initial, switches),
	};
}

/** Drops the switches that change nothing, and keeps only the last of several at one time. */
function compactSwitches(
	initial: RecordingCameraLayout,
	switches: readonly RecordingLayoutSwitch[],
): RecordingLayoutSwitch[] {
	const lastAtEachTime: RecordingLayoutSwitch[] = [];
	for (const entry of switches) {
		const last = lastAtEachTime.at(-1);
		if (last && last.atMs === entry.atMs) lastAtEachTime[lastAtEachTime.length - 1] = entry;
		else lastAtEachTime.push(entry);
	}
	const out: RecordingLayoutSwitch[] = [];
	let current = initial;
	for (const entry of lastAtEachTime) {
		if (entry.layout === current) continue;
		out.push(entry);
		current = entry.layout;
	}
	return out;
}

/** The layout file for the asset: source seconds instead of media ms. */
export function recordingLayoutOnAsset(file: RecordingLayoutFile): RecordingLayoutOnAsset {
	return {
		initial: file.initial,
		switches: file.switches.map((entry) => ({ atSec: entry.atMs / 1000, layout: entry.layout })),
	};
}

/** True when the take shows anything but the default from start to end. */
export function recordingLayoutHasFace(layout: RecordingLayoutOnAsset): boolean {
	return layout.initial === "face" || layout.switches.some((entry) => entry.layout === "face");
}

/**
 * The spans of the take shown as "face", in source seconds, ends clamped to
 * `durationSec`. Spans that would be empty are left out.
 */
export function recordingFaceSpansSec(
	layout: RecordingLayoutOnAsset,
	durationSec: number,
): { startSec: number; endSec: number }[] {
	const spans: { startSec: number; endSec: number }[] = [];
	let current = layout.initial;
	let since = 0;
	const close = (endSec: number) => {
		if (current !== "face") return;
		const end = Math.min(endSec, durationSec);
		if (end > since) spans.push({ startSec: since, endSec: end });
	};
	for (const entry of [...layout.switches].sort((a, b) => a.atSec - b.atSec)) {
		if (entry.layout === current) continue;
		close(entry.atSec);
		current = entry.layout;
		since = Math.min(entry.atSec, durationSec);
	}
	close(durationSec);
	return spans;
}
