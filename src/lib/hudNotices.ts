import type { ExternalToast, ToastT } from "sonner";

/**
 * What makes something on the HUD clickable, and how long a toast stays there.
 *
 * The HUD is click-through: the window ignores the mouse until the cursor is over
 * something the user can press, and that "something" is decided by one hit test, run
 * both by the DOM pointer handlers and by the main process's cursor poll (the only
 * route back while the window is input-transparent). A sonner toast is not part of the
 * HUD's own markup, so before this selector named it, the toast's close cross sat in
 * the click-through area: the real mouse never reached it. Every surface that floats on
 * the HUD is listed here, so a new kind of notice is clickable without its own wiring.
 */
export const HUD_INTERACTIVE_SELECTOR = [
	"[data-hud-interactive='true']",
	// Each toast, not the toaster: the toaster's list spans the window's width and must
	// stay click-through around the toasts. A toast on its way out is invisible but still in
	// the DOM for its exit animation, and must not keep the area under it from clicking through.
	"[data-sonner-toaster] [data-sonner-toast]:not([data-removed='true'])",
].join(", ");

/** True when the element under the pointer belongs to something the user can press. */
export function isHudInteractiveTarget(element: Element | null | undefined): boolean {
	return Boolean(element?.closest(HUD_INTERACTIVE_SELECTOR));
}

/** Every toast on the HUD closes this long after it appears (or is shown again). */
export const HUD_TOAST_DURATION_MS = 3000;

/** Marks a toast the HUD keeps until the user closes it. */
export const PERSISTENT_TOAST_CLASS = "openscreen-toast-persistent";

/**
 * For the few failures a 3 s toast would hide before they are read: the take is lost or
 * was not saved, so the user has to know and act. They stay until closed (the cross works).
 */
export function persistentToast(options: ExternalToast = {}): ExternalToast {
	return {
		...options,
		duration: Number.POSITIVE_INFINITY,
		className: [options.className, PERSISTENT_TOAST_CLASS].filter(Boolean).join(" "),
	};
}

export function isPersistentToast(toast: Pick<ToastT, "className">): boolean {
	return (toast.className ?? "").split(/\s+/).includes(PERSISTENT_TOAST_CLASS);
}

/**
 * When the HUD dismisses a toast, whatever duration its caller asked for (several asked
 * for 15 s, the muted-mic warning for "until the signal returns"): null keeps it.
 */
export function hudToastDismissDelayMs(toast: Pick<ToastT, "className">): number | null {
	return isPersistentToast(toast) ? null : HUD_TOAST_DURATION_MS;
}
