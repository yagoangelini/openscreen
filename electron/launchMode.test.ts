import { readFileSync } from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";
import {
	RECORDER_APP_USER_MODEL_ID,
	type RunningAppState,
	recorderRelaunchCommand,
	requestedLaunchTarget,
	routeSecondInstance,
	STUDIO_APP_USER_MODEL_ID,
} from "./launchMode";

const ROOT = path.resolve(__dirname, "..");

describe("requestedLaunchTarget", () => {
	it("opens the Studio on a bare Windows launch", () => {
		expect(requestedLaunchTarget(["C:\\app\\Openscreen.exe"], "win32")).toBe("studio");
	});

	it("opens the HUD with --recorder", () => {
		expect(requestedLaunchTarget(["C:\\app\\Openscreen.exe", "--recorder"], "win32")).toBe(
			"recorder",
		);
	});

	it("finds the switch after the app path of a dev build and among Chromium switches", () => {
		expect(
			requestedLaunchTarget(
				["electron.exe", ".", "--user-data-dir=C:\\tmp\\p", "--recorder", "--allow-file-access"],
				"win32",
			),
		).toBe("recorder");
	});

	it("ignores look-alikes and the installer's --updated", () => {
		expect(requestedLaunchTarget(["Openscreen.exe", "--updated"], "win32")).toBe("studio");
		expect(requestedLaunchTarget(["Openscreen.exe", "--recorder=1"], "win32")).toBe("studio");
		expect(requestedLaunchTarget(["Openscreen.exe", "recorder"], "win32")).toBe("studio");
	});

	it("lets the last explicit switch win", () => {
		expect(requestedLaunchTarget(["x", "--recorder", "--studio"], "win32")).toBe("studio");
		expect(requestedLaunchTarget(["x", "--studio", "--recorder"], "linux")).toBe("recorder");
	});

	it("keeps the HUD as the bare launch outside Windows", () => {
		expect(requestedLaunchTarget(["openscreen"], "darwin")).toBe("recorder");
		expect(requestedLaunchTarget(["openscreen"], "linux")).toBe("recorder");
		expect(requestedLaunchTarget(["openscreen", "--studio"], "darwin")).toBe("studio");
	});
});

describe("routeSecondInstance", () => {
	const state = (over: Partial<RunningAppState>): RunningAppState => ({
		open: "hud",
		recordingBusy: false,
		editorExporting: false,
		...over,
	});

	it("opens the requested window when none is open", () => {
		expect(routeSecondInstance("studio", state({ open: "none" }))).toBe("open-studio");
		expect(routeSecondInstance("recorder", state({ open: "none" }))).toBe("open-recorder");
	});

	it("focuses the window that is already the requested one", () => {
		expect(routeSecondInstance("studio", state({ open: "editor" }))).toBe("focus");
		expect(routeSecondInstance("recorder", state({ open: "hud" }))).toBe("focus");
	});

	it("swaps an idle HUD for the Studio", () => {
		expect(routeSecondInstance("studio", state({ open: "hud" }))).toBe("open-studio");
	});

	it("never closes the HUD under a take or a countdown", () => {
		expect(routeSecondInstance("studio", state({ open: "hud", recordingBusy: true }))).toBe(
			"focus",
		);
	});

	it("asks the editor to hand over to the recorder", () => {
		expect(routeSecondInstance("recorder", state({ open: "editor" }))).toBe("editor-to-recorder");
	});

	it("leaves an exporting editor alone", () => {
		expect(routeSecondInstance("recorder", state({ open: "editor", editorExporting: true }))).toBe(
			"focus",
		);
	});
});

describe("recorderRelaunchCommand", () => {
	it("is the quoted exe plus --recorder when packaged", () => {
		expect(
			recorderRelaunchCommand(
				"C:\\Users\\Me\\AppData\\Local\\Programs\\Openscreen\\Openscreen.exe",
				null,
			),
		).toBe('"C:\\Users\\Me\\AppData\\Local\\Programs\\Openscreen\\Openscreen.exe" --recorder');
	});

	it("carries the app directory for a dev build", () => {
		expect(recorderRelaunchCommand("C:\\repo\\electron.exe", "C:\\repo")).toBe(
			'"C:\\repo\\electron.exe" "C:\\repo" --recorder',
		);
	});
});

describe("taskbar identities agree with the installer", () => {
	it("uses electron-builder's appId as the Studio's AppUserModelID", () => {
		const config = readFileSync(path.join(ROOT, "electron-builder.json5"), "utf8");
		expect(config).toMatch(
			new RegExp(`"appId":\\s*"${STUDIO_APP_USER_MODEL_ID.replace(/\./g, "\\.")}"`),
		);
	});

	it("is the fork's own identity, not upstream's", () => {
		expect(STUDIO_APP_USER_MODEL_ID).toBe("com.yagoangelini.openscreen");
		expect(RECORDER_APP_USER_MODEL_ID).toBe(`${STUDIO_APP_USER_MODEL_ID}.recorder`);
	});

	// The NSIS GUID is what makes the next installer replace the 2.4.0 install instead of
	// landing beside it: electron-builder derives it from appId unless pinned, and appId moved
	// off upstream's. This is the GUID it derived from "com.etiennelescot.openscreen".
	it("keeps the installer's product GUID and folders from before the appId change", () => {
		const config = readFileSync(path.join(ROOT, "electron-builder.json5"), "utf8");
		expect(config).toMatch(/"guid":\s*"5b412b41-8d8b-5faf-b557-de4fe681e5fc"/);
		expect(config).toMatch(/"productName":\s*"Openscreen"/);
	});

	it("retags existing shortcuts and taskbar pins on every install", () => {
		const nsh = readFileSync(path.join(ROOT, "build", "installer.nsh"), "utf8");
		const customInstall = nsh.slice(nsh.indexOf("!macro customInstall"));
		expect(customInstall).toContain("!insertmacro openscreenRetagShortcuts");
		expect(nsh).toContain("User Pinned\\TaskBar");
		expect(nsh).toContain('"$appExe" "${APP_ID}" "${RECORDER_APP_ID}"');
	});

	it("stamps the recorder's ID and switch on the installer's Recorder shortcuts", () => {
		const nsh = readFileSync(path.join(ROOT, "build", "installer.nsh"), "utf8");
		expect(nsh).toContain(`!define RECORDER_APP_ID "${RECORDER_APP_USER_MODEL_ID}"`);
		expect(nsh).toContain('"$appExe" "--recorder"');
	});

	it("ships the recorder icon the HUD points its taskbar button at", () => {
		const config = readFileSync(path.join(ROOT, "electron-builder.json5"), "utf8");
		expect(config).toContain('"from": "icons/icons/win/recorder.ico"');
		const ico = readFileSync(path.join(ROOT, "icons", "icons", "win", "recorder.ico"));
		expect(ico.readUInt16LE(2)).toBe(1); // icon resource
		const sizes = Array.from({ length: ico.readUInt16LE(4) }, (_, i) => ico[6 + i * 16] || 256);
		expect(sizes).toEqual([16, 24, 32, 48, 64, 128, 256]);
	});
});
