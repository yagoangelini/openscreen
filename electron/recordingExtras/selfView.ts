import type { ChildProcessWithoutNullStreams } from "node:child_process";
import fs from "node:fs";
import net from "node:net";
import path from "node:path";
import { app, type BrowserWindow, ipcMain, type Rectangle, screen } from "electron";
import type { SelfViewShape, SelfViewSnapshot } from "../../src/lib/recordingExtrasApi";
import {
	LatestFrameMailbox,
	type SelfViewFrame,
	SelfViewFrameParser,
} from "../recording/selfViewStream";
import { createSelfViewWindow } from "./extrasWindows";

/**
 * "Ver a câmera ao gravar": a small floating window with the live camera, for the user only.
 * Content-protected, so it is never in the video, and shown only when the user asks for it
 * (the HUD's button), with the camera on.
 *
 * Who owns the camera decides where the picture comes from:
 * - between takes, the self-view opens the camera itself (getUserMedia);
 * - during a take on Windows the helper owns it, so the self-view lets go of it BEFORE the
 *   helper is spawned (the helper opening a camera still held elsewhere is what must never
 *   happen), and shows the small frames the helper publishes on a named pipe instead
 *   (`SelfViewPreviewPublisher`, ~15 fps, 320 px). The helper only makes them while the
 *   self-view is shown (`selfview on|off` on its stdin).
 */

interface SelfViewPlacement {
	x: number;
	y: number;
	size: number;
	shape: SelfViewShape;
	/** The user's toggle, kept across launches. */
	requested: boolean;
}

export const SELF_VIEW_MIN_SIZE = 120;
export const SELF_VIEW_MAX_SIZE = 480;
const DEFAULT_SIZE = 200;
const PLACEMENT_FILE = "self-view-window.json";
/** How long a take's start waits for the self-view to let go of the camera. */
const CAMERA_RELEASE_TIMEOUT_MS = 600;

let placement: SelfViewPlacement | null = null;
let window: BrowserWindow | null = null;
let hudOpen = false;
let camera: { enabled: boolean; deviceId: string | null } = { enabled: false, deviceId: null };
let helper: ChildProcessWithoutNullStreams | null = null;
let helperOwnsCamera = false;
let pipeServer: net.Server | null = null;
let dragOrigin: { x: number; y: number } | null = null;
let releaseWaiters: Array<() => void> = [];
/** The take's preview frames so far, and since when: logged when the helper lets go. */
let previewStats: { frames: number; sinceMs: number } | null = null;
const mailbox = new LatestFrameMailbox<SelfViewFrame>();
let getHud: () => BrowserWindow | null = () => null;

function placementPath() {
	return path.join(app.getPath("userData"), PLACEMENT_FILE);
}

/** A placement read back from disk, clamped into a display that still exists. */
export function sanitizePlacement(raw: unknown, workArea: Rectangle): SelfViewPlacement {
	const value = raw && typeof raw === "object" ? (raw as Partial<SelfViewPlacement>) : {};
	const size = Math.round(
		Math.min(
			SELF_VIEW_MAX_SIZE,
			Math.max(SELF_VIEW_MIN_SIZE, typeof value.size === "number" ? value.size : DEFAULT_SIZE),
		),
	);
	const fallback = {
		x: workArea.x + workArea.width - size - 24,
		y: workArea.y + workArea.height - size - 140,
	};
	const x = typeof value.x === "number" && Number.isFinite(value.x) ? value.x : fallback.x;
	const y = typeof value.y === "number" && Number.isFinite(value.y) ? value.y : fallback.y;
	return {
		x: Math.round(Math.min(Math.max(x, workArea.x), workArea.x + workArea.width - size)),
		y: Math.round(Math.min(Math.max(y, workArea.y), workArea.y + workArea.height - size)),
		size,
		shape: value.shape === "rounded" ? "rounded" : "circle",
		requested: value.requested === true,
	};
}

function currentPlacement(): SelfViewPlacement {
	if (!placement) {
		let raw: unknown = null;
		try {
			raw = JSON.parse(fs.readFileSync(placementPath(), "utf8"));
		} catch {
			// First use: the default corner.
		}
		const near = raw && typeof raw === "object" ? (raw as { x?: number; y?: number }) : {};
		const workArea = screen.getDisplayNearestPoint({
			x: Number.isFinite(near.x) ? (near.x as number) : 0,
			y: Number.isFinite(near.y) ? (near.y as number) : 0,
		}).workArea;
		placement = sanitizePlacement(raw, workArea);
	}
	return placement;
}

