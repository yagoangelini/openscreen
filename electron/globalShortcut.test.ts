import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => {
	const owned = new Set<string>();
	return {
		owned,
		/** Accelerators another app holds: registering them fails. */
		takenElsewhere: new Set<string>(),
		globalShortcut: {
			register: vi.fn((accelerator: string) => {
				if (mocks.takenElsewhere.has(accelerator) || owned.has(accelerator)) return false;
				owned.add(accelerator);
				return true;
			}),
			unregister: vi.fn((accelerator: string) => {
				owned.delete(accelerator);
			}),
			unregisterAll: vi.fn(() => owned.clear()),
		},
	};
});

vi.mock("electron", () => ({ globalShortcut: mocks.globalShortcut }));
vi.mock("./ipc/handlers", () => ({ SHORTCUTS_FILE: "/nonexistent/shortcuts.json" }));

import { DEFAULT_SHORTCUTS } from "../src/lib/shortcuts";
import {
	bindingToAccelerator,
	registerGlobalShortcuts,
	unregisterAllGlobalShortcuts,
} from "./globalShortcut";

const handlers = {
	openApp: vi.fn(),
	recordToggle: vi.fn(),
	pauseToggle: vi.fn(),
	addMarker: vi.fn(),
	cameraLayoutToggle: vi.fn(),
};

describe("bindingToAccelerator", () => {
	it("maps F-keys and the default record binding", () => {
		expect(bindingToAccelerator(DEFAULT_SHORTCUTS.recordToggle)).toBe("CommandOrControl+Shift+F9");
	});

	it("binds the main-row minus and slash, not the numpad's", () => {
		expect(bindingToAccelerator({ key: "-", ctrl: true })).toBe("CommandOrControl+-");
		expect(bindingToAccelerator({ key: "/", ctrl: true })).toBe("CommandOrControl+/");
	});
});

describe("registerGlobalShortcuts", () => {
	beforeEach(() => {
		unregisterAllGlobalShortcuts();
		mocks.takenElsewhere.clear();
		vi.clearAllMocks();
	});

	it("registers all five system-wide actions from the defaults", () => {
		const results = registerGlobalShortcuts({}, handlers);
		expect(Object.values(results).every(Boolean)).toBe(true);
		expect([...mocks.owned].sort()).toEqual(
			[
				"CommandOrControl+Shift+F10",
				"CommandOrControl+Shift+F12",
				"CommandOrControl+Shift+F7",
				"CommandOrControl+Shift+F8",
				"CommandOrControl+Shift+F9",
			].sort(),
		);
	});

	it("keeps the old binding when the new one belongs to another app", () => {
		registerGlobalShortcuts({}, handlers);
		mocks.takenElsewhere.add("CommandOrControl+Shift+F6");
		const results = registerGlobalShortcuts(
			{ addMarker: { key: "f6", ctrl: true, shift: true } },
			handlers,
		);
		expect(results.addMarker).toBe(false);
		expect(mocks.owned.has("CommandOrControl+Shift+F8")).toBe(true);
	});

	it("lets two actions swap their bindings", () => {
		registerGlobalShortcuts({}, handlers);
		const results = registerGlobalShortcuts(
			{
				recordToggle: DEFAULT_SHORTCUTS.pauseToggle,
				pauseToggle: DEFAULT_SHORTCUTS.recordToggle,
			},
			handlers,
		);
		expect(results.recordToggle).toBe(true);
		expect(results.pauseToggle).toBe(true);
		expect(mocks.owned.has("CommandOrControl+Shift+F9")).toBe(true);
		expect(mocks.owned.has("CommandOrControl+Shift+F10")).toBe(true);
	});
});
