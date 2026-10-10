import { EventEmitter } from "node:events";
import { Readable } from "node:stream";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const spawn = vi.fn();
const dipToScreenRect = vi.fn();

vi.mock("node:child_process", () => ({ spawn: (...args: unknown[]) => spawn(...args) }));
vi.mock("electron", () => ({
	app: { getAppPath: () => "C:\\app", isPackaged: false },
	screen: {
		dipToScreenRect: (...args: unknown[]) => dipToScreenRect(...args),
		screenToDipPoint: (p: unknown) => p,
		getDisplayNearestPoint: () => ({ scaleFactor: 1, bounds: DIP_BOUNDS }),
		getPrimaryDisplay: () => ({ bounds: DIP_BOUNDS }),
	},
}));

import { WindowsNativeRecordingSession } from "./windowsNativeRecordingSession";

/** A 1920x1080 panel at 187.5%, the arrangement measured while fixing #346. */
const DIP_BOUNDS = { x: 0, y: 0, width: 1024, height: 576 };
const PHYSICAL_BOUNDS = { x: 0, y: 0, width: 1920, height: 1080 };

function fakeHelper() {
	// Push-only streams: the test feeds them, so `_read` has nothing to do.
	const noPull = () => undefined;
	const stdout = new Readable({ read: noPull });
	const stderr = new Readable({ read: noPull });
	const child = Object.assign(new EventEmitter(), { stdout, stderr, pid: 4242, kill: vi.fn() });
	return { child, stdout };
}

/**
 * The unit test on `toHelperRect` proves the conversion works; it cannot prove
 * this file still calls it. That is the half that broke in #346 — the recorder
 * and the cursor telemetry each decided for themselves which space they were in
 * — so pin the two branches that decision has.
 */
describe("WindowsNativeRecordingSession bounds handling", () => {
	const REAL_PLATFORM = process.platform;
	const setPlatform = (value: NodeJS.Platform) =>
		Object.defineProperty(process, "platform", { value, configurable: true });

	beforeEach(() => {
		setPlatform("win32");
		// First candidate in the lookup, so nothing has to exist on disk but this.
		process.env.OPENSCREEN_CURSOR_SAMPLER_EXE = __filename;
		dipToScreenRect.mockReturnValue(PHYSICAL_BOUNDS);
		vi.spyOn(console, "error").mockImplementation(() => undefined);
		vi.spyOn(console, "info").mockImplementation(() => undefined);
	});

	afterEach(() => {
		setPlatform(REAL_PLATFORM);
		process.env.OPENSCREEN_CURSOR_SAMPLER_EXE = undefined;
		spawn.mockReset();
		dipToScreenRect.mockReset();
		vi.restoreAllMocks();
	});

	const run = async (sample: Record<string, unknown>) => {
		const { child, stdout } = fakeHelper();
		spawn.mockReturnValue(child);
		const session = new WindowsNativeRecordingSession({
			getDisplayBounds: () => DIP_BOUNDS,
			maxSamples: 10,
			sampleIntervalMs: 33,
			startTimeMs: 1000,
		});
		const started = session.start();
		stdout.push(`${JSON.stringify({ type: "ready", timestampMs: 1000 })}\n`);
		await started;
		stdout.push(`${JSON.stringify(sample)}\n`);
		await new Promise((resolve) => setImmediate(resolve));
		return (await session.stop()).samples;
	};

	it("normalizes a display capture against the physical rect, not the DIP one", async () => {
		const samples = await run({
			type: "sample",
			timestampMs: 1100,
			x: 1440,
			y: 538,
			visible: true,
			handle: null,
			asset: null,
		});

		expect(dipToScreenRect).toHaveBeenCalledWith(null, DIP_BOUNDS);
		// 1440/1920, not 1440/1024 — the latter is 1.40625 and lands off-frame.
		expect(samples[0].cx).toBeCloseTo(0.75, 5);
		expect(samples[0].cy).toBeCloseTo(538 / 1080, 5);
	});

	it("uses the sampler's own bounds as-is for a window capture", async () => {
		const samples = await run({
			type: "sample",
			timestampMs: 1100,
			x: 900,
			y: 500,
			visible: true,
			handle: "0x10003",
			bounds: { x: 100, y: 100, width: 800, height: 600 },
			asset: null,
		});

		// GetWindowRect is already physical, so converting it again would be wrong.
		expect(dipToScreenRect).not.toHaveBeenCalled();
		expect(samples[0].cx).toBeCloseTo((900 - 100) / 800, 5);
		expect(samples[0].cy).toBeCloseTo((500 - 100) / 600, 5);
	});
});

