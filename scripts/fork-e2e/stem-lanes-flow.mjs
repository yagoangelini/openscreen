// E2E of the stem lanes and "Remover eco do alto-falante" in an ISOLATED instance, driven over
// CDP only (no OS mouse or keyboard):
//
//   node scripts/fork-e2e/stem-lanes-flow.mjs --take <dir> --out <folder> [--port 9291]
//
// <dir> holds one take: `<name>.mp4` with its `<name>.voice.m4a` and `<name>.system.m4a`. It is
// copied into a recordings folder inside --out; a fresh profile is made there too (the user's
// %APPDATA%\Openscreen and Videos\OpenScreen are never touched), and only that instance —
// filtered by name AND profile path — is stopped at the end. Run `npm run build-vite` first.
//
// The flow: the take arrives as a fresh recording (`setCurrentRecordingSession`); the timeline
// must show the two stem lanes; the microphone lane's pane must report the echo the canceller
// found, and the preview must play the echo-free voice; the computer lane is muted from its chip,
// 2 s of the microphone are silenced at 10 s, the echo removal is switched off and on again.
// Then the project is exported twice through the CLI (each in a profile of its own), as edited
// and with the echo removal off, and both files are measured with ffmpeg: the silenced 2 s,
// the muted computer sound, and the echo removed from the voice.
import { execFileSync, spawn, spawnSync } from "node:child_process";
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
const port = option("port", "9291");
const repo = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../..");
const stamp = Date.now();
const profile = path.join(out, `profile-${stamp}`);
const recordings = path.join(out, "rec");
mkdirSync(profile, { recursive: true });
const takeDir = path.resolve(option("take", ""));
const mp4 = readdirSync(takeDir).find((name) => name.endsWith(".mp4"));
if (!mp4) throw new Error(`--take has no .mp4: ${takeDir}`);
const base = mp4.replace(/\.mp4$/, "");
const takeFolder = path.join(recordings, base);
mkdirSync(takeFolder, { recursive: true });
for (const suffix of [".mp4", ".voice.m4a", ".system.m4a"]) {
	copyFileSync(path.join(takeDir, `${base}${suffix}`), path.join(takeFolder, `${base}${suffix}`));
}
const video = path.join(takeFolder, mp4);
writeFileSync(
	path.join(profile, "recording-settings.json"),
	JSON.stringify({ countdownSeconds: 0, recordingsFolder: recordings }),
);

const ffmpegDir = path.join(
	repo,
	"crates",
	"thirdparty",
	readdirSync(path.join(repo, "crates", "thirdparty")).find((n) => n.startsWith("ffmpeg-")),
	"bin",
);
const ffmpeg = path.join(ffmpegDir, "ffmpeg.exe");

const wait = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
const log = (...parts) => console.log("[stem-e2e]", ...parts);
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

