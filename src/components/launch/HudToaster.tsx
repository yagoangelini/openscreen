import { useEffect, useRef } from "react";
import { type ToastT, toast, useSonner } from "sonner";
import { Toaster } from "@/components/ui/sonner";
import { HUD_TOAST_DURATION_MS, hudToastDismissDelayMs } from "@/lib/hudNotices";

/**
 * Closes each HUD toast {@link HUD_TOAST_DURATION_MS} after it appears, whatever duration
 * its caller asked for: the HUD sits over the app being recorded, and a 15 s warning there
 * covers the user's own screen. Showing a toast again under the same id (the muted-mic
 * warning) is a new appearance and gets the full time again. Persistent toasts are left
 * alone, and an update that makes a toast persistent cancels its timer.
 */
export function useHudToastAutoDismiss(toasts: ToastT[]) {
	const timers = useRef(new Map<ToastT["id"], ReturnType<typeof setTimeout>>());
	// useSonner hands out a new object for every create or update, so identity is what
	// says "this appearance has been scheduled".
	const seen = useRef(new WeakSet<ToastT>());

	useEffect(() => {
		for (const item of toasts) {
			if (seen.current.has(item)) continue;
			seen.current.add(item);
			const previous = timers.current.get(item.id);
			if (previous) clearTimeout(previous);
			timers.current.delete(item.id);
			const delay = hudToastDismissDelayMs(item);
			if (delay === null) continue;
			const id = item.id;
			timers.current.set(
				id,
				setTimeout(() => {
					timers.current.delete(id);
					toast.dismiss(id);
				}, delay),
			);
		}
	}, [toasts]);

	useEffect(() => {
		const pending = timers.current;
		return () => {
			for (const timer of pending.values()) clearTimeout(timer);
			pending.clear();
		};
	}, []);
}

/**
 * The HUD's toaster: centred just above the bar (LaunchWindow keeps `--hud-toast-bottom` at
 * the bar's top edge), so a toast never covers the bar's own controls, and every toast is
 * clickable through the click-through window (`HUD_INTERACTIVE_SELECTOR`).
 */
export function HudToaster() {
	const { toasts } = useSonner();
	useHudToastAutoDismiss(toasts);
	return (
		<Toaster
			position="bottom-center"
			duration={HUD_TOAST_DURATION_MS}
			offset={{ bottom: "var(--hud-toast-bottom, 96px)" }}
		/>
	);
}