function savePlacement() {
	try {
		fs.writeFileSync(placementPath(), JSON.stringify(currentPlacement()), "utf8");
	} catch (error) {
		console.warn("[self-view] could not save its placement", error);
	}
}

function alive(win: BrowserWindow | null): win is BrowserWindow {
	return Boolean(win && !win.isDestroyed());
}

function shouldShow() {
	return currentPlacement().requested && camera.enabled && hudOpen;
}

function snapshot(): SelfViewSnapshot {
	return {
		requested: currentPlacement().requested,
		visible: alive(window) && window.isVisible(),
		shape: currentPlacement().shape,
		source: helperOwnsCamera ? "helper" : "camera",
		deviceId: camera.deviceId,
	};
}

function broadcast() {
	const message = snapshot();
	for (const win of [getHud(), window]) {
		if (alive(win)) win.webContents.send("self-view:state", message);
	}
}

function bounds(): Rectangle {
	const { x, y, size } = currentPlacement();
	return { x, y, width: size, height: size };
}

/** Tells a running helper whether to make preview frames: only while the window shows. */
function tellHelper() {
	const proc = helper;
	if (!proc || !proc.stdin.writable) return;
	proc.stdin.write(shouldShow() ? "selfview on\n" : "selfview off\n");
}

function update() {
	if (shouldShow()) {
		if (!alive(window)) {
			window = createSelfViewWindow(bounds());
			const created = window;
			created.on("closed", () => {
				if (window === created) window = null;
				mailbox.reset();
				for (const resolve of releaseWaiters.splice(0)) resolve();
			});
			created.once("ready-to-show", () => {
				if (!created.isDestroyed() && shouldShow()) {
					created.setBounds(bounds());
					created.showInactive();
					broadcast();
				}
			});
		} else if (!window.isVisible()) {
			window.showInactive();
		}
	} else if (alive(window)) {
		// Closed, not hidden: a hidden self-view would still hold the camera between takes.
		window.close();
		window = null;
	}
	tellHelper();
	broadcast();
}

/**
 * Before the helper is spawned: the self-view lets go of the camera (waited for, briefly)
 * and a pipe is opened for the helper's preview frames. Null config without a camera.
 */
export async function prepareSelfViewForTake(
	recordingId: number,
	webcamEnabled: boolean,
): Promise<{ selfViewPipe: string; selfViewPreview: boolean } | Record<string, never>> {
	if (process.platform !== "win32" || !webcamEnabled) return {};
	closePipe();
	helperOwnsCamera = true;
	if (alive(window)) {
		const askedAt = Date.now();
		let answered = false;
		const released = new Promise<void>((resolve) => {
			releaseWaiters.push(() => {
				answered = true;
				resolve();
			});
			setTimeout(resolve, CAMERA_RELEASE_TIMEOUT_MS);
		});
		broadcast();
		await released;
		console.info(
			`[self-view] camera ${answered ? "released" : "not released (timed out)"} in ${Date.now() - askedAt} ms`,
		);
	}
	previewStats = { frames: 0, sinceMs: Date.now() };
	const name = `openscreen-selfview-${process.pid}-${recordingId}`;
	const server = net.createServer((socket) => {
		const parser = new SelfViewFrameParser();
		socket.on("data", (chunk: Buffer) => {
			let frames: SelfViewFrame[];
			try {
				frames = parser.push(chunk);
			} catch (error) {
				console.warn("[self-view] dropping a stream that is not preview frames", error);
				socket.destroy();
				return;
			}
			for (const frame of frames) {
				if (previewStats) previewStats.frames += 1;
				const next = mailbox.offer(frame);
				if (next) sendFrame(next);
			}
		});
		socket.on("error", () => undefined);
	});
	server.on("error", (error) => console.warn("[self-view] preview pipe error", error));
	try {
		await new Promise<void>((resolve, reject) => {
			server.once("listening", resolve);
			server.once("error", reject);
			server.listen(`\\\\.\\pipe\\${name}`);
		});
	} catch (error) {
		console.warn("[self-view] no preview pipe for this take", error);
		server.close();
		return {};
	}
	pipeServer = server;
	return { selfViewPipe: name, selfViewPreview: shouldShow() };
}

function sendFrame(frame: SelfViewFrame) {
	if (!alive(window) || !window.isVisible()) {
		mailbox.reset();
		return;
	}
	window.webContents.send("self-view:frame", {
		width: frame.width,
		height: frame.height,
		rgba: frame.rgba,
	});
}

