// What the user did at a cursor sample, beyond moving: the input signals the Windows cursor
// sampler records (cursor-sampler.cpp) next to the pointer's position. They ride on ordinary
// cursor samples (`CursorRecordingSample.input`), one sample per event at the event's own time
// and place, so every older reader sees a plain sample and an older sidecar simply has none.
//
// Consumers: the auto-zoom planner (`zoom-suggestions.ts`) — typing holds, popup framing,
// wheel activity, the clicked element's bounds — and, later, on-screen shortcuts (`combo`).
//
// Privacy: a key-down carries its TIME only. `combo` exists only for a chord that holds Ctrl, Alt
// or Win ("Ctrl+K"); a plain key, Shift+key or an AltGr character never names its key. UI
// Automation contributes an element's bounds and control type, never its name or value.
//
// Relative imports only: the main process reads sidecars through this module.

/** A rectangle, as fractions of the captured surface (like `cx`/`cy`). */
export interface NormalizedRect {
	x: number;
	y: number;
	width: number;
	height: number;
}

export type CursorInputButton = "left" | "right" | "middle";

export type CursorInputSignal =
	| {
			kind: "press";
			button: CursorInputButton;
			/** The second press of a double click, by the system's own double-click settings. */
			double?: boolean;
			/** UI Automation: the bounds of the element under the press. */
			target?: NormalizedRect;
			/** UI Automation ControlType id of that element (50004 Edit, 50030 Document, …). */
			controlType?: number;
	  }
	| { kind: "release"; button: CursorInputButton }
	| { kind: "wheel"; delta: number; horizontal?: boolean }
	| { kind: "key"; combo?: string }
	| {
			kind: "popup-open";
			/** Pairs an open with its close. */
			id: string;
			rect: NormalizedRect;
			/** A system menu (EVENT_SYSTEM_MENUPOPUPSTART) rather than any popup window. */
			menu?: boolean;
	  }
	| { kind: "popup-close"; id: string };

/** UI Automation control types the planner reads (UIA_*ControlTypeId). */
export const UIA_CONTROL_TYPE = {
	edit: 50004,
	document: 50030,
	comboBox: 50003,
	menuItem: 50011,
} as const;

const BUTTONS: readonly CursorInputButton[] = ["left", "right", "middle"];

function finite(value: unknown): value is number {
	return typeof value === "number" && Number.isFinite(value);
}

export function normalizeRect(value: unknown): NormalizedRect | undefined {
	if (!value || typeof value !== "object") return undefined;
	const r = value as Record<string, unknown>;
	if (!finite(r.x) || !finite(r.y) || !finite(r.width) || !finite(r.height)) return undefined;
	if (r.width <= 0 || r.height <= 0) return undefined;
	return { x: r.x, y: r.y, width: r.width, height: r.height };
}

/** A combo as the sampler writes it: modifiers and one key joined by "+", nothing else. */
const COMBO = /^(?:(?:Ctrl|Alt|Shift|Win)\+)+\S{1,12}$/;

/** A stored signal, validated; anything malformed is dropped rather than half-read. */
export function normalizeInputSignal(value: unknown): CursorInputSignal | undefined {
	if (!value || typeof value !== "object") return undefined;
	const v = value as Record<string, unknown>;
	const button = BUTTONS.includes(v.button as CursorInputButton)
		? (v.button as CursorInputButton)
		: undefined;
	switch (v.kind) {
		case "press": {
			if (!button) return undefined;
			const target = normalizeRect(v.target);
			return {
				kind: "press",
				button,
				...(v.double === true ? { double: true } : {}),
				...(target ? { target } : {}),
				...(finite(v.controlType) ? { controlType: v.controlType } : {}),
			};
		}
		case "release":
			return button ? { kind: "release", button } : undefined;
		case "wheel":
			return finite(v.delta)
				? { kind: "wheel", delta: v.delta, ...(v.horizontal === true ? { horizontal: true } : {}) }
				: undefined;
		case "key":
			// Shift alone makes no shortcut: whatever wrote one, it does not travel on.
			return typeof v.combo === "string" &&
				COMBO.test(v.combo) &&
				/(?:^|\+)(?:Ctrl|Alt|Win)\+/.test(v.combo)
				? { kind: "key", combo: v.combo }
				: { kind: "key" };
		case "popup-open": {
			const rect = normalizeRect(v.rect);
			if (typeof v.id !== "string" || !rect) return undefined;
			return { kind: "popup-open", id: v.id, rect, ...(v.menu === true ? { menu: true } : {}) };
		}
		case "popup-close":
			return typeof v.id === "string" ? { kind: "popup-close", id: v.id } : undefined;
		default:
			return undefined;
	}
}
