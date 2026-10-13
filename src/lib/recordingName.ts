// The name a user gives a recording becomes the name of its folder in the recordings
// folder, so it has to be a name Windows accepts. Pure, so the main process (which
// renames the folder) and the name dialog (which shows what will be used) agree.
//
// Like `exportBaseName`, only what Windows refuses is replaced: accents, spaces and
// commas stay, so "Aula 3: Copilot no Teams" becomes "Aula 3- Copilot no Teams".

/** Long enough for a real title, short enough to keep paths under MAX_PATH. */
export const RECORDING_NAME_MAX_LENGTH = 80;

// < > : " / \ | ? * and the control characters, invalid in a Windows file name.
// biome-ignore lint/suspicious/noControlCharactersInRegex: control characters are the point
const INVALID_CHARACTERS = /[<>:"/\\|?*\u0000-\u001f]+/g;

// CON, PRN, AUX, NUL, COM1-9 and LPT1-9 name devices, with or without an extension
// ("con.aula" is just as reserved as "con"), and so do the superscript-digit forms.
const RESERVED_NAME = /^(con|prn|aux|nul|com[1-9¹²³]|lpt[1-9¹²³])$/i;

/**
 * The folder name for `input`, or null when nothing usable is left (empty, only dots,
 * a reserved device name).
 */
export function sanitizeRecordingName(input: string | null | undefined): string | null {
	const cleaned = (input ?? "")
		.normalize("NFC")
		.replace(/\s+/g, " ")
		.replace(INVALID_CHARACTERS, "-")
		.trim();
	// Cut by code point, never through a surrogate pair, then drop what Windows strips
	// from the end of a name anyway (dots and spaces), and leading dots (hidden on the
	// other platforms, and ".." must never survive).
	const name = Array.from(cleaned)
		.slice(0, RECORDING_NAME_MAX_LENGTH)
		.join("")
		.replace(/[. ]+$/, "")
		.replace(/^[. ]+/, "");
	if (!name) return null;
	const device = name.split(".")[0]?.trim() ?? "";
	if (RESERVED_NAME.test(device)) return null;
	return name;
}

/**
 * `desired`, or `desired (2)`, `desired (3)`... -- the first one not in `taken`. Windows
 * compares names without case, so `taken` is matched that way everywhere. `self` is the
 * name being renamed: it never collides with itself, so "aula" can become "Aula".
 */
export function uniqueRecordingName(
	desired: string,
	taken: Iterable<string>,
	self?: string | null,
): string {
	const fold = (name: string) => name.normalize("NFC").toLowerCase();
	const selfFolded = self ? fold(self) : null;
	const used = new Set<string>();
	for (const name of taken) {
		const folded = fold(name);
		if (folded !== selfFolded) used.add(folded);
	}
	if (!used.has(fold(desired))) return desired;
	for (let n = 2; ; n++) {
		const suffix = ` (${n})`;
		const base = Array.from(desired)
			.slice(0, RECORDING_NAME_MAX_LENGTH - suffix.length)
			.join("")
			.replace(/[. ]+$/, "");
		const candidate = `${base}${suffix}`;
		if (!used.has(fold(candidate))) return candidate;
	}
}
