import { describe, expect, it } from "vitest";
import type { CursorRecordingData } from "../../src/native/contracts";
import { dropControlPressClicks, plausiblePressEpochMs } from "./takeControlPresses";

const sample = (
	timeMs: number,
	interactionType?: CursorRecordingData["samples"][number]["interactionType"],
) => ({
	timeMs,
	cx: 0.5,
	cy: 0.92,
	visible: true,
	...(interactionType ? { interactionType } : {}),
	...(interactionType && interactionType !== "move"
		? { input: { kind: interactionType === "mouseup" ? "release" : "press", button: "left" } }
		: {}),
});

const data = (samples: ReturnType<typeof sample>[]) =>
	({ version: 2, provider: "native", samples, assets: [] }) as unknown as CursorRecordingData;

describe("dropControlPressClicks", () => {
	it("turns the press on a HUD control and its release into plain positions", () => {
		const out = dropControlPressClicks(
			data([sample(1000, "move"), sample(4475, "click"), sample(4579, "mouseup"), sample(4600)]),
			[4480],
		);
		expect(out.samples.map((s) => s.interactionType ?? null)).toEqual([
			"move",
			"move",
			"move",
			null,
		]);
		expect(out.samples[1]).not.toHaveProperty("input");
		// The pointer still went there: the positions stay.
		expect(out.samples.map((s) => s.timeMs)).toEqual([1000, 4475, 4579, 4600]);
	});

	it("leaves the clicks in the recorded app alone", () => {
		const input = data([sample(1962, "click"), sample(2052, "mouseup"), sample(4475, "click")]);
		const out = dropControlPressClicks(input, [4470]);
		expect(out.samples[0].interactionType).toBe("click");
		expect(out.samples[1].interactionType).toBe("mouseup");
		expect(out.samples[2].interactionType).toBe("move");
	});

	it("takes the nearest press within the tolerance, one per reported press", () => {
		const input = data([sample(1000, "click"), sample(1100, "mouseup"), sample(1200, "click")]);
		const out = dropControlPressClicks(input, [1190]);
		expect(out.samples.map((s) => s.interactionType)).toEqual(["click", "mouseup", "move"]);
		// Too far from every press: nothing taken.
		expect(dropControlPressClicks(input, [1600])).toBe(input);
	});

	it("does not take the release of a later press", () => {
		const input = data([
			sample(1000, "click"),
			sample(1050, "right-click"),
			sample(1100, "mouseup"),
		]);
		const out = dropControlPressClicks(input, [1000]);
		expect(out.samples.map((s) => s.interactionType)).toEqual(["move", "right-click", "mouseup"]);
	});

	it("is the same data with no press reported", () => {
		const input = data([sample(1000, "click")]);
		expect(dropControlPressClicks(input, [])).toBe(input);
	});
});

describe("plausiblePressEpochMs", () => {
	it("keeps a press from the last few seconds", () => {
		expect(plausiblePressEpochMs(9_900, 10_000)).toBe(9_900);
		// A clock a hair ahead is the same instant.
		expect(plausiblePressEpochMs(10_020, 10_000)).toBe(10_000);
	});

	it("refuses what cannot be this take's press", () => {
		expect(plausiblePressEpochMs(undefined, 10_000)).toBeNull();
		expect(plausiblePressEpochMs("9900", 10_000)).toBeNull();
		expect(plausiblePressEpochMs(20_000, 10_000)).toBeNull();
		expect(plausiblePressEpochMs(1_000, 10_000)).toBeNull();
	});
});
