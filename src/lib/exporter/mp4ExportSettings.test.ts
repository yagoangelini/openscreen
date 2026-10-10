import { describe, expect, it } from "vitest";
import { DEFAULT_PROJECT_APPEARANCE } from "@/lib/projectDefaults";
import { getAspectRatioValue } from "@/utils/aspectRatioUtils";
import {
	calculateEffectiveSourceDimensions,
	calculateMp4ExportSettings,
	H264_MAX_SIDE,
	wouldUpscale,
} from "./mp4ExportSettings";

describe("the default export", () => {
	it("is exactly 1920x1080 for a new project at the dialog's default tier", () => {
		// A new project's format and the dialog's default quality ("good"): the fork's export
		// decision. Auto used to be the default and made 1752x1080 out of a 16:9 screen.
		const aspectRatioValue = getAspectRatioValue(DEFAULT_PROJECT_APPEARANCE.aspectRatio);
		expect(
			calculateMp4ExportSettings({
				quality: "good",
				sourceWidth: 1920,
				sourceHeight: 1080,
				aspectRatioValue,
				frameRate: 60,
			}),
		).toMatchObject({ width: 1920, height: 1080 });
	});
});

describe("the 1440p tier", () => {
	it("targets a 1440 short side in the project's format", () => {
		expect(
			calculateMp4ExportSettings({
				quality: "high",
				sourceWidth: 1920,
				sourceHeight: 1080,
				aspectRatioValue: 16 / 9,
				frameRate: 60,
			}),
		).toMatchObject({ width: 2560, height: 1440 });
		expect(
			calculateMp4ExportSettings({
				quality: "high",
				sourceWidth: 1080,
				sourceHeight: 1920,
				aspectRatioValue: 9 / 16,
				frameRate: 30,
			}),
		).toMatchObject({ width: 1440, height: 2560 });
	});

	it("is flagged as an upscale for a 1080p recording, like 1080p is for a 720p one", () => {
		const dims = calculateMp4ExportSettings({
			quality: "high",
			sourceWidth: 1920,
			sourceHeight: 1080,
			aspectRatioValue: 16 / 9,
			frameRate: 60,
		});
		expect(wouldUpscale(dims, { width: 1920, height: 1080 })).toBe(true);
		expect(wouldUpscale(dims, { width: 2560, height: 1440 })).toBe(false);
	});
});

describe("the H.264 size cap", () => {
	it("scales a wider-than-4K source export down to 4096 for H.264, keeping its shape", () => {
		const settings = calculateMp4ExportSettings({
			quality: "source",
			sourceWidth: 5120,
			sourceHeight: 2880,
			aspectRatioValue: 16 / 9,
			frameRate: 30,
		});
		expect(settings).toMatchObject({ width: 4096, height: 2304 });
		expect(Math.max(settings.width, settings.height)).toBeLessThanOrEqual(H264_MAX_SIDE);
	});

	it("caps a portrait export on its long side too", () => {
		expect(
			calculateMp4ExportSettings({
				quality: "source",
				sourceWidth: 2880,
				sourceHeight: 5120,
				aspectRatioValue: 9 / 16,
				frameRate: 30,
				codec: "h264",
			}),
		).toMatchObject({ width: 2304, height: 4096 });
	});

	it("leaves H.265 and sizes already under the cap alone", () => {
		expect(
			calculateMp4ExportSettings({
				quality: "source",
				sourceWidth: 5120,
				sourceHeight: 2880,
				aspectRatioValue: 16 / 9,
				frameRate: 30,
				codec: "h265",
			}),
		).toMatchObject({ width: 5120, height: 2880 });
		expect(
			calculateMp4ExportSettings({
				quality: "source",
				sourceWidth: 3840,
				sourceHeight: 2160,
				aspectRatioValue: 16 / 9,
				frameRate: 30,
			}),
		).toMatchObject({ width: 3840, height: 2160 });
	});
});

