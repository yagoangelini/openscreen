// Dates and numbers in the UI's language, not the system's.
//
// `toLocaleString()` with no locale formats in the OS's locale, which on a Portuguese
// Windows that Chromium reports as en-US printed "Gravação 10/11/2026, 11:27:06 PM" for
// 11 October at 23:27, and `toFixed(1)` printed "1.3 s" in a pt-BR UI (E2E 2.4.0, D-6).
// Every visible date or decimal goes through here with the locale the UI speaks.

import type { Locale } from "./config";

function safely<T>(format: () => T, fallback: () => T): T {
	try {
		return format();
	} catch {
		// An unknown locale tag (a stale stored value) must not break the screen.
		return fallback();
	}
}

/** Date and time, as "11/10/2026, 23:27:06" in pt-BR. */
export function formatDateTime(date: Date | number | string, locale: Locale): string {
	const value = new Date(date);
	return safely(
		() => value.toLocaleString(locale),
		() => value.toLocaleString(),
	);
}

/** Date only, as "11/10/2026" in pt-BR. */
export function formatDate(date: Date | number | string, locale: Locale): string {
	const value = new Date(date);
	return safely(
		() => value.toLocaleDateString(locale),
		() => value.toLocaleDateString(),
	);
}

/** Time only, as "23:27:06" in pt-BR. */
export function formatTime(date: Date | number | string, locale: Locale): string {
	const value = new Date(date);
	return safely(
		() => value.toLocaleTimeString(locale),
		() => value.toLocaleTimeString(),
	);
}

/** A number with exactly `digits` decimals, as "1,3" in pt-BR. */
export function formatDecimal(value: number, digits: number, locale: Locale): string {
	return safely(
		() =>
			new Intl.NumberFormat(locale, {
				minimumFractionDigits: digits,
				maximumFractionDigits: digits,
			}).format(value),
		() => value.toFixed(digits),
	);
}
