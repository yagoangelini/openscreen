import { describe, expect, it, vi } from "vitest";
import { createQuitWhileRecordingPrompt } from "./quitWhileRecording";

function deferred<T>() {
	let resolve!: (value: T) => void;
	const promise = new Promise<T>((r) => {
		resolve = r;
	});
	return { promise, resolve };
}

describe("createQuitWhileRecordingPrompt", () => {
	it("stops and opens the take when the user picks stop", async () => {
		const stopAndOpen = vi.fn();
		const prompt = createQuitWhileRecordingPrompt({
			isRecording: () => true,
			ask: async () => true,
			stopAndOpen,
		});
		await prompt();
		expect(stopAndOpen).toHaveBeenCalledTimes(1);
	});

	it("keeps recording when the user picks keep recording", async () => {
		const stopAndOpen = vi.fn();
		const prompt = createQuitWhileRecordingPrompt({
			isRecording: () => true,
			ask: async () => false,
			stopAndOpen,
		});
		await prompt();
		expect(stopAndOpen).not.toHaveBeenCalled();
	});

	it("shows one dialog for repeated close attempts, and a new one after it closes", async () => {
		const answer = deferred<boolean>();
		const ask = vi.fn(() => answer.promise);
		const stopAndOpen = vi.fn();
		const prompt = createQuitWhileRecordingPrompt({ isRecording: () => true, ask, stopAndOpen });

		const first = prompt();
		const second = prompt();
		expect(second).toBe(first);
		expect(ask).toHaveBeenCalledTimes(1);

		answer.resolve(false);
		await first;
		ask.mockResolvedValueOnce(true);
		await prompt();
		expect(ask).toHaveBeenCalledTimes(2);
		expect(stopAndOpen).toHaveBeenCalledTimes(1);
	});

	it("does nothing when the take already ended while the dialog was open", async () => {
		const stopAndOpen = vi.fn();
		const prompt = createQuitWhileRecordingPrompt({
			isRecording: () => false,
			ask: async () => true,
			stopAndOpen,
		});
		await prompt();
		expect(stopAndOpen).not.toHaveBeenCalled();
	});

	it("survives a dialog that fails", async () => {
		const error = vi.spyOn(console, "error").mockImplementation(() => undefined);
		const prompt = createQuitWhileRecordingPrompt({
			isRecording: () => true,
			ask: () => Promise.reject(new Error("no window")),
			stopAndOpen: vi.fn(),
		});
		await expect(prompt()).resolves.toBeUndefined();
		error.mockRestore();
	});
});