describe("WindowsNativeRecordingSession input events", () => {
	const REAL_PLATFORM = process.platform;
	const setPlatform = (value: NodeJS.Platform) =>
		Object.defineProperty(process, "platform", { value, configurable: true });

	beforeEach(() => {
		setPlatform("win32");
		process.env.OPENSCREEN_CURSOR_SAMPLER_EXE = __filename;
		dipToScreenRect.mockReturnValue(PHYSICAL_BOUNDS);
		vi.spyOn(console, "error").mockImplementation(() => undefined);
		vi.spyOn(console, "info").mockImplementation(() => undefined);
	});

	afterEach(() => {
		setPlatform(REAL_PLATFORM);
		process.env.OPENSCREEN_CURSOR_SAMPLER_EXE = undefined;
		spawn.mockReset();
		dipToScreenRect.mockReset();
		vi.restoreAllMocks();
	});

	const record = async (ready: Record<string, unknown>, lines: Record<string, unknown>[]) => {
		const { child, stdout } = fakeHelper();
		spawn.mockReturnValue(child);
		const session = new WindowsNativeRecordingSession({
			getDisplayBounds: () => DIP_BOUNDS,
			maxSamples: Number.POSITIVE_INFINITY,
			sampleIntervalMs: 33,
			startTimeMs: 1000,
		});
		const started = session.start();
		stdout.push(`${JSON.stringify({ type: "ready", timestampMs: 1000, ...ready })}\n`);
		await started;
		for (const line of lines) stdout.push(`${JSON.stringify(line)}\n`);
		await new Promise((resolve) => setImmediate(resolve));
		return (await session.stop()).samples;
	};

	const tick = (timestampMs: number, extra: Record<string, unknown> = {}) => ({
		type: "sample",
		timestampMs,
		x: 960,
		y: 540,
		visible: true,
		handle: null,
		asset: null,
		...extra,
	});

	it("records each press at the hook's own time and point, and the ticks as moves", async () => {
		const samples = await record({ inputEvents: true }, [
			tick(1100),
			// The tick after the press still carries the old flags: it must not click again.
			tick(1133, { leftButtonDown: true, leftButtonPressed: true }),
			{
				type: "input",
				timestampMs: 1120,
				x: 480,
				y: 270,
				kind: "press",
				button: "left",
				target: { x: 400, y: 240, width: 160, height: 60 },
				controlType: 50000,
			},
			{ type: "input", timestampMs: 1180, x: 480, y: 270, kind: "release", button: "left" },
			{ type: "input", timestampMs: 1200, x: 960, y: 540, kind: "press", button: "right" },
		]);
		expect(samples.map((s) => [s.timeMs, s.interactionType])).toEqual([
			[100, "move"],
			[120, "click"],
			[133, "move"],
			[180, "mouseup"],
			[200, "right-click"],
		]);
		const press = samples[1];
		expect(press.cx).toBeCloseTo(0.25, 6);
		expect(press.cy).toBeCloseTo(0.25, 6);
		expect(press.input).toEqual({
			kind: "press",
			button: "left",
			target: { x: 400 / 1920, y: 240 / 1080, width: 160 / 1920, height: 60 / 1080 },
			controlType: 50000,
		});
	});

	it("keeps keys as times, chords by name, wheel and popups", async () => {
		const samples = await record({ inputEvents: true }, [
			tick(1100),
			{ type: "input", timestampMs: 1150, x: 960, y: 540, kind: "key" },
			{ type: "input", timestampMs: 1160, x: 960, y: 540, kind: "key", combo: "Ctrl+K" },
			{ type: "input", timestampMs: 1170, x: 960, y: 540, kind: "wheel", delta: -120 },
			{
				type: "popup",
				timestampMs: 1180,
				event: "open",
				id: "0x1",
				menu: true,
				rect: { x: 960, y: 540, width: 192, height: 108 },
			},
			{ type: "popup", timestampMs: 1300, event: "close", id: "0x1" },
		]);
		expect(samples.slice(1).map((s) => s.input)).toEqual([
			{ kind: "key" },
			{ kind: "key", combo: "Ctrl+K" },
			{ kind: "wheel", delta: -120 },
			{
				kind: "popup-open",
				id: "0x1",
				menu: true,
				rect: { x: 0.5, y: 0.5, width: 0.1, height: 0.1 },
			},
			{ kind: "popup-close", id: "0x1" },
		]);
		expect(samples.slice(1).every((s) => s.interactionType === "move")).toBe(true);
	});

	it("still reads clicks off the ticks from an older helper", async () => {
		const samples = await record({}, [
			tick(1100, { leftButtonDown: true, leftButtonPressed: true }),
		]);
		expect(samples[0].interactionType).toBe("click");
	});
});
