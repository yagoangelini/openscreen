// Empties dist-electron before a release build. vite-plugin-electron writes hashed main-*.js
// chunks there and never removes the old ones, and electron-builder packs the whole folder:
// 2.5.0's app.asar carried 145 stale chunks, 175 MB. Not done by `emptyOutDir`, because the
// main and preload builds share the folder and run in an order the plugin doesn't promise.
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const dir = path.join(path.dirname(fileURLToPath(import.meta.url)), "..", "dist-electron");
fs.rmSync(dir, { recursive: true, force: true });
console.log("[clean-dist-electron] emptied", dir);
