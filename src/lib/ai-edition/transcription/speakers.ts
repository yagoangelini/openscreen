// "Quem está falando": each transcript word labelled with who said it, from the take's two
// audio stems -- the microphone ("Você") and the computer's sound ("Convidado": the other
// side of a Teams call, a video played on screen).
//
// HOW. Over each word's span, the RMS of each stem's peak envelope (the same `getAudioPeaks`
// the timeline waveform uses, cached on disk), each divided by that stem's own speaking level
// (its 95th percentile) so a quiet mic and a loud call compare fairly. The louder side by
// more than `MARGIN_DB` is the speaker; a word where neither side clearly wins (both near
// silence, or crosstalk) takes the speaker of the word before it in its segment, or failing
// that the nearest decided word. A segment's speaker is the one holding most of its time.
//
// LIMITS, said out loud because no amount of tuning removes them:
//   - Two people on the SAME microphone are one speaker here: the stems separate devices,
//     not voices.
//   - The guest is only in the transcript when the transcription heard the computer's sound:
//     by default a take with stems is transcribed from the voice stem alone; the
//     "transcribe the guest too" preference transcribes the mixed track instead.
//   - Loud speakers (no headphones) put the guest into the mic too. The comparison is
//     relative, so a guest heard through the room still reads as the computer as long as
//     the call is louder in its own stem than its echo in the mic -- the usual case.

import type { AxcutTranscript, AxcutWord } from "../schema";

export type Speaker = "mic" | "system";

/** A side must be this much louder (relative to its own level) to own the word. */
export const MARGIN_DB = 3;
/** Below this fraction of its own speaking level a stem is taken as silent. */
const SILENT_FRACTION = 0.06;
const EPS = 1e-6;

/** Peak amplitude per block from the [min, max] pairs `getAudioPeaks` returns. */
export function peakAmplitudes(peaks: Float32Array): Float32Array {
	const out = new Float32Array(Math.floor(peaks.length / 2));
	for (let i = 0; i < out.length; i++) {
		out[i] = Math.max(Math.abs(peaks[2 * i]), Math.abs(peaks[2 * i + 1]));
	}
	return out;
}

/**
 * Never compare against a level quieter than this (about -34 dBFS): a stem that only ever
 * carries its noise floor would otherwise be "speaking" at its own floor.
 */
const MIN_LEVEL = 0.02;

/** A stem's speaking level: the 95th percentile of its blocks, at least `MIN_LEVEL`. */
export function stemLevel(amps: Float32Array): number {
	if (amps.length === 0) return MIN_LEVEL;
	const sorted = Array.from(amps).sort((a, b) => a - b);
	return Math.max(MIN_LEVEL, sorted[Math.min(sorted.length - 1, Math.floor(sorted.length * 0.95))]);
}

interface Envelope {
	amps: Float32Array;
	blockSec: number;
	level: number;
}

function envelope(peaks: Float32Array, durationSec: number): Envelope | null {
	const amps = peakAmplitudes(peaks);
	if (amps.length === 0 || !(durationSec > 0)) return null;
	return { amps, blockSec: durationSec / amps.length, level: stemLevel(amps) };
}

/** RMS of the envelope over [startSec, endSec), relative to the stem's level. */
function relativeRms(env: Envelope, startSec: number, endSec: number): number {
	if (env.level <= EPS) return 0;
	const first = Math.max(0, Math.floor(startSec / env.blockSec));
	const last = Math.min(env.amps.length, Math.max(first + 1, Math.ceil(endSec / env.blockSec)));
	let sum = 0;
	let n = 0;
	for (let i = first; i < last; i++) {
		sum += env.amps[i] * env.amps[i];
		n += 1;
	}
	return n > 0 ? Math.sqrt(sum / n) / env.level : 0;
}

/** Who said a span, or null when neither stem clearly holds it. */
export function speakerForSpan(
	voice: Envelope,
	system: Envelope,
	startSec: number,
	endSec: number,
): Speaker | null {
	const v = relativeRms(voice, startSec, endSec);
	const s = relativeRms(system, startSec, endSec);
	if (v < SILENT_FRACTION && s < SILENT_FRACTION) return null;
	const diffDb = 20 * Math.log10((v + EPS) / (s + EPS));
	if (diffDb >= MARGIN_DB) return "mic";
	if (diffDb <= -MARGIN_DB) return "system";
	return null;
}

