// PNG decode/encode and an area-average resampler, shared by the icon generators
// (generate-appx-assets.mjs, generate-recorder-icon.mjs).
//
// Hand-rolled on purpose: the project has no image library in its dependency tree (no
// sharp, no jimp), and adding one with prebuilt native binaries to draw a few static logos
// would cost far more than this file. Node's zlib does the only hard part.

import { deflateSync, inflateSync } from "node:zlib";

// --- PNG decoding -----------------------------------------------------------------

const PNG_SIGNATURE = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);

const CRC_TABLE = (() => {
	const table = new Int32Array(256);
	for (let n = 0; n < 256; n++) {
		let c = n;
		for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
		table[n] = c;
	}
	return table;
})();

function crc32(buffer) {
	let c = -1;
	for (let i = 0; i < buffer.length; i++) c = CRC_TABLE[(c ^ buffer[i]) & 0xff] ^ (c >>> 8);
	return (c ^ -1) >>> 0;
}

function paethPredictor(a, b, c) {
	const p = a + b - c;
	const pa = Math.abs(p - a);
	const pb = Math.abs(p - b);
	const pc = Math.abs(p - c);
	if (pa <= pb && pa <= pc) return a;
	return pb <= pc ? b : c;
}

/** Decodes an 8-bit RGBA, non-interlaced PNG into flat RGBA bytes. */
export function decodePng(buffer, label = "PNG") {
	if (!buffer.subarray(0, 8).equals(PNG_SIGNATURE)) throw new Error("not a PNG");

	let width = 0;
	let height = 0;
	const idat = [];
	let offset = 8;
	while (offset < buffer.length) {
		const length = buffer.readUInt32BE(offset);
		const type = buffer.toString("ascii", offset + 4, offset + 8);
		const body = buffer.subarray(offset + 8, offset + 8 + length);
		if (type === "IHDR") {
			width = body.readUInt32BE(0);
			height = body.readUInt32BE(4);
			// The master icon is committed as RGBA8; anything else would need a converter
			// this script deliberately does not carry.
			if (body[8] !== 8 || body[9] !== 6 || body[12] !== 0) {
				throw new Error(
					`${label}: expected 8-bit RGBA non-interlaced, got depth=${body[8]} colorType=${body[9]} interlace=${body[12]}`,
				);
			}
		} else if (type === "IDAT") {
			idat.push(body);
		} else if (type === "IEND") {
			break;
		}
		offset += 12 + length;
	}

	const raw = inflateSync(Buffer.concat(idat));
	const stride = width * 4;
	const pixels = new Uint8ClampedArray(width * height * 4);
	let pos = 0;
	for (let y = 0; y < height; y++) {
		const filter = raw[pos++];
		const row = raw.subarray(pos, pos + stride);
		pos += stride;
		const out = y * stride;
		const prev = out - stride;
		for (let x = 0; x < stride; x++) {
			const left = x >= 4 ? pixels[out + x - 4] : 0;
			const up = y > 0 ? pixels[prev + x] : 0;
			const upLeft = y > 0 && x >= 4 ? pixels[prev + x - 4] : 0;
			let value = row[x];
			if (filter === 1) value += left;
			else if (filter === 2) value += up;
			else if (filter === 3) value += (left + up) >> 1;
			else if (filter === 4) value += paethPredictor(left, up, upLeft);
			else if (filter !== 0) throw new Error(`unsupported PNG row filter ${filter}`);
			pixels[out + x] = value & 0xff;
		}
	}
	return { width, height, pixels };
}

// --- PNG encoding -----------------------------------------------------------------

function chunk(type, body) {
	const length = Buffer.alloc(4);
	length.writeUInt32BE(body.length, 0);
	const typed = Buffer.concat([Buffer.from(type, "ascii"), body]);
	const crc = Buffer.alloc(4);
	crc.writeUInt32BE(crc32(typed), 0);
	return Buffer.concat([length, typed, crc]);
}

export function encodePng(width, height, pixels) {
	const stride = width * 4;
	// Paeth on every row: these assets are mostly flat colour and long transparent runs,
	// which the predictor turns into zeroes for deflate to collapse.
	const raw = Buffer.alloc(height * (stride + 1));
	for (let y = 0; y < height; y++) {
		const dst = y * (stride + 1);
		raw[dst] = 4;
		const src = y * stride;
		const prev = src - stride;
		for (let x = 0; x < stride; x++) {
			const left = x >= 4 ? pixels[src + x - 4] : 0;
			const up = y > 0 ? pixels[prev + x] : 0;
			const upLeft = y > 0 && x >= 4 ? pixels[prev + x - 4] : 0;
			raw[dst + 1 + x] = (pixels[src + x] - paethPredictor(left, up, upLeft)) & 0xff;
		}
	}

	const ihdr = Buffer.alloc(13);
	ihdr.writeUInt32BE(width, 0);
	ihdr.writeUInt32BE(height, 4);
	ihdr[8] = 8; // bit depth
	ihdr[9] = 6; // colour type: RGBA
	return Buffer.concat([
		PNG_SIGNATURE,
		chunk("IHDR", ihdr),
		chunk("IDAT", deflateSync(raw, { level: 9 })),
		chunk("IEND", Buffer.alloc(0)),
	]);
}

// --- Resampling ---------------------------------------------------

/**
 * Box-filter (exact area average) resample in PREMULTIPLIED alpha.
 *
 * Averaging straight RGBA would pull the fully transparent black outside the icon's
 * rounded corners into the visible edge and leave a dark fringe at small sizes.
 */
export function resample(src, srcWidth, srcHeight, dstWidth, dstHeight) {
	const out = new Uint8ClampedArray(dstWidth * dstHeight * 4);
	const xRatio = srcWidth / dstWidth;
	const yRatio = srcHeight / dstHeight;
	for (let dy = 0; dy < dstHeight; dy++) {
		const y0 = dy * yRatio;
		const y1 = (dy + 1) * yRatio;
		const sy0 = Math.floor(y0);
		const sy1 = Math.min(srcHeight, Math.ceil(y1));
		for (let dx = 0; dx < dstWidth; dx++) {
			const x0 = dx * xRatio;
			const x1 = (dx + 1) * xRatio;
			const sx0 = Math.floor(x0);
			const sx1 = Math.min(srcWidth, Math.ceil(x1));
			let r = 0;
			let g = 0;
			let b = 0;
			let alpha = 0;
			let weight = 0;
			for (let sy = sy0; sy < sy1; sy++) {
				const wy = Math.min(sy + 1, y1) - Math.max(sy, y0);
				if (wy <= 0) continue;
				for (let sx = sx0; sx < sx1; sx++) {
					const wx = Math.min(sx + 1, x1) - Math.max(sx, x0);
					if (wx <= 0) continue;
					const w = wx * wy;
					const o = (sy * srcWidth + sx) * 4;
					const a = (src[o + 3] / 255) * w;
					r += src[o] * a;
					g += src[o + 1] * a;
					b += src[o + 2] * a;
					alpha += a;
					weight += w;
				}
			}
			const o = (dy * dstWidth + dx) * 4;
			if (alpha > 0) {
				out[o] = Math.round(r / alpha);
				out[o + 1] = Math.round(g / alpha);
				out[o + 2] = Math.round(b / alpha);
			}
			out[o + 3] = Math.round((alpha / weight) * 255);
		}
	}
	return out;
}
