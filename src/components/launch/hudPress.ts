import type React from "react";

/**
 * When a pointer event happened on the wall clock: the page's time origin plus the event's own
 * timestamp, which is the moment the OS delivered the press, not the moment a handler got to
 * run. Falls back to `nowMs` for a timestamp that cannot be one (synthetic events).
 */
export function pointerEventEpochMs(
	timeStamp: number,
	timeOrigin: number = performance.timeOrigin,
	nowMs: number = Date.now(),
): number {
	const at = timeOrigin + timeStamp;
	return Number.isFinite(at) && at <= nowMs + 5 && at > nowMs - 5_000 ? Math.min(at, nowMs) : nowMs;
}

/**
 * A HUD control that acts on the PRESS, not on the click. A click fires on the release, a
 * tenth of a second after the press, and the take went on recording through it: the stop
 * caught its own click, and a "Rosto / Tela + câmera" switch landed late. The keyboard (and a
 * click with no pointer behind it, `detail` 0) still acts on the click.
 */
export function pressHandlers(
	action: (pressedAtEpochMs: number) => void,
): Pick<React.ButtonHTMLAttributes<HTMLButtonElement>, "onPointerDown" | "onClick"> {
	return {
		onPointerDown: (event) => {
			if (event.button !== 0 || event.currentTarget.disabled) return;
			action(pointerEventEpochMs(event.timeStamp));
		},
		onClick: (event) => {
			if (event.detail !== 0) return;
			action(Date.now());
		},
	};
}
