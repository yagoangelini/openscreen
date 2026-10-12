/**
 * Every way out of the app in the middle of a take asks the same question first: the HUD's
 * quit button, closing the Recorder window (its taskbar "Close window", Alt+F4, WM_CLOSE) and
 * any `app.quit()`. Before, only the button asked; the others ended the take silently and
 * left it to the next launch's recovery offer (E2E 2.4.0, D-3).
 *
 * One prompt at a time: closing the window while the question is already on screen must not
 * stack a second dialog.
 *
 * And the question goes away with the take: ended some other way while it is on screen (the
 * HUD's stop, a global shortcut, the tray), the dialog stayed up with nothing left to stop,
 * its "stop and open in the editor" dead (E2E 2.5.0, E-5). `dismiss` closes it.
 */

export interface QuitWhileRecordingDeps {
	/** True while a take is running (or being finalized and not yet reported stopped). */
	isRecording: () => boolean;
	/**
	 * Shows the question; resolves true for "stop and open in the editor". `signal` aborts
	 * when the take ends first: the dialog must close as if the user had cancelled it.
	 */
	ask: (signal: AbortSignal) => Promise<boolean>;
	/** Stops the take the way the HUD's stop button does, which opens the editor. */
	stopAndOpen: () => void;
}

export interface QuitWhileRecordingPrompt {
	/** Asks, or joins the question already on screen. */
	(): Promise<void>;
	/** The take ended: close the question if it is on screen. Nothing is stopped. */
	dismiss: () => void;
}

export function createQuitWhileRecordingPrompt(
	deps: QuitWhileRecordingDeps,
): QuitWhileRecordingPrompt {
	let pending: Promise<void> | null = null;
	let open: AbortController | null = null;
	const prompt = () => {
		if (pending) return pending;
		const controller = new AbortController();
		open = controller;
		pending = deps
			.ask(controller.signal)
			.then((stop) => {
				// The take may have ended while the dialog was open (the HUD's own stop, a
				// global shortcut): nothing is left to stop then.
				if (stop && !controller.signal.aborted && deps.isRecording()) deps.stopAndOpen();
			})
			.catch((error) => {
				console.error("[recording] quit-while-recording prompt failed:", error);
			})
			.finally(() => {
				pending = null;
				if (open === controller) open = null;
			});
		return pending;
	};
	return Object.assign(prompt, {
		dismiss: () => {
			open?.abort();
		},
	});
}
