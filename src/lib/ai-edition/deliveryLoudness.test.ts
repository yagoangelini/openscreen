import { describe, expect, it } from "vitest";
import type { SceneDescription } from "@/native/sceneDescription";
import { withDeliveryLoudness } from "./deliveryLoudness";

const scene = (gainDb: number) => ({ audio: { gainDb } }) as unknown as SceneDescription;

describe("withDeliveryLoudness", () => {
	it("lifts the export from the −16 LUFS voice target to YouTube's −14", () => {
		expect(withDeliveryLoudness(scene(0), true).audio.gainDb).toBe(2);
		expect(withDeliveryLoudness(scene(-3), true).audio.gainDb).toBe(-1);
	});

	it("leaves the scene alone when off, and stays inside the compositor's trim range", () => {
		const off = scene(1);
		expect(withDeliveryLoudness(off, false)).toBe(off);
		expect(withDeliveryLoudness(scene(11), true).audio.gainDb).toBe(12);
	});
});
