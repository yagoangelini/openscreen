// Which window a launch opens, and what a second launch does to the running app.
//
// On Windows the app has two entry points, each with its own taskbar button:
//   - `Openscreen.exe`            → OpenScreen Studio (the editor, on the last project)
//   - `Openscreen.exe --recorder` → OpenScreen Recorder (the recording HUD)
// Elsewhere a bare launch keeps opening the HUD, as upstream does.
//
// Pure: no Electron imports, so it is unit-tested under plain vitest.

/** The process-wide AppUserModelID. Must equal `appId` in electron-builder.json5: the
 *  installer stamps it on the Studio shortcuts, and a pinned taskbar icon only groups the
 *  windows whose ID matches its own. */
export const STUDIO_APP_USER_MODEL_ID = "com.yagoangelini.openscreen";
/** The recorder windows' own ID, so they get a taskbar button of their own. Also stamped
 *  on the "OpenScreen Recorder" shortcuts by build/installer.nsh. */
export const RECORDER_APP_USER_MODEL_ID = "com.yagoangelini.openscreen.recorder";
// Up to 2.4.0 both IDs were upstream's (`com.etiennelescot.openscreen[.recorder]`).
// build/installer.nsh retags every shortcut and taskbar pin that points at the installed
// exe, so a pin made under the old ID keeps grouping these windows.

export const STUDIO_NAME = "OpenScreen Studio";
export const RECORDER_NAME = "OpenScreen Recorder";

export const RECORDER_SWITCH = "--recorder";
export const STUDIO_SWITCH = "--studio";

export type LaunchTarget = "studio" | "recorder";

/**
 * The window a command line asks for. An explicit switch wins (the last one, if both are
 * given); without one, Windows opens the Studio and the other platforms the HUD.
 *
 * Matched anywhere in argv: on `second-instance` Chromium may reorder the switches, and
 * the packaged/dev offset (exe vs. electron + app path) does not matter for a flag.
 */
export function requestedLaunchTarget(
	argv: readonly string[],
	platform: NodeJS.Platform,
): LaunchTarget {
	for (let i = argv.length - 1; i >= 0; i--) {
		const arg = argv[i];
		if (arg === RECORDER_SWITCH) return "recorder";
		if (arg === STUDIO_SWITCH) return "studio";
	}
	return platform === "win32" ? "studio" : "recorder";
}

/** What the running app currently shows. */
export interface RunningAppState {
	/** The open main window: the HUD, the editor, or none (e.g. the bench, or mid-swap). */
	open: "hud" | "editor" | "none";
	/** A take is recording or counting down: the HUD must not be closed under it. */
	recordingBusy: boolean;
	/** The editor is exporting: closing it would cancel the export. */
	editorExporting: boolean;
}

export type SecondInstanceAction =
	/** Bring the window that is open to the front, change nothing. */
	| "focus"
	/** Open the Studio, closing an idle HUD. */
	| "open-studio"
	/** Open the HUD (no window was open). */
	| "open-recorder"
	/** Ask the editor to hand over to the HUD; it asks about unsaved changes first. */
	| "editor-to-recorder";

/** What a second launch asking for `target` does, given what the running app shows. */
export function routeSecondInstance(
	target: LaunchTarget,
	state: RunningAppState,
): SecondInstanceAction {
	if (state.open === "none") {
		return target === "studio" ? "open-studio" : "open-recorder";
	}
	if (target === "studio") {
		// A take in flight is never interrupted: the HUD is the only way to stop it.
		if (state.open === "hud" && !state.recordingBusy) return "open-studio";
		return "focus";
	}
	if (state.open === "editor" && !state.editorExporting) return "editor-to-recorder";
	return "focus";
}

/** The relaunch command Windows stores when the recorder's taskbar button is pinned. */
export function recorderRelaunchCommand(execPath: string, appPath: string | null): string {
	const quote = (value: string) => `"${value}"`;
	const parts = [quote(execPath)];
	// A dev build runs as electron.exe and needs the app directory; a packaged one does not.
	if (appPath) parts.push(quote(appPath));
	parts.push(RECORDER_SWITCH);
	return parts.join(" ");
}
