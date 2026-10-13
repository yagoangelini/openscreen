// E2E of the global defaults ("Padrões") in an ISOLATED instance, driven over CDP only (no OS
// mouse or keyboard input, nothing recorded from the screen):
//
//   node scripts/fork-e2e/defaults-flow.mjs --video <short.mp4> --out <folder> [--port 9261]
//
// It starts its own Electron with a fresh profile and a recordings folder inside --out, so the
// user's %APPDATA%\Openscreen and Videos\OpenScreen are never touched, and stops that instance
// (filtered by name AND by its profile path) when it ends. --video must sit inside the
// recordings folder it creates (<out>/rec), or it is copied there.
//
// The flow: set a default glossary line and a default cursor size in Padrões, open the video as
// a new project, check both reached it, then override the transcription language in the Media
// panel, reset it, override it again and save it as the default. Screenshots go to --out.
import { execFileSync, spawn } from "node:child_process";
import {
	copyFileSync,
	existsSync,
	mkdirSync,
	readdirSync,
	readFileSync,
	writeFileSync,
} from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { chromium } from "@playwright/test";

const args = process.argv.slice(2);
const option = (name, fallback) => {
	const at = args.indexOf(`--${name}`);
	return at >= 0 && args[at + 1] ? args[at + 1] : fallback;
};
const out = path.resolve(option("out", "."));
const port = option("port", "9261");
const repo = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../..");
const profile = path.join(out, `profile-${Date.now()}`);
const recordings = path.join(out, "rec");
mkdirSync(profile, { recursive: true });
mkdirSync(recordings, { recursive: true });
let video = path.resolve(option("video", ""));
if (!existsSync(video)) throw new Error(`--video not found: ${video}`);
if (path.dirname(video) !== recordings) {
	const copy = path.join(recordings, path.basename(video));
	copyFileSync(video, copy);
	video = copy;
}
writeFileSync(
	path.join(profile, "recording-settings.json"),
	JSON.stringify({ countdownSeconds: 0, recordingsFolder: recordings }),
);

const wait = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
const log = (...parts) => console.log("[defaults-e2e]", ...parts);
const results = [];
const check = (name, ok, detail = "") => {
	results.push({ name, ok, detail });
	log(ok ? "PASS" : "FAIL", name, detail);
};

const electron = path.join(repo, "node_modules", "electron", "dist", "electron.exe");
const child = spawn(
	electron,
	[".", "--studio", `--user-data-dir=${profile}`, `--remote-debugging-port=${port}`],
	{ cwd: repo, stdio: "ignore", detached: false },
);

function stopInstance() {
	// Only processes of THIS profile, by name and command line.
	const script = `Get-CimInstance Win32_Process -Filter "Name='electron.exe'" | Where-Object { $_.CommandLine -like '*${profile.replace(/'/g, "''")}*' } | ForEach-Object { Stop-Process -Id $_.ProcessId -ErrorAction SilentlyContinue }`;
	try {
		execFileSync("powershell", ["-NoProfile", "-Command", script], { stdio: "ignore" });
	} catch {
		// Nothing left to stop.
	}
}

function projectFiles() {
	const dir = path.join(profile, "projects");
	if (!existsSync(dir)) return [];
	return readdirSync(dir)
		.filter((name) => name.endsWith(".openscreen"))
		.map((name) => JSON.parse(readFileSync(path.join(dir, name), "utf8")));
}

