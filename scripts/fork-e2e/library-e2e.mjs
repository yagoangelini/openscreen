// End-to-end pass of the recordings library through an ISOLATED instance, over CDP.
//
//   node scripts/fork-e2e/library-e2e.mjs --port 9271 --recordings <folder> --profile <dir> --out <dir>
//
// Start the instance first, with a fresh profile (never the user's app) whose
// recording-settings.json points `recordingsFolder` at <folder>:
//   node_modules/electron/dist/electron.exe . --recorder --user-data-dir=<dir> --remote-debugging-port=9271
//
// What it does, with a screenshot of each step in --out:
//   1. records take A (5 s), names it in the dialog the editor opens with, checks its folder;
//   2. renames A from the Media tab while the open project uses it, checks folder and project;
//   3. records take B, keeps the default name (Esc), opens A again from the library;
//   4. deletes B from the library (confirm dialog) while A is open;
//   5. reloads the editor: it restores B's project, whose take is gone -> missing-media panel;
//      "Remove from the project" clears it;
//   6. opens A, moves its folder away behind the app's back -> the panel shows up live;
//      moves it back -> the preview returns;
//   7. deletes A from the library while its project is open (the preview lets go first).
// Both takes end in the Recycle Bin (that is what delete does); they are a few MB each.
// Everything here is injected input into the instance's own windows, never OS input.
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { chromium } from "@playwright/test";

const args = process.argv.slice(2);
const option = (name, fallback) => {
	const at = args.indexOf(`--${name}`);
	return at >= 0 && args[at + 1] ? args[at + 1] : fallback;
};
const port = option("port", "9271");
const recordings = option("recordings", null);
const profile = option("profile", null);
const out = option("out", ".");
// The take's clock starts once its file exists (a busy machine can take several seconds
// to open the encoder), not at the click.
const startedCount = () =>
	fs
		.readdirSync(recordings, { withFileTypes: true })
		.filter((entry) => entry.isDirectory())
		.flatMap((entry) => fs.readdirSync(path.join(recordings, entry.name)))
		.filter((name) => /^recording-\d+\.mp4$/.test(name)).length;
if (!recordings || !profile) throw new Error("--recordings and --profile are required");
fs.mkdirSync(out, { recursive: true });

const wait = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
const log = (...parts) => console.log(new Date().toISOString().slice(11, 23), ...parts);
const browser = await chromium.connectOverCDP(`http://127.0.0.1:${port}`);
const pages = () => browser.contexts().flatMap((context) => context.pages());
// Another instance on the same port would be driven instead of ours: refuse unless every
// window is served from this checkout.
const checkout = path.basename(
	path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", ".."),
);
const foreign = pages().filter(
	(p) => !decodeURIComponent(p.url()).toLowerCase().includes(`/${checkout.toLowerCase()}/`),
);
if (pages().length === 0 || foreign.length > 0) {
	console.error(
		"refusing: the instance on this port is not this checkout's",
		foreign.map((p) => p.url()),
	);
	process.exit(2);
}
const find = async (part, tries = 80) => {
	for (let i = 0; i < tries; i++) {
		const page = pages().find((p) => p.url().includes(part) && !p.isClosed());
		if (page) return page;
		await wait(250);
	}
	return null;
};
const shot = async (page, name) => {
	await page.screenshot({ path: path.join(out, `${name}.png`) });
	log("screenshot", name);
};
const until = async (what, check, timeoutMs = 30_000) => {
	const end = Date.now() + timeoutMs;
	for (;;) {
		const value = await check();
		if (value) return value;
		if (Date.now() > end) throw new Error(`timed out: ${what}`);
		await wait(250);
	}
};
const listRoot = () => fs.readdirSync(recordings);
const projectFiles = () =>
	fs
		.readdirSync(path.join(profile, "projects"))
		.filter((name) => name.endsWith(".openscreen"))
		.map((name) => JSON.parse(fs.readFileSync(path.join(profile, "projects", name), "utf8")));
const results = [];
const check = (name, ok, detail = "") => {
	results.push({ name, ok, detail });
	log(ok ? "PASS" : "FAIL", name, detail);
};

