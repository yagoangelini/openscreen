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
//
// --scenario media-tab runs the Media tab pass instead (mediaTabFlow below): one named take,
// Edit -> Media with no editor timeline and one card, details, drag to the drop strip, and a
// delete of the open project's take while another process holds it (probes/hold.ps1): no
// Windows prompt, an "in use" error, then the Recycle Bin once it lets go. The take ends in
// the Recycle Bin. probes/*.ps1 read the instance from outside (Restart Manager, its dialogs,
// the Recycle Bin) and never send it input.
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
	page.locator("[data-testid=media-card]", {
		has: page.locator("[data-testid=media-card-name]", { hasText: name }),
	});

const finish = () => {
	fs.writeFileSync(path.join(out, "results.json"), JSON.stringify(results, null, 2));
	log(`${results.filter((r) => r.ok).length}/${results.length} passed`);
	process.exit(results.every((r) => r.ok) ? 0 : 1);
};

// PowerShell probes of the instance (scripts/fork-e2e/probes): which processes hold a take's
// files (Restart Manager), which file-operation dialogs the instance shows, and what the
// Recycle Bin holds. Read-only, except `dialogs -Close`, which posts WM_CLOSE to a dialog of
// the instance's own processes so a failing run never leaves one on screen.
const probesDir = path.join(path.dirname(fileURLToPath(import.meta.url)), "probes");
const powershell = async (script, ...params) => {
	const { execFile } = await import("node:child_process");
	return new Promise((resolve) =>
		execFile(
			"powershell.exe",
			[
				"-NoProfile",
				"-ExecutionPolicy",
				"Bypass",
				"-File",
				path.join(probesDir, script),
				...params,
			],
			{ windowsHide: true, timeout: 60_000 },
			(error, stdout, stderr) => resolve(`${stdout}${error ? `\n${stderr}` : ""}`.trim()),
		),
	);
};

/**
 * The Media tab with the open project's own take (the user's report of 13/10): record and
 * name a take, go Edit -> Media, check the tab shows no editor timeline and one card for
 * the take, then delete it from there -- it must land in the Recycle Bin, with no Windows
 * prompt on the way.
 */
async function mediaTabFlow() {
	const name = "Aula Mídia E2E";
	const page = await recordTake(Number(option("seconds", "6")));
	await page.fill("[data-testid=take-name-input]", name);
	await page.keyboard.press("Enter");
	await page.waitForSelector("[data-testid=preview]", { timeout: 60_000 });
	await answerAutoZoom(page);
	const folder = await until("the named folder", () => listRoot().find((n) => n === name));
	const takeFolder = path.join(recordings, folder);
	// Long enough for what a fresh take starts in the background (peaks, activity, OCR).
	await wait(4000);
	await mode(page, EDIT);
	await page.waitForSelector("[data-testid=preview]", { timeout: 20_000 });
	await wait(1500);
	log("holders in Edit:\n", await powershell("holders.ps1", takeFolder));
	// `--stop-at edit` leaves the take open in Edit, for poking at it by hand (diagnosis).
	if (option("stop-at", "") === "edit") return;

	await mode(page, MEDIA);
	await page.waitForSelector("[data-testid=media-card]", {
		timeout: 20_000,
	});
	await wait(2500);
	await shot(page, "media-01-media-tab");
	check(
		"the Media tab shows no editor timeline",
		(await page.locator("[data-testid=editor-timeline]").count()) === 0 &&
			(await page.getByText(/Organizar clipes|Arrange clips/).count()) === 0,
	);
	const cards = page.locator("[data-testid=media-card]");
	const names = await page.locator("[data-testid=media-card-name]").allInnerTexts();
	check(
		"one card for the take, under its name",
		(await cards.count()) === 1 && names[0] === name && names.join(" | "),
	);
	check(
		"the card shows the take's real thumbnail",
		(await cards.first().locator("img").count()) === 1,
	);
	log("holders in Media:\n", await powershell("holders.ps1", takeFolder));

	if ((await cards.count()) > 0) {
		await cards.first().click();
		const detail = await page
			.waitForSelector("[data-testid=media-detail]", { timeout: 10_000 })
			.catch(() => null);
		await shot(page, "media-02-detail");
		check("a click on the card opens its details", Boolean(detail));

		// Drag to the timeline without a timeline on screen: the drop strip shows while the
		// card is dragged (Chromium's HTML5 drag, driven by CDP mouse events in the page).
		const clipsBefore = projectFiles().find((doc) => doc.project.title === name)?.timeline?.clips
			?.length;
		const source = await cards.first().locator("button").first().boundingBox();
		await page.mouse.move(source.x + source.width / 2, source.y + 40);
		await page.mouse.down();
		await page.mouse.move(source.x + source.width / 2 + 30, source.y + 80, { steps: 5 });
		const zone = await page
			.waitForSelector("[data-testid=media-drop-zone]", { timeout: 5_000 })
			.catch(() => null);
		if (zone) {
			const box = await zone.boundingBox();
			await page.mouse.move(box.x + box.width / 2, box.y + box.height / 2, { steps: 8 });
			await shot(page, "media-02b-drop-strip");
		}
		await page.mouse.up();
		const clipsAfter = await until(
			"the dropped clip saved",
			() =>
				projectFiles().find((doc) => doc.project.title === name)?.timeline?.clips?.length >
					(clipsBefore ?? 0) && projectFiles().find((doc) => doc.project.title === name),
			10_000,
		)
			.then((doc) => doc.timeline.clips.length)
			.catch(() => clipsBefore);
		check(
			"a card dragged to the drop strip lands on the timeline",
			Boolean(zone) && clipsAfter > (clipsBefore ?? 0),
			`${clipsBefore} -> ${clipsAfter} clips`,
		);
		await wait(1000);
		check(
			"the drop strip goes away after the drop",
			(await page.locator("[data-testid=media-drop-zone]").count()) === 0,
		);
	}

	const screenFile = fs.readdirSync(takeFolder).find((file) => /^recording-\d+\.mp4$/.test(file));

	// 1. Another program keeps the take open for longer than the library waits: the bin is
	//    never asked (so no prompt), the folder stays, and the user is told why.
	const longHold = await holdFile(path.join(takeFolder, screenFile), 14);
	const blocked = await deleteFromMedia(page, takeFolder, "media-03-delete-confirm");
	check(
		"held by another program: no Windows prompt",
		blocked.dialogs.length === 0,
		blocked.dialogs.join(" / "),
	);
	check("held by another program: the folder stays", listRoot().includes(folder));
	const inUseToast = await page
		.getByText(/ainda está com esta gravação aberta|still has this recording open/)
		.first()
		.waitFor({ timeout: 10_000 })
		.then(() => true)
		.catch(() => false);
	await shot(page, "media-04-in-use-error");
	check("held by another program: a clear error says so", inUseToast);
	await longHold.done;

	// 2. A program that lets go within a moment (an indexer, a scan): the library waits it out.
	const shortHold = await holdFile(path.join(takeFolder, screenFile), 1.5);
	const removed = await deleteFromMedia(page, takeFolder);
	await shortHold.done;
	check(
		"no Windows prompt during the delete",
		removed.dialogs.length === 0,
		removed.dialogs.join(" / "),
	);
	check("the take's folder left the recordings folder", removed.gone);
	const bin = await powershell("recycle-bin.ps1", recordings);
	check(
		"the take's folder is in the Recycle Bin",
		bin.split(/\r?\n/).some((line) => line.trim() === folder),
		bin,
	);
	await wait(1500);
	await shot(page, "media-05-after-delete");
	const project = projectFiles().find((doc) => doc.project.title === name);
	check("the asset left the project", project?.assets.length === 0, `${project?.assets.length}`);
	check(
		"the Media tab is empty after the delete",
		(await page.locator("[data-testid=media-card]").count()) === 0,
	);
}

