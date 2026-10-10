// Runs cargo inside crates/ with the MSVC toolchain and the bundled ffmpeg on PATH (Windows).
//
//   node scripts/cargo-msvc.mjs test -p openscreen-compositor --lib
//
// A plain `cargo` from Git Bash or PowerShell has neither: the linker comes from
// vcvarsall.bat, and the compositor's tests dlopen the av* DLLs at run time.
// `npm run build:native:compositor` sets both up for the build; this does the same
// for any other cargo command (tests, clippy, check).
import { spawn } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { findVcVarsAll } from "./msvcEnv.mjs";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const crates = path.join(root, "crates");
const thirdparty = path.join(crates, "thirdparty");
const ffmpegDir = fs.existsSync(thirdparty)
	? fs
			.readdirSync(thirdparty)
			.find((name) => name.startsWith("ffmpeg-") && name.endsWith("-shared"))
	: undefined;
if (!ffmpegDir) {
	console.error(
		"[cargo-msvc] no crates/thirdparty/ffmpeg-*-shared: run `npm run fetch:ffmpeg` first",
	);
	process.exit(1);
}

const cargo = path.join(os.homedir(), ".cargo", "bin", "cargo.exe");
const cmd = path.join(os.tmpdir(), `cargo-msvc-${process.pid}.cmd`);
fs.writeFileSync(
	cmd,
	[
		"@echo off",
		`call "${findVcVarsAll()}" x64 >nul`,
		"if errorlevel 1 exit /b %errorlevel%",
		`set "PATH=${path.join(thirdparty, ffmpegDir, "bin")};%PATH%"`,
		`"${cargo}" ${process.argv.slice(2).join(" ")}`,
		"exit /b %errorlevel%",
		"",
	].join("\r\n"),
);
const child = spawn("cmd.exe", ["/d", "/c", cmd], { cwd: crates, stdio: "inherit" });
child.on("exit", (code) => {
	fs.unlinkSync(cmd);
	process.exit(code ?? 1);
});
