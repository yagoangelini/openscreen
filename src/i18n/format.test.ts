import { describe, expect, it } from "vitest";
import { formatDate, formatDateTime, formatDecimal, formatTime } from "./format";

// 11 October 2026, 23:27:06 local time: the take the E2E named "10/11/2026, 11:27:06 PM".
const TAKE = new Date(2026, 9, 11, 23, 27, 6);

describe("format in the UI's locale", () => {
	it("writes pt-BR dates day first, on a 24-hour clock", () => {
		expect(formatDateTime(TAKE, "pt-BR")).toBe("11/10/2026, 23:27:06");
		expect(formatDate(TAKE, "pt-BR")).toBe("11/10/2026");
		expect(formatTime(TAKE, "pt-BR")).toBe("23:27:06");
	});

	it("keeps en dates as English readers expect them", () => {
		expect(formatDate(TAKE, "en")).toBe("10/11/2026");
	});

	it("uses the locale's decimal separator, with fixed decimals", () => {
		expect(formatDecimal(1.25, 1, "pt-BR")).toBe("1,3");
		expect(formatDecimal(2, 1, "pt-BR")).toBe("2,0");
		expect(formatDecimal(1.3, 1, "en")).toBe("1.3");
	});

	it("falls back instead of throwing on a malformed locale tag", () => {
		expect(formatDecimal(1.5, 1, "not a locale!")).toBe("1.5");
		expect(() => formatDateTime(TAKE, "not a locale!")).not.toThrow();
	});
});