/** Holds `file` open from another process (hold.ps1) until `seconds` pass. */
async function holdFile(file, seconds) {
	const { spawn } = await import("node:child_process");
	const child = spawn(
		"powershell.exe",
		[
			"-NoProfile",
			"-ExecutionPolicy",
			"Bypass",
			"-File",
			path.join(probesDir, "hold.ps1"),
			"-File",
			file,
			"-Seconds",
			String(seconds),
		],
		{ windowsHide: true, stdio: ["ignore", "pipe", "pipe"] },
	);
	const done = new Promise((resolve) => child.once("close", resolve));
	await new Promise((resolve) => {
		child.stdout.on("data", (chunk) => {
			if (String(chunk).includes("holding")) resolve();
		});
		child.once("close", resolve);
	});
	log(`holding ${path.basename(file)} for ${seconds} s`);
	return { done };
}

/**
 * Deletes the Media tab's only card through its confirm dialog, watching for a Windows
 * prompt of the instance all along (closed at once if one shows). Resolves once the folder
 * is gone or the library answered (its card is no longer being worked on).
 */
async function deleteFromMedia(page, takeFolder, shotName) {
	const card = page.locator("[data-testid=media-card]").first();
	await card.locator("[data-testid=library-delete]").click();
	await page.waitForSelector("[data-testid=library-delete-dialog]");
	if (shotName) await shot(page, shotName);
	await page.click("[data-testid=library-delete-confirm]");
	const dialogs = [];
	const started = Date.now();
	let gone = false;
	await until(
		"the delete answered",
		async () => {
			const open = await powershell("dialogs.ps1", profile, "-Close");
			if (!/^no dialogs/.test(open)) {
				dialogs.push(open);
				log("dialog:", open, "\nholders:\n", await powershell("holders.ps1", takeFolder));
			}
			gone = !fs.existsSync(takeFolder);
			if (gone) return true;
			// The card's delete button is enabled again once the library answered.
			const busy = await card
				.locator("[data-testid=library-delete]")
				.isDisabled()
				.catch(() => false);
			return Date.now() - started > 1500 && !busy;
		},
		40_000,
	).catch((error) => log(String(error)));
	log(`delete answered after ${Date.now() - started} ms; folder ${gone ? "gone" : "still there"}`);
	return { dialogs, gone };
}

if (option("scenario", "library") === "media-tab") {
	await mediaTabFlow();
	finish();
}

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
await editor.waitForSelector("[data-testid=media-card]", { timeout: 20_000 });
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
