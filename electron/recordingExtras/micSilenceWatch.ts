import type { BrowserWindow } from "electron";
import { MicSilenceDetector } from "../recording/micSilence";

/**
 * Runs a `MicSilenceDetector` for one take (the countdown included) and tells the HUD when
 * the microphone starts or stops looking muted (`native-recording-mic-silent`). The levels
 * come from the helper's `mic-level` lines; the clock is a 250 ms tick of its own, so a
 * helper that stops sending them still counts as silence.
 */

const TICK_MS = 250;

let detector: MicSilenceDetector | null = null;
let timer: ReturnType<typeof setInterval> | null = null;
let notify: (silent: boolean, reason?: string) => void = () => undefined;

export function startMicSilenceWatch(options: {
	getHud: () => BrowserWindow | null;
	/** False once the take is stopping or gone: the watch ends itself. */
	isActive: () => boolean;
	isPaused: () => boolean;
}) {
	stopMicSilenceWatch();
	const current = new MicSilenceDetector();
	detector = current;
	notify = (silent, reason = "signal is back") => {
		console.info(`[mic-silence] ${silent ? "the microphone seems muted" : reason}`);
		const hud = options.getHud();
		if (hud && !hud.isDestroyed()) hud.webContents.send("native-recording-mic-silent", silent);
	};
	current.tick(Date.now());
	timer = setInterval(() => {
		if (detector !== current) return;
		if (!options.isActive()) {
			stopMicSilenceWatch();
			return;
		}
		const change = current.tick(Date.now(), options.isPaused());
		if (change !== null) notify(change);
	}, TICK_MS);
}

/** One `mic-level` window from the helper; ignored with no watch running. */
export function micSilenceLevel(peakDb: number) {
	detector?.level(peakDb);
}

/** The take ended: the HUD's warning goes with it. */
export function stopMicSilenceWatch() {
	if (timer) clearInterval(timer);
	timer = null;
	if (detector?.isSilent) notify(false, "the take ended");
	detector = null;
}
