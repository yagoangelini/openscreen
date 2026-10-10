import fs from "node:fs/promises";
import { globalShortcut } from "electron";
import {
	DEFAULT_SHORTCUTS,
	GLOBAL_SHORTCUT_ACTIONS,
	type GlobalShortcutAction,
	type GlobalShortcutsConfig,
	type ShortcutBinding,
} from "../src/lib/shortcuts";
import { SHORTCUTS_FILE } from "./ipc/handlers";

// Maps KeyboardEvent.key values to Electron accelerator key names
const KEY_TO_ACCELERATOR: Record<string, string> = {
	" ": "Space",
	"+": "Plus",
	// The main-row keys. These used to map to numsub/nummult/numdiv, so binding
	// Ctrl+Shift+- registered the NUMPAD minus instead.
	"-": "-",
	"*": "*",
	"/": "/",
	arrowup: "Up",
	arrowdown: "Down",
	arrowleft: "Left",
	arrowright: "Right",
	escape: "Escape",
	enter: "Return",
	backspace: "Backspace",
	delete: "Delete",
	tab: "Tab",
};

export function bindingToAccelerator(binding: ShortcutBinding): string {
	const parts: string[] = [];
	if (binding.ctrl) parts.push("CommandOrControl");
	if (binding.shift) parts.push("Shift");
	if (binding.alt) parts.push("Alt");

	const keyLower = binding.key.toLowerCase();
	const acceleratorKey = KEY_TO_ACCELERATOR[keyLower] ?? binding.key.toUpperCase();
	parts.push(acceleratorKey);

	return parts.join("+");
}

const registered = new Map<GlobalShortcutAction, string>();

/**
 * Registers each system-wide shortcut. A binding that cannot be registered (another
 * app owns it) keeps the action's previous binding, so a failed change never leaves
 * the action with no shortcut at all. Returns, per action, whether its binding is live.
 */
export function registerGlobalShortcuts(
	config: Partial<GlobalShortcutsConfig>,
	handlers: Record<GlobalShortcutAction, () => void>,
): Record<GlobalShortcutAction, boolean> {
	const results = {} as Record<GlobalShortcutAction, boolean>;
	for (const action of GLOBAL_SHORTCUT_ACTIONS) {
		const binding = config[action] ?? DEFAULT_SHORTCUTS[action];
		const accelerator = bindingToAccelerator(binding);
		const previous = registered.get(action);
		if (accelerator === previous) {
			results[action] = true;
			continue;
		}
		// Release the old binding first only when another action is about to take it
		// (a swap); otherwise register the new one first, so a failure keeps the old.
		const takenByOther = [...registered.entries()].find(
			([other, value]) => other !== action && value === accelerator,
		);
		if (takenByOther) {
			globalShortcut.unregister(accelerator);
			registered.delete(takenByOther[0]);
		}
		const success = globalShortcut.register(accelerator, handlers[action]);
		if (success) {
			if (previous) {
				globalShortcut.unregister(previous);
			}
			registered.set(action, accelerator);
			console.log(`Global shortcut registered: ${accelerator} (${action})`);
		} else {
			console.warn(`Failed to register global shortcut: ${accelerator} (${action})`);
		}
		results[action] = success;
	}
	return results;
}

export async function loadAndRegisterGlobalShortcuts(
	handlers: Record<GlobalShortcutAction, () => void>,
): Promise<void> {
	let saved: Partial<GlobalShortcutsConfig> = {};
	try {
		saved = JSON.parse(await fs.readFile(SHORTCUTS_FILE, "utf-8"));
	} catch {
		// No saved shortcuts yet: the defaults apply.
	}
	registerGlobalShortcuts(saved, handlers);
}

export function unregisterAllGlobalShortcuts(): void {
	globalShortcut.unregisterAll();
	registered.clear();
}
