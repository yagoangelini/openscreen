// A small always-on-top square that turns from black to white on command, so a take can be
// measured against the moment its stop was pressed: every white frame at the end of the file
// is time recorded after the click. Started by `record-take.mjs --marker`, never on its own.
//
//   electron.exe scripts/fork-e2e/stop-marker.cjs --control=<file> --user-data-dir=<temp dir>
//
// The command comes through a file, not stdin (a GUI Electron on Windows does not read its
// stdin): write `white` or `black` into it. stdout: `ready <x> <y> <size>` once shown, and
// `painted <color> <epoch ms>` once the change has reached the screen. The window takes no
// focus and lets every click through.
const fs = require("node:fs");
const { app, BrowserWindow, screen } = require("electron");

const SIZE = 160;
const controlArg = process.argv.find((arg) => arg.startsWith("--control="));
const controlPath = controlArg?.slice("--control=".length);

app.whenReady().then(async () => {
	const { x, y } = screen.getPrimaryDisplay().bounds;
	const win = new BrowserWindow({
		x,
		y,
		width: SIZE,
		height: SIZE,
		frame: false,
		resizable: false,
		focusable: false,
		skipTaskbar: true,
		alwaysOnTop: true,
		backgroundColor: "#000000",
		show: false,
		webPreferences: { backgroundThrottling: false },
	});
	win.setAlwaysOnTop(true, "screen-saver");
	win.setIgnoreMouseEvents(true);
	await win.loadURL("data:text/html,<body style='margin:0;background:#000'></body>");
	win.showInactive();
	console.log(`ready ${x} ${y} ${SIZE}`);

	let shown = "black";
	let painting = false;
	const poll = async () => {
		if (painting || !controlPath) return;
		let wanted = shown;
		try {
			wanted = fs.readFileSync(controlPath, "utf8").trim();
		} catch {
			return;
		}
		if (wanted === "quit") {
			app.quit();
			return;
		}
		if ((wanted !== "white" && wanted !== "black") || wanted === shown) return;
		painting = true;
		shown = wanted;
		win.setBackgroundColor(wanted === "white" ? "#ffffff" : "#000000");
		await win.webContents.executeJavaScript(
			`document.body.style.background = "${wanted === "white" ? "#fff" : "#000"}"`,
		);
		// The next composited frame: what a capture can see from now on.
		await new Promise((resolve) => setTimeout(resolve, 16));
		console.log(`painted ${wanted} ${Date.now()}`);
		painting = false;
	};
	setInterval(() => void poll(), 2);
});
