import { spawn } from "node:child_process";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
	registerTakeFileHolder,
	releaseTakeFiles,
	takeFileTest,
	trackedReaderPaths,
	trackFileReader,
} from "./takeFileHolders";

const take = path.join(path.sep, "rec", "Aula");
const screen = path.join(take, "recording-1.mp4");
const other = path.join(path.sep, "rec", "Outra", "recording-2.mp4");

/** A child that just waits, standing in for an ffmpeg reading the take. */
function sleeper() {
	return spawn(process.execPath, ["-e", "setTimeout(() => {}, 60000)"], { stdio: "ignore" });
}

const cleanups: Array<() => void> = [];
afterEach(() => {
	for (const cleanup of cleanups.splice(0)) cleanup();
});

describe("takeFileTest", () => {
	it("accepts the take's files and anything inside its folder, nothing else", () => {
		const isTake = takeFileTest(take, [screen]);
		expect(isTake(screen)).toBe(true);
		expect(isTake(path.join(take, "recording-1.session.json"))).toBe(true);
		expect(isTake(path.join(path.sep, "rec", "Aula 2", "recording-3.mp4"))).toBe(false);
		expect(isTake(other)).toBe(false);
		expect(isTake("")).toBe(false);
	});

	it("names a flat take by its files only", () => {
		const isTake = takeFileTest(null, [screen]);
		expect(isTake(screen)).toBe(true);
		expect(isTake(path.join(take, "recording-1-webcam.mp4"))).toBe(false);
	});
});

describe("releaseTakeFiles", () => {
	it("stops the child processes reading the take, and waits until they are gone", async () => {
		const reading = sleeper();
		const elsewhere = sleeper();
		cleanups.push(() => elsewhere.kill("SIGKILL"));
		trackFileReader(reading, screen);
		trackFileReader(elsewhere, other);
		expect(trackedReaderPaths()).toEqual(expect.arrayContaining([screen, other]));

		const released = await releaseTakeFiles(takeFileTest(take, [screen]));

		expect(released).toEqual({ readers: 1 });
		expect(reading.exitCode !== null || reading.signalCode !== null).toBe(true);
		expect(elsewhere.exitCode).toBeNull();
		expect(trackedReaderPaths()).toEqual([other]);
	});

	it("asks every registered holder, and reports only those that let something go", async () => {
		const seen: string[] = [];
		cleanups.push(
			registerTakeFileHolder("preview views", (isTake) => {
				seen.push("views");
				return isTake(screen) ? 2 : 0;
			}),
			registerTakeFileHolder("idle", () => 0),
			registerTakeFileHolder("broken", () => {
				throw new Error("boom");
			}),
		);
		expect(await releaseTakeFiles(takeFileTest(take, []))).toEqual({ "preview views": 2 });
		expect(seen).toEqual(["views"]);
	});

	it("ignores a child double without events", () => {
		trackFileReader({} as never, screen);
		expect(trackedReaderPaths()).not.toContain(screen);
	});
});
