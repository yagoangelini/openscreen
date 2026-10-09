import os from "node:os";
import { describe, expect, it } from "vitest";
import {
	assessFreeSpace,
	CRITICAL_FREE_BYTES,
	LOW_FREE_BYTES,
	RECORDING_BYTES_PER_MINUTE,
	readFreeBytes,
} from "./diskSpace";

describe("assessFreeSpace", () => {
	it("refuses to start below the critical floor", () => {
		expect(assessFreeSpace(CRITICAL_FREE_BYTES - 1).level).toBe("critical");
	});

	it("warns under about half an hour of room", () => {
		const assessment = assessFreeSpace(LOW_FREE_BYTES - 1);
		expect(assessment.level).toBe("low");
		expect(assessment.minutesLeft).toBe(29);
	});

	it("is fine with plenty of room", () => {
		const assessment = assessFreeSpace(120 * RECORDING_BYTES_PER_MINUTE);
		expect(assessment.level).toBe("ok");
		expect(assessment.minutesLeft).toBe(120);
	});

	it("never reports negative minutes", () => {
		expect(assessFreeSpace(0).minutesLeft).toBe(0);
	});
});

describe("readFreeBytes", () => {
	it("reads the free space of a real directory", async () => {
		const free = await readFreeBytes(os.tmpdir());
		expect(free).not.toBeNull();
		expect(free).toBeGreaterThan(0);
	});

	it("answers null rather than throwing for a path that does not exist", async () => {
		expect(await readFreeBytes("Z:\\definitely\\not\\here\\openscreen")).toBeNull();
	});
});