function stopInstances() {
	// Only processes of THIS run's profiles, by name and command line.
	const marker = path.join(out, "profile-").replace(/'/g, "''");
	const script = `Get-CimInstance Win32_Process -Filter "Name='electron.exe'" | Where-Object { $_.CommandLine -like '*${marker}*' } | ForEach-Object { Stop-Process -Id $_.ProcessId -ErrorAction SilentlyContinue }`;
	try {
		execFileSync("powershell", ["-NoProfile", "-Command", script], { stdio: "ignore" });
	} catch {
		// Nothing left to stop.
	}
}

const projectsDir = path.join(profile, "projects");
function projectEntry() {
	if (!existsSync(projectsDir)) return null;
	for (const name of readdirSync(projectsDir)) {
		if (!name.endsWith(".openscreen")) continue;
		const file = path.join(projectsDir, name);
		const doc = JSON.parse(readFileSync(file, "utf8"));
		if (doc.assets?.some((a) => a.originalPath === video)) return { file, doc };
	}
	return null;
}
const project = () => projectEntry()?.doc;

/** Mono 48 kHz f32 samples of a file's audio. */
function decode(file) {
	const raw = execFileSync(
		ffmpeg,
		["-v", "error", "-i", file, "-ac", "1", "-ar", "48000", "-f", "f32le", "-"],
		{
			maxBuffer: 1 << 30,
		},
	);
	return new Float32Array(raw.buffer, raw.byteOffset, Math.floor(raw.byteLength / 4));
}
const levelDb = (x, fromSec, toSec) => {
	const a = Math.max(0, Math.round(fromSec * 48000));
	const b = Math.min(x.length, Math.round(toSec * 48000));
	let e = 0;
	for (let i = a; i < b; i++) e += x[i] * x[i];
	return 10 * Math.log10(e / Math.max(1, b - a) + 1e-12);
};

function cliExport(projectFile, output) {
	const cliProfile = path.join(out, `profile-cli-${path.basename(output, ".mp4")}-${stamp}`);
	mkdirSync(cliProfile, { recursive: true });
	// The take lives in this run's recordings folder: the CLI instance must trust it as an installed
	// app trusts VideosOpenScreen, or it may not read the stems for the echo removal.
	writeFileSync(
		path.join(cliProfile, "recording-settings.json"),
		JSON.stringify({ recordingsFolder: recordings }),
	);
	const run = spawnSync(
		electron,
		[".", `--user-data-dir=${cliProfile}`, "export", projectFile, "-o", output, "--json"],
		{ cwd: repo, encoding: "utf8", timeout: 600_000 },
	);
	return { ok: run.status === 0 && existsSync(output), stdout: run.stdout?.slice(-400) ?? "" };
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
	const consoleLines = [];
	page.on("console", (message) => {
		if (message.type() === "warning" || message.type() === "error") {
			consoleLines.push(message.text());
		}
	});
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
	check("the take became a project with its stems", Boolean(created?.assets?.[0]?.audioStems));
	const shot = (name) => page.screenshot({ path: path.join(out, `${name}.png`) });

	// 1. Two lanes under the clips.
	await page.waitForSelector("[data-testid='stem-lane-voice']", { timeout: 30_000 });
	check(
		"the microphone lane is shown",
		(await page.locator("[data-testid='stem-lane-voice']").count()) === 1,
	);
	check(
		"the computer lane is shown",
		(await page.locator("[data-testid='stem-lane-system']").count()) === 1,
	);
	await wait(2500);
	await shot("01-two-lanes");

	// 2. The microphone lane's pane, and what the canceller found.
	await page.locator("[data-testid='stem-lane-voice']").click({ position: { x: 40, y: 15 } });
	let status = "";
	for (let i = 0; i < 120; i++) {
		status =
			(await page
				.locator("[data-testid='echo-cancel-status']")
				.first()
				.textContent()
				.catch(() => "")) ?? "";
		if (status && !/Procurando|Looking/.test(status)) break;
		await wait(500);
	}
	check(
		"the canceller reported on the take",
		/encontrado|found|Nenhum|No speaker/.test(status),
		status,
	);
	const primarySrc = await page
		.locator("[data-testid='preview-audio-primary']")
		.getAttribute("src");
	check(
		"the preview plays the echo-free voice",
		/echo-free/.test(primarySrc ?? ""),
		primarySrc ?? "",
	);
	writeFileSync(path.join(out, "console.txt"), consoleLines.join("\n"));
	await shot("02-microphone-pane");

	// 3. Mute the computer lane from its chip.
	await page.locator("[data-testid='stem-lane-mute-system']").click();
	await wait(1200);
	check("the computer lane is muted in the project", project()?.legacyEditor?.systemMuted === true);

	// 4. Silence 2 s of the microphone at 10 s (the ruler is the playhead's clock).
	const ruler = page.locator("[class*='tlRulerRow']").first();
	const rulerBox = await ruler.boundingBox();
	const canvas = page.locator("[class*='tlTracks'] > [class*='tlCanvas']").first();
	const total = Math.max(...project().timeline.clips.map((c) => c.timelineEndSec));
	const canvasBox = await canvas.boundingBox();
	await page.mouse.click(
		canvasBox.x + (10 / total) * canvasBox.width,
		rulerBox.y + rulerBox.height / 2,
	);
	await wait(500);
	// A click on a lane also moves the playhead there, so the lane is clicked at 10 s too.
	const laneBox = await page.locator("[data-testid='stem-lane-voice']").boundingBox();
	await page.mouse.click(canvasBox.x + (10 / total) * canvasBox.width, laneBox.y + 8);
	await wait(500);
	await page.locator("[data-testid='stem-add-mute']").click();
	await wait(1200);
	const mute = project()?.audioStemMutes?.[0];
	check(
		"a silenced stretch of the microphone, about 10..12 s",
		mute?.stem === "voice" &&
			Math.abs(mute.startSec - 10) < 0.3 &&
			Math.abs(mute.endSec - mute.startSec - 2) < 0.01,
		JSON.stringify(mute),
	);
	await shot("03-system-muted-and-a-stretch");

	// 5. Echo removal off, then on again, from the pane's toggle.
	const echoToggle = page
		.getByRole("button", { name: /Remover eco do alto-falante|Remove speaker echo/ })
		.first();
	await echoToggle.click();
	await wait(1000);
	const off = project()?.legacyEditor?.echoCancel;
	await echoToggle.click();
	await wait(1000);
	check(
		"the echo toggle switches off and back on",
		off === false && project()?.legacyEditor?.echoCancel === true,
	);
	await shot("04-echo-toggle-on");

	// Close the instance: the CLI exports run in their own profiles.
	stopInstances();
	child.kill();
	await wait(1500);

	const entry = projectEntry();
	const edited = path.join(out, "export-edited.mp4");
	const a = cliExport(entry.file, edited);
	check("export as edited", a.ok, a.stdout);
	// The same project with the echo removal off and the computer lane back on.
	const plainFile = path.join(out, "project-plain.openscreen");
	const plainDoc = structuredClone(entry.doc);
	plainDoc.legacyEditor = { ...plainDoc.legacyEditor, echoCancel: false, systemMuted: false };
	plainDoc.audioStemMutes = undefined;
	writeFileSync(plainFile, JSON.stringify(plainDoc));
	const plain = path.join(out, "export-plain.mp4");
	const b = cliExport(plainFile, plain);
	check("export with the echo kept and the computer sound on", b.ok, b.stdout);

	if (a.ok && b.ok) {
		const x = decode(edited);
		const y = decode(plain);
		const voiceStem = decode(path.join(takeFolder, `${base}.voice.m4a`));
		const systemStem = decode(path.join(takeFolder, `${base}.system.m4a`));
		const silenced = levelDb(x, mute.startSec + 0.1, mute.endSec - 0.1);
		check(
			"the silenced 2 s are silent in the export",
			silenced < -70,
			`${silenced.toFixed(1)} dBFS`,
		);
		const around = levelDb(y, mute.startSec + 0.1, mute.endSec - 0.1);
		log(`same 2 s without the stretch: ${around.toFixed(1)} dBFS`);
		// Where the computer plays: the edited export (voice without echo, computer muted) against
		// the plain one (voice with its echo, plus the computer).
		const frames = [];
		for (let t = 0; t + 0.1 < Math.min(x.length, y.length) / 48000; t += 0.1) {
			if (t > mute.startSec - 0.2 && t < mute.endSec + 0.2) continue;
			if (levelDb(systemStem, t, t + 0.1) > -50)
				frames.push(levelDb(y, t, t + 0.1) - levelDb(x, t, t + 0.1));
		}
		frames.sort((p, q) => p - q);
		const median = frames.length ? frames[Math.floor(frames.length / 2)] : 0;
		check(
			"where the computer plays, the edited export is much quieter (echo gone, computer muted)",
			median > 10,
			`median ${median.toFixed(1)} dB over ${frames.length} frames`,
		);
		writeFileSync(
			path.join(out, "measurements.json"),
			JSON.stringify(
				{
					silencedDbfs: silenced,
					sameStretchPlainDbfs: around,
					medianDropWhereComputerPlaysDb: median,
					frames: frames.length,
					voiceStemDbfs: levelDb(voiceStem, 0, 60),
					editedDbfs: levelDb(x, 0, 60),
					plainDbfs: levelDb(y, 0, 60),
				},
				null,
				2,
			),
		);
	}
} catch (error) {
	check("flow ran to the end", false, error instanceof Error ? error.message : String(error));
} finally {
	stopInstances();
	child.kill();
	const failed = results.filter((r) => !r.ok);
	log(`${results.length - failed.length} of ${results.length} checks passed`);
	writeFileSync(path.join(out, "results.json"), JSON.stringify(results, null, 2));
	process.exit(failed.length ? 1 : 0);
}
