// Chromium names displays in English whatever the UI language ("Screen 1", "Entire Screen").
// The name stays as it is everywhere it identifies a source (the remembered pick, the main
// process); only what the UI shows is put in the user's language. Window titles pass through.

type Translate = (key: string, vars?: Record<string, string | number>) => string;

const NUMBERED_SCREEN = /^Screen (\d+)$/;

/** `t` is scoped to the `common` namespace, which the main process reads too. */
export function sourceDisplayName(name: string, t: Translate): string {
	const numbered = NUMBERED_SCREEN.exec(name);
	if (numbered) return t("recordingSource.screenNumber", { number: numbered[1] });
	if (name === "Entire Screen") return t("recordingSource.entireScreen");
	// The main process's own fallback name when nothing was picked.
	if (name === "Screen") return t("recordingSource.screen");
	return name;
}