async function recordTake(seconds) {
	const editor = pages().find((p) => p.url().includes("windowType=editor"));
	if (editor) {
		await editor.evaluate(() => window.electronAPI.switchToHud()).catch(() => undefined);
		await wait(2500);
	}
	const hud = await find("hud-overlay");
	if (!hud) throw new Error("no HUD");
	await hud.evaluate(async () => {
		const sources = await window.electronAPI.getSources({
			types: ["screen"],
			thumbnailSize: { width: 1, height: 1 },
		});
		if (sources[0]) await window.electronAPI.selectSource(sources[0]);
	});
	await wait(800);
	const before = startedCount();
	await hud.evaluate(() => document.querySelector("[data-testid=launch-record-button]")?.click());
	await until("the take's file", () => startedCount() > before, 30_000);
	await wait(1000);
	log("recording", seconds, "s");
	await wait(seconds * 1000);
	await hud.evaluate(() => document.querySelector("[data-testid=launch-record-button]")?.click());
	const next = await find("windowType=editor", 240);
	if (!next) throw new Error("no editor after the take");
	await next.waitForSelector("[data-testid=take-name-dialog]", { timeout: 60_000 });
	return next;
}

// The transcript auto-zoom question comes after the name (and after the import): answered
// "only the cursor", so no transcription model is downloaded.
async function answerAutoZoom(page, shotName) {
	const no = await page
		.waitForSelector("[data-testid=transcript-autozoom-no]", { timeout: 20_000 })
		.catch(() => null);
	if (shotName && no) await shot(page, shotName);
	await no?.click();
	return Boolean(no);
}

const mode = (page, label) =>
	page.evaluate((re) => {
		const tab = [...document.querySelectorAll("[role=tab]")].find((el) =>
			new RegExp(re).test(el.textContent ?? ""),
		);
		tab?.click();
		return Boolean(tab);
	}, label);
const MEDIA = "Mídia|Media";
const EDIT = "Editar|Edit";
const card = (page, name) =>
	page.locator("[data-testid=library-card]", {
		has: page.locator("[data-testid=library-card-name]", { hasText: name }),
	});

// 1. Take A, named in the dialog.
let editor = await recordTake(5);
await shot(editor, "01-take-name-dialog");
await editor.fill("[data-testid=take-name-input]", "Aula E2E: Teams");
await editor.keyboard.press("Enter");
await editor.waitForSelector("[data-testid=preview]", { timeout: 60_000 });
check(
	"the auto-zoom question comes after the name, not over it",
	await answerAutoZoom(editor, "02-autozoom-after-name"),
);
await wait(1000);
await shot(editor, "02b-editor-after-naming");
const folderA = await until("folder A", () => listRoot().find((n) => n === "Aula E2E- Teams"));
const filesA = fs.readdirSync(path.join(recordings, folderA));
check(
	"take A lands in its own named folder",
	filesA.some((f) => /^recording-\d+\.mp4$/.test(f)) &&
		!listRoot().some((n) => /^recording-/.test(n)),
	`${folderA}: ${filesA.join(", ")}`,
);
const projectA = await until("project A", () =>
	projectFiles().find((doc) => doc.project.title === "Aula E2E- Teams"),
);
check(
	"project A points into the named folder",
	projectA.assets[0]?.originalPath.includes(`${path.sep}Aula E2E- Teams${path.sep}`),
	projectA.assets[0]?.originalPath,
);

// 2. Rename A from the Media tab, while the open project uses it.
await mode(editor, MEDIA);
await editor.waitForSelector("[data-testid=library-card]", { timeout: 20_000 });
await wait(2500);
await shot(editor, "03-media-tab-library");
await card(editor, "Aula E2E- Teams").locator("[data-testid=library-rename]").click();
await editor.fill("[data-testid=library-rename-input]", "Aula renomeada");
await editor.keyboard.press("Enter");
await until("renamed folder", () => listRoot().includes("Aula renomeada"), 20_000);
await card(editor, "Aula renomeada").waitFor({ timeout: 20_000 });
await wait(800);
await shot(editor, "04-renamed-in-library");
const afterRename = projectFiles().find((doc) => doc.project.id === projectA.project.id);
check(
	"rename moves the folder and the project follows",
	!listRoot().includes("Aula E2E- Teams") &&
		afterRename.assets[0].originalPath.includes(`${path.sep}Aula renomeada${path.sep}`) &&
		fs.existsSync(afterRename.assets[0].originalPath),
	afterRename.assets[0].originalPath,
);
const session = fs
	.readdirSync(path.join(recordings, "Aula renomeada"))
	.find((f) => f.endsWith(".session.json"));
if (session) {
	const manifest = JSON.parse(
		fs.readFileSync(path.join(recordings, "Aula renomeada", session), "utf8"),
	);
	check(
		"session manifest follows the rename",
		manifest.screenVideoPath.includes(`${path.sep}Aula renomeada${path.sep}`),
		manifest.screenVideoPath,
	);
}
await mode(editor, EDIT);
await editor.waitForSelector("[data-testid=preview]", { timeout: 20_000 });
check(
	"no missing-media panel after the rename",
	(await editor.locator("[data-testid=missing-media-panel]").count()) === 0,
);

