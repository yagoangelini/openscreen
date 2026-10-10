import { sourceSpanToTimelineSpans } from "./captions/cues";
import type { AxcutDocument } from "./schema";
import { anchorRegionsWithDerivedMs } from "./timeline/timelineMap";

/**
 * Automatic privacy blur: what a take shows on screen that should not reach
 * YouTube -- an e-mail address, the tenant's domain, an object GUID, a secret, a
 * phone number -- found by OCR after the recording and blurred, as suggestions
 * the user keeps or deletes like any other annotation.
 *
 * The text is read by `ocr-scan.exe` (Windows' own OCR, offline) one frame every
 * couple of seconds. Everything here is the part that needs no Windows: parsing
 * its output, matching the patterns, following a match across frames, and
 * turning what was found into blur regions on the timeline.
 */

export type SensitiveKind = "email" | "tenant" | "guid" | "secret" | "phone";

/** A box in fractions of the video frame. */
export interface Box {
	x: number;
	y: number;
	w: number;
	h: number;
}

type OcrWord = [number, number, number, number, string];

export interface OcrSample {
	t: number;
	/** `true`: the frame looked like the previous one, which was not read again. */
	same?: boolean;
	words?: OcrWord[];
	lines?: Array<[number, number]>;
}

export interface OcrScan {
	durationSec: number;
	intervalSec: number;
	samples: OcrSample[];
}

export interface Detection {
	kind: SensitiveKind;
	text: string;
	box: Box;
}

export interface RedactionSpan extends Detection {
	startSec: number;
	endSec: number;
}

/** Reads `ocr-scan.exe`'s NDJSON; malformed lines are skipped. */
export function parseOcrScan(ndjson: string, intervalSec = 2): OcrScan {
	const samples: OcrSample[] = [];
	let durationSec = 0;
	for (const line of ndjson.split(/\r?\n/)) {
		if (!line.trim()) continue;
		let event: Record<string, unknown>;
		try {
			event = JSON.parse(line);
		} catch {
			continue;
		}
		if (event.type === "info" && typeof event.durationSec === "number") {
			durationSec = event.durationSec;
		} else if (event.type === "same" && typeof event.t === "number") {
			samples.push({ t: event.t, same: true });
		} else if (
			event.type === "frame" &&
			typeof event.t === "number" &&
			Array.isArray(event.words)
		) {
			const words = event.words.filter(
				(word): word is OcrWord =>
					Array.isArray(word) &&
					word.length === 5 &&
					word.slice(0, 4).every((n) => typeof n === "number" && Number.isFinite(n)) &&
					typeof word[4] === "string",
			);
			const lines = Array.isArray(event.lines)
				? event.lines.filter(
						(l): l is [number, number] =>
							Array.isArray(l) && Number.isInteger(l[0]) && Number.isInteger(l[1]),
					)
				: [[0, words.length] as [number, number]];
			samples.push({ t: event.t, words, lines });
		}
	}
	samples.sort((a, b) => a.t - b.t);
	return { durationSec, intervalSec, samples };
}

/**
 * What counts as sensitive, in the order it is tried. Matched against one OCR line
 * at a time, its words joined by single spaces.
 */
const PATTERNS: Array<{ kind: SensitiveKind; re: RegExp }> = [
	// Before the e-mail: the tenant is the part a viewer can do the most with.
	{
		kind: "tenant",
		re: /\b[a-z0-9-]+(?:-my)?\.(?:onmicrosoft|sharepoint|crm\d{0,2}\.dynamics|powerappsportals|powerapps)\.com\b/gi,
	},
	{ kind: "email", re: /\b[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}\b/g },
	{
		kind: "guid",
		re: /\b[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}\b/gi,
	},
	// A JWT, a provider's key prefix, or a long run that mixes cases and digits the way
	// generated secrets do and words never do.
	{
		kind: "secret",
		re: /\beyJ[A-Za-z0-9_-]{10,}(?:\.[A-Za-z0-9_-]+){0,2}|\b(?:sk-|ghp_|gho_|xox[abp]-|AKIA)[A-Za-z0-9_-]{12,}|\b(?=[A-Za-z0-9+/_-]*[0-9])(?=[A-Za-z0-9+/_-]*[a-z])(?=[A-Za-z0-9+/_-]*[A-Z])[A-Za-z0-9+/_-]{28,}={0,2}/g,
	},
	// Brazilian and international numbers: (11) 91234-5678, +55 11 91234 5678, 11 3456-7890.
	{
		kind: "phone",
		re: /(?:\+\d{1,3}[\s.-]?)?\(?\d{2,3}\)?[\s.-]?9?\d{4}[\s.-]?\d{4}\b/g,
	},
];

function union(boxes: Box[]): Box {
	const x0 = Math.min(...boxes.map((b) => b.x));
	const y0 = Math.min(...boxes.map((b) => b.y));
	const x1 = Math.max(...boxes.map((b) => b.x + b.w));
	const y1 = Math.max(...boxes.map((b) => b.y + b.h));
	return { x: x0, y: y0, w: x1 - x0, h: y1 - y0 };
}

