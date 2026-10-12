export const SHORTCUT_ACTIONS = [
	"openApp",
	"recordToggle",
	"pauseToggle",
	"addMarker",
	"cameraLayoutToggle",
	"drawingToggle",
	"addZoom",
	"addTrim",
	"addSpeed",
	"addCameraFullscreen",
	"splitCamera",
	"addAnnotation",
	"addHighlight",
	"addStep",
	"addAudio",
	"addVoiceover",
	"deleteSelected",
	"playPause",
	"copySelected",
	"paste",
] as const;

export type ShortcutAction = (typeof SHORTCUT_ACTIONS)[number];

/**
 * The actions registered system-wide, so they work while another app has focus --
 * the whole point while recording a tutorial in that other app.
 */
export const GLOBAL_SHORTCUT_ACTIONS = [
	"openApp",
	"recordToggle",
	"pauseToggle",
	"addMarker",
	"cameraLayoutToggle",
	"drawingToggle",
] as const;

export type GlobalShortcutAction = (typeof GLOBAL_SHORTCUT_ACTIONS)[number];

export type GlobalShortcutsConfig = Record<GlobalShortcutAction, ShortcutBinding>;

export function pickGlobalShortcuts(config: ShortcutsConfig): GlobalShortcutsConfig {
	return {
		openApp: config.openApp,
		recordToggle: config.recordToggle,
		pauseToggle: config.pauseToggle,
		addMarker: config.addMarker,
		cameraLayoutToggle: config.cameraLayoutToggle,
		drawingToggle: config.drawingToggle,
	};
}

export interface ShortcutBinding {
	key: string;
	/** Maps to Cmd on macOS, Ctrl on Windows/Linux */
	ctrl?: boolean;
	shift?: boolean;
	alt?: boolean;
}

export type ShortcutsConfig = Record<ShortcutAction, ShortcutBinding>;

export interface FixedShortcut {
	i18nKey: string;
	label: string;
	display: string;
	bindings: ShortcutBinding[];
}

export const FIXED_SHORTCUTS: FixedShortcut[] = [
	{ i18nKey: "undo", label: "Undo", display: "Ctrl + Z", bindings: [{ key: "z", ctrl: true }] },
	{
		i18nKey: "redo",
		label: "Redo",
		display: "Ctrl + Shift + Z / Ctrl + Y",
		bindings: [
			{ key: "z", ctrl: true, shift: true },
			{ key: "y", ctrl: true },
		],
	},
	{
		i18nKey: "cycleAnnotationsForward",
		label: "Cycle Annotations Forward",
		display: "Tab",
		bindings: [{ key: "tab" }],
	},
	{
		i18nKey: "cycleAnnotationsBackward",
		label: "Cycle Annotations Backward",
		display: "Shift + Tab",
		bindings: [{ key: "tab", shift: true }],
	},
	{
		i18nKey: "deleteSelectedAlt",
		label: "Delete Selected (alt)",
		display: "Del / ⌫",
		bindings: [{ key: "delete" }, { key: "backspace" }],
	},
	{
		i18nKey: "panTimeline",
		label: "Pan Timeline",
		display: "Scroll",
		bindings: [],
	},
	{ i18nKey: "zoomTimeline", label: "Zoom Timeline", display: "Ctrl + Scroll", bindings: [] },
	{ i18nKey: "frameBack", label: "Frame Back", display: "←", bindings: [{ key: "arrowleft" }] },
	{
		i18nKey: "frameForward",
		label: "Frame Forward",
		display: "→",
		bindings: [{ key: "arrowright" }],
	},
];

export type ShortcutConflict =
	| { type: "configurable"; action: ShortcutAction }
	| { type: "fixed"; label: string };

export function bindingsEqual(a: ShortcutBinding, b: ShortcutBinding): boolean {
	return (
		a.key.toLowerCase() === b.key.toLowerCase() &&
		!!a.ctrl === !!b.ctrl &&
		!!a.shift === !!b.shift &&
		!!a.alt === !!b.alt
	);
}

export function findConflict(
	binding: ShortcutBinding,
	forAction: ShortcutAction,
	config: ShortcutsConfig,
): ShortcutConflict | null {
	for (const fixed of FIXED_SHORTCUTS) {
		if (fixed.bindings.some((b) => bindingsEqual(b, binding))) {
			return { type: "fixed", label: fixed.label };
		}
	}
	for (const action of SHORTCUT_ACTIONS) {
		if (action !== forAction && bindingsEqual(config[action], binding)) {
			return { type: "configurable", action };
		}
	}
	return null;
}

