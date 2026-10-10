import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createInactivityTimer } from "./inactivityTimer";

describe("createInactivityTimer", () => {
	beforeEach(() => {
		vi.useFakeTimers();
	});
	afterEach(() => {
		vi.useRealTimers();
	});

	it("fires once the process has been silent for the whole window", () => {
		const onIdle = vi.fn();
		createInactivityTimer(1000, onIdle);
		vi.advanceTimersByTime(999);
		expect(onIdle).not.toHaveBeenCalled();
		vi.advanceTimersByTime(1);
		expect(onIdle).toHaveBeenCalledTimes(1);
	});

	it("never fires while output keeps arriving, however long the run", () => {
		const onIdle = vi.fn();
		const timer = createInactivityTimer(1000, onIdle);
		for (let i = 0; i < 300; i++) {
			vi.advanceTimersByTime(900);
			timer.touch();
		}
		expect(onIdle).not.toHaveBeenCalled();
		timer.clear();
		vi.advanceTimersByTime(5000);
		expect(onIdle).not.toHaveBeenCalled();
	});
});