let browser;
try {
	for (let i = 0; i < 60 && !browser; i++) {
		browser = await chromium.connectOverCDP(`http://127.0.0.1:${port}`).catch(() => undefined);
		if (!browser) await wait(500);
	}
	if (!browser) throw new Error("the instance never opened its debugging port");
	let page;
	for (let i = 0; i < 80 && !page; i++) {
		page = browser
			.contexts()
			.flatMap((c) => c.pages())
			.find((p) => p.url().includes("windowType=editor"));
		if (!page) await wait(250);
	}
	if (!page) throw new Error("no editor window");
	await page.waitForLoadState("domcontentloaded");
	// Answer "only the cursor" after a take, so no transcript question opens over the editor.
	await page.evaluate(() => {
		const key = "openscreen_user_preferences";
		const prefs = JSON.parse(localStorage.getItem(key) || "{}");
		localStorage.setItem(key, JSON.stringify({ ...prefs, autoZoomAfterRecording: "cursor" }));
	});
	await page.reload();
	await page.waitForSelector("button[aria-label='OpenScreen']", { timeout: 30_000 });
	await wait(1500);
	const shot = (name) => page.screenshot({ path: path.join(out, `${name}.png`) });

	// 1. Padrões: a default glossary line and a default cursor size.
	await page.click("button[aria-label='OpenScreen']");
	await page.click("[data-testid='app-menu-defaults']");
	await page.waitForSelector("[data-testid='defaults-dialog']");
	const glossary = page.locator("[data-testid='defaults-glossary']");
	const seeded = await glossary.inputValue();
	check(
		"glossary seeded with the built-in list",
		seeded.includes("SharePoint:") && seeded.includes("Copilot Studio:"),
	);
	await glossary.fill(`${seeded}\nContoso: contozo, kontoso`);
	await glossary.blur();
	await shot("01-defaults-glossary");
	await page.click("[data-testid='defaults-tab-look']");
	const size = page.getByRole("slider", { name: "Tamanho" }).first();
	await size.focus();
	for (let i = 0; i < 4; i++) await size.press("ArrowRight");
	await wait(300);
	const stored = await page.evaluate(() =>
		JSON.parse(localStorage.getItem("openscreen_editor_defaults") || "null"),
	);
	check(
		"cursor size saved as a default",
		typeof stored?.cursorSize === "number" && stored.cursorSize > 2.2,
		JSON.stringify(stored?.cursorSize),
	);
	await shot("02-defaults-look-cursor");
	await page.keyboard.press("Escape");
	await wait(400);

	// 2. A new project from the test video, the way a finished take arrives.
	const before = projectFiles().length;
	await page.evaluate(
		(screenVideoPath) =>
			window.electronAPI.setCurrentRecordingSession({
				screenVideoPath,
				cursorCaptureMode: "system",
			}),
		video,
	);
	await page.reload();
	await page.waitForSelector("button[aria-label='OpenScreen']", { timeout: 30_000 });
	let created;
	for (let i = 0; i < 60 && !created; i++) {
		const files = projectFiles();
		created =
			files.length > before
				? files.find((d) => d.assets?.some((a) => a.originalPath === video))
				: undefined;
		if (!created) await wait(500);
	}
	check("a new project was created from the video", Boolean(created));
	check(
		"the new project copied the default cursor size",
		created?.legacyEditor?.cursorSize === stored?.cursorSize,
		`${created?.legacyEditor?.cursorSize} vs ${stored?.cursorSize}`,
	);
	await wait(2000);
	await shot("03-new-project-editor");

	// 3. The Media panel: the merged glossary, then override / reset / save as default.
	await page.getByRole("tab").first().click();
	await page
		.locator("button", { hasText: path.basename(video) })
		.first()
		.click();
	await page.waitForSelector("[data-testid='project-transcription-settings']");
	await page.locator("summary", { hasText: "Glossário" }).click();
	await page.locator("[data-testid='default-list-preview'] summary").last().click();
	const preview = await page.locator("[data-testid='default-list-preview'] pre").last().innerText();
	check("the project's glossary holds the default line", preview.includes("Contoso: contozo"));
	const languageBadge = () =>
		page
			.locator("[data-testid='project-setting-language'] [data-testid='setting-source']")
			.getAttribute("data-source");
	check("language follows the default", (await languageBadge()) === "default");
	await shot("04-media-defaults");

	await page.selectOption("[data-testid='media-stage-language']", "en");
	await wait(800);
	const overridden = projectFiles().find((d) => d.project.id === created?.project.id);
	check(
		"language override stored on the project",
		overridden?.legacyEditor?.projectOverrides?.transcriptionLanguage === "en",
	);
	check("badge says this project", (await languageBadge()) === "project");
	await shot("05-media-override");

	await page.click("[data-testid='project-setting-language-reset']");
	await wait(800);
	const reset = projectFiles().find((d) => d.project.id === created?.project.id);
	check("reset removes the override", reset?.legacyEditor?.projectOverrides === undefined);
	check("badge back to default", (await languageBadge()) === "default");
	await shot("06-media-reset");

	await page.selectOption("[data-testid='media-stage-language']", "en");
	await wait(800);
	await page.click("[data-testid='project-setting-language-promote']");
	await wait(800);
	const prefs = await page.evaluate(() =>
		JSON.parse(localStorage.getItem("openscreen_user_preferences") || "{}"),
	);
	const promoted = projectFiles().find((d) => d.project.id === created?.project.id);
	check("save as default writes the preference", prefs.transcriptionLanguage === "en");
	check(
		"and the project follows the default again",
		promoted?.legacyEditor?.projectOverrides === undefined,
	);
	check("badge back to default after saving", (await languageBadge()) === "default");
	await shot("07-media-saved-as-default");
} catch (error) {
	check("flow ran to the end", false, error instanceof Error ? error.message : String(error));
} finally {
	writeFileSync(
		path.join(out, "results.json"),
		`${JSON.stringify({ profile, results }, null, 2)}\n`,
	);
	stopInstance();
	child.kill();
	const failed = results.filter((r) => !r.ok).length;
	log(`${results.length - failed}/${results.length} passed; profile ${profile}`);
	process.exit(failed === 0 ? 0 : 1);
}
