import { afterEach, describe, expect, it } from "vitest";
import {
	clampSystemCompensationDb,
	type EchoCancelState,
	echoCancelState,
	echoFreeVoicePath,
	prepareEchoCancelledVoice,
	resetEchoCancelCache,
	seedEchoCancelState,
	systemCompensationDb,
	systemLaneGainDb,
} from "./echoCancel";
import type { EchoCancelReport } from "./echoCancelReport";
import { readStemPeaks } from "./transcription/speakerStems";

afterEach(() => resetEchoCancelCache());

const report = (over: Partial<EchoCancelReport> = {}): EchoCancelReport => ({
	detected: true,
	delayMs: 180,
	delayEndMs: 207,
	driftPpm: 20.7,
	windows: 186,
	consistentWindows: 171,
	echoToVoiceDb: -6.6,
	erleDb: 14.2,
	linearErleDb: 6.6,
	processedShare: 0.55,
	adaptShare: 0.81,
	durationSec: 1308.7,
	echoPathGainDb: 20.2,
	systemTruePeakDbfs: -26.1,
	systemCompensationDb: 20.2,
	...over,
});

describe("clampSystemCompensationDb", () => {
	// The same points as Rust `the_compensation_is_the_echo_path_gain_within_its_bounds`.
	it("is the echo path gain, between 0 dB, +30 dB and the stem's true peak at −1 dBFS", () => {
		expect(clampSystemCompensationDb(25.3, -26.1)).toBeCloseTo(25.1, 9);
		expect(clampSystemCompensationDb(18, -26.1)).toBeCloseTo(18, 9);
		expect(clampSystemCompensationDb(40, -60)).toBe(30);
		expect(clampSystemCompensationDb(-3, -20)).toBe(0);
		expect(clampSystemCompensationDb(10, 0.5)).toBe(0);
		expect(clampSystemCompensationDb(Number.NaN, -20)).toBe(0);
	});
});

describe("systemLaneGainDb", () => {
	// The same points as Rust `system_lane_gain_db` in `each_stem_lane_mutes_and_silences_on_its_own`.
	it("adds the compensation and the voice's loudness gain to the lane's own volume", () => {
		expect(systemLaneGainDb(-6, 12, 2.5)).toBe(8.5);
		expect(systemLaneGainDb(3, 0, 2.5)).toBe(3);
		expect(systemLaneGainDb(3, -4, 2.5)).toBe(3);
	});
});

describe("systemCompensationDb", () => {
	const on = { echoCancel: true, systemCompensation: true };
	const removed: EchoCancelState = { path: "/cache/take.echo-free.wav", report: report() };

	it("raises the computer lane by the echo path once the echo is removed", () => {
		expect(systemCompensationDb(on, removed)).toBeCloseTo(20.2, 9);
		// Clamped again from the report's own fields, whatever the stored value says.
		expect(
			systemCompensationDb(on, {
				...removed,
				report: report({ echoPathGainDb: 28, systemTruePeakDbfs: -26.1 }),
			}),
		).toBeCloseTo(25.1, 9);
	});

	it("changes nothing with the echo removal or the switch off, without an echo, or with an old report", () => {
		expect(systemCompensationDb({ echoCancel: false, systemCompensation: true }, removed)).toBe(0);
		expect(systemCompensationDb({ echoCancel: true, systemCompensation: false }, removed)).toBe(0);
		expect(systemCompensationDb(on, { report: report({ detected: false }) })).toBe(0);
		expect(systemCompensationDb(on, undefined)).toBe(0);
		expect(
			systemCompensationDb(on, {
				...removed,
				report: report({ echoPathGainDb: undefined, systemTruePeakDbfs: undefined }),
			}),
		).toBe(0);
	});
});

describe("the strength", () => {
	it("is part of what an answer is for: each strength is its own file", () => {
		const voice = "/take.voice.m4a";
		const system = "/take.system.m4a";
		seedEchoCancelState(voice, system, { path: "/cache/take.echo-free.3-strong.wav" }, "strong");
		expect(echoFreeVoicePath(voice, system, "strong")).toBe("/cache/take.echo-free.3-strong.wav");
		expect(echoFreeVoicePath(voice, system, "normal")).toBeUndefined();
		expect(echoCancelState(voice, system, "gentle")).toBeUndefined();
		// Without a strength (who spoke only needs the echo out): any one made, Normal first.
		expect(echoFreeVoicePath(voice, system)).toBe("/cache/take.echo-free.3-strong.wav");
		seedEchoCancelState(voice, system, { path: "/cache/take.echo-free.3-normal.wav" });
		expect(echoFreeVoicePath(voice, system)).toBe("/cache/take.echo-free.3-normal.wav");
	});

	it("goes to the main process with the request", async () => {
		const asked: unknown[][] = [];
		const api = {
			prepareEchoCancelledVoice: async (...args: unknown[]) => {
				asked.push(args);
				return { success: true, path: "/cache/x.wav", report: report() };
			},
		};
		const previous = (globalThis as { window?: unknown }).window;
		(globalThis as { window?: unknown }).window = { electronAPI: api };
		try {
			const state = await prepareEchoCancelledVoice("/v.m4a", "/s.m4a", "gentle");
			expect(state?.path).toBe("/cache/x.wav");
			expect(asked).toEqual([["/v.m4a", "/s.m4a", "gentle"]]);
			// Answered once per strength: the same ask again is the cache.
			await prepareEchoCancelledVoice("/v.m4a", "/s.m4a", "gentle");
			expect(asked).toHaveLength(1);
			await prepareEchoCancelledVoice("/v.m4a", "/s.m4a", "strong");
			expect(asked).toHaveLength(2);
		} finally {
			(globalThis as { window?: unknown }).window = previous;
		}
	});
});

describe("Quem fala and the echo", () => {
	it("reads the echo-free voice when the canceller has made one", async () => {
		const asset = {
			audioStems: { voicePath: "/take.voice.m4a", systemPath: "/take.system.m4a" },
			durationSec: 10,
		};
		const read: string[] = [];
		const peaks = async (filePath: string) => {
			read.push(filePath);
			return new Float32Array(4);
		};
		await readStemPeaks(asset, peaks);
		expect(read).toEqual(["/take.voice.m4a", "/take.system.m4a"]);
		seedEchoCancelState("/take.voice.m4a", "/take.system.m4a", {
			path: "/cache/take.echo-free.wav",
		});
		read.length = 0;
		await readStemPeaks(asset, peaks);
		expect(read).toEqual(["/cache/take.echo-free.wav", "/take.system.m4a"]);
	});
});
