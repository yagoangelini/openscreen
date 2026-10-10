// @vitest-environment jsdom
import { describe, expect, it } from "vitest";
import {
	bindingsEqual,
	DEFAULT_SHORTCUTS,
	findConflict,
	GLOBAL_SHORTCUT_ACTIONS,
	isTextEditingTarget,
	pickGlobalShortcuts,
	SHORTCUT_ACTIONS,
} from "./shortcuts";

describe("global shortcuts", () => {
	it("defaults to Ctrl+Shift+F-keys that no default collides with", () => {
		expect(DEFAULT_SHORTCUTS.recordToggle).toEqual({ key: "f9", ctrl: true, shift: true });
		expect(DEFAULT_SHORTCUTS.pauseToggle).toEqual({ key: "f10", ctrl: true, shift: true });
		expect(DEFAULT_SHORTCUTS.addMarker).toEqual({ key: "f8", ctrl: true, shift: true });
		expect(DEFAULT_SHORTCUTS.openApp).toEqual({ key: "f12", ctrl: true, shift: true });
		for (const action of GLOBAL_SHORTCUT_ACTIONS) {
			expect(findConflict(DEFAULT_SHORTCUTS[action], action, DEFAULT_SHORTCUTS)).toBeNull();
		}
	});

	it("no longer takes Ctrl+Shift+O, VS Code's Go to Symbol", () => {
		const ctrlShiftO = { key: "o", ctrl: true, shift: true };
		for (const action of SHORTCUT_ACTIONS) {
			expect(bindingsEqual(DEFAULT_SHORTCUTS[action], ctrlShiftO)).toBe(false);
		}
	});

	it("picks exactly the system-wide actions out of a full config", () => {
		expect(Object.keys(pickGlobalShortcuts(DEFAULT_SHORTCUTS)).sort()).toEqual(
			[...GLOBAL_SHORTCUT_ACTIONS].sort(),
		);
	});
});

describe("isTextEditingTarget", () => {
	it("leaves a focused dropdown its own keys", () => {
		expect(isTextEditingTarget(document.createElement("select"))).toBe(true);
	});

	it("leaves sliders and comboboxes their arrow keys", () => {
		for (const role of ["slider", "combobox", "spinbutton", "listbox"]) {
			const element = document.createElement("div");
			element.setAttribute("role", role);
			expect(isTextEditingTarget(element), role).toBe(true);
		}
	});

	it("still lets shortcuts through on ordinary elements", () => {
		expect(isTextEditingTarget(document.createElement("button"))).toBe(false);
		expect(isTextEditingTarget(document.body)).toBe(false);
		expect(isTextEditingTarget(null)).toBe(false);
	});
});
