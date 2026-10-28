// Reads a take's two stems for `labelSpeakers`: the peaks `getAudioPeaks` already computes
// (and caches on disk) for the timeline waveform, over the take's duration so both stems
// land on the same blocks.

import { echoFreeVoicePath } from "../echoCancel";
import type { AxcutAsset, AxcutTranscript } from "../schema";
import { labelSpeakers, type SpeakerLabelling } from "./speakers";

export type PeaksReader = (filePath: string, durationSec: number) => Promise<Float32Array | null>;

const electronPeaks: PeaksReader = async (filePath, durationSec) => {
	const result = await window.electronAPI?.getAudioPeaks?.(filePath, durationSec);
	return result?.success ? (result.peaks ?? null) : null;
};

export interface StemPeaks {
	voice: Float32Array;
	system: Float32Array;
	durationSec: number;
}

/**
 * Both stems' peaks, or null when the take cannot say who spoke: no stems, no known length,
 * or a stem that would not decode. Never throws: a label is a nicety, and a missing one must
 * not cost the transcript it would have decorated.
 */
export async function readStemPeaks(
	asset: Pick<AxcutAsset, "audioStems" | "durationSec">,
	readPeaks: PeaksReader = electronPeaks,
): Promise<StemPeaks | null> {
	const stems = asset.audioStems;
	const durationSec = asset.durationSec;
	if (!stems || !durationSec || durationSec <= 0) return null;
	try {
		// The voice without the speaker echo when the canceller has made it: with the echo, the
		// guest's words are loud in the voice stem too and could count as the user's.
		const voicePath = echoFreeVoicePath(stems.voicePath, stems.systemPath) ?? stems.voicePath;
		const [voice, system] = await Promise.all([
			readPeaks(voicePath, durationSec),
			readPeaks(stems.systemPath, durationSec),
		]);
		return voice && system ? { voice, system, durationSec } : null;
	} catch (error) {
		console.warn("[speakers] the take's stems could not be read:", error);
		return null;
	}
}

/** `transcript` labelled by who spoke, or null when the take cannot say (see readStemPeaks). */
export async function labelTranscriptFromStems(
	asset: Pick<AxcutAsset, "audioStems" | "durationSec">,
	transcript: AxcutTranscript,
	readPeaks: PeaksReader = electronPeaks,
): Promise<SpeakerLabelling | null> {
	const peaks = await readStemPeaks(asset, readPeaks);
	return peaks ? labelSpeakers(transcript, peaks.voice, peaks.system, peaks.durationSec) : null;
}
