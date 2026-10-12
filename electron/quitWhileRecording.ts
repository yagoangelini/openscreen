/**
 * Every way out of the app in the middle of a take asks the same question first: the HUD's
 * quit button, closing the Recorder window (its taskbar "Close window", Alt+F4, WM_CLOSE) and
 * any `app.quit()`. Before, only the button asked; the others ended the take silently and
 * left it to the next launch's recovery offer (E2E 2.4.0, D-3).
 *
 * One prompt at a time: closing the window while the question is already on screen must not
 * stack a second dialog.
 */

export interface QuitWhileRecordingDeps {
	/** True while a take is running (or being finalized and not yet reported stopped). */
	isRecording: () => boolean;
	/** Shows the question; resolves true for "stop and open in the editor". */
	ask: () => Promise<boolean>;
	/** Stops the take the way the HUD's stop button does, which opens the editor. */
	stopAndOpen: () => void;
}

export function createQuitWhileRecordingPrompt(deps: QuitWhileRecordingDeps): () => Promise<void> {
	let pending: Promise<void> | null = null;
	return () => {
		if (pending) return pending;
		pending = deps
			.ask()
			.then((stop) => {
				// The take may have ended while the dialog was open (the HUD's own stop, a
				// global shortcut): nothing is left to stop then.
				if (stop && deps.isRecording()) deps.stopAndOpen();
			})
			.catch((error) => {
				console.error("[recording] quit-while-recording prompt failed:", error);
			})
			.finally(() => {
				pending = null;
			});
		return pending;
	};
}
