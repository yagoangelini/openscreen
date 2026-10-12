// Records one take through the HUD of an ISOLATED instance and reports what the editor got.
//
//   node scripts/fork-e2e/record-take.mjs --port 9233 [--screen 1] [--seconds 6] [--keys] [--marker]
//
// Start the instance first, with a profile of its own (never the user's installed app):
//   node_modules/electron/dist/electron.exe . --recorder --user-data-dir=<temp dir> --remote-debugging-port=9233
// and point its takes away from Videos\OpenScreen with a `recording-settings.json` in that
// profile: { "micEnabled": true, "systemAudioEnabled": true, "countdownSeconds": 0,
//            "recordingsFolder": "<another temp dir>" }.
//
// --screen picks the Nth screen through the bridge (0: the first; on the Dell G15, 1 is the
// monitor on the RTX, which exercises the NVENC/DXGI path). --keys types Ctrl+K, "abc",
// Ctrl+Shift+P and "xyz" into a window of its own (type-keys.ps1), for the shortcut plates.
// --marker shows a 160 px square in the primary display's top-left corner (stop-marker.cjs)
// that turns white half a second before the stop click: the white frames at the end of the file,
// less that lead, are what was recorded after it. Every run prints how long the HUD, the editor
// window and its preview took after the click (`stop timing:`).
// The recording is of the real screen: delete the take when done.
//
// Clicks here are injected, so they prove renderer wiring, never that the click-through HUD
// is reachable by a real mouse (see AGENTS.md, "Only a real OS mouse move reaches the HUD").
import { execFileSync, spawn } from "node:child_process";
import { writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { chromium } from "@playwright/test";

const args = process.argv.slice(2);
const option = (name, fallback) => {
	const at = args.indexOf(`--${name}`);
	return at >= 0 && args[at + 1] && !args[at + 1].startsWith("--") ? args[at + 1] : fallback;
};
const port = option("port", "9233");
const screenIndex = option("screen", null);
const seconds = Number(option("seconds", "6"));
const typeKeys = args.includes("--keys");
const useMarker = args.includes("--marker");
const MARKER_LEAD_MS = 500;
const here = path.dirname(fileURLToPath(import.meta.url));

const wait = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
const browser = await chromium.connectOverCDP(`http://127.0.0.1:${port}`);
const pages = () => browser.contexts().flatMap((context) => context.pages());
const find = async (part, tries = 40) => {
	for (let i = 0; i < tries; i++) {
		const page = pages().find((p) => p.url().includes(part));
		if (page) return page;
		await wait(250);
	}
	return null;
};

// The HUD and the editor never share the screen: come back from a previous take first.
const editorBefore = pages().find((p) => p.url().includes("windowType=editor"));
if (editorBefore) {
	await editorBefore.evaluate(() => window.electronAPI.switchToHud()).catch(() => undefined);
	await wait(2500);
}
const hud = await find("hud-overlay");
if (!hud) throw new Error("no HUD window");
// The HUD's own account of the start (`[start-timing]` in useScreenRecorder).
hud.on("console", (message) => {
	if (message.text().includes("start-timing")) console.log("hud:", message.text());
});

if (screenIndex !== null) {
	const picked = await hud.evaluate(async (index) => {
		const sources = await window.electronAPI.getSources({
			types: ["screen"],
			thumbnailSize: { width: 1, height: 1 },
		});
		const source = sources[index];
		if (source) await window.electronAPI.selectSource(source);
		return source?.id ?? null;
	}, Number(screenIndex));
	console.log("screen:", picked);
	await wait(800);
}

await hud.evaluate(() => document.querySelector("[data-testid=launch-record-button]")?.click());
// With no source chosen yet, the record button opens the picker first.
const picker = await find("source-selector", 12);
if (picker) {
	for (let i = 0; i < 20; i++) {
		const clicked = await picker
			.evaluate(() => {
				const card = document.querySelector("[data-testid=source-selector-card]");
				if (!card) return false;
				card.click();
				return true;
			})
			.catch(() => false);
		if (clicked) break;
		await wait(300);
	}
	await wait(400);
	await picker
		.evaluate(() => document.querySelector("[data-testid=source-selector-share-button]")?.click())
		.catch(() => undefined);
}
let marker = null;
const markerControl = path.join(os.tmpdir(), "openscreen-stop-marker.txt");
if (useMarker) {
	writeFileSync(markerControl, "black");
	marker = spawn(
		path.join(here, "..", "..", "node_modules", "electron", "dist", "electron.exe"),
		[
			path.join(here, "stop-marker.cjs"),
			`--control=${markerControl}`,
			`--user-data-dir=${path.join(os.tmpdir(), "openscreen-stop-marker")}`,
		],
		{ stdio: ["ignore", "pipe", "ignore"] },
	);
	marker.lines = [];
	marker.stdout.on("data", (chunk) =>
		marker.lines.push(...chunk.toString().split(/\r?\n/).filter(Boolean)),
	);
	for (let i = 0; i < 40 && !marker.lines.some((l) => l.startsWith("ready")); i++) await wait(250);
	console.log("marker:", marker.lines.find((l) => l.startsWith("ready")) ?? "not ready");
}
console.log("recording...");
await wait(Math.max(1, seconds / 2) * 1000);
if (typeKeys) {
	try {
		const out = execFileSync(
			"powershell.exe",
			["-NoProfile", "-ExecutionPolicy", "Bypass", "-File", path.join(here, "type-keys.ps1")],
			{ encoding: "utf8", timeout: 20_000 },
		);
		console.log("keys:", out.trim());
	} catch (error) {
		console.log("keys not typed:", error.stdout?.toString().trim() || error.message);
	}
}
await wait(Math.max(1, seconds / 2) * 1000);
const hudAgain = await find("hud-overlay");
let editorPageAtMs = null;
// The HUD closes as the editor is shown (they never share the screen).
let hudClosedAtMs = null;
hudAgain?.once("close", () => {
	hudClosedAtMs = Date.now();
});
for (const context of browser.contexts()) {
	context.on("page", (page) => {
		if (editorPageAtMs === null && page.url().includes("windowType=editor"))
			editorPageAtMs = Date.now();
	});
}
// White a fixed lead before the click, so the end of the file shows the lead plus whatever was
// recorded after the click (a take cut short shows less than the lead).
if (marker) {
	writeFileSync(markerControl, "white");
	await wait(MARKER_LEAD_MS);
}
// The click and the HUD's answer to it, timed inside the HUD: the record button turns
// disabled ("saving") on the render that follows the stop.
const stopClick = await hudAgain
	?.evaluate(async () => {
		const button = document.querySelector("[data-testid=launch-record-button]");
		const clickAtMs = Date.now();
		const t0 = performance.now();
		button?.click();
		const hudMs = await new Promise((resolve) => {
			const check = () =>
				!button?.isConnected || button.disabled
					? resolve(performance.now() - t0)
					: requestAnimationFrame(check);
			check();
			setTimeout(() => resolve(null), 10_000);
		});
		return { clickAtMs, hudMs };
	})
	.catch(() => null);
const editor = await find("windowType=editor", 240);
editorPageAtMs ??= editor ? Date.now() : null;
console.log("editor opened:", Boolean(editor));
let previewAtMs = null;
let editorNavigationAtMs = null;
if (editor) {
	await editor
		.waitForSelector("[data-testid=preview]", { timeout: 60_000 })
		.then(() => {
			previewAtMs = Date.now();
		})
		.catch(() => undefined);
	editorNavigationAtMs = await editor
		.evaluate(() => Math.round(performance.timeOrigin))
		.catch(() => null);
}
if (stopClick) {
	const since = (at) => (at === null ? null : at - stopClick.clickAtMs);
	const painted = marker?.lines.find((l) => l.startsWith("painted white"));
	console.log("stop timing:", {
		clickAtMs: stopClick.clickAtMs,
		hudMs: stopClick.hudMs === null ? null : Math.round(stopClick.hudMs),
		hudClosedMs: since(hudClosedAtMs),
		editorWindowMs: since(editorPageAtMs),
		editorNavigationMs: since(editorNavigationAtMs),
		editorPreviewMs: since(previewAtMs),
		// Negative: the square was white this long before the click.
		...(painted ? { markerWhiteMs: since(Number(painted.split(" ")[2])) } : {}),
	});
}
if (marker) writeFileSync(markerControl, "quit");
await browser.close().catch(() => undefined);
