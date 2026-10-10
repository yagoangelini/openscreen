import type { ExportQuality, ExportVideoCodec } from "./types";

export interface Mp4ExportSettings {
	width: number;
	height: number;
	bitrate: number;
}

interface SourceCropRegion {
	width: number;
	height: number;
}

interface Dims {
	width: number;
	height: number;
}

/**
 * Would rendering a `source`-sized clip into an `output`-sized frame stretch it past its own
 * resolution?
 *
 * The clip is CONTAIN-fitted into the output frame, so the answer is that fit scale — not a
 * comparison of short sides, which counts letterbox rows as if they were stretched pixels. A
 * 1920x1032 window capture in a 16:9 project gives a 1920x1080 frame whose 48 extra rows are
 * wallpaper, at scale 1.0: nothing is upscaled. The short-side test called that frame an
 * upscale under the "1080p" tier while "Source" produced the exact same frame unflagged.
 */
export function wouldUpscale(output: Dims, source: Dims): boolean {
	return Math.min(output.width / source.width, output.height / source.height) > 1;
}

const MEDIUM_SHORT_SIDE = 720;
const GOOD_SHORT_SIDE = 1080;
const HIGH_SHORT_SIDE = 1440;

/**
 * Largest side an H.264 export may have. Hardware H.264 encoders stop at 4096 (NVENC's limit;
 * level 5.1/5.2's frame size is 4096x2304), so a "Source" export of a wider-than-4K recording
 * would fail to open the encoder. H.265 goes to 8192 and is left alone.
 */
export const H264_MAX_SIDE = 4096;

/** Scales `dims` down, keeping their ratio and even sizes, until neither side passes `max`. */
function capLongSide(dims: Dims, max: number): Dims {
	const long = Math.max(dims.width, dims.height);
	if (long <= max) return dims;
	const scale = max / long;
	return {
		width: Math.min(max, atLeastEven(Math.round(dims.width * scale))),
		height: Math.min(max, atLeastEven(Math.round(dims.height * scale))),
	};
}

function even(value: number) {
	return Math.floor(value / 2) * 2;
}

function atLeastEven(value: number) {
	return Math.max(2, even(value));
}

export function calculateEffectiveSourceDimensions(
	sourceWidth: number,
	sourceHeight: number,
	cropRegion?: SourceCropRegion,
) {
	const cropWidth = cropRegion?.width ?? 1;
	const cropHeight = cropRegion?.height ?? 1;

	return {
		width: atLeastEven(Math.round(sourceWidth * cropWidth)),
		height: atLeastEven(Math.round(sourceHeight * cropHeight)),
	};
}

function calculateDimensionsForShortSide(targetShortSide: number, aspectRatioValue: number) {
	if (aspectRatioValue >= 1) {
		const height = even(targetShortSide);
		return {
			width: even(height * aspectRatioValue),
			height,
		};
	}

	const width = even(targetShortSide);
	return {
		width,
		height: even(width / aspectRatioValue),
	};
}

function calculateSourceDimensions(
	sourceWidth: number,
	sourceHeight: number,
	aspectRatioValue: number,
) {
	const sourceLongDim = Math.max(sourceWidth, sourceHeight);

	if (aspectRatioValue === 1) {
		const baseDimension = even(Math.min(sourceWidth, sourceHeight));
		return {
			width: baseDimension,
			height: baseDimension,
		};
	}

	if (aspectRatioValue > 1) {
		const baseWidth = even(sourceLongDim);
		for (let width = baseWidth; width >= 100; width -= 2) {
			const height = Math.round(width / aspectRatioValue);
			if (height % 2 === 0 && Math.abs(width / height - aspectRatioValue) < 0.0001) {
				return { width, height };
			}
		}
		return {
			width: baseWidth,
			height: even(baseWidth / aspectRatioValue),
		};
	}

	const baseHeight = even(sourceLongDim);
	for (let height = baseHeight; height >= 100; height -= 2) {
		const width = Math.round(height * aspectRatioValue);
		if (width % 2 === 0 && Math.abs(width / height - aspectRatioValue) < 0.0001) {
			return { width, height };
		}
	}
	return {
		width: even(baseHeight * aspectRatioValue),
		height: baseHeight,
	};
}

/**
 * Bits the encoder may spend per pixel of each frame. Measured with NVENC on scrolled text under
 * animated zooms, against the same export with no cap: at 1080p60 the quality climbs steeply up
 * to 16-20 Mb/s and flattens after, and 0.15 sits on that knee (18.7 Mb/s; 9.3 at 1080p30).
 * Equal quality took 1.6-1.9x the bits at 60 fps as at 30, so scaling linearly with the frame
 * rate is right, if a little generous. It is a ceiling more than a spend: NVENC and AMF run VBR
 * and a still screen costs far less.
 */
const BITS_PER_PIXEL = 0.15;
/** Floor for tiny outputs, the native pipeline's own. */
const MIN_BITRATE = 2_000_000;

/**
 * The bitrate the native encoder is asked for: per pixel AND per frame. The frame rate is the
 * half that used to be missing. The pipeline encoded 8 Mb/s at 1080p whatever the rate, so a
 * 60 fps export spread the same bits over twice the frames.
 */
function calculateBitrate(width: number, height: number, frameRate: number) {
	return Math.max(MIN_BITRATE, Math.round(width * height * frameRate * BITS_PER_PIXEL));
}

/** The short side each fixed tier targets; "source" follows the recording instead. */
const TIER_SHORT_SIDE: Record<Exclude<ExportQuality, "source">, number> = {
	medium: MEDIUM_SHORT_SIDE,
	good: GOOD_SHORT_SIDE,
	high: HIGH_SHORT_SIDE,
};

export function calculateMp4ExportSettings({
	quality,
	sourceWidth,
	sourceHeight,
	aspectRatioValue,
	frameRate,
	codec = "h264",
}: {
	quality: ExportQuality;
	sourceWidth: number;
	sourceHeight: number;
	aspectRatioValue: number;
	frameRate: number;
	/** H.264 caps the long side at `H264_MAX_SIDE`; defaults to H.264, the dialog's default. */
	codec?: ExportVideoCodec;
}): Mp4ExportSettings {
	const uncapped =
		quality === "source"
			? calculateSourceDimensions(sourceWidth, sourceHeight, aspectRatioValue)
			: calculateDimensionsForShortSide(TIER_SHORT_SIDE[quality], aspectRatioValue);
	const dimensions = codec === "h264" ? capLongSide(uncapped, H264_MAX_SIDE) : uncapped;
	return {
		...dimensions,
		bitrate: calculateBitrate(dimensions.width, dimensions.height, frameRate),
	};
}
