/**
 * "Seu microfone parece mudo": a take whose microphone is on but records nothing.
 *
 * The Windows helper reports the microphone's level four times a second (`mic-level`, peak
 * and RMS in dBFS, from the raw capture before any gain). A muted endpoint, a dead input or
 * the wrong device all read as digital silence or as a floor far under any voice; a natural
 * pause does not, because a live mic still hears the room. The line between the two is
 * `thresholdDb` on the PEAK of each window: one window above it is signal.
 *
 * Two waits, so a pause is not mistaken for a muted mic:
 * - before the mic has carried any signal in this take (the countdown included), a short
 *   one, `neverHeardMs`: a mic muted from the start is the case worth catching early, while
 *   the take is still cheap to redo;
 * - once it has, a long one, `afterSignalMs`: a gate like NVIDIA Broadcast's writes true
 *   silence between sentences, and a quiet stretch while the user clicks around is normal.
 *
 * Time is counted by `tick`, not by the level lines, so a helper that stops sending them (a
 * device that delivers nothing) reads as silence too. A paused take counts no time.
 */

export interface MicSilenceOptions {
	/** A window whose peak reaches this is signal. */
	thresholdDb: number;
	/** Silence before the warning, while the mic has had no signal yet. */
	neverHeardMs: number;
	/** Silence before the warning, after it has. */
	afterSignalMs: number;
}

export const DEFAULT_MIC_SILENCE_OPTIONS: MicSilenceOptions = {
	thresholdDb: -60,
	neverHeardMs: 6_000,
	afterSignalMs: 30_000,
};

export class MicSilenceDetector {
	private readonly options: MicSilenceOptions;
	private lastTickMs: number | null = null;
	private silentMs = 0;
	private heardSinceTick = false;
	private everHeard = false;
	private silent = false;

	constructor(options: Partial<MicSilenceOptions> = {}) {
		this.options = { ...DEFAULT_MIC_SILENCE_OPTIONS, ...options };
	}

	/** One `mic-level` window from the helper. */
	level(peakDb: number): void {
		if (Number.isFinite(peakDb) && peakDb >= this.options.thresholdDb) {
			this.heardSinceTick = true;
		}
	}

	/**
	 * Advances the clock. Returns the new state when it changed (true: the warning shows,
	 * false: signal came back), null otherwise.
	 */
	tick(nowMs: number, paused = false): boolean | null {
		const elapsed = this.lastTickMs === null ? 0 : Math.max(0, nowMs - this.lastTickMs);
		this.lastTickMs = nowMs;
		if (this.heardSinceTick) {
			this.heardSinceTick = false;
			this.everHeard = true;
			this.silentMs = 0;
		} else if (!paused) {
			this.silentMs += elapsed;
		}
		const limit = this.everHeard ? this.options.afterSignalMs : this.options.neverHeardMs;
		const silent = this.silentMs >= limit;
		if (silent === this.silent) return null;
		this.silent = silent;
		return silent;
	}

	get isSilent(): boolean {
		return this.silent;
	}
}

/** The peak of a helper `mic-level` event, or null for any other line. */
export function readMicLevelEvent(event: unknown): number | null {
	if (!event || typeof event !== "object") return null;
	const candidate = event as { event?: unknown; peakDb?: unknown };
	if (candidate.event !== "mic-level" || typeof candidate.peakDb !== "number") return null;
	return Number.isFinite(candidate.peakDb) ? candidate.peakDb : null;
}