export interface SpeakerLabelling {
	transcript: AxcutTranscript;
	/** Words labelled "mic" and "system". Both 0: nothing could be told apart. */
	mic: number;
	system: number;
}

function withoutSpeaker<T extends { speaker?: Speaker }>(item: T): T {
	if (item.speaker === undefined) return item;
	const { speaker: _, ...rest } = item;
	return rest as T;
}

/**
 * The transcript with `speaker` on every word and segment, from the two stems' peaks
 * (`getAudioPeaks` of the voice and system .m4a, both read over `durationSec`). When
 * nothing can be decided -- a silent stem, peaks missing -- every label is removed rather
 * than guessed.
 */
export function labelSpeakers(
	transcript: AxcutTranscript,
	voicePeaks: Float32Array,
	systemPeaks: Float32Array,
	durationSec: number,
): SpeakerLabelling {
	const voice = envelope(voicePeaks, durationSec);
	const system = envelope(systemPeaks, durationSec);
	const cleared = (): SpeakerLabelling => ({
		transcript: {
			...transcript,
			words: transcript.words.map(withoutSpeaker),
			segments: transcript.segments.map(withoutSpeaker),
		},
		mic: 0,
		system: 0,
	});
	if (!voice || !system) return cleared();

	const decided: Array<Speaker | null> = transcript.words.map((w) =>
		w.source === "synth" ? null : speakerForSpan(voice, system, w.startSec, w.endSec),
	);
	if (decided.every((s) => s === null)) return cleared();

	// Undecided words: the previous word of the same segment, else the nearest decided word.
	const filled = decided.slice();
	for (let i = 0; i < filled.length; i++) {
		if (filled[i] !== null) continue;
		const prev = i > 0 ? filled[i - 1] : null;
		if (prev !== null && transcript.words[i - 1].segmentId === transcript.words[i].segmentId) {
			filled[i] = prev;
			continue;
		}
		let best: Speaker | null = null;
		let bestDistance = Number.POSITIVE_INFINITY;
		for (let j = 0; j < decided.length; j++) {
			const s = decided[j];
			if (s === null) continue;
			const distance = Math.abs(transcript.words[j].startSec - transcript.words[i].startSec);
			if (distance < bestDistance) {
				bestDistance = distance;
				best = s;
			}
		}
		filled[i] = best;
	}

	const words: AxcutWord[] = transcript.words.map((w, i) => {
		const speaker = filled[i];
		return speaker ? { ...w, speaker } : withoutSpeaker(w);
	});
	const byId = new Map(words.map((w) => [w.id, w]));
	const segments = transcript.segments.map((segment) => {
		const time: Record<Speaker, number> = { mic: 0, system: 0 };
		for (const id of segment.wordIds) {
			const w = byId.get(id);
			if (w?.speaker) time[w.speaker] += Math.max(0.01, w.endSec - w.startSec);
		}
		if (time.mic === 0 && time.system === 0) {
			const own = speakerForSpan(voice, system, segment.startSec, segment.endSec);
			return own ? { ...segment, speaker: own } : withoutSpeaker(segment);
		}
		return { ...segment, speaker: time.system > time.mic ? ("system" as const) : ("mic" as const) };
	});
	return {
		transcript: { ...transcript, words, segments },
		mic: words.filter((w) => w.speaker === "mic").length,
		system: words.filter((w) => w.speaker === "system").length,
	};
}

/** Whether labels are worth showing: both sides speak somewhere in it. */
export function transcriptHasTwoSpeakers(transcript: AxcutTranscript | null | undefined): boolean {
	if (!transcript) return false;
	let mic = false;
	let system = false;
	for (const w of transcript.words) {
		if (w.speaker === "mic") mic = true;
		else if (w.speaker === "system") system = true;
		if (mic && system) return true;
	}
	return false;
}
