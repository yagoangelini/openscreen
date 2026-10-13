import { describe, expect, it } from "vitest";
import { normalizeRecordingSession } from "./recordingSession";

describe("normalizeRecordingSession: stopAtMs", () => {
	it("keeps where the take was stopped", () => {
		expect(
			normalizeRecordingSession({ screenVideoPath: "C:/t/r.mp4", createdAt: 1, stopAtMs: 6537 }),
		).toEqual({ screenVideoPath: "C:/t/r.mp4", createdAt: 1, stopAtMs: 6537 });
	});

	it("drops a value that is not a position in the take", () => {
		for (const stopAtMs of [0, -5, Number.NaN, "6537", null]) {
			expect(
				normalizeRecordingSession({ screenVideoPath: "C:/t/r.mp4", createdAt: 1, stopAtMs }),
			).not.toHaveProperty("stopAtMs");
		}
	});
});