// Global defaults sit on Ctrl+Shift+F-keys. Ctrl+Shift+O, the old "open app", is
// VS Code's Go to Symbol and Chrome's bookmark manager, so pressing it while
// recording a tutorial in either app summoned OpenScreen instead. Alt+F9/F10 are
// the NVIDIA overlay's, Win+Alt+R is the Game Bar's, and Ctrl+Alt+letter is AltGr
// on an ABNT2 keyboard.
export const DEFAULT_SHORTCUTS: ShortcutsConfig = {
	openApp: { key: "f12", ctrl: true, shift: true },
	recordToggle: { key: "f9", ctrl: true, shift: true },
	pauseToggle: { key: "f10", ctrl: true, shift: true },
	addMarker: { key: "f8", ctrl: true, shift: true },
	// "Rosto / Tela + câmera" during the take. F7 is caret browsing in Chrome and Edge only
	// without modifiers, and nothing claims Ctrl+Shift+F7 in Office, Teams or VS Code.
	cameraLayoutToggle: { key: "f7", ctrl: true, shift: true },
	// "Desenhar na tela". Excel and Word use Ctrl+Shift+F6 for "previous window"; nothing in
	// Teams, VS Code, Edge or Chrome claims it, and it is configurable like the others.
	drawingToggle: { key: "f6", ctrl: true, shift: true },
	addZoom: { key: "z" },
	addTrim: { key: "t" },
	addSpeed: { key: "s" },
	addCameraFullscreen: { key: "c" },
	// B, as in a blade: S is already speed.
	splitCamera: { key: "b" },
	addAnnotation: { key: "a" },
	// Tutorial annotations: H for a highlight rectangle, N for a numbered step.
	addHighlight: { key: "h" },
	addStep: { key: "n" },
	addAudio: { key: "m" },
	// Record a voiceover over the timeline from the playhead.
	addVoiceover: { key: "v" },
	deleteSelected: { key: "d", ctrl: true },
	playPause: { key: " " },
	copySelected: { key: "c", ctrl: true },
	paste: { key: "v", ctrl: true },
};

export const SHORTCUT_LABELS: Record<ShortcutAction, string> = {
	openApp: "Open App",
	recordToggle: "Start / Stop Recording",
	pauseToggle: "Pause / Resume Recording",
	addMarker: "Add Marker While Recording",
	cameraLayoutToggle: "Switch Face / Screen + Camera",
	drawingToggle: "Draw on Screen While Recording",
	addZoom: "Add Zoom",
	addTrim: "Add Trim",
	addSpeed: "Add Speed",
	addCameraFullscreen: "Add Full Camera",
	splitCamera: "Split Camera at Playhead",
	addAnnotation: "Add Annotation",
	addHighlight: "Add Highlight",
	addStep: "Add Numbered Step",
	addAudio: "Add Audio",
	addVoiceover: "Record Voiceover",
	deleteSelected: "Delete Selected",
	playPause: "Play / Pause",
	copySelected: "Copy Selected",
	paste: "Paste",
};

export function matchesShortcut(
	e: KeyboardEvent,
	binding: ShortcutBinding | undefined,
	isMacPlatform: boolean,
): boolean {
	if (!binding) return false;
	if (e.key.toLowerCase() !== binding.key.toLowerCase()) return false;

	const primaryMod = isMacPlatform ? e.metaKey : e.ctrlKey;
	if (primaryMod !== !!binding.ctrl) return false;
	if (e.shiftKey !== !!binding.shift) return false;
	if (e.altKey !== !!binding.alt) return false;

	return true;
}

/**
 * True when the event target owns its own keys, so editor shortcuts must not fire:
 * text fields, but also a focused dropdown (typing "p" to jump to "Português" added a
 * trim region instead) and sliders/comboboxes, whose arrow keys moved the playhead.
 */
export function isTextEditingTarget(target: EventTarget | null): boolean {
	if (
		target instanceof HTMLInputElement ||
		target instanceof HTMLTextAreaElement ||
		target instanceof HTMLSelectElement
	) {
		return true;
	}
	if (!(target instanceof HTMLElement)) {
		return false;
	}
	if (target.isContentEditable) {
		return true;
	}
	const role = target.getAttribute("role");
	return role === "slider" || role === "combobox" || role === "spinbutton" || role === "listbox";
}

const KEY_LABELS: Record<string, string> = {
	" ": "Space",
	delete: "Del",
	backspace: "⌫",
	escape: "Esc",
	arrowup: "↑",
	arrowdown: "↓",
	arrowleft: "←",
	arrowright: "→",
};

export function formatBinding(binding: ShortcutBinding, isMac: boolean): string {
	const parts: string[] = [];
	if (binding.ctrl) parts.push(isMac ? "⌘" : "Ctrl");
	if (binding.shift) parts.push(isMac ? "⇧" : "Shift");
	if (binding.alt) parts.push(isMac ? "⌥" : "Alt");
	parts.push(KEY_LABELS[binding.key] ?? binding.key.toUpperCase());
	return parts.join(" + ");
}

/**
 * The label a fixed row shows. Rows bound to the primary modifier are built from their bindings,
 * so macOS gets ⌘ like the configurable rows; the rest keep their hand-written `display`.
 */
export function formatFixedShortcut(shortcut: FixedShortcut, isMac: boolean): string {
	if (!shortcut.bindings.some((binding) => binding.ctrl)) return shortcut.display;
	return shortcut.bindings.map((binding) => formatBinding(binding, isMac)).join(" / ");
}

/**
 * The chip a tooltip shows for a fixed shortcut: its first binding only. Redo has two
 * (Ctrl + Shift + Z, Ctrl + Y), and a tooltip names one, so the label a dialog row shows
 * (`formatFixedShortcut`) would be too long for it. `undefined` when the row has no binding.
 */
export function formatFirstFixedBinding(i18nKey: string, isMac: boolean): string | undefined {
	const first = FIXED_SHORTCUTS.find((shortcut) => shortcut.i18nKey === i18nKey)?.bindings[0];
	return first ? formatBinding(first, isMac) : undefined;
}

export function mergeWithDefaults(partial: Partial<ShortcutsConfig>): ShortcutsConfig {
	const merged = { ...DEFAULT_SHORTCUTS };
	for (const action of SHORTCUT_ACTIONS) {
		if (partial[action]) {
			merged[action] = partial[action] as ShortcutBinding;
		}
	}
	return merged;
}
