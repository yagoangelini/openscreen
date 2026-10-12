import { describe, expect, it } from "vitest";
import { DEFAULT_AUTO_ZOOM_SETTINGS, resolveZoomRendering } from "./zoom-motion";

describe("resolveZoomRendering", () => {
	const fixed = DEFAULT_AUTO_ZOOM_SETTINGS;

	it("holds an automatic zoom still under the fixed camera", () => {
		expect(resolveZoomRendering({ source: "auto" }, fixed, false).focusMode).toBe("manual");
	});

	it("lets a shot the planner made to follow the pointer follow under the fixed camera", () => {
		const rendering = resolveZoomRendering({ source: "auto", focusMode: "auto" }, fixed, false);
		expect(rendering.focusMode).toBe("auto");
		// With the project's calm law: the motion it follows by.
		expect(rendering.motion?.followDeadZone).toBe(0.7);
	});

	it("follows every automatic zoom under a following camera, and all of them with Auto-Focus", () => {
		const follow = { ...fixed, cameraMode: "follow" as const };
		expect(resolveZoomRendering({ source: "auto" }, follow, false).focusMode).toBe("auto");
		expect(resolveZoomRendering({ source: "auto" }, fixed, true).focusMode).toBe("auto");
	});
});
