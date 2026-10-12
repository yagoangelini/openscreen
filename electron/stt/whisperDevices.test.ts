import { describe, expect, it } from "vitest";

import {
	isWhisperModelPreference,
	parseDeviceList,
	resolveWhisperModel,
	TURBO_MIN_VRAM_BYTES,
	turboCapableDevice,
	type WhisperDevice,
} from "./whisperDevices";

const GiB = 1024 ** 3;

// What the helper printed on the Dell G15 (RTX 3060 Laptop + Intel UHD), ggml's
// own device lines on stderr first.
const G15_OUTPUT = [
	"ggml_vulkan: Found 2 Vulkan devices:",
	"ggml_vulkan: 0 = NVIDIA GeForce RTX 3060 Laptop GPU (NVIDIA) | uma: 0 | fp16: 1",
	'{"devices":[{"description":"NVIDIA GeForce RTX 3060 Laptop GPU","memory_free":5479858176,"memory_total":6285164544,"name":"Vulkan0","type":"gpu"},{"description":"Intel(R) UHD Graphics","memory_free":24678010880,"memory_total":21331593216,"name":"Vulkan1","type":"igpu"},{"description":"11th Gen Intel(R) Core(TM) i7-11800H @ 2.30GHz","memory_free":15108894720,"memory_total":42663186432,"name":"CPU","type":"cpu"}]}',
].join("\n");

function device(over: Partial<WhisperDevice>): WhisperDevice {
	return {
		name: "Vulkan0",
		description: "GPU",
		type: "gpu",
		memoryFreeBytes: 0,
		memoryTotalBytes: 8 * GiB,
		...over,
	};
}

describe("parseDeviceList", () => {
	it("reads the helper's JSON line among ggml's log lines", () => {
		const devices = parseDeviceList(G15_OUTPUT);
		expect(devices.map((d) => [d.name, d.type])).toEqual([
			["Vulkan0", "gpu"],
			["Vulkan1", "igpu"],
			["CPU", "cpu"],
		]);
		expect(devices[0].memoryTotalBytes).toBe(6285164544);
	});

	it("is empty for a helper that predates --list-devices", () => {
		expect(
			parseDeviceList("FATAL: --model <path-to-ggml.bin> or OPENSCREEN_WHISPER_MODEL is required"),
		).toEqual([]);
		expect(parseDeviceList("")).toEqual([]);
		expect(parseDeviceList('{"devices": "nope"}')).toEqual([]);
	});
});

describe("turboCapableDevice", () => {
	it("takes the dedicated RTX of the G15, not its integrated GPU", () => {
		expect(turboCapableDevice(parseDeviceList(G15_OUTPUT))?.description).toBe(
			"NVIDIA GeForce RTX 3060 Laptop GPU",
		);
	});

	it("refuses an integrated GPU however much shared memory it reports", () => {
		expect(turboCapableDevice([device({ type: "igpu", memoryTotalBytes: 20 * GiB })])).toBeNull();
	});

	it("refuses a dedicated GPU too small or too full for it", () => {
		expect(turboCapableDevice([device({ memoryTotalBytes: 2 * GiB })])).toBeNull();
		expect(turboCapableDevice([device({ memoryFreeBytes: 1 * GiB })])).toBeNull();
		// A 4 GB card reports a little under 4 GiB.
		expect(turboCapableDevice([device({ memoryTotalBytes: 3.9 * GiB })])).not.toBeNull();
		expect(TURBO_MIN_VRAM_BYTES).toBeLessThan(3.9 * GiB);
	});

	it("trusts the total when the driver reports no free memory", () => {
		expect(turboCapableDevice([device({ memoryFreeBytes: 0 })])).not.toBeNull();
	});
});

describe("resolveWhisperModel", () => {
	it("auto is turbo on a capable GPU and small everywhere else", () => {
		expect(resolveWhisperModel("auto", parseDeviceList(G15_OUTPUT))).toBe("large-v3-turbo");
		expect(resolveWhisperModel("auto", [device({ type: "cpu" })])).toBe("small");
		expect(resolveWhisperModel("auto", [])).toBe("small");
	});

	it("an explicit choice wins over the hardware", () => {
		expect(resolveWhisperModel("large-v3-turbo", [])).toBe("large-v3-turbo");
		expect(resolveWhisperModel("small", parseDeviceList(G15_OUTPUT))).toBe("small");
	});

	it("knows its preferences", () => {
		expect(isWhisperModelPreference("auto")).toBe(true);
		expect(isWhisperModelPreference("large-v3-turbo")).toBe(true);
		expect(isWhisperModelPreference("medium")).toBe(false);
	});
});
