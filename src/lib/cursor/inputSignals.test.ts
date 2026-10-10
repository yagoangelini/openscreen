import { describe, expect, it } from "vitest";
import { normalizeCursorSample } from "../../../electron/media/cursorSidecar";
import { normalizeInputSignal } from "./inputSignals";

describe("normalizeInputSignal", () => {
	it("keeps a well-formed signal and drops a malformed one", () => {
		expect(
			normalizeInputSignal({
				kind: "press",
				button: "right",
				double: true,
				target: { x: 0.1, y: 0.2, width: 0.3, height: 0.1 },
				controlType: 50004,
				name: "Password",
			}),
		).toEqual({
			kind: "press",
			button: "right",
			double: true,
			target: { x: 0.1, y: 0.2, width: 0.3, height: 0.1 },
			controlType: 50004,
		});
		expect(normalizeInputSignal({ kind: "press", button: "thumb" })).toBeUndefined();
		expect(
			normalizeInputSignal({ kind: "popup-open", id: "1", rect: { x: 0, y: 0 } }),
		).toBeUndefined();
		expect(normalizeInputSignal({ kind: "teleport" })).toBeUndefined();
	});

	it("never lets a key's identity through outside a Ctrl/Alt/Win chord", () => {
		expect(normalizeInputSignal({ kind: "key", combo: "Ctrl+Shift+P" })).toEqual({
			kind: "key",
			combo: "Ctrl+Shift+P",
		});
		for (const combo of ["k", "Shift+K", "hello world", "Ctrl+", 42]) {
			expect(normalizeInputSignal({ kind: "key", combo })).toEqual({ kind: "key" });
		}
	});

	it("travels through the sidecar reader, and an old sidecar sample has none", () => {
		const sample = normalizeCursorSample({
			timeMs: 10,
			cx: 0.5,
			cy: 0.5,
			interactionType: "move",
			input: { kind: "wheel", delta: 120 },
		});
		expect(sample?.input).toEqual({ kind: "wheel", delta: 120 });
		expect(normalizeCursorSample({ timeMs: 10, cx: 0.5, cy: 0.5 })).not.toHaveProperty("input");
	});
});
