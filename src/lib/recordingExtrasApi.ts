/**
 * The bridge the recording extras' windows use (`window.recordingExtrasAPI`, electron/preload.ts):
 * the drawing layer, its toolbar, the camera self-view, and the HUD's buttons for them.
 * Types only, shared by the preload and the renderer.
 */

import type { DrawingPhase, DrawingStyle } from "./drawing/overlayState";

export interface DrawingSnapshot {
	phase: DrawingPhase;
	style: DrawingStyle;
	/** The take records a window: the strokes stay out of the video. */
	windowCapture: boolean;
}

export type SelfViewShape = "circle" | "rounded";

export interface SelfViewSnapshot {
	/** The user's toggle on the HUD. */
	requested: boolean;
	visible: boolean;
	shape: SelfViewShape;
	/** Who has the camera: the self-view itself, or the recording helper (frames by pipe). */
	source: "camera" | "helper";
	deviceId: string | null;
}

export interface SelfViewFrameMessage {
	width: number;
	height: number;
	rgba: Uint8Array;
}

export interface RecordingExtrasApi {
	getDrawingState: () => Promise<DrawingSnapshot>;
	toggleDrawing: () => Promise<DrawingSnapshot>;
	exitDrawing: () => void;
	setDrawingStyle: (patch: Partial<DrawingStyle>) => Promise<DrawingSnapshot>;
	/** The layer: whether any stroke is still on screen. */
	reportStrokesVisible: (visible: boolean) => void;
	/** The toolbar's clear and undo, forwarded to the layer. */
	sendDrawingCommand: (command: "clear" | "undo") => void;
	onDrawingState: (callback: (state: DrawingSnapshot) => void) => () => void;
	onDrawingCommand: (callback: (command: "clear" | "undo") => void) => () => void;

	getSelfViewState: () => Promise<SelfViewSnapshot>;
	toggleSelfView: () => Promise<SelfViewSnapshot>;
	/** The HUD's camera toggle and device, which the self-view follows. */
	reportSelfViewCamera: (enabled: boolean, deviceId: string | null) => void;
	onSelfViewState: (callback: (state: SelfViewSnapshot) => void) => () => void;
	onSelfViewFrame: (callback: (frame: SelfViewFrameMessage) => void) => () => void;
	ackSelfViewFrame: () => void;
	selfViewCameraReleased: () => void;
	setSelfViewShape: (shape: SelfViewShape) => void;
	selfViewDragStart: () => void;
	selfViewDragTo: (deltaX: number, deltaY: number) => void;
	selfViewDragEnd: () => void;
	selfViewResize: (size: number) => void;

	/** The take's microphone records only silence (true), or signal came back (false). */
	onMicSilent: (callback: (silent: boolean) => void) => () => void;
}
