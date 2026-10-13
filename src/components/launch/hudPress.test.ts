import type React from "react";
import { describe, expect, it, vi } from "vitest";
import { pointerEventEpochMs, pressHandlers } from "./hudPress";

const pointerDown = (init: { button?: number; timeStamp?: number; disabled?: boolean }) =>
	({
		button: init.button ?? 0,
		timeStamp: init.timeStamp ?? 0,
		currentTarget: { disabled: init.disabled ?? false },
	}) as unknown as React.PointerEvent<HTMLButtonElement>;
const click = (detail: number) => ({ detail }) as unknown as React.MouseEvent<HTMLButtonElement>;

describe("pointerEventEpochMs", () => {
	it("is the page's origin plus the event's own timestamp", () => {
		expect(pointerEventEpochMs(250.5, 1_000_000, 1_000_400)).toBe(1_000_250.5);
	});

	it("falls back to now for a timestamp that cannot be a press of this moment", () => {
		expect(pointerEventEpochMs(Number.NaN, 1_000_000, 1_000_400)).toBe(1_000_400);
		expect(pointerEventEpochMs(10_000, 1_000_000, 1_000_400)).toBe(1_000_400);
		expect(pointerEventEpochMs(-10_000, 1_000_000, 1_000_400)).toBe(1_000_400);
	});
});

describe("pressHandlers", () => {
	it("acts on the primary press, with when it happened, and not again on its click", () => {
		const action = vi.fn();
		const handlers = pressHandlers(action);
		handlers.onPointerDown?.(pointerDown({ timeStamp: performance.now() - 5 }));
		handlers.onClick?.(click(1));
		expect(action).toHaveBeenCalledTimes(1);
		expect(Math.abs(action.mock.calls[0][0] - (Date.now() - 5))).toBeLessThan(50);
	});

	it("leaves other buttons and disabled controls alone", () => {
		const action = vi.fn();
		const handlers = pressHandlers(action);
		handlers.onPointerDown?.(pointerDown({ button: 2 }));
		handlers.onPointerDown?.(pointerDown({ disabled: true }));
		expect(action).not.toHaveBeenCalled();
	});

	it("still acts on a click with no pointer behind it (the keyboard)", () => {
		const action = vi.fn();
		pressHandlers(action).onClick?.(click(0));
		expect(action).toHaveBeenCalledTimes(1);
	});
});
