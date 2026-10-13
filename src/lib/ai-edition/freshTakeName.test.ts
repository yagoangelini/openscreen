import { describe, expect, it } from "vitest";
import { defaultTakeName, takeHasOwnFolder } from "./freshTakeName";

describe("takeHasOwnFolder", () => {
	it("names only a take in a recording-<id> folder of its own", () => {
		expect(takeHasOwnFolder("C:\\V\\OpenScreen\\recording-17\\recording-17.mp4")).toBe(true);
		expect(takeHasOwnFolder("/home/y/OpenScreen/recording-17/recording-17.webm")).toBe(true);
		// A flat take, an already named folder, a folder of another take.
		expect(takeHasOwnFolder("C:\\V\\OpenScreen\\recording-17.mp4")).toBe(false);
		expect(takeHasOwnFolder("C:\\V\\OpenScreen\\Aula 1\\recording-17.mp4")).toBe(false);
		expect(takeHasOwnFolder("C:\\V\\OpenScreen\\recording-18\\recording-17.mp4")).toBe(false);
	});
});

describe("defaultTakeName", () => {
	it("is a folder-safe date and time", () => {
		const name = defaultTakeName(new Date(2026, 9, 13, 14, 5, 11));
		expect(name).not.toMatch(/[<>:"/\\|?*]/);
		expect(name).toMatch(/2026/);
	});
});