function closePipe() {
	pipeServer?.close();
	pipeServer = null;
	mailbox.reset();
}

/** The helper spawned with the config above: its stdin carries `selfview on|off`. */
export function attachSelfViewToHelper(proc: ChildProcessWithoutNullStreams) {
	if (!helperOwnsCamera) return;
	helper = proc;
	proc.once("close", () => {
		if (helper !== proc) return;
		releaseCameraFromHelper();
	});
}

/** The take's helper is gone (or never started): the self-view opens the camera again. */
export function releaseCameraFromHelper() {
	helper = null;
	closePipe();
	if (previewStats && previewStats.frames > 0) {
		const seconds = (Date.now() - previewStats.sinceMs) / 1000;
		console.info(
			`[self-view] ${previewStats.frames} preview frames in ${seconds.toFixed(1)} s (${(previewStats.frames / seconds).toFixed(1)} fps)`,
		);
	}
	previewStats = null;
	if (!helperOwnsCamera) return;
	helperOwnsCamera = false;
	broadcast();
}

/** The HUD reports its camera toggle and device; the self-view follows them. */
function setCamera(next: { enabled: boolean; deviceId: string | null }) {
	if (next.enabled === camera.enabled && next.deviceId === camera.deviceId) return;
	camera = next;
	update();
}

/** The HUD window came or went: no self-view without it (the editor has its own preview). */
export function setSelfViewHudOpen(open: boolean) {
	hudOpen = open;
	if (!open) camera = { enabled: false, deviceId: null };
	update();
}

export function registerSelfView(options: { getHud: () => BrowserWindow | null }) {
	getHud = options.getHud;

	ipcMain.handle("self-view:get-state", () => snapshot());
	ipcMain.handle("self-view:toggle", () => {
		const current = currentPlacement();
		placement = { ...current, requested: !current.requested };
		savePlacement();
		update();
		return snapshot();
	});
	ipcMain.on("self-view:camera", (_event, enabled: unknown, deviceId: unknown) => {
		setCamera({
			enabled: enabled === true,
			deviceId: typeof deviceId === "string" && deviceId ? deviceId : null,
		});
	});
	ipcMain.on("self-view:camera-released", () => {
		for (const resolve of releaseWaiters.splice(0)) resolve();
	});
	ipcMain.on("self-view:frame-ack", () => {
		const next = mailbox.ack();
		if (next) sendFrame(next);
	});
	ipcMain.on("self-view:set-shape", (_event, shape: unknown) => {
		if (shape !== "circle" && shape !== "rounded") return;
		placement = { ...currentPlacement(), shape };
		savePlacement();
		broadcast();
	});
	ipcMain.on("self-view:drag-start", () => {
		if (!alive(window)) return;
		const [x, y] = window.getPosition();
		dragOrigin = { x, y };
	});
	ipcMain.on("self-view:drag-to", (_event, deltaX: unknown, deltaY: unknown) => {
		if (!alive(window) || !dragOrigin || typeof deltaX !== "number" || typeof deltaY !== "number") {
			return;
		}
		if (!Number.isFinite(deltaX) || !Number.isFinite(deltaY)) return;
		const { size } = currentPlacement();
		// The window's own size every time: getBounds() drifts under fractional scaling.
		window.setBounds(
			{
				x: Math.round(dragOrigin.x + deltaX),
				y: Math.round(dragOrigin.y + deltaY),
				width: size,
				height: size,
			},
			false,
		);
	});
	ipcMain.on("self-view:drag-end", () => {
		if (!alive(window) || !dragOrigin) return;
		dragOrigin = null;
		const [x, y] = window.getPosition();
		const workArea = screen.getDisplayMatching(window.getBounds()).workArea;
		placement = sanitizePlacement({ ...currentPlacement(), x, y }, workArea);
		window.setBounds(bounds(), false);
		savePlacement();
	});
	ipcMain.on("self-view:resize", (_event, size: unknown) => {
		if (!alive(window) || typeof size !== "number" || !Number.isFinite(size)) return;
		const current = currentPlacement();
		const workArea = screen.getDisplayMatching(window.getBounds()).workArea;
		// Grows and shrinks around its centre, so it does not walk off under the pointer.
		const half = (Math.round(size) - current.size) / 2;
		placement = sanitizePlacement(
			{ ...current, size, x: current.x - half, y: current.y - half },
			workArea,
		);
		window.setBounds(bounds(), false);
		savePlacement();
	});
}
