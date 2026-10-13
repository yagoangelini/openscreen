// @vitest-environment node
import { spawnSync } from "node:child_process";
import { mkdtempSync, rmSync } from "node:fs";
import os, { tmpdir } from "node:os";
import path from "node:path";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { resolveFfmpeg } from "./audioPeaks";
import { getScreenActivity, screenActivityArgs } from "./screenActivity";

describe("screenActivityArgs", () => {
	it("streams the take as small grey frames at the activity rate, without its audio", () => {
		const args = screenActivityArgs("C:\\takes\\a.mp4");
		expect(args).toContain("-an");
		expect(args[args.indexOf("-i") + 1]).toBe("C:\\takes\\a.mp4");
		expect(args[args.indexOf("-vf") + 1]).toBe("fps=8,scale=160:90:flags=area,format=gray");
		expect(args.slice(-3)).toEqual(["-f", "rawvideo", "pipe:1"]);
	});
});

const ffmpeg = resolveFfmpeg();
const dir = mkdtempSync(path.join(tmpdir(), "screen-activity-"));
afterAll(() => rmSync(dir, { recursive: true, force: true }));

describe.skipIf(!ffmpeg)("getScreenActivity (real ffmpeg)", () => {
	// The app runs the scan below normal priority so the preview comes first. Under the full
	// suite every core is busy at normal priority, and a below-normal ffmpeg was starved past
	// even a 30 s timeout (it takes ~0.3 s on its own). The priority is not what this checks.
	beforeAll(() => {
		vi.spyOn(os, "setPriority").mockImplementation(() => undefined);
	});
	afterAll(() => vi.restoreAllMocks());

	it("finds the box that appears half way through a clip, where it appears", async () => {
		const video = path.join(dir, "box.mp4");
		// Two seconds of dark grey; a white box over the right third, top half, from 1 s on.
		const made = spawnSync(ffmpeg as string, [
			"-hide_banner",
			"-loglevel",
			"error",
			"-f",
			"lavfi",
			"-i",
			"color=c=0x202020:s=640x360:r=30:d=2",
			"-vf",
			"drawbox=x=420:y=0:w=200:h=180:color=white:t=fill:enable='gte(t,1)'",
			"-pix_fmt",
			"yuv420p",
			video,
		]);
		expect(made.status).toBe(0);
		const result = await getScreenActivity(video);
		expect(result.success).toBe(true);
		const steps = result.activity?.steps ?? [];
		expect(steps).toHaveLength(1);
		expect(steps[0].t).toBeGreaterThanOrEqual(875);
		expect(steps[0].t).toBeLessThanOrEqual(1125);
		const [box] = steps[0].boxes;
		expect(box.x).toBeCloseTo(420 / 640, 1);
		expect(box.y).toBeCloseTo(0, 1);
		expect(box.width).toBeCloseTo(200 / 640, 1);
		expect(box.height).toBeCloseTo(0.5, 1);
		// Two real ffmpeg runs: under a full suite they can outlast the default 5 s.
	}, 30_000);
});
