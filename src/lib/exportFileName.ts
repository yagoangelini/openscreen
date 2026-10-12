// The file name the export's save dialog suggests, from the project's title.
//
// It used to keep only [a-z0-9-_], so "Gravação 11/10/2026, 23:27:06" became
// "Grava_o_11_10_2026_23_27_06.mp4" (E2E 2.4.0, D-6). Only what Windows refuses in a
// file name is replaced now: accents, spaces and commas stay.

const MAX_LENGTH = 60;

// < > : " / \ | ? * and the control characters, invalid in a Windows file name.
// biome-ignore lint/suspicious/noControlCharactersInRegex: control characters are the point
const INVALID_CHARACTERS = /[<>:"/\\|?*\u0000-\u001f]+/g;

// CON, PRN, AUX, NUL, COM1-9 and LPT1-9 name devices, extension or not.
const RESERVED_NAME = /^(con|prn|aux|nul|com[1-9]|lpt[1-9])$/i;

export function exportBaseName(title: string | undefined, fallback = "export"): string {
	const cleaned = (title ?? "")
		.normalize("NFC")
		.replace(/\s+/g, " ")
		.replace(INVALID_CHARACTERS, "-")
		.trim();
	// Cut by code point, never through a surrogate pair, then drop what Windows strips
	// from the end of a name anyway (dots and spaces).
	const name = Array.from(cleaned)
		.slice(0, MAX_LENGTH)
		.join("")
		.replace(/[. -]+$/, "")
		.replace(/^[. -]+/, "");
	if (!name || RESERVED_NAME.test(name)) return fallback;
	return name;
}
