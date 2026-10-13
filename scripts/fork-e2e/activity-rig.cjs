// A scripted "app" window for auto-zoom checks with NO input: it sits where the pointer already
// is, never takes focus, lets every click through, and plays a fixed screen script so the take
// has screen activity next to a resting pointer (menu opening under it, items lighting up,
// then a dialog in the middle of the screen). Quits by itself after --seconds.
//   node_modules/electron/dist/electron.exe scripts/fork-e2e/activity-rig.cjs --seconds=16 --user-data-dir=<temp>
// Start it once the take is running. The script times are relative to its own start (about
// 1.5 s after the spawn): menu at +2 s, items lit at +3/+4/+5 s, menu gone at +6.5 s, dialog
// from +8 to +12 s. It feeds the screen-activity scan only: the pointer never moves, so the
// director plans nothing from it on its own (a resting pointer needs evidence and a rest).
const { app, BrowserWindow, screen } = require("electron");

const seconds = Number(
	(process.argv.find((a) => a.startsWith("--seconds=")) || "--seconds=16").split("=")[1],
);
app.whenReady().then(async () => {
	const display = screen.getPrimaryDisplay();
	const { width, height } = display.workArea;
	const win = new BrowserWindow({
		x: 0,
		y: 0,
		width,
		height,
		frame: false,
		resizable: false,
		focusable: false,
		skipTaskbar: true,
		alwaysOnTop: true,
		backgroundColor: "#f3f3f3",
		show: false,
		webPreferences: { backgroundThrottling: false },
	});
	win.setIgnoreMouseEvents(true);
	const p = screen.getCursorScreenPoint();
	const px = Math.min(Math.max(p.x - 40, 20), width - 300);
	const py = Math.min(Math.max(p.y + 12, 60), height - 360);
	const html = `<body style="margin:0;font:16px Segoe UI;background:#f3f3f3">
<div style="height:48px;background:#2b579a;color:#fff;padding:12px 20px;box-sizing:border-box">Rig E2E 2.7.0</div>
<div id="menu" style="display:none;position:absolute;left:${px}px;top:${py}px;width:260px;background:#fff;border:1px solid #888;box-shadow:0 4px 16px #0004">
${[1, 2, 3, 4, 5, 6].map((i) => `<div id="i${i}" style="padding:10px 14px">Item ${i}</div>`).join("")}
</div>
<div id="dlg" style="display:none;position:absolute;left:${width / 2 - 260}px;top:${height / 2 - 160}px;width:520px;height:320px;background:#fff;border:1px solid #555;box-shadow:0 8px 40px #0006;padding:24px;box-sizing:border-box"><h2>Caixa de diálogo</h2><p>Conteúdo novo no meio da tela.</p></div>
<script>
const at=(s,f)=>setTimeout(f,s*1000);
at(2,()=>menu.style.display="block");
at(3,()=>i1.style.background="#cde");
at(4,()=>{i1.style.background="";i2.style.background="#cde"});
at(5,()=>{i2.style.background="";i3.style.background="#cde"});
at(6.5,()=>menu.style.display="none");
at(8,()=>dlg.style.display="block");
at(12,()=>dlg.style.display="none");
</script></body>`;
	await win.loadURL(`data:text/html;charset=utf-8,${encodeURIComponent(html)}`);
	win.showInactive();
	console.log(`ready cursor ${p.x} ${p.y} menu ${px} ${py}`);
	setTimeout(() => app.quit(), seconds * 1000);
});
