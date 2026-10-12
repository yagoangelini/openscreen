import fs from "node:fs";
import path from "node:path";
import { app, BrowserWindow, globalShortcut, ipcMain, type Rectangle, screen } from "electron";
import {
	type DrawingEvent,
	type DrawingMachineState,
	type DrawingStyle,
	drawingWindowPlan,
	INITIAL_DRAWING_STATE,
	reduceDrawing,
	sanitizeDrawingStyle,
} from "../../src/lib/drawing/overlayState";
import type { DrawingSnapshot } from "../../src/lib/recordingExtrasApi";
import { createDrawingLayerWindow, createDrawingToolbarWindow } from "./extrasWindows";

/**
 * "Desenhar na tela": the drawing layer over the recorded display, its toolbar, and the keys
 * that only exist while drawing. The phases are `reduceDrawing`'s; this file only applies them.
 *
 * Window capture: Windows Graphics Capture records a window's own pixels, not what is on the
 * screen over it, and the layer is another window (of another process, even). So with a
 * window source the strokes are seen by the user and NOT recorded; the toolbar says so, and
 * recording the screen is the way to keep them.
 */

export interface DrawingTarget {
	/** The display the take records (DIP), or the one under the pointer. */
	bounds: Rectangle;
	/** A window source: the strokes stay out of the video (see above). */
	windowCapture: boolean;
}

// Wide enough for the whole row, tall enough for the window-capture note under it.
const TOOLBAR_SIZE = { width: 780, height: 104 };
const STYLE_FILE = "drawing-overlay.json";

let state: DrawingMachineState = INITIAL_DRAWING_STATE;
let style: DrawingStyle | null = null;
let target: DrawingTarget | null = null;
let layer: BrowserWindow | null = null;
let toolbar: BrowserWindow | null = null;
let keysRegistered = false;
let getTarget: () => DrawingTarget = () => ({
	bounds: screen.getDisplayNearestPoint(screen.getCursorScreenPoint()).bounds,
	windowCapture: false,
});
let getHud: () => BrowserWindow | null = () => null;

function stylePath() {
	return path.join(app.getPath("userData"), STYLE_FILE);
}

function currentStyle(): DrawingStyle {
	if (!style) {
		try {
			style = sanitizeDrawingStyle(JSON.parse(fs.readFileSync(stylePath(), "utf8")));
		} catch {
			style = sanitizeDrawingStyle(null);
		}
	}
	return style;
}

function snapshot(): DrawingSnapshot {
	return {
		phase: state.phase,
		style: currentStyle(),
		windowCapture: target?.windowCapture ?? false,
	};
}

function alive(win: BrowserWindow | null): win is BrowserWindow {
	return Boolean(win && !win.isDestroyed());
}

function broadcast() {
	const message = snapshot();
	for (const win of [getHud(), layer, toolbar]) {
		if (alive(win)) win.webContents.send("drawing:state", message);
	}
}

function toolbarBounds(display: Rectangle): Rectangle {
	return {
		x: Math.round(display.x + (display.width - TOOLBAR_SIZE.width) / 2),
		y: display.y + 16,
		...TOOLBAR_SIZE,
	};
}

/** Shown without taking focus, once it has painted (a transparent window flashes black before). */
function showWhenReady(win: BrowserWindow) {
	if (win.webContents.isLoading()) {
		win.once("ready-to-show", () => {
			if (!win.isDestroyed()) win.showInactive();
		});
	} else {
		win.showInactive();
	}
}

function ensureLayer(bounds: Rectangle): BrowserWindow {
	if (!alive(layer)) {
		layer = createDrawingLayerWindow(bounds);
		const created = layer;
		created.on("closed", () => {
			if (layer === created) layer = null;
		});
	}
	// Placed each time it comes up (not while shown), and again after creation: on a display
	// with another scale factor, a window created there is sized against the primary display's
	// until it is moved onto its own.
	if (!layer.isVisible()) layer.setBounds(bounds);
	return layer;
}

