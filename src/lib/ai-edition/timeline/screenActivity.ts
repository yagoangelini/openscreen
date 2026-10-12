// Where the screen changed during a take, for the automatic zooms.
//
// The cursor says where the hand is; the frames say what the UI did about it. A menu that opens
// on hover, a row that lights up under the pointer, a tooltip, a dialog, a page replaced by the
// next: none of them needs a click, and a web page's own menus are invisible to UI Automation.
// The main process decodes the take once, small and grey (`electron/media/screenActivity.ts`),
// and this module turns consecutive frames into the boxes that changed between them.
//
// Only numbers leave the decoder: no pixel of the recording is kept or sent anywhere.
//
// Pure and relative-import only: the main process runs the diff.

/** The grid the frames are compared on: 12×12 px cells on a 1080p take. */
export const ACTIVITY_GRID_W = 160;
export const ACTIVITY_GRID_H = 90;
/** Frames compared per second. A menu's fade-in spans one or two steps. */
export const ACTIVITY_FPS = 8;
/** A cell this much brighter or darker, in luma levels, changed. Below it is encoder noise. */
export const ACTIVITY_CELL_DELTA = 12;
/** Changed cells this close (in cells) belong to one change: a menu's rows make one box. */
const LINK_RADIUS = 2;
/** A change of fewer cells than this is noise, a caret, a blinking cursor. */
const MIN_BOX_CELLS = 3;
/** The boxes kept per step, largest first. */
const MAX_BOXES = 6;

/** One area that changed, as fractions of the frame; `share` is its changed cells' share of all. */
export interface ScreenChangeBox {
	x: number;
	y: number;
	width: number;
	height: number;
	share: number;
}

/** What changed between the frame before `t` and the one at `t` (ms, the video's own time). */
export interface ScreenActivityStep {
	t: number;
	/** The share of the whole frame that changed. */
	share: number;
	boxes: ScreenChangeBox[];
}

export interface ScreenActivity {
	version: 1;
	fps: number;
	/** The video's length the scan covered, in ms. */
	durationMs: number;
	/** Only the steps where something changed. */
	steps: ScreenActivityStep[];
}

function round4(value: number): number {
	return Math.round(value * 10_000) / 10_000;
}

/**
 * The boxes that changed between two grey frames of `width × height`, or null when nothing
 * did. Changed cells are linked into one box when within `LINK_RADIUS` cells of each other.
 */
export function diffFrames(
	previous: Uint8Array,
	current: Uint8Array,
	width = ACTIVITY_GRID_W,
	height = ACTIVITY_GRID_H,
): Omit<ScreenActivityStep, "t"> | null {
	const cells = width * height;
	const changed = new Uint8Array(cells);
	let any = false;
	for (let i = 0; i < cells; i += 1) {
		if (Math.abs(current[i] - previous[i]) > ACTIVITY_CELL_DELTA) {
			changed[i] = 1;
			any = true;
		}
	}
	if (!any) return null;
	const seen = new Uint8Array(cells);
	const stack: number[] = [];
	const boxes: Array<ScreenChangeBox & { cells: number }> = [];
	let total = 0;
	for (let start = 0; start < cells; start += 1) {
		if (!changed[start] || seen[start]) continue;
		seen[start] = 1;
		stack.push(start);
		let minX = width;
		let minY = height;
		let maxX = -1;
		let maxY = -1;
		let count = 0;
		while (stack.length > 0) {
			const cell = stack.pop() as number;
			const x = cell % width;
			const y = (cell - x) / width;
			count += 1;
			if (x < minX) minX = x;
			if (x > maxX) maxX = x;
			if (y < minY) minY = y;
			if (y > maxY) maxY = y;
			for (let dy = -LINK_RADIUS; dy <= LINK_RADIUS; dy += 1) {
				const ny = y + dy;
				if (ny < 0 || ny >= height) continue;
				for (let dx = -LINK_RADIUS; dx <= LINK_RADIUS; dx += 1) {
					const nx = x + dx;
					if (nx < 0 || nx >= width) continue;
					const next = ny * width + nx;
					if (changed[next] && !seen[next]) {
						seen[next] = 1;
						stack.push(next);
					}
				}
			}
		}
		if (count < MIN_BOX_CELLS) continue;
		total += count;
		boxes.push({
			x: round4(minX / width),
			y: round4(minY / height),
			width: round4((maxX - minX + 1) / width),
			height: round4((maxY - minY + 1) / height),
			share: round4(count / cells),
			cells: count,
		});
	}
	if (boxes.length === 0) return null;
	boxes.sort((a, b) => b.cells - a.cells);
	return {
		share: round4(total / cells),
		boxes: boxes.slice(0, MAX_BOXES).map(({ cells: _cells, ...box }) => box),
	};
}

