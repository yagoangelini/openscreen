import type { CursorRecordingData } from "../../src/native/contracts";

/**
 * The presses a take records on OpenScreen's own controls: the HUD's record, pause, notes,
 * layout and stop buttons, and its other windows that never show in the video (they are
 * content-protected). The cursor sampler sees every OS press, so each of these also lands in
 * the take's cursor file, and the editor drew a click ripple, played a click sound and aimed
 * an auto-zoom at a spot where the viewer sees nothing -- the stop click at the very end
 * above all. The windows report their presses (`note-recording-control-press`), and the
 * matching clicks are turned back into plain positions before the cursor file is written.
 */

/** How far apart the window's press and the sampler's may be. There is one mouse: two
 *  presses this close are the same press, and the sampler ticks every 8 ms. */
export const CONTROL_PRESS_MATCH_MS = 250;

const PRESS_TYPES = new Set(["click", "double-click", "right-click", "middle-click"]);

/**
 * `pressesMs` are on the sampler's clock (ms since it started, like `samples[].timeMs`).
 * Each press takes the nearest sampled press within `toleranceMs` (one each), and that
 * press's release with it. The samples stay, as positions: the pointer still went there.
 */
export function dropControlPressClicks(
	data: CursorRecordingData,
	pressesMs: readonly number[],
	toleranceMs = CONTROL_PRESS_MATCH_MS,
): CursorRecordingData {
	if (pressesMs.length === 0 || data.samples.length === 0) return data;
	const order = data.samples
		.map((sample, index) => ({ sample, index }))
		.sort((a, b) => a.sample.timeMs - b.sample.timeMs);
	const dropped = new Set<number>();
	for (const pressMs of pressesMs) {
		if (!Number.isFinite(pressMs)) continue;
		let best: number | null = null;
		let bestDistance = Number.POSITIVE_INFINITY;
		for (const [at, { sample }] of order.entries()) {
			if (!PRESS_TYPES.has(sample.interactionType ?? "") || dropped.has(order[at].index)) continue;
			const distance = Math.abs(sample.timeMs - pressMs);
			if (distance <= toleranceMs && distance < bestDistance) {
				best = at;
				bestDistance = distance;
			}
		}
		if (best === null) continue;
		dropped.add(order[best].index);
		// Its release: the next one, unless another press comes first.
		for (let at = best + 1; at < order.length; at++) {
			const type = order[at].sample.interactionType ?? "";
			if (PRESS_TYPES.has(type)) break;
			if (type === "mouseup") {
				dropped.add(order[at].index);
				break;
			}
		}
	}
	if (dropped.size === 0) return data;
	return {
		...data,
		samples: data.samples.map((sample, index) => {
			if (!dropped.has(index)) return sample;
			const { input: _input, ...position } = sample;
			return { ...position, interactionType: "move" };
		}),
	};
}

/**
 * The epoch ms a window reports for a press, kept only when it is plausible: not in the
 * future, and not older than `maxAgeMs` (a window's clock is the same wall clock, but a
 * value that far off was not a press of this take). `null` otherwise.
 */
export function plausiblePressEpochMs(
	value: unknown,
	nowMs: number,
	maxAgeMs = 5_000,
): number | null {
	if (typeof value !== "number" || !Number.isFinite(value)) return null;
	if (value > nowMs + 50 || value < nowMs - maxAgeMs) return null;
	return Math.min(value, nowMs);
}
