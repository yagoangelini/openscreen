import { normalizeInputSignal } from "../cursor/inputSignals";

/**
 * On-screen shortcuts: the chords the user pressed while recording ("Ctrl + C",
 * "Win + Shift + S"), shown as a small plate while the video plays them.
 *
 * The sampler writes a combo only for a chord holding Ctrl, Alt or Win, never
 * plain typing (`inputSignals.ts`), and the import keeps those on the asset.
 * From there they are derived on the fly into text regions, exactly like the
 * captions: nothing is stored on the timeline, the compositor draws them in the
 * preview and the export alike, and one switch shows or hides them all.
 */

export interface RecordedKeystroke {
	/** Source seconds into the take. */
	sec: number;
	combo: string;
	/** Times pressed in a row (Ctrl+Z, Ctrl+Z, Ctrl+Z reads "Ctrl + Z ×3"). */
	count?: number;
	/** Source seconds of the last of those presses. Absent on takes imported before it was kept. */
	lastSec?: number;
}

/**
 * When a chord was last pressed: the time kept for it, or -- for a take imported before
 * that was kept -- the latest the presses could have been, one join window apart.
 */
export function lastPressSec(keystroke: RecordedKeystroke): number {
	return keystroke.lastSec ?? keystroke.sec + ((keystroke.count ?? 1) - 1) * REPEAT_JOIN_SEC;
}

/** Where the switch lives in `legacyEditor`. */
export const SHOW_KEYSTROKES_KEY = "cursorShowKeystrokes";

/** How long a plate stays up. Long enough to read two keys, short enough to not linger. */
export const KEYSTROKE_DISPLAY_SEC = 1.6;
/** A repeat of the same chord within this joins the plate already up. */
export const REPEAT_JOIN_SEC = 0.8;

/** The chords out of a take's cursor samples, in order, repeats folded together. */
export function keystrokesFromCursorSamples(samples: unknown): RecordedKeystroke[] {
	if (!Array.isArray(samples)) return [];
	const out: RecordedKeystroke[] = [];
	const presses = samples
		.flatMap((sample) => {
			if (!sample || typeof sample !== "object") return [];
			const { timeMs, input } = sample as { timeMs?: unknown; input?: unknown };
			if (typeof timeMs !== "number" || !Number.isFinite(timeMs) || timeMs < 0) return [];
			const signal = normalizeInputSignal(input);
			return signal?.kind === "key" && signal.combo
				? [{ sec: timeMs / 1000, combo: signal.combo }]
				: [];
		})
		.sort((a, b) => a.sec - b.sec);
	for (const press of presses) {
		const last = out[out.length - 1];
		// Joined on the real time of the previous press: five quick Ctrl+Z inside a second
		// are one plate, and a press a second after the last of them starts a new one.
		if (last && last.combo === press.combo && press.sec - lastPressSec(last) <= REPEAT_JOIN_SEC) {
			last.count = (last.count ?? 1) + 1;
			last.lastSec = press.sec;
			continue;
		}
		out.push({ sec: press.sec, combo: press.combo });
	}
	return out;
}

/** "Ctrl+Shift+S" -> "Ctrl + Shift + S", and "×3" for a chord pressed three times. */
export function formatKeystroke(keystroke: Pick<RecordedKeystroke, "combo" | "count">): string {
	const keys = keystroke.combo.split("+").join(" + ");
	return keystroke.count && keystroke.count > 1 ? `${keys}  ×${keystroke.count}` : keys;
}
