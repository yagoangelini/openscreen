// Generates the Microsoft Store (AppX/MSIX) tile assets into build/appx/.
//
// Why this exists: electron-builder only ships BRANDED tiles if it finds them in
// `<buildResources>/appx/` (AppXTarget.computeUserAssets -> packager.getResource(undefined, "appx")).
// With that directory missing it silently falls back to its vendored placeholders
// — SampleAppx.50x50.png, SampleAppx.150x150.png, SampleAppx.44x44.png,
// SampleAppx.310x150.png — and ships an Electron-generic tile. That is exactly what
// Store certification rejected under 10.1.1.11 "On Device Tiles":
//   "The available product tile icons include a default image."
// So build/appx/ is committed to the repo; this script only regenerates it when the
// app icon changes. No build step depends on it.
//
// PNG I/O is hand-rolled, in png-codec.mjs: the project has no image library in its
// dependency tree (no sharp, no jimp).
//
// Layout follows Microsoft's tile guidance: the icon sits on a TRANSPARENT canvas with
// padding rather than bleeding to the edges, because `appx.backgroundColor` is
// "transparent" in electron-builder.json5, so Windows paints the tile in the user's
// accent colour behind these assets. The small assets (store logo, 44x44 app-list icon)
// are full-bleed instead: Windows plates and crops those itself.
//
// Run: node scripts/generate-appx-assets.mjs
// Verify: the generated names must keep matching electron-builder's expectations —
// StoreLogo / Square150x150Logo / Square44x44Logo / Wide310x150Logo are the four it
// substitutes placeholders for, and SmallTile / LargeTile / SplashScreen are opt-in
// (their <uap:> manifest attributes only appear when the file is present).

