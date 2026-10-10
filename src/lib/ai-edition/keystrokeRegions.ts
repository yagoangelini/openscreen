import { sourceSpanToTimelineSpans } from "./captions/cues";
import { formatKeystroke, KEYSTROKE_DISPLAY_SEC, lastPressSec } from "./keystrokes";
import type { AxcutDocument } from "./schema";

/**
 * The on-screen shortcut plates as text regions; `keystrokes.ts` reads the chords.
 * Apart from it because this half needs the caption timing, which the main process
 * -- reading the chords at import -- has no business loading.
 */

/** Above every annotation, below the captions (`CAPTION_Z_INDEX_BASE`). */
const KEYSTROKE_Z_INDEX_BASE = 90_000;
const KEYSTROKE_FONT_SIZE = 40;
/** The plate's box, in percent of the output frame. */
const KEYSTROKE_BOX = { width: 40, height: 9, bottomInset: 6 };

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
				const heldSec = lastPressSec(keystroke) - keystroke.sec;
				// Anchored on the press itself, wherever a clip plays it: a chord that was cut
				// away gets no plate, since it would announce something the viewer never sees.
				return sourceSpanToTimelineSpans(asset.id, keystroke.sec, keystroke.sec + 0.01, clips).map(
					(press) => ({
						startSec: press.startSec,
						endSec: press.startSec + heldSec + KEYSTROKE_DISPLAY_SEC,
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
