import { normalizeInputSignal } from "@/lib/cursor/inputSignals";
import { sourceSpanToTimelineSpans } from "./captions/cues";
import type { AxcutDocument } from "./schema";

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
}

/** Where the switch lives in `legacyEditor`. */
export const SHOW_KEYSTROKES_KEY = "cursorShowKeystrokes";

/** How long a plate stays up. Long enough to read two keys, short enough to not linger. */
export const KEYSTROKE_DISPLAY_SEC = 1.6;
/** A repeat of the same chord within this joins the plate already up. */
const REPEAT_JOIN_SEC = 0.8;
/** Above every annotation, below the captions (`CAPTION_Z_INDEX_BASE`). */
const KEYSTROKE_Z_INDEX_BASE = 90_000;
const KEYSTROKE_FONT_SIZE = 40;
/** The plate's box, in percent of the output frame. */
const KEYSTROKE_BOX = { width: 40, height: 9, bottomInset: 6 };

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
		const lastSeen = last ? last.sec + ((last.count ?? 1) - 1) * REPEAT_JOIN_SEC : 0;
		if (last && last.combo === press.combo && press.sec - lastSeen <= REPEAT_JOIN_SEC) {
			last.count = (last.count ?? 1) + 1;
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

export interface KeystrokeTextRegion {
	id: string;
	startMs: number;
	endMs: number;
	type: "text";
	content: string;
	space: "frame";
	verticalAlign: "bottom";
	position: { x: number; y: number };
	size: { width: number; height: number };
	style: {
		color: string;
		backgroundColor: string;
		fontSize: number;
		fontFamily: string;
		fontWeight: "bold";
		fontStyle: "normal";
		textDecoration: "none";
		textAlign: "center";
		textAnimation: "none";
	};
	zIndex: number;
}

/**
 * The plates for every chord the timeline plays, in timeline time. `aboveTopPct`
 * is the top of the caption box when captions are showing: the plate sits just
 * over them instead of on top of them.
 */
export function keystrokeTextRegions(
	document: AxcutDocument,
	options: { aboveTopPct?: number | null } = {},
): KeystrokeTextRegion[] {
	const clips = document.timeline.clips;
	const spans = document.assets
		.flatMap((asset) =>
			(asset.keystrokes ?? []).flatMap((keystroke) => {
				const lastPressSec = keystroke.sec + ((keystroke.count ?? 1) - 1) * REPEAT_JOIN_SEC;
				// Anchored on the press itself, wherever a clip plays it: a chord that was cut
				// away gets no plate, since it would announce something the viewer never sees.
				return sourceSpanToTimelineSpans(asset.id, keystroke.sec, keystroke.sec + 0.01, clips).map(
					(press) => ({
						startSec: press.startSec,
						endSec: press.startSec + (lastPressSec - keystroke.sec) + KEYSTROKE_DISPLAY_SEC,
						keystroke,
					}),
				);
			}),
		)
		.sort((a, b) => a.startSec - b.startSec);

	const bottom =
		typeof options.aboveTopPct === "number" && Number.isFinite(options.aboveTopPct)
			? Math.max(KEYSTROKE_BOX.height, options.aboveTopPct - 1)
			: 100 - KEYSTROKE_BOX.bottomInset;
	return spans.flatMap((span, index) => {
		// One plate at a time: the next chord replaces the one still up.
		const next = spans[index + 1];
		const endSec = next ? Math.min(span.endSec, next.startSec) : span.endSec;
		if (endSec - span.startSec < 0.05) return [];
		return [
			{
				id: `keystroke-${index}`,
				startMs: span.startSec * 1000,
				endMs: endSec * 1000,
				type: "text" as const,
				content: formatKeystroke(span.keystroke),
				space: "frame" as const,
				verticalAlign: "bottom" as const,
				position: { x: (100 - KEYSTROKE_BOX.width) / 2, y: bottom - KEYSTROKE_BOX.height },
				size: { width: KEYSTROKE_BOX.width, height: KEYSTROKE_BOX.height },
				style: {
					color: "#ffffff",
					backgroundColor: "rgba(17, 17, 17, 0.82)",
					fontSize: KEYSTROKE_FONT_SIZE,
					fontFamily: "Inter",
					fontWeight: "bold" as const,
					fontStyle: "normal" as const,
					textDecoration: "none" as const,
					textAlign: "center" as const,
					textAnimation: "none" as const,
				},
				zIndex: KEYSTROKE_Z_INDEX_BASE + index,
			},
		];
	});
}
