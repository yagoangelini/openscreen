import type { SceneDescription } from "@/native/sceneDescription";

/**
 * Loudness for delivery to YouTube.
 *
 * Every voice file is already normalised to −16 LUFS by the compositor
 * (`LOUDNESS_TARGET_LUFS`), the same gain in the preview and the export. YouTube
 * plays everything at −14 LUFS and turns louder uploads down, never quieter ones
 * up, so a −16 video simply plays 2 dB softer than its neighbours. This lifts the
 * export's output trim by the difference; the export's look-ahead limiter
 * (−1.5 dBFS) still has the last word on peaks. The preview is left alone: it is
 * a delivery target, not part of the edit.
 */
export const YOUTUBE_LOUDNESS_LUFS = -14;
const NORMALISED_VOICE_LUFS = -16;
/** The compositor clamps the trim to this either way (`finish_audio`). */
const MAX_TRIM_DB = 12;

export function withDeliveryLoudness(
	scene: SceneDescription,
	youtubeLoudness: boolean,
): SceneDescription {
	if (!youtubeLoudness) return scene;
	const lift = YOUTUBE_LOUDNESS_LUFS - NORMALISED_VOICE_LUFS;
	return {
		...scene,
		audio: { ...scene.audio, gainDb: Math.min(MAX_TRIM_DB, scene.audio.gainDb + lift) },
	};
}
