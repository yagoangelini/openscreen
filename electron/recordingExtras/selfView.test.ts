import { describe, expect, it, vi } from "vitest";

vi.mock("electron", () => ({
	app: { getPath: () => "" },
	ipcMain: { handle: vi.fn(), on: vi.fn() },
	screen: {},
	BrowserWindow: vi.fn(),
}));
vi.mock("./extrasWindows", () => ({ createSelfViewWindow: vi.fn() }));

const { SELF_VIEW_MAX_SIZE, SELF_VIEW_MIN_SIZE, sanitizePlacement } = await import("./selfView");

const workArea = { x: 0, y: 0, width: 1920, height: 1040 };

describe("the self-view's remembered placement", () => {
	it("starts in the bottom-right corner, a circle, not shown", () => {
		expect(sanitizePlacement(null, workArea)).toEqual({
			x: 1920 - 200 - 24,
			y: 1040 - 200 - 140,
			size: 200,
			shape: "circle",
			requested: false,
		});
	});

	it("keeps what was saved", () => {
		expect(
			sanitizePlacement({ x: 100, y: 120, size: 260, shape: "rounded", requested: true }, workArea),
		).toEqual({ x: 100, y: 120, size: 260, shape: "rounded", requested: true });
	});

	it("brings back a window left off screen (a display that is gone)", () => {
		const placement = sanitizePlacement({ x: 4000, y: -300, size: 200 }, workArea);
		expect(placement.x).toBe(1920 - 200);
		expect(placement.y).toBe(0);
	});

	it("keeps the size between its limits", () => {
		expect(sanitizePlacement({ size: 20 }, workArea).size).toBe(SELF_VIEW_MIN_SIZE);
		expect(sanitizePlacement({ size: 5000 }, workArea).size).toBe(SELF_VIEW_MAX_SIZE);
	});
});