describe("calculateMp4ExportSettings", () => {
	it("keeps 1080p explicit even when it upscales short native captures", () => {
		const aspectRatioValue = 1920 / 1032;

		expect(
			calculateMp4ExportSettings({
				quality: "good",
				sourceWidth: 1920,
				sourceHeight: 1032,
				aspectRatioValue,
				frameRate: 60,
			}),
		).toMatchObject({
			width: 2008,
			height: 1080,
		});

		expect(
			calculateMp4ExportSettings({
				quality: "source",
				sourceWidth: 1920,
				sourceHeight: 1032,
				aspectRatioValue,
				frameRate: 60,
			}),
		).toMatchObject({
			width: 1920,
			height: 1032,
		});
	});

	it("keeps lower quality presets below the source size when downscaling is useful", () => {
		expect(
			calculateMp4ExportSettings({
				quality: "medium",
				sourceWidth: 1920,
				sourceHeight: 1032,
				aspectRatioValue: 1920 / 1032,
				frameRate: 60,
			}),
		).toMatchObject({
			width: 1338,
			height: 720,
		});
	});

	it("keeps 1080p explicit even for 720p source dimensions", () => {
		expect(
			calculateMp4ExportSettings({
				quality: "good",
				sourceWidth: 1280,
				sourceHeight: 720,
				aspectRatioValue: 16 / 9,
				frameRate: 60,
			}),
		).toMatchObject({
			width: 1920,
			height: 1080,
		});
	});

	it("preserves source-sized High exports when the source is already 1080p or larger", () => {
		expect(
			calculateMp4ExportSettings({
				quality: "source",
				sourceWidth: 1920,
				sourceHeight: 1080,
				aspectRatioValue: 16 / 9,
				frameRate: 60,
			}),
		).toMatchObject({
			width: 1920,
			height: 1080,
		});

		expect(
			calculateMp4ExportSettings({
				quality: "source",
				sourceWidth: 3840,
				sourceHeight: 2160,
				aspectRatioValue: 16 / 9,
				frameRate: 60,
			}),
		).toMatchObject({
			width: 3840,
			height: 2160,
		});
	});

	it("keeps portrait presets on the short side", () => {
		expect(
			calculateMp4ExportSettings({
				quality: "good",
				sourceWidth: 1080,
				sourceHeight: 1920,
				aspectRatioValue: 9 / 16,
				frameRate: 60,
			}),
		).toMatchObject({
			width: 1080,
			height: 1920,
		});
	});

	it("does not call letterbox rows an upscale (1920x1032 window capture, 16:9 project)", () => {
		const source = { width: 1920, height: 1032 };
		const tier = (quality: "medium" | "good" | "source") =>
			calculateMp4ExportSettings({
				quality,
				sourceWidth: source.width,
				sourceHeight: source.height,
				aspectRatioValue: 16 / 9,
				frameRate: 60,
			});

		// The reported bug: both tiers resolve to the exact same 1920x1080 frame, so they must
		// carry the same badge. The old short-side test flagged only one of them.
		expect(tier("good")).toMatchObject({ width: 1920, height: 1080 });
		expect(tier("source")).toMatchObject({ width: 1920, height: 1080 });
		expect(wouldUpscale(tier("good"), source)).toBe(false);
		expect(wouldUpscale(tier("source"), source)).toBe(false);
		expect(wouldUpscale(tier("medium"), source)).toBe(false);
	});

	it("still flags a tier that genuinely stretches the source", () => {
		const source = { width: 1280, height: 720 };
		expect(
			wouldUpscale(
				calculateMp4ExportSettings({
					quality: "good",
					sourceWidth: source.width,
					sourceHeight: source.height,
					aspectRatioValue: 16 / 9,
					frameRate: 60,
				}),
				source,
			),
		).toBe(true);
	});

	it("uses the cropped area as the effective source size", () => {
		const effectiveSource = calculateEffectiveSourceDimensions(3840, 2160, {
			width: 854 / 3840,
			height: 480 / 2160,
		});

		expect(effectiveSource).toEqual({
			width: 854,
			height: 480,
		});

		expect(
			calculateMp4ExportSettings({
				quality: "source",
				sourceWidth: effectiveSource.width,
				sourceHeight: effectiveSource.height,
				aspectRatioValue: effectiveSource.width / effectiveSource.height,
				frameRate: 60,
			}),
		).toMatchObject({
			width: 854,
			height: 480,
		});

		expect(
			calculateMp4ExportSettings({
				quality: "good",
				sourceWidth: effectiveSource.width,
				sourceHeight: effectiveSource.height,
				aspectRatioValue: effectiveSource.width / effectiveSource.height,
				frameRate: 60,
			}),
		).toMatchObject({
			width: 1920,
			height: 1080,
		});
	});
});

describe("calculateMp4ExportSettings bitrate", () => {
	const bitrate = (quality: "medium" | "good" | "source", frameRate: number, source = 1080) =>
		calculateMp4ExportSettings({
			quality,
			sourceWidth: (source * 16) / 9,
			sourceHeight: source,
			aspectRatioValue: 16 / 9,
			frameRate,
		}).bitrate;

	it("gives a 1080p60 export 18.7 Mb/s, where the pipeline alone gave it 8", () => {
		expect(bitrate("good", 60)).toBe(18_662_400);
	});

	it("scales with the frame rate: twice the frames, twice the bits", () => {
		expect(bitrate("good", 60)).toBe(2 * bitrate("good", 30));
		expect(bitrate("good", 24)).toBeLessThan(bitrate("good", 30));
	});

	it("scales with the pixels, whichever tier produced them", () => {
		// 4K is four 1080p frames; "Source" gets no bonus over the pixels it adds.
		expect(bitrate("source", 60, 2160)).toBe(4 * bitrate("good", 60));
		expect(bitrate("source", 60, 1080)).toBe(bitrate("good", 60));
		expect(bitrate("medium", 60)).toBeLessThan(bitrate("good", 60));
	});

	it("keeps a floor for tiny outputs", () => {
		expect(bitrate("source", 24, 180)).toBe(2_000_000);
	});
});