import { mkdir, readdir, readFile, rm, writeFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { decodePng, encodePng, resample } from "./png-codec.mjs";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const SOURCE_ICON = path.join(ROOT, "icons", "icons", "png", "1024x1024.png");
const OUT_DIR = path.join(ROOT, "build", "appx");

/**
 * One entry per logical asset.
 *
 * `fill` is the icon's edge length as a fraction of the canvas's SHORT side, and
 * `shiftY` nudges it up as a fraction of canvas height — the tiles that carry
 * `<uap:ShowNameOnTiles>` (150x150 and the wide tile, per showNameOnTiles in
 * electron-builder.json5) get the product name drawn across their bottom band, and
 * a dead-centred logo sits under that text.
 *
 * `scales` are the MRT scale qualifiers emitted next to the unqualified 100% file.
 * 400% is only worth its bytes on the assets that stay small on screen; the big tiles
 * stop at 200%. Every variant is a DOWNSCALE of the 1024px master — nothing here
 * upsamples.
 */
const ASSETS = [
	{ name: "StoreLogo", width: 50, height: 50, fill: 1, scales: [125, 150, 200, 400] },
	{ name: "Square44x44Logo", width: 44, height: 44, fill: 1, scales: [125, 150, 200, 400] },
	{ name: "SmallTile", width: 71, height: 71, fill: 0.7, scales: [125, 150, 200, 400] },
	{
		name: "Square150x150Logo",
		width: 150,
		height: 150,
		fill: 0.66,
		shiftY: -0.08,
		scales: [125, 150, 200],
	},
	{
		name: "Wide310x150Logo",
		width: 310,
		height: 150,
		fill: 0.6,
		shiftY: -0.08,
		scales: [125, 150, 200],
	},
	{ name: "LargeTile", width: 310, height: 310, fill: 0.55, scales: [125, 150, 200] },
	{ name: "SplashScreen", width: 620, height: 300, fill: 0.6, scales: [125, 150, 200] },
];

/**
 * Square44x44Logo is also consumed by target size rather than by scale: the taskbar,
 * task-view and Start's app list ask for an exact pixel size. `altform-unplated` is the
 * variant Windows uses where it does NOT draw its accent-coloured plate behind the icon
 * (taskbar, title bar) — same art, different qualifier.
 */
const TARGET_SIZES = [16, 24, 32, 48, 256];
// --- Composition ------------------------------------------------------------------

/** Draws the square icon, scaled to `size`, onto a transparent canvas. */
function compose(icon, canvasWidth, canvasHeight, size, shiftY) {
	const scaled = resample(icon.pixels, icon.width, icon.height, size, size);
	const canvas = new Uint8ClampedArray(canvasWidth * canvasHeight * 4);
	const left = Math.round((canvasWidth - size) / 2);
	const top = Math.round((canvasHeight - size) / 2 + shiftY * canvasHeight);
	for (let y = 0; y < size; y++) {
		const dy = top + y;
		if (dy < 0 || dy >= canvasHeight) continue;
		canvas.set(scaled.subarray(y * size * 4, (y + 1) * size * 4), (dy * canvasWidth + left) * 4);
	}
	return canvas;
}

// --- Generation -------------------------------------------------------------------

/**
 * Every asset this generator owns, as {name, width, height, size, shiftY}, derived from
 * ASSETS/TARGET_SIZES alone — no filesystem involved.
 *
 * This table, not the contents of build/appx/, is the authority on what the package must
 * contain. `--list` exposes it so CI can tell "this asset is missing" apart from "this
 * asset was never expected": a check that reads build/appx/ to decide what to look for
 * passes happily once a file is deleted there, which is precisely when electron-builder
 * swaps a blank placeholder in.
 *
 * The targetsize variants come out of compose() too rather than a bare resample: at
 * size == width == height with no shift, the canvas is fully covered, so the two are the
 * same pixels — and there is then a single code path to keep honest.
 */
function plannedAssets() {
	const planned = [];
	for (const asset of ASSETS) {
		const shiftY = asset.shiftY ?? 0;
		for (const scale of [100, ...(asset.scales ?? [])]) {
			const width = Math.round((asset.width * scale) / 100);
			const height = Math.round((asset.height * scale) / 100);
			const size = Math.round(Math.min(width, height) * asset.fill);
			// The 100% variant stays unqualified so it is also the neutral MRT candidate:
			// if resources.pri ever fails to resolve a scale, Windows still finds art.
			const suffix = scale === 100 ? "" : `.scale-${scale}`;
			planned.push({ name: `${asset.name}${suffix}.png`, width, height, size, shiftY });
		}
	}
	for (const target of TARGET_SIZES) {
		for (const suffix of ["", "_altform-unplated"]) {
			planned.push({
				name: `Square44x44Logo.targetsize-${target}${suffix}.png`,
				width: target,
				height: target,
				size: target,
				shiftY: 0,
			});
		}
	}
	return planned;
}

async function main() {
	const planned = plannedAssets();

	if (process.argv.includes("--list")) {
		console.log(planned.map((it) => it.name).join("\n"));
		return;
	}

	const icon = decodePng(await readFile(SOURCE_ICON), SOURCE_ICON);
	for (const { name, size } of planned) {
		if (size > icon.width) {
			throw new Error(`${name} needs a ${size}px icon; master is ${icon.width}px`);
		}
	}

	// Wipe first: a renamed or dropped asset left behind in build/appx/ would still be
	// mapped into the package by electron-builder, which copies the directory wholesale.
	await rm(OUT_DIR, { recursive: true, force: true });
	await mkdir(OUT_DIR, { recursive: true });

	for (const { name, width, height, size, shiftY } of planned) {
		const pixels = compose(icon, width, height, size, shiftY);
		await writeFile(path.join(OUT_DIR, name), encodePng(width, height, pixels));
	}

	const total = (await readdir(OUT_DIR)).length;
	console.log(
		`${planned.length} assets written to ${path.relative(ROOT, OUT_DIR)} (${total} files)`,
	);
}

await main();
