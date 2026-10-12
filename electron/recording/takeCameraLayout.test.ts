import { describe, expect, it } from "vitest";
import { TakeCameraLayoutLog, takeMediaTimeMs } from "./takeCameraLayout";

describe("takeMediaTimeMs", () => {
	it("is null before the first frame: the countdown, or the helper still opening", () => {
		expect(
			takeMediaTimeMs({
				nowMs: 10_000,
				captureStartedAtMs: null,
				pausedTotalMs: 0,
				pausedSinceMs: null,
			}),
		).toBeNull();
	});

	it("counts from the first frame, which comes after the countdown", () => {
		// The countdown started at 7 000 and its last tick (the first frame) was at 10 000.
		expect(
			takeMediaTimeMs({
				nowMs: 15_250,
				captureStartedAtMs: 10_000,
				pausedTotalMs: 0,
				pausedSinceMs: null,
			}),
		).toBe(5_250);
	});

	it("leaves out the time paused so far", () => {
		expect(
			takeMediaTimeMs({
				nowMs: 30_000,
				captureStartedAtMs: 10_000,
				pausedTotalMs: 6_000,
				pausedSinceMs: null,
			}),
		).toBe(14_000);
	});

	it("stands still at the pause while the take is paused", () => {
		const paused = {
			captureStartedAtMs: 10_000,
			pausedTotalMs: 2_000,
			pausedSinceMs: 20_000,
		};
		expect(takeMediaTimeMs({ ...paused, nowMs: 21_000 })).toBe(8_000);
		expect(takeMediaTimeMs({ ...paused, nowMs: 29_000 })).toBe(8_000);
	});
});

describe("TakeCameraLayoutLog", () => {
	it("starts where the HUD said and logs the switches at media time", () => {
		const log = new TakeCameraLayoutLog("face");
		expect(log.current).toBe("face");
		expect(log.switchTo("screen", 5_230)).toBe("screen");
		expect(log.switchTo("face", 12_000)).toBe("face");
		expect(log.toFile()).toEqual({
			version: 1,
			initial: "face",
			switches: [
				{ atMs: 5_230, layout: "screen" },
				{ atMs: 12_000, layout: "face" },
			],
		});
	});

	it("moves the start instead while the countdown runs", () => {
		const log = new TakeCameraLayoutLog("screen");
		log.switchTo("face", null);
		expect(log.toFile()).toEqual({ version: 1, initial: "face", switches: [] });
		expect(log.isWorthWriting).toBe(true);
		log.switchTo("screen", null);
		expect(log.isWorthWriting).toBe(false);
	});

	it("records nothing for a switch to the layout already shown", () => {
		const log = new TakeCameraLayoutLog("screen");
		log.switchTo("screen", 1_000);
		expect(log.toFile().switches).toEqual([]);
		expect(log.isWorthWriting).toBe(false);
	});

	it("keeps the last of two switches made at one paused moment", () => {
		const log = new TakeCameraLayoutLog("screen");
		log.switchTo("face", 8_000);
		log.switchTo("screen", 8_000);
		expect(log.current).toBe("screen");
		expect(log.toFile().switches).toEqual([]);
		log.switchTo("face", 8_000);
		expect(log.toFile().switches).toEqual([{ atMs: 8_000, layout: "face" }]);
	});
});