function ensureToolbar(bounds: Rectangle): BrowserWindow {
	if (!alive(toolbar)) {
		toolbar = createDrawingToolbarWindow(bounds);
		const created = toolbar;
		created.on("closed", () => {
			if (toolbar === created) toolbar = null;
		});
	}
	// Where the user dragged it stays put while it shows; it comes back at the top each time.
	if (!toolbar.isVisible()) toolbar.setBounds(bounds);
	return toolbar;
}

function setDrawingKeys(on: boolean) {
	if (on === keysRegistered) return;
	keysRegistered = on;
	const keys: Array<[string, () => void]> = [
		["Escape", () => dispatch({ type: "exit" })],
		["Delete", () => sendToLayer("clear")],
		["CommandOrControl+Z", () => sendToLayer("undo")],
	];
	for (const [accelerator, handler] of keys) {
		if (on) {
			if (!globalShortcut.register(accelerator, handler)) {
				console.warn(`[drawing] could not register ${accelerator} while drawing`);
			}
		} else {
			globalShortcut.unregister(accelerator);
		}
	}
}

function sendToLayer(command: "clear" | "undo") {
	if (alive(layer)) layer.webContents.send("drawing:command", command);
}

function apply(previousPhase: DrawingMachineState["phase"]) {
	const plan = drawingWindowPlan(state.phase);
	if (previousPhase === "off" && state.phase !== "off") {
		// Aimed at the display being recorded each time drawing starts from nothing: the
		// source may have changed since the last time.
		target = getTarget();
	}
	if (plan.layerVisible && target) {
		const win = ensureLayer(target.bounds);
		win.setIgnoreMouseEvents(!plan.layerTakesMouse);
		if (!win.isVisible()) showWhenReady(win);
	} else if (alive(layer) && layer.isVisible()) {
		layer.setIgnoreMouseEvents(true);
		layer.hide();
	}
	if (plan.toolbarVisible && target) {
		const win = ensureToolbar(toolbarBounds(target.bounds));
		if (!win.isVisible()) showWhenReady(win);
	} else if (alive(toolbar) && toolbar.isVisible()) {
		toolbar.hide();
	}
	setDrawingKeys(plan.drawingKeys);
}

function dispatch(event: DrawingEvent) {
	const previous = state;
	state = reduceDrawing(state, event);
	if (state === previous) return;
	console.info("[drawing]", event.type, `${previous.phase} -> ${state.phase}`);
	apply(previous.phase);
	if (state.phase !== previous.phase) broadcast();
}

/** The HUD button and the global shortcut. */
export function toggleDrawing() {
	dispatch({ type: "toggle" });
}

/** Leaves drawing mode, keeping what is drawn until it fades. */
export function exitDrawing() {
	dispatch({ type: "exit" });
}

/** The HUD closed (the editor opened, the app quits): nothing of the overlay outlives it. */
export function closeDrawingWindows() {
	setDrawingKeys(false);
	state = INITIAL_DRAWING_STATE;
	for (const win of [layer, toolbar]) {
		if (alive(win)) win.close();
	}
	layer = null;
	toolbar = null;
}

export function registerDrawingOverlay(options: {
	getTarget: () => DrawingTarget;
	getHud: () => BrowserWindow | null;
}) {
	getTarget = options.getTarget;
	getHud = options.getHud;

	ipcMain.handle("drawing:get-state", () => snapshot());
	ipcMain.handle("drawing:toggle", () => {
		toggleDrawing();
		return snapshot();
	});
	ipcMain.on("drawing:exit", () => exitDrawing());
	ipcMain.on("drawing:strokes", (_event, visible: unknown) => {
		if (typeof visible === "boolean") dispatch({ type: "strokes", visible });
	});
	ipcMain.on("drawing:command", (_event, command: unknown) => {
		if (command === "clear" || command === "undo") sendToLayer(command);
	});
	ipcMain.handle("drawing:set-style", (_event, patch: unknown) => {
		style = sanitizeDrawingStyle({ ...currentStyle(), ...(patch as object) });
		try {
			fs.writeFileSync(stylePath(), JSON.stringify(style), "utf8");
		} catch (error) {
			console.warn("[drawing] could not save the drawing style", error);
		}
		broadcast();
		return snapshot();
	});
}