// Reopen: the Studio restores the last project on load.
await editor.reload();
await editor.waitForSelector("[data-testid=preview]", { timeout: 60_000 });
await wait(2500);
await shot(editor, "05-reopened-after-rename");
check(
	"reopened project shows its preview, not the missing panel",
	(await editor.locator("[data-testid=missing-media-panel]").count()) === 0,
);

// 3. Take B, default name kept with Esc.
editor = await recordTake(5);
await editor.keyboard.press("Escape");
await editor.waitForSelector("[data-testid=preview]", { timeout: 60_000 });
await answerAutoZoom(editor);
const folderB = await until("folder B", () =>
	listRoot().find((n) => n !== "Aula renomeada" && !/^recording-/.test(n)),
);
check("Esc keeps the default (date and time) name", /\d/.test(folderB), folderB);
await mode(editor, MEDIA);
await card(editor, "Aula renomeada").locator("[data-testid=library-open]").click();
await editor.waitForSelector("[data-testid=preview]", { timeout: 30_000 });
check("library Open loads the project that uses the take", true);

// 4. Delete B from the library while A is open.
await mode(editor, MEDIA);
await card(editor, folderB).locator("[data-testid=library-delete]").click();
await editor.waitForSelector("[data-testid=library-delete-dialog]");
await shot(editor, "06-delete-confirm");
await editor.click("[data-testid=library-delete-confirm]");
await until("B gone", () => !listRoot().includes(folderB), 20_000);
check("delete sends B's whole folder away", !listRoot().includes(folderB), listRoot().join(", "));

// 5. Reload: the most recent project is B's, whose take is gone.
await editor.reload();
const panel = await editor
	.waitForSelector("[data-testid=missing-media-panel]", { timeout: 30_000 })
	.catch(() => null);
await wait(800);
await shot(editor, "07-missing-media-on-restore");
check(
	"restoring a project whose take was deleted shows the panel, not a timeline",
	Boolean(panel) && (await editor.locator("[data-testid=preview]").count()) === 0,
);
await editor.click("[data-testid=missing-media-remove]");
await until(
	"panel gone",
	async () => (await editor.locator("[data-testid=missing-media-panel]").count()) === 0,
);
await shot(editor, "08-after-remove-from-project");
check("Remove from the project clears the panel", true);

// 6. A's folder moved away behind the app's back while its project is open.
await mode(editor, MEDIA);
await card(editor, "Aula renomeada").locator("[data-testid=library-open]").click();
await editor.waitForSelector("[data-testid=preview]", { timeout: 30_000 });
await wait(2000);
const aside = path.join(path.dirname(recordings), "moved-away");
let moved = false;
for (let i = 0; i < 40 && !moved; i++) {
	try {
		fs.renameSync(path.join(recordings, "Aula renomeada"), aside);
		moved = true;
	} catch {
		await wait(250);
	}
}
// Not a pass/fail: Windows refuses to move a folder whose video the preview has open, so a
// take can only vanish under an open project when nothing holds it (a network drive, a
// camera file not on screen). Logged either way.
log("external move while the preview is open:", moved ? "done" : "refused by Windows (expected)");
if (moved) {
	await editor.evaluate(() => window.dispatchEvent(new Event("focus")));
	const live = await editor
		.waitForSelector("[data-testid=missing-media-panel]", { timeout: 15_000 })
		.catch(() => null);
	await shot(editor, "09-missing-media-live");
	check("a take deleted while its project is open shows the panel", Boolean(live));
	fs.renameSync(aside, path.join(recordings, "Aula renomeada"));
	await editor.evaluate(() => window.dispatchEvent(new Event("focus")));
	await editor.waitForSelector("[data-testid=preview]", { timeout: 20_000 });
	check("the preview returns when the take is back", true);
}

// 7. Delete A while its project is open.
await mode(editor, MEDIA);
await card(editor, "Aula renomeada").locator("[data-testid=library-delete]").click();
await editor.waitForSelector("[data-testid=library-delete-dialog]");
await shot(editor, "10-delete-used-here-confirm");
await editor.click("[data-testid=library-delete-confirm]");
await until("A gone", () => !listRoot().includes("Aula renomeada"), 30_000);
await wait(1500);
await shot(editor, "11-library-empty");
const projectAfter = projectFiles().find((doc) => doc.project.id === projectA.project.id);
check(
	"deleting the open project's take removes it from the project",
	projectAfter.assets.length === 0,
	`${projectAfter.assets.length} assets`,
);

fs.writeFileSync(path.join(out, "results.json"), JSON.stringify(results, null, 2));
log(`${results.filter((r) => r.ok).length}/${results.length} passed`);
process.exit(results.every((r) => r.ok) ? 0 : 1);
