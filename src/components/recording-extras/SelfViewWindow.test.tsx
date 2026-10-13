// @vitest-environment jsdom
// The camera self-view looks the same before a take (it opens the camera itself) as during
// one (the helper sends frames): before, the <video> escaped the rounded crop and showed
// the camera as a full square under a faint ring that marked where the crop should be.
import "@testing-library/jest-dom";
import { act, render, screen } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { I18nProvider } from "@/contexts/I18nContext";
import type { SelfViewSnapshot } from "@/lib/recordingExtrasApi";
import { SelfViewWindow, selfViewShapeStyle } from "./SelfViewWindow";

vi.mock("@/hooks/useCameraPreviewStream", () => ({
	useCameraPreviewStream: () => ({ stream: null, error: null }),
}));

let pushState: (state: SelfViewSnapshot) => void = () => undefined;

function snapshot(overrides: Partial<SelfViewSnapshot> = {}): SelfViewSnapshot {
	return {
		requested: true,
		visible: true,
		shape: "circle",
		source: "camera",
		deviceId: null,
		...overrides,
	};
}

beforeEach(() => {
	(window as unknown as { recordingExtrasAPI: unknown }).recordingExtrasAPI = {
		getSelfViewState: vi.fn(() => Promise.resolve(snapshot())),
		onSelfViewState: vi.fn((callback: (state: SelfViewSnapshot) => void) => {
			pushState = callback;
			return () => undefined;
		}),
		onSelfViewFrame: vi.fn(() => () => undefined),
		ackSelfViewFrame: vi.fn(),
		selfViewCameraReleased: vi.fn(),
		setSelfViewShape: vi.fn(),
	};
});

afterEach(() => {
	delete (window as unknown as { recordingExtrasAPI?: unknown }).recordingExtrasAPI;
});

async function renderSelfView() {
	render(
		<I18nProvider>
			<SelfViewWindow />
		</I18nProvider>,
	);
	return screen.findByTestId("self-view");
}

describe("selfViewShapeStyle", () => {
	it("clips with clip-path, which also holds over a composited layer", () => {
		expect(selfViewShapeStyle("circle")).toEqual({
			borderRadius: "50%",
			clipPath: "circle(50% at 50% 50%)",
		});
		expect(selfViewShapeStyle("rounded")).toEqual({
			borderRadius: "18%",
			clipPath: "inset(0 round 18%)",
		});
	});
});

describe("SelfViewWindow", () => {
	it("crops the same way before a take and during one", async () => {
		const root = await renderSelfView();
		const before = root.getAttribute("style");
		expect(root.style.clipPath).toBe("circle(50% at 50% 50%)");

		act(() => pushState(snapshot({ source: "helper" })));
		expect(root).toHaveAttribute("data-source", "helper");
		expect(root.getAttribute("style")).toBe(before);
	});

	it("follows the shape", async () => {
		const root = await renderSelfView();
		act(() => pushState(snapshot({ shape: "rounded" })));
		expect(root).toHaveAttribute("data-shape", "rounded");
		expect(root.style.clipPath).toBe("inset(0 round 18%)");
	});

	it("shows the picture only through the canvas: the <video> is a hidden decoder", async () => {
		const root = await renderSelfView();
		expect(screen.getByTestId("self-view-canvas")).toHaveClass("inset-0", "h-full", "w-full");
		const decoder = screen.getByTestId("self-view-decoder");
		expect(decoder.tagName).toBe("VIDEO");
		expect(decoder).toHaveClass("opacity-0", "h-px", "w-px");
		// No mirrored <video> filling the window, and no ring drawn over the crop.
		expect(root.querySelectorAll("video")).toHaveLength(1);
		expect(root.querySelector(".border-2")).toBeNull();
	});
});
