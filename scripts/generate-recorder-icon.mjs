// Generates the "OpenScreen Recorder" icon: the app logo with a red REC dot in its
// bottom-right corner. Windows shows it on the recorder's own taskbar button and on the
// "OpenScreen Recorder" shortcuts the installer creates (build/installer.nsh), so the
// recorder and the Studio read as two apps at a glance.
//
// Every size is drawn from the logo PNG of that same size rather than downscaled from one
// master, so the small sizes keep whatever hand-tuning the committed logo PNGs carry. The
// dot is drawn analytically (supersampled coverage), so it is crisp at 16 px too.
//
// Outputs (committed; nothing in the build runs this):
//   icons/icons/win/recorder.ico           16, 24, 32, 48, 64, 128 (BMP) and 256 (PNG)
//   icons/icons/recorder-png/<n>x<n>.png    the same sizes, for previews and docs
//   public/openscreen-recorder.png          256 px, the recorder windows' own icon
//
// Run: node scripts/generate-recorder-icon.mjs

import { mkdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { decodePng, encodePng } from "./png-codec.mjs";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const LOGO_DIR = path.join(ROOT, "icons", "icons", "png");
const ICO_PATH = path.join(ROOT, "icons", "icons", "win", "recorder.ico");
// Not under icons/icons/png: that directory is the Linux icon set electron-builder reads.
const PNG_DIR = path.join(ROOT, "icons", "icons", "recorder-png");
const PUBLIC_PNG = path.join(ROOT, "public", "openscreen-recorder.png");

const SIZES = [16, 24, 32, 48, 64, 128, 256];

const DOT_RED = [0xe5, 0x32, 0x2d];
const RING_WHITE = [0xff, 0xff, 0xff];

/**
 * The dot's geometry at a given icon size, in pixels. Small sizes get a slightly larger
 * dot and a ring of at least one pixel, or the dot dissolves into the logo.
 */
export function dotGeometry(size) {
	const diameter = size * (size <= 32 ? 0.42 : 0.34);
	const outer = diameter / 2;
	const ring = Math.max(1, size * 0.025);
	const margin = size * 0.02;
	const center = size - margin - outer;
	return { cx: center, cy: center, outer, inner: Math.max(0, outer - ring) };
}

/** Fraction of the pixel (px, py) covered by a disk, by 8×8 supersampling. */
function diskCoverage(px, py, cx, cy, radius) {
	const n = 8;
	let hits = 0;
	for (let sy = 0; sy < n; sy++) {
		for (let sx = 0; sx < n; sx++) {
			const dx = px + (sx + 0.5) / n - cx;
			const dy = py + (sy + 0.5) / n - cy;
			if (dx * dx + dy * dy <= radius * radius) hits++;
		}
	}
	return hits / (n * n);
}

/** Source-over of an opaque colour with the given coverage, on straight-alpha RGBA. */
function paint(pixels, offset, rgb, coverage) {
	if (coverage <= 0) return;
	const dstA = pixels[offset + 3] / 255;
	const outA = coverage + dstA * (1 - coverage);
	for (let c = 0; c < 3; c++) {
		const blended = rgb[c] * coverage + pixels[offset + c] * dstA * (1 - coverage);
		pixels[offset + c] = Math.round(blended / outA);
	}
	pixels[offset + 3] = Math.round(outA * 255);
}

export function addRecDot(icon) {
	const { width: size, pixels } = icon;
	const out = new Uint8ClampedArray(pixels);
	const { cx, cy, outer, inner } = dotGeometry(size);
	for (let y = Math.floor(cy - outer); y < Math.ceil(cy + outer); y++) {
		for (let x = Math.floor(cx - outer); x < Math.ceil(cx + outer); x++) {
			if (x < 0 || y < 0 || x >= size || y >= size) continue;
			const o = (y * size + x) * 4;
			paint(out, o, RING_WHITE, diskCoverage(x, y, cx, cy, outer));
			paint(out, o, DOT_RED, diskCoverage(x, y, cx, cy, inner));
		}
	}
	return out;
}

/** A 32-bit BGRA DIB icon entry: header, bottom-up XOR bitmap, all-zero AND mask. */
function dibEntry(size, pixels) {
	const header = Buffer.alloc(40);
	header.writeUInt32LE(40, 0);
	header.writeInt32LE(size, 4);
	header.writeInt32LE(size * 2, 8); // XOR + AND masks
	header.writeUInt16LE(1, 12);
	header.writeUInt16LE(32, 14);
	const xor = Buffer.alloc(size * size * 4);
	for (let y = 0; y < size; y++) {
		const row = size - 1 - y;
		for (let x = 0; x < size; x++) {
			const s = (y * size + x) * 4;
			const d = (row * size + x) * 4;
			xor[d] = pixels[s + 2];
			xor[d + 1] = pixels[s + 1];
			xor[d + 2] = pixels[s];
			xor[d + 3] = pixels[s + 3];
		}
	}
	const maskStride = Math.ceil(size / 32) * 4;
	return Buffer.concat([header, xor, Buffer.alloc(maskStride * size)]);
}

/** Packs the entries into an .ico: PNG for 256 px (as Windows' own icons do), DIB below. */
function buildIco(images) {
	const entries = images.map(({ size, pixels }) =>
		size >= 256 ? encodePng(size, size, pixels) : dibEntry(size, pixels),
	);
	const dir = Buffer.alloc(6 + 16 * images.length);
	dir.writeUInt16LE(0, 0);
	dir.writeUInt16LE(1, 2);
	dir.writeUInt16LE(images.length, 4);
	let offset = dir.length;
	images.forEach(({ size }, i) => {
		const e = 6 + i * 16;
		dir[e] = size >= 256 ? 0 : size;
		dir[e + 1] = size >= 256 ? 0 : size;
		dir.writeUInt16LE(1, e + 4);
		dir.writeUInt16LE(32, e + 6);
		dir.writeUInt32LE(entries[i].length, e + 8);
		dir.writeUInt32LE(offset, e + 12);
		offset += entries[i].length;
	});
	return Buffer.concat([dir, ...entries]);
}

async function main() {
	await mkdir(PNG_DIR, { recursive: true });
	const images = [];
	for (const size of SIZES) {
		const source = path.join(LOGO_DIR, `${size}x${size}.png`);
		const icon = decodePng(await readFile(source), source);
		if (icon.width !== size || icon.height !== size) {
			throw new Error(`${source} is ${icon.width}x${icon.height}, expected ${size}x${size}`);
		}
		const pixels = addRecDot(icon);
		images.push({ size, pixels });
		await writeFile(path.join(PNG_DIR, `${size}x${size}.png`), encodePng(size, size, pixels));
	}
	await writeFile(ICO_PATH, buildIco(images));
	const largest = images[images.length - 1];
	await writeFile(PUBLIC_PNG, encodePng(largest.size, largest.size, largest.pixels));
	console.log(
		`recorder icon: ${path.relative(ROOT, ICO_PATH)} (${SIZES.join(", ")} px), ` +
			`${path.relative(ROOT, PNG_DIR)}/, ${path.relative(ROOT, PUBLIC_PNG)}`,
	);
}

await main();
