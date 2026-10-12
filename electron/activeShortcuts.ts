import type { GlobalShortcutAction, ShortcutBinding } from "../src/lib/shortcuts";

// The system-wide shortcuts live right now, apart from globalShortcut.ts so that the
// document service can read them (to leave them out of a take's keystroke plates) without
// importing Electron's globalShortcut and the IPC handlers behind it.

const active = new Map<GlobalShortcutAction, ShortcutBinding>();

export function setActiveGlobalShortcut(action: GlobalShortcutAction, binding: ShortcutBinding) {
	active.set(action, binding);
}

export function clearActiveGlobalShortcut(action?: GlobalShortcutAction) {
	if (action) active.delete(action);
	else active.clear();
}

export function activeGlobalShortcutBindings(): ShortcutBinding[] {
	return [...active.values()];
}
