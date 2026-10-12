import type { Rectangle } from "electron";
import type { NativeCursorType } from "../../../../src/native/contracts";

export interface WindowsCursorSampleEvent {
	type: "sample";
	timestampMs: number;
	x: number;
	y: number;
	visible: boolean;
	handle: string | null;
	cursorType?: NativeCursorType | null;
	leftButtonDown?: boolean;
	leftButtonPressed?: boolean;
	leftButtonReleased?: boolean;
	bounds?: {
		x: number;
		y: number;
		width: number;
		height: number;
	} | null;
	asset: WindowsCursorAssetPayload | null;
}

export interface WindowsCursorReadyEvent {
	type: "ready";
	timestampMs: number;
	/** The helper writes presses, releases, wheel and keys as their own `input` events, stamped
	 *  by the hook: the ticks' button flags stop being the source of clicks. Absent from older
	 *  helpers. */
	inputEvents?: boolean;
}

interface WindowsHelperRect {
	x: number;
	y: number;
	width: number;
	height: number;
}

/** One input event, at the hook's own time and point (physical screen pixels). */
export type WindowsCursorInputEvent = {
	type: "input";
	timestampMs: number;
	x: number;
	y: number;
} & (
	| {
			kind: "press";
			button: "left" | "right" | "middle";
			double?: boolean;
			target?: WindowsHelperRect;
			controlType?: number;
	  }
	| { kind: "release"; button: "left" | "right" | "middle" }
	| { kind: "wheel"; delta: number; horizontal?: boolean }
	| { kind: "key"; combo?: string }
);

/** A popup or menu window opening or closing (WinEvents), in physical screen pixels. */
export interface WindowsCursorPopupEvent {
	type: "popup";
	timestampMs: number;
	event: "open" | "close";
	id: string;
	menu?: boolean;
	rect?: WindowsHelperRect;
}

/** Where the pointer is between two samples (physical screen pixels), written only when it moved. */
export interface WindowsCursorMoveEvent {
	type: "move";
	timestampMs: number;
	x: number;
	y: number;
}

export interface WindowsCursorErrorEvent {
	type: "error";
	timestampMs: number;
	message: string;
}

export interface WindowsCursorAssetPayload {
	id: string;
	imageDataUrl: string;
	width: number;
	height: number;
	hotspotX: number;
	hotspotY: number;
	cursorType?: NativeCursorType | null;
}

export type WindowsCursorEvent =
	| WindowsCursorSampleEvent
	| WindowsCursorReadyEvent
	| WindowsCursorInputEvent
	| WindowsCursorPopupEvent
	| WindowsCursorMoveEvent
	| WindowsCursorErrorEvent;

export interface WindowsNativeRecordingSessionOptions {
	getDisplayBounds: () => Rectangle | null;
	maxSamples: number;
	sampleIntervalMs: number;
	sourceId?: string | null;
	startTimeMs?: number;
}
