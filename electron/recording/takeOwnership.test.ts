import { describe, expect, it } from "vitest";
import { TakeOwnership } from "./takeOwnership";

describe("TakeOwnership", () => {
	it("lets the current owner act", () => {
		const cursor = new TakeOwnership();
		const take = cursor.claim();
		expect(cursor.owns(take)).toBe(true);
	});

	it("stops a timed-out take's late cleanup from ending the next take's sampler", () => {
		const cursor = new TakeOwnership();
		const timedOut = cursor.claim();
		// The failed start is still killing its helper when the next take claims the sampler.
		const next = cursor.claim();
		expect(cursor.owns(timedOut)).toBe(false);
		expect(cursor.owns(next)).toBe(true);
	});

	it("reports the current token, 0 before anyone claimed", () => {
		const cursor = new TakeOwnership();
		expect(cursor.token).toBe(0);
		const take = cursor.claim();
		expect(cursor.token).toBe(take);
	});
});
