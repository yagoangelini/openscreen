import { describe, expect, it } from "vitest";
import { audioStemPathsFor } from "./recordingSession";

describe("audioStemPathsFor", () => {
	it("names the stems after the video, beside it", () => {
		expect(audioStemPathsFor("C:\\Videos\\OpenScreen\\recording-1.mp4")).toEqual({
			voicePath: "C:\\Videos\\OpenScreen\\recording-1.voice.m4a",
			systemPath: "C:\\Videos\\OpenScreen\\recording-1.system.m4a",
		});
		expect(audioStemPathsFor("/takes/a.b/take.mp4").voicePath).toBe("/takes/a.b/take.voice.m4a");
	});
});