/** Feeds grey frames in order and collects the steps that changed. */
export class ScreenActivityRecorder {
	private previous: Uint8Array | null = null;
	private index = 0;
	readonly steps: ScreenActivityStep[] = [];

	constructor(
		private readonly fps = ACTIVITY_FPS,
		private readonly width = ACTIVITY_GRID_W,
		private readonly height = ACTIVITY_GRID_H,
	) {}

	push(frame: Uint8Array): void {
		if (this.previous) {
			const step = diffFrames(this.previous, frame, this.width, this.height);
			if (step) this.steps.push({ t: Math.round((this.index * 1000) / this.fps), ...step });
		}
		this.previous = frame;
		this.index += 1;
	}

	result(): ScreenActivity {
		return {
			version: 1,
			fps: this.fps,
			durationMs: Math.round((Math.max(0, this.index - 1) * 1000) / this.fps),
			steps: this.steps,
		};
	}
}

function finite(value: unknown): value is number {
	return typeof value === "number" && Number.isFinite(value);
}

/** A stored or received activity, validated; anything malformed reads as none. */
export function readScreenActivity(raw: unknown): ScreenActivity | null {
	if (!raw || typeof raw !== "object") return null;
	const value = raw as Record<string, unknown>;
	if (value.version !== 1 || !finite(value.fps) || !Array.isArray(value.steps)) return null;
	const steps: ScreenActivityStep[] = [];
	for (const entry of value.steps) {
		if (!entry || typeof entry !== "object") continue;
		const step = entry as Record<string, unknown>;
		if (!finite(step.t) || !finite(step.share) || !Array.isArray(step.boxes)) continue;
		const boxes: ScreenChangeBox[] = [];
		for (const candidate of step.boxes) {
			if (!candidate || typeof candidate !== "object") continue;
			const box = candidate as Record<string, unknown>;
			if (
				finite(box.x) &&
				finite(box.y) &&
				finite(box.width) &&
				finite(box.height) &&
				finite(box.share) &&
				box.width > 0 &&
				box.height > 0
			) {
				boxes.push({
					x: box.x,
					y: box.y,
					width: box.width,
					height: box.height,
					share: box.share,
				});
			}
		}
		if (boxes.length > 0) steps.push({ t: step.t, share: step.share, boxes });
	}
	steps.sort((a, b) => a.t - b.t);
	return {
		version: 1,
		fps: value.fps,
		durationMs: finite(value.durationMs) ? value.durationMs : (steps[steps.length - 1]?.t ?? 0),
		steps,
	};
}

/** The steps inside `[fromMs, toMs]`, shifted by `-offsetMs`: one clip's window. */
export function activityWindow(
	activity: ScreenActivity,
	fromMs: number,
	toMs: number,
	offsetMs: number,
): ScreenActivityStep[] {
	return activity.steps
		.filter((step) => step.t >= fromMs && step.t <= toMs)
		.map((step) => ({ ...step, t: step.t - offsetMs }));
}
