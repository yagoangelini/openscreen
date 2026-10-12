// Smoke test of a build: its HUD loads and offers the record button.
//
//   release/<ver>/win-unpacked/Openscreen.exe --recorder --user-data-dir=<temp dir> --remote-debugging-port=9232
//   node scripts/fork-e2e/smoke-hud.mjs --port 9232
//
// Close that instance afterwards by its profile, never by name alone: the user's installed
// OpenScreen is also `Openscreen.exe`.
//   Get-CimInstance Win32_Process -Filter "Name='Openscreen.exe'" |
//     Where-Object { $_.CommandLine -like '*<temp dir>*' } | ForEach-Object { Stop-Process -Id $_.ProcessId }
import { chromium } from "@playwright/test";

const at = process.argv.indexOf("--port");
const port = at >= 0 ? process.argv[at + 1] : "9232";
const wait = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

let browser;
for (let i = 0; i < 40 && !browser; i++) {
	browser = await chromium.connectOverCDP(`http://127.0.0.1:${port}`).catch(() => undefined);
	if (!browser) await wait(500);
}
if (!browser) throw new Error(`nothing answers on port ${port}`);
let hud;
for (let i = 0; i < 40 && !hud; i++) {
	hud = browser
		.contexts()
		.flatMap((context) => context.pages())
		.find((page) => page.url().includes("hud-overlay"));
	if (!hud) await wait(500);
}
if (!hud) throw new Error("no HUD window");
await hud.waitForSelector("[data-testid=launch-record-button]", { timeout: 15_000 });
console.log("HUD ok: the record button is there");
await browser.close().catch(() => undefined);
