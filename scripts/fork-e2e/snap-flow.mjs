// E2E of the timeline magnet (edges snap to the playhead) in an ISOLATED instance, driven over
// CDP only — pointer and key events go through the DevTools protocol, never the OS:
//
//   node scripts/fork-e2e/snap-flow.mjs --video <short.mp4> --out <folder> [--port 9287]
//
// It starts its own Electron with a fresh profile and a recordings folder inside --out (the
// user's %APPDATA%\Openscreen and Videos\OpenScreen are never touched) and stops that instance
// — filtered by name AND by its profile path — when it ends. Run `npm run build-vite` first.
//
// The flow: the video arrives as a fresh take (`setCurrentRecordingSession`), a zoom and an
// annotation are added at 3 s, the playhead is parked elsewhere, and the zoom's end edge and the
// annotation's end edge are dragged to within a few pixels of it. Each stored edge must equal
// the playhead's ms. Then Alt held mid-drag must bypass the magnet, and one Ctrl+Z must undo one
// drag. Screenshots of each snap cue go to --out.
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
const port = option("port", "9287");
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
const log = (...parts) => console.log("[snap-e2e]", ...parts);
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
const project = () => projectFiles().find((d) => d.assets?.some((a) => a.originalPath === video));

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
		created = project();
		if (!created?.timeline?.clips?.length) created = undefined;
		if (!created) await wait(500);
	}
	check("the take became a project with a clip", Boolean(created));
	await page.waitForSelector("[data-testid='timeline-playhead']", { timeout: 30_000 });
	await wait(2500);
	const shot = (name) => page.screenshot({ path: path.join(out, `${name}.png`) });
	const totalSec = () =>
		Math.max(...(project()?.timeline?.clips ?? []).map((c) => c.timelineEndSec), 1);

	// The ruler: clicking it is a scrub (CDP pointer events, not the OS mouse).
	const ruler = page.locator("[class*='tlRulerRow']").first();
	const rulerBox = await ruler.boundingBox();
	const canvas = page.locator("[class*='tlTracks'] > [class*='tlCanvas']").first();
	const xAt = async (sec) => {
		const box = await canvas.boundingBox();
		return box.x + (sec / totalSec()) * box.width;
	};
	const playheadSec = () =>
		page
			.locator("[data-testid='timeline-playhead']")
			.evaluate((el) => Number.parseFloat(el.style.left) / 100)
			.then((fraction) => fraction * totalSec());
	const seek = async (sec) => {
		await page.mouse.click(await xAt(sec), rulerBox.y + rulerBox.height / 2);
		await wait(400);
	};

	// 1. A zoom and an annotation at 3 s, from their shortcuts.
	await seek(3);
	await page.keyboard.press("z");
	await wait(700);
	await seek(3);
	await page.keyboard.press("a");
	await wait(900);
	const zoomPill = page.locator("[class*='lanePill'][class*='laneZoom']").first();
	const annPill = page.locator("[class*='lanePill'][class*='laneAnnotation']").first();
	check("a zoom was added", (await zoomPill.count()) === 1);
	check("an annotation was added", (await annPill.count()) === 1);

	// 2. Park the playhead somewhere arbitrary — where a scrub leaves it is a float.
	await seek(11.37);
	const parked = await playheadSec();
	const parkedMs = Math.round(parked * 1000);
	log("playhead at", parked, "s");
	await shot("01-playhead-parked");

	/** Drag a pill's end handle so its EDGE (not the pointer: the grab is the handle's middle)
	 *  arrives at `edgeX`, in steps, and hold there for a screenshot before letting go. */
	const dragEnd = async (pill, edgeX, name, { altMidway = false } = {}) => {
		const handle = pill.locator("[class*='lanePillHandle']").last();
		const box = await handle.boundingBox();
		const y = box.y + box.height / 2;
		const grabX = box.x + box.width / 2;
		const toX = edgeX - (box.x + box.width - grabX);
		await page.mouse.move(grabX, y);
		await page.mouse.down();
		await page.mouse.move(toX, y, { steps: 12 });
		await wait(150);
		const lit = () =>
			page.locator("[data-testid='timeline-playhead']").getAttribute("data-snapped");
		const snappedBefore = await lit();
		const tip = await page
			.locator("[data-testid='timeline-snap-tip']")
			.textContent({ timeout: 500 })
			.catch(() => null);
		// Full-window shots only: a clipped one makes Playwright override the viewport, and the
		// relayout under a held button reaches the drag as a pointer move somewhere else.
		await shot(name);
		let snappedWithAlt = null;
		if (altMidway) {
			// Alt held mid-drag, the pointer still: the magnet lets go at once.
			await page.keyboard.down("Alt");
			await wait(150);
			snappedWithAlt = await lit();
			await shot(`${name}-alt`);
		}
		await page.mouse.up();
		if (altMidway) await page.keyboard.up("Alt");
		await wait(900);
		return { snappedBefore, snappedWithAlt, tip };
	};

	// 3. The zoom's end edge, brought to 3 px short of the playhead.
	const zoomCue = await dragEnd(zoomPill, (await xAt(parked)) - 3, "02-zoom-end-snapped");
	const zoom = project()?.zoomRanges?.[0];
	check("zoom: the playhead lit while snapped", zoomCue.snappedBefore === "true");
	check(
		"zoom: the tip named the playhead",
		/Cursor de reprodução|Playhead/.test(zoomCue.tip ?? ""),
		zoomCue.tip,
	);
	check(
		"zoom: stored end equals the playhead's ms",
		zoom?.endMs === parkedMs,
		`${zoom?.endMs} vs ${parkedMs}`,
	);
	if (zoom?.clipId) {
		const clip = project().timeline.clips.find((c) => c.id === zoom.clipId);
		const back = clip.timelineStartSec + (zoom.sourceEndSec - clip.sourceStartSec);
		check(
			"zoom: its source anchor maps back to the playhead",
			Math.round(back * 1000) === parkedMs && Math.abs(back - parkedMs / 1000) < 1e-9,
			`${zoom.sourceEndSec} → ${back}`,
		);
	}

	// 4. The annotation's end edge, brought to 4 px past it.
	const annCue = await dragEnd(annPill, (await xAt(parked)) + 4, "03-annotation-end-snapped");
	const ann = project()?.annotations?.[0];
	check("annotation: the playhead lit while snapped", annCue.snappedBefore === "true");
	check(
		"annotation: stored end equals the playhead's ms",
		ann?.endMs === parkedMs,
		`${ann?.endMs} vs ${parkedMs}`,
	);

	// 5. Alt pressed mid-drag lets go, and the edge lands where the pointer did.
	const altCue = await dragEnd(annPill, (await xAt(parked)) + 4, "04-annotation-alt-free", {
		altMidway: true,
	});
	const annFree = project()?.annotations?.[0];
	check("alt: snapped before Alt", altCue.snappedBefore === "true");
	check("alt: released by Alt", altCue.snappedWithAlt === null);
	check(
		"alt: stored end is off the playhead",
		annFree && annFree.endMs !== parkedMs && Math.abs(annFree.endMs - parkedMs) < 300,
		`${annFree?.endMs}`,
	);

	// 6. One Ctrl+Z takes back one drag: the annotation is on the playhead again.
	await page.keyboard.press("Control+z");
	await wait(900);
	check(
		"undo: one step back is the snapped edge",
		project()?.annotations?.[0]?.endMs === parkedMs,
		`${project()?.annotations?.[0]?.endMs}`,
	);
	await shot("05-after-undo");
} catch (error) {
	check("flow ran to the end", false, error instanceof Error ? error.message : String(error));
} finally {
	stopInstance();
	child.kill();
	const failed = results.filter((r) => !r.ok);
	log(`${results.length - failed.length} of ${results.length} checks passed`);
	writeFileSync(path.join(out, "results.json"), JSON.stringify(results, null, 2));
	process.exit(failed.length ? 1 : 0);
}
