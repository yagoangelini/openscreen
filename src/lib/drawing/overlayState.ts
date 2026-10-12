/**
 * Drawing on the screen during a take: what the overlay windows do, as a pure state machine.
 *
 * Two windows take part (electron/recordingExtras/drawingOverlay.ts):
 * - the DRAWING LAYER, a transparent always-on-top window over the recorded display, NOT
 *   content-protected, so the strokes end up in the video;
 * - the TOOLBAR, a small content-protected window, so its buttons never do.
 *
 * Phases:
 * - "off": nothing on screen (both windows hidden);
 * - "drawing": the layer takes the mouse, the toolbar shows, Esc and the drawing keys are live;
 * - "showing": drawing mode left, but strokes are still fading out: the layer stays visible
 *   and click-through (it must never take a click the user meant for their app), the toolbar
 *   and the keys are gone.
 *
 * Shared by the main process, so no `@/` imports.
 */

export type DrawingTool = "pen" | "arrow" | "rectangle" | "ellipse" | "highlighter";
export const DRAWING_TOOLS: readonly DrawingTool[] = [
	"pen",
	"arrow",
	"rectangle",
	"ellipse",
	"highlighter",
];

export const DRAWING_COLORS = [
	"#ef4444",
	"#facc15",
	"#22c55e",
	"#3b82f6",
	"#ffffff",
	"#111827",
] as const;
export const DRAWING_WIDTHS = [3, 6, 12] as const;
/** Seconds a finished stroke stays before it fades; 0 keeps it until cleared. */
export const DRAWING_FADE_OPTIONS = [3, 5, 10, 0] as const;

export interface DrawingStyle {
	tool: DrawingTool;
	color: string;
	width: number;
	fadeSeconds: number;
}

export const DEFAULT_DRAWING_STYLE: DrawingStyle = {
	tool: "pen",
	color: DRAWING_COLORS[0],
	width: DRAWING_WIDTHS[1],
	fadeSeconds: 3,
};

export type DrawingPhase = "off" | "drawing" | "showing";

export type DrawingEvent =
	/** The HUD button or the global shortcut. */
	| { type: "toggle" }
	/** Esc, the toolbar's close button, or a take/HUD that ended. */
	| { type: "exit" }
	/** The layer reports whether any stroke is still on screen. */
	| { type: "strokes"; visible: boolean };

export interface DrawingMachineState {
	phase: DrawingPhase;
	/** Whether the layer last said it still has strokes on screen. */
	strokesVisible: boolean;
}

export const INITIAL_DRAWING_STATE: DrawingMachineState = { phase: "off", strokesVisible: false };

export function reduceDrawing(
	state: DrawingMachineState,
	event: DrawingEvent,
): DrawingMachineState {
	switch (event.type) {
		case "toggle":
			return state.phase === "drawing"
				? { ...state, phase: state.strokesVisible ? "showing" : "off" }
				: { ...state, phase: "drawing" };
		case "exit":
			if (state.phase !== "drawing") return state;
			return { ...state, phase: state.strokesVisible ? "showing" : "off" };
		case "strokes":
			if (event.visible === state.strokesVisible) return state;
			return {
				strokesVisible: event.visible,
				phase: state.phase === "showing" && !event.visible ? "off" : state.phase,
			};
	}
}

/** What each phase asks of the windows and the keyboard. */
export interface DrawingWindowPlan {
	layerVisible: boolean;
	/** False: the layer ignores the mouse (WS_EX_TRANSPARENT), so every click goes through. */
	layerTakesMouse: boolean;
	toolbarVisible: boolean;
	/** Esc, Delete and Ctrl+Z registered while drawing, and only then. */
	drawingKeys: boolean;
}

export function drawingWindowPlan(phase: DrawingPhase): DrawingWindowPlan {
	return {
		layerVisible: phase !== "off",
		layerTakesMouse: phase === "drawing",
		toolbarVisible: phase === "drawing",
		drawingKeys: phase === "drawing",
	};
}

/** A stored style, with anything unknown or out of range replaced by the default. */
export function sanitizeDrawingStyle(raw: unknown): DrawingStyle {
	const value =
		raw && typeof raw === "object" ? (raw as Partial<Record<keyof DrawingStyle, unknown>>) : {};
	return {
		tool: DRAWING_TOOLS.includes(value.tool as DrawingTool)
			? (value.tool as DrawingTool)
			: DEFAULT_DRAWING_STYLE.tool,
		color:
			typeof value.color === "string" && /^#[0-9a-f]{6}$/i.test(value.color)
				? value.color
				: DEFAULT_DRAWING_STYLE.color,
		width: (DRAWING_WIDTHS as readonly unknown[]).includes(value.width)
			? (value.width as number)
			: DEFAULT_DRAWING_STYLE.width,
		fadeSeconds: (DRAWING_FADE_OPTIONS as readonly unknown[]).includes(value.fadeSeconds)
			? (value.fadeSeconds as number)
			: DEFAULT_DRAWING_STYLE.fadeSeconds,
	};
}
