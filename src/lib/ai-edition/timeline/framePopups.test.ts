import { describe, expect, it } from "vitest";
import type { CursorTelemetryPoint } from "@/components/video-editor/types";
import { clicksToScan, withFramePopups } from "./framePopups";
import { buildAutoZoomSuggestions } from "./zoom-suggestions";

const click = (timeMs: number, cx = 0.3, cy = 0.2): CursorTelemetryPoint => ({
	timeMs,
	cx,
	cy,
	interactionType: "click",
});

describe("clicksToScan", () => {
	it("skips the clicks a UI Automation popup already explains", () => {
		const telemetry: CursorTelemetryPoint[] = [
			click(1000),
			{
				timeMs: 1300,
				cx: 0.3,
				cy: 0.2,
				interactionType: "move",
				input: {
					kind: "popup-open",
					id: "uia-1",
					rect: { x: 0.2, y: 0.2, width: 0.2, height: 0.3 },
				},
			},
			click(5000),
			{ timeMs: 6000, cx: 0.5, cy: 0.5, interactionType: "move" },
		];
		expect(clicksToScan(telemetry)).toEqual([5000]);
	});
});

describe("withFramePopups", () => {
	it("opens a popup just after the click and closes it after the next click", () => {
		const telemetry = [click(1000), click(3000)];
		const out = withFramePopups(telemetry, [
			{ t: 1000, rect: { x: 0.3, y: 0.22, width: 0.15, height: 0.35 } },
		]);
		const signals = out.filter((p) => p.input);
		expect(signals.map((p) => [p.timeMs, p.input?.kind])).toEqual([
			[1300, "popup-open"],
			[3300, "popup-close"],
		]);
	});

	it("makes the planner frame the menu with the click, as it does a native one", () => {
		const telemetry = [click(4000, 0.32, 0.2)];
		const menu = { x: 0.3, y: 0.22, width: 0.15, height: 0.35 };
		const plain = buildAutoZoomSuggestions({
			cursorTelemetry: telemetry,
			totalMs: 12000,
			existingRegions: [],
		});
		const framed = buildAutoZoomSuggestions({
			cursorTelemetry: withFramePopups(telemetry, [{ t: 4000, rect: menu }]),
			totalMs: 12000,
			existingRegions: [],
		});
		expect(plain).toHaveLength(1);
		expect(framed).toHaveLength(1);
		// The menu reaches down to y = 0.57: the framed shot is centred lower to show it.
		expect(framed[0].focus.cy).toBeGreaterThan(plain[0].focus.cy);
	});
});