/** The sensitive text in one read frame, each with the box of the words it covers. */
export function detectSensitive(sample: OcrSample): Detection[] {
	const words = sample.words ?? [];
	const out: Detection[] = [];
	for (const [first, count] of sample.lines ?? []) {
		const lineWords = words.slice(first, first + count);
		if (lineWords.length === 0) continue;
		let text = "";
		const spans = lineWords.map((word) => {
			const start = text.length === 0 ? 0 : text.length + 1;
			text = text.length === 0 ? word[4] : `${text} ${word[4]}`;
			return { start, end: start + word[4].length, word };
		});
		const taken: Array<[number, number]> = [];
		for (const { kind, re } of PATTERNS) {
			re.lastIndex = 0;
			for (const match of text.matchAll(re)) {
				const start = match.index ?? 0;
				const end = start + match[0].length;
				// Each stretch of text is one thing: the e-mail on a tenant domain is not also a phone.
				if (taken.some(([s, e]) => start < e && end > s)) continue;
				const covered = spans.filter((s) => s.start < end && s.end > start);
				if (covered.length === 0) continue;
				taken.push([start, end]);
				out.push({
					kind,
					text: match[0],
					box: union(
						covered.map(({ word }) => ({ x: word[0], y: word[1], w: word[2], h: word[3] })),
					),
				});
			}
		}
	}
	return out;
}

function overlap(a: Box, b: Box): number {
	const ix = Math.max(0, Math.min(a.x + a.w, b.x + b.w) - Math.max(a.x, b.x));
	const iy = Math.max(0, Math.min(a.y + a.h, b.y + b.h) - Math.max(a.y, b.y));
	const inter = ix * iy;
	const unionArea = a.w * a.h + b.w * b.h - inter;
	return unionArea > 0 ? inter / unionArea : 0;
}

/**
 * Follows each detection across the samples into one span of time. Generous on
 * both ends: text first seen at a sample may have appeared any time since the
 * previous one, and text gone at a sample may have left any time after the last
 * one that had it -- a blur a second too long costs nothing, one a second short
 * shows the address.
 */
export function trackDetections(scan: OcrScan): RedactionSpan[] {
	interface Track extends RedactionSpan {
		lastSeenIndex: number;
	}
	const open: Track[] = [];
	const closed: RedactionSpan[] = [];
	let previous: Detection[] = [];
	scan.samples.forEach((sample, index) => {
		const detections = sample.same ? previous : detectSensitive(sample);
		previous = detections;
		const matched = new Set<Track>();
		for (const detection of detections) {
			const track = open.find(
				(candidate) =>
					!matched.has(candidate) &&
					candidate.kind === detection.kind &&
					candidate.text.toLowerCase() === detection.text.toLowerCase() &&
					overlap(candidate.box, detection.box) > 0.3,
			);
			if (track) {
				track.box = union([track.box, detection.box]);
				track.lastSeenIndex = index;
				matched.add(track);
				continue;
			}
			const startSec = index > 0 ? scan.samples[index - 1].t : 0;
			const created: Track = { ...detection, startSec, endSec: sample.t, lastSeenIndex: index };
			open.push(created);
			matched.add(created);
		}
		for (let i = open.length - 1; i >= 0; i--) {
			const track = open[i];
			if (matched.has(track)) continue;
			open.splice(i, 1);
			const { lastSeenIndex: _, ...span } = track;
			closed.push({ ...span, endSec: sample.t });
		}
	});
	const end = Math.max(scan.durationSec, scan.samples.at(-1)?.t ?? 0);
	for (const { lastSeenIndex: _, ...span } of open) {
		closed.push({ ...span, endSec: end });
	}
	return closed.sort((a, b) => a.startSec - b.startSec);
}

/** A little room around the words: OCR boxes hug the glyphs, descenders and all. */
function padded(box: Box): Box {
	const pad = Math.max(0.004, box.h * 0.35);
	const x = Math.max(0, box.x - pad);
	const y = Math.max(0, box.y - pad);
	return {
		x,
		y,
		w: Math.min(1 - x, box.w + 2 * pad),
		h: Math.min(1 - y, box.h + 2 * pad),
	};
}

export const AUTO_REDACT_SOURCE = "auto-redact" as const;

/**
 * Blur regions for the spans, wherever the timeline plays them, anchored to their
 * clips like any region the user draws. In footage space -- no `space` -- so the
 * blur stays on what it hides through zooms and padding.
 */
export function redactionAnnotations(
	document: AxcutDocument,
	assetId: string,
	spans: RedactionSpan[],
	makeId: (prefix: string) => string,
): AxcutDocument["annotations"] {
	const baseZ = document.annotations.length + 1;
	const regions = spans.flatMap((span, index) =>
		sourceSpanToTimelineSpans(assetId, span.startSec, span.endSec, document.timeline.clips).map(
			(timeline) => {
				const box = padded(span.box);
				return {
					id: makeId("ann"),
					startMs: Math.round(timeline.startSec * 1000),
					endMs: Math.round(timeline.endSec * 1000),
					type: "blur" as const,
					content: "",
					position: { x: box.x * 100, y: box.y * 100 },
					size: { width: box.w * 100, height: box.h * 100 },
					style: {
						color: "#ffffff",
						backgroundColor: "transparent",
						fontSize: 32,
						fontFamily: "Inter",
						fontWeight: "bold" as const,
						fontStyle: "normal" as const,
						textDecoration: "none" as const,
						textAlign: "center" as const,
					},
					zIndex: baseZ + index,
					annotationSource: AUTO_REDACT_SOURCE,
					blurData: {
						type: "blur" as const,
						shape: "rectangle" as const,
						color: "white" as const,
						intensity: 18,
						blockSize: 12,
					},
				};
			},
		),
	);
	return anchorRegionsWithDerivedMs(regions, document.timeline.clips, () =>
		makeId("ann"),
	) as unknown as AxcutDocument["annotations"];
}
