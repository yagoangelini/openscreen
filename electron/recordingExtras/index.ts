import type { BrowserWindow } from "electron";
import { closeDrawingWindows, type DrawingTarget, registerDrawingOverlay } from "./drawingOverlay";
import { registerSelfView, setSelfViewHudOpen } from "./selfView";

export { toggleDrawing } from "./drawingOverlay";

/** The drawing layer, its toolbar and the camera self-view: one call from main.ts at startup. */
export function registerRecordingExtras(options: {
	getHud: () => BrowserWindow | null;
	getDrawingTarget: () => DrawingTarget;
}) {
	registerDrawingOverlay({ getTarget: options.getDrawingTarget, getHud: options.getHud });
	registerSelfView({ getHud: options.getHud });
}

/**
 * Ties the extras to a HUD window: they exist alongside it and close with it, so none of
 * them lingers over the editor, or keeps the app alive once its last real window is gone.
 */
let currentHud: BrowserWindow | null = null;

export function attachRecordingExtrasToHud(hud: BrowserWindow) {
	currentHud = hud;
	setSelfViewHudOpen(true);
	hud.once("closed", () => {
		if (currentHud !== hud) return;
		currentHud = null;
		closeDrawingWindows();
		setSelfViewHudOpen(false);
	});
}
