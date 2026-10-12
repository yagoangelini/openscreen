import { describe, expect, it } from "vitest";
import { MicSilenceDetector, readMicLevelEvent } from "./micSilence";

/** Feeds `seconds` of windows at `peakDb`, a level and a tick every 250 ms. */
function feed(
	detector: MicSilenceDetector,
	startMs: number,
	seconds: number,
	peakDb: number | null,
) {
	const changes: Array<{ atMs: number; silent: boolean }> = [];
	let now = startMs;
	for (let i = 0; i < seconds * 4; i += 1) {
		now += 250;
		if (peakDb !== null) detector.level(peakDb);
		const change = detector.tick(now);
		if (change !== null) changes.push({ atMs: now, silent: change });
	}
	return { changes, endMs: now };
}

describe("MicSilenceDetector", () => {
	it("warns after 6 s of digital silence from the start of the take", () => {
		const detector = new MicSilenceDetector();
		detector.tick(0);
		const { changes } = feed(detector, 0, 10, -120);
		expect(changes).toEqual([{ atMs: 6_000, silent: true }]);
	});

	it("says nothing for 5.75 s of silence", () => {
		const detector = new MicSilenceDetector();
		detector.tick(0);
		expect(feed(detector, 0, 5.75, -120).changes).toEqual([]);
		expect(detector.isSilent).toBe(false);
	});

	it("does not count room noise above -60 dBFS as silence", () => {
		const detector = new MicSilenceDetector();
		detector.tick(0);
		expect(feed(detector, 0, 60, -55).changes).toEqual([]);
	});

	it("treats a floor under -60 dBFS as silence", () => {
		const detector = new MicSilenceDetector();
		detector.tick(0);
		expect(feed(detector, 0, 8, -66).changes).toEqual([{ atMs: 6_000, silent: true }]);
	});

	it("clears as soon as signal returns", () => {
		const detector = new MicSilenceDetector();
		detector.tick(0);
		const muted = feed(detector, 0, 7, -120);
		const back = feed(detector, muted.endMs, 1, -20);
		expect(back.changes).toEqual([{ atMs: muted.endMs + 250, silent: false }]);
	});

	it("waits 30 s, not 6, for a pause once the mic has carried a voice", () => {
		const detector = new MicSilenceDetector();
		detector.tick(0);
		const spoke = feed(detector, 0, 2, -18);
		const pause = feed(detector, spoke.endMs, 20, -120);
		expect(pause.changes).toEqual([]);
		const longer = feed(detector, pause.endMs, 11, -120);
		expect(longer.changes).toEqual([{ atMs: spoke.endMs + 30_000, silent: true }]);
	});

	it("counts the time without level lines as silence (a device that delivers nothing)", () => {
		const detector = new MicSilenceDetector();
		detector.tick(0);
		const { changes } = feed(detector, 0, 7, null);
		expect(changes[0]).toEqual({ atMs: 6_000, silent: true });
	});

	it("counts no time while the take is paused", () => {
		const detector = new MicSilenceDetector();
		detector.tick(0);
		feed(detector, 0, 4, -120);
		expect(detector.tick(60_000, true)).toBeNull();
		// 4 s before the pause + 1.75 s after: still under 6 s.
		let now = 60_000;
		for (let i = 0; i < 7; i += 1) {
			now += 250;
			detector.level(-120);
			expect(detector.tick(now)).toBeNull();
		}
		now += 250;
		expect(detector.tick(now)).toBe(true);
	});

	it("honours its options", () => {
		const detector = new MicSilenceDetector({ neverHeardMs: 1_000, thresholdDb: -40 });
		detector.tick(0);
		expect(feed(detector, 0, 2, -45).changes).toEqual([{ atMs: 1_000, silent: true }]);
	});
});

describe("readMicLevelEvent", () => {
	it("reads the peak of a mic-level line", () => {
		expect(readMicLevelEvent({ event: "mic-level", peakDb: -12.5, rmsDb: -30 })).toBe(-12.5);
	});

	it("ignores every other line", () => {
		expect(readMicLevelEvent({ event: "warning", code: "webcam-dark" })).toBeNull();
		expect(readMicLevelEvent({ event: "mic-level" })).toBeNull();
		expect(readMicLevelEvent(null)).toBeNull();
	});
});
