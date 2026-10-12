import type { CursorTelemetryPoint } from "@/components/video-editor/types";
import { readScreenActivity, type ScreenActivity } from "./screenActivity";

/**
 * Menus drawn inside a web page, for the automatic zooms.
 *
 * A dropdown in SharePoint or Power Apps is part of the browser's page, so UI
 * Automation never reports it opening -- the sampler only sees native menus. After
 * the take, the frames around each click it could not explain are compared
 * (\`ocr-scan.exe --popups\`), and a region that changed becomes the same "popup
 * opened here" signal the planner already acts on: it frames the menu with the
 * click, and a change covering most of the screen reads as a page change. The menu
 * is taken to close at the next click (the one that picks from it).
 */

export interface FrameChange {
	/** The click's time, in ms on the telemetry's axis. */
	t: number;
	rect: { x: number; y: number; width: number; height: number };
}

const CLICK_TYPES = new Set(["click", "double-click", "right-click"]);
/** A popup UI Automation already saw this soon after a click explains it. */
const EXPLAINED_WITHIN_MS = 1200;
/** Seen in the frames this long after the click, which is when it is taken to open. */
const OPENS_AFTER_MS = 300;
/** It closes this long after the next click, so that click still frames it. */
const CLOSES_AFTER_NEXT_CLICK_MS = 300;
/** At most this many clicks are scanned in one take. */
export const MAX_SCANNED_CLICKS = 400;

function clickTimes(telemetry: CursorTelemetryPoint[]): number[] {
	return telemetry
		.filter((p) => p.interactionType !== undefined && CLICK_TYPES.has(p.interactionType))
		.map((p) => p.timeMs)
		.sort((a, b) => a - b);
}

/** A popup UI Automation saw closing this close to a click: what changed is the menu going. */
const CLOSED_BY_CLICK_MS = 300;

/**
 * The clicks no popup signal explains: the ones worth looking at in the frames. A click that
 * closed a menu is explained too. The frames do change around it, but the change is the menu
 * going away, and read as a new menu it held a zoom on the empty spot for ten seconds.
 */
export function clicksToScan(telemetry: CursorTelemetryPoint[]): number[] {
	const opens = telemetry.filter((p) => p.input?.kind === "popup-open").map((p) => p.timeMs);
	const closes = telemetry.filter((p) => p.input?.kind === "popup-close").map((p) => p.timeMs);
	return clickTimes(telemetry)
		.filter((t) => !opens.some((o) => o >= t - 150 && o <= t + EXPLAINED_WITHIN_MS))
		.filter((t) => !closes.some((c) => c >= t - 150 && c <= t + CLOSED_BY_CLICK_MS))
		.slice(0, MAX_SCANNED_CLICKS);
}

/** The telemetry with a popup-open (and its close) for every change found after a click. */
export function withFramePopups(
	telemetry: CursorTelemetryPoint[],
	changes: FrameChange[],
): CursorTelemetryPoint[] {
	if (changes.length === 0) return telemetry;
	const clicks = clickTimes(telemetry);
	const added: CursorTelemetryPoint[] = changes.flatMap((change, index) => {
		const click = telemetry.find((p) => p.timeMs === change.t);
		const at: [number, number] = click ? [click.cx, click.cy] : [0.5, 0.5];
		const id = `frame-${index}`;
		const next = clicks.find((t) => t > change.t);
		const open: CursorTelemetryPoint = {
			timeMs: change.t + OPENS_AFTER_MS,
			cx: at[0],
			cy: at[1],
			interactionType: "move",
			input: { kind: "popup-open", id, rect: change.rect },
		};
		if (next === undefined) return [open];
		return [
			open,
			{
				timeMs: next + CLOSES_AFTER_NEXT_CLICK_MS,
				cx: at[0],
				cy: at[1],
				interactionType: "move",
				input: { kind: "popup-close", id },
			},
		];
	});
	return [...telemetry, ...added].sort((a, b) => a.timeMs - b.timeMs);
}

/**
 * The take's telemetry with the menus its frames show. Falls back to the plain
 * telemetry on any failure, a host without the scanner, or after \`timeoutMs\`.
 */
export async function getTelemetryWithFramePopups(
	videoPath: string,
	getTelemetry: (videoPath: string) => Promise<CursorTelemetryPoint[] | null | undefined>,
	timeoutMs = 60_000,
): Promise<CursorTelemetryPoint[]> {
	const telemetry = (await getTelemetry(videoPath)) ?? [];
	const scan = typeof window !== "undefined" ? window.electronAPI?.scanFrameChanges : undefined;
	const times = clicksToScan(telemetry);
	if (!scan || times.length === 0) return telemetry;
	const deadline = new Promise<null>((resolve) => setTimeout(() => resolve(null), timeoutMs));
	const result = await Promise.race([scan(videoPath, times).catch(() => null), deadline]);
	return result?.success ? withFramePopups(telemetry, result.changes ?? []) : telemetry;
}

/**
 * Where the take's screen changed, for the automatic zooms (`getScreenActivity` in the main
 * process: one small grey decode, cached). Null on any failure, a host without it, or after
 * `timeoutMs`: the zooms are then planned from the pointer alone.
 */
export async function getScreenActivityForZooms(
	videoPath: string,
	timeoutMs = 180_000,
): Promise<ScreenActivity | null> {
	const scan = typeof window !== "undefined" ? window.electronAPI?.getScreenActivity : undefined;
	if (!scan) return null;
	const deadline = new Promise<null>((resolve) => setTimeout(() => resolve(null), timeoutMs));
	const result = await Promise.race([scan(videoPath).catch(() => null), deadline]);
	return result?.success ? readScreenActivity(result.activity) : null;
}
