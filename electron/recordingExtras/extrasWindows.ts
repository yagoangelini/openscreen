import path from "node:path";
import { fileURLToPath } from "node:url";
import { BrowserWindow, type Rectangle } from "electron";
import { ASSET_BASE_URL_ARG, applyContentProtection } from "../windows";

// The recording extras' windows: the drawing layer, its toolbar and the camera self-view.
// Kept out of windows.ts so the HUD's own window code stays as it is.

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const RENDERER_DIST = path.join(__dirname, "..", "dist");
const VITE_DEV_SERVER_URL = process.env["VITE_DEV_SERVER_URL"];

function loadRendererWindow(win: BrowserWindow, windowType: string) {
	if (VITE_DEV_SERVER_URL) {
		void win.loadURL(`${VITE_DEV_SERVER_URL}?windowType=${windowType}`);
	} else {
		void win.loadFile(path.join(RENDERER_DIST, "index.html"), { query: { windowType } });
	}
}

/** Frameless, transparent, always on top, never in the taskbar, never focused on its own. */
function overlayWindowOptions(bounds: Rectangle): Electron.BrowserWindowConstructorOptions {
	return {
		...bounds,
		frame: false,
		transparent: true,
		backgroundColor: "#00000000",
		hasShadow: false,
		resizable: false,
		maximizable: false,
		minimizable: false,
		fullscreenable: false,
		alwaysOnTop: true,
		skipTaskbar: true,
		// Never takes the keyboard from the app being recorded. Mouse input still arrives
		// (WS_EX_NOACTIVATE windows get clicks without being activated).
		focusable: false,
		enableLargerThanScreen: true,
		show: false,
		webPreferences: {
			preload: path.join(__dirname, "preload.mjs"),
			additionalArguments: [ASSET_BASE_URL_ARG],
			nodeIntegration: false,
			contextIsolation: true,
			backgroundThrottling: false,
		},
	};
}

/**
 * The drawing layer over the recorded display. NOT content-protected: the strokes are meant
 * to be in the video. Born click-through; drawing mode lifts that.
 */
export function createDrawingLayerWindow(bounds: Rectangle): BrowserWindow {
	const win = new BrowserWindow(overlayWindowOptions(bounds));
	// Above every ordinary always-on-top window (the HUD, the app being shown), so a stroke
	// is never drawn under something.
	win.setAlwaysOnTop(true, "screen-saver");
	win.setIgnoreMouseEvents(true);
	loadRendererWindow(win, "drawing-overlay");
	return win;
}

/** The drawing tools. Content-protected, like the HUD: its buttons never reach the video. */
export function createDrawingToolbarWindow(bounds: Rectangle): BrowserWindow {
	const win = new BrowserWindow(overlayWindowOptions(bounds));
	// One level over the layer, so it stays clickable while the layer takes the mouse.
	win.setAlwaysOnTop(true, "screen-saver", 1);
	applyContentProtection(win, "drawing toolbar");
	win.once("ready-to-show", () => applyContentProtection(win, "drawing toolbar"));
	loadRendererWindow(win, "drawing-toolbar");
	return win;
}

/** The floating camera the user sees and the video does not (content-protected). */
export function createSelfViewWindow(bounds: Rectangle): BrowserWindow {
	const win = new BrowserWindow({
		...overlayWindowOptions(bounds),
		// Over the HUD and the app being recorded; under the drawing layer while drawing.
		alwaysOnTop: true,
	});
	win.setAlwaysOnTop(true, "floating", 1);
	applyContentProtection(win, "self-view");
	win.once("ready-to-show", () => applyContentProtection(win, "self-view"));
	loadRendererWindow(win, "self-view");
	return win;
}
