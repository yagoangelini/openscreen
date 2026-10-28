// "Remover eco do alto-falante" on the renderer side: asks the main process for a take's
// echo-free voice (`prepare-echo-cancelled-voice`, Rust `echo_cancel.rs`) and remembers the
// answer, so the scene builder — which cannot await — can read it, the way `clickSound.ts` does
// for the click samples. The preview plays the same file the export reads.

import { useEffect, useState } from "react";
import type { EchoCancelReport } from "./echoCancelReport";
import type { AxcutDocument } from "./schema";
import { getEditorSettings } from "./store/editorSettings";

export type { EchoCancelReport } from "./echoCancelReport";

export interface EchoCancelState {
	/** The echo-free voice, when an echo was found. */
	path?: string;
	report?: EchoCancelReport;
}

const settled = new Map<string, EchoCancelState>();
const pending = new Map<string, Promise<EchoCancelState | null>>();
const listeners = new Set<() => void>();

function keyOf(voicePath: string, systemPath: string): string {
	return `${voicePath}\n${systemPath}`;
}

/** Most a compensation may add (Rust `MAX_SYSTEM_COMPENSATION_DB`). */
export const MAX_SYSTEM_COMPENSATION_DB = 30;

/**
 * The computer lane's compensation for an echo path of `echoPathGainDb`: that gain, but never
 * below 0 dB, never above `MAX_SYSTEM_COMPENSATION_DB`, and never past what keeps the stem's
 * true peak at −1 dBFS. Rust `system_compensation_db` (`echo_cancel.rs`) is the same function,
 * with the same test points.
 */
export function clampSystemCompensationDb(
	echoPathGainDb: number,
	systemTruePeakDbfs: number,
): number {
	if (!Number.isFinite(echoPathGainDb)) return 0;
	const headroom = Number.isFinite(systemTruePeakDbfs) ? -1 - systemTruePeakDbfs : 0;
	return Math.max(0, Math.min(echoPathGainDb, MAX_SYSTEM_COMPENSATION_DB, headroom));
}

/**
 * The computer lane's gain: its own volume, plus, when it is compensated, the echo path's gain AND
 * the voice's loudness gain (the echo it stands in for lived in the voice stem and was levelled
 * with it). Rust `system_lane_gain_db` (`audio_stream.rs`) is the same sum: the export applies
 * that one, the preview this one.
 */
export function systemLaneGainDb(
	laneGainDb: number,
	compensationDb: number,
	voiceLoudnessDb: number,
): number {
	return compensationDb > 0 ? laneGainDb + compensationDb + voiceLoudnessDb : laneGainDb;
}

/**
 * What the computer lane is raised by: once the echo is removed, the guest is only in the
 * computer stem, usually far quieter than the microphone heard them (the take of 27/10: −41.5
 * LUFS against the voice's −18.3). The compensation puts them back at the level the microphone
 * heard, once and clean. 0 with the echo removal off, with the switch off, when no echo was
 * found, or with a report from before the field.
 */
export function systemCompensationDb(
	settings: { echoCancel: boolean; systemCompensation: boolean },
	state: EchoCancelState | undefined,
): number {
	const report = state?.report;
	if (!settings.echoCancel || !settings.systemCompensation || !state?.path || !report?.detected) {
		return 0;
	}
	if (report.echoPathGainDb === undefined || report.systemTruePeakDbfs === undefined) return 0;
	return clampSystemCompensationDb(report.echoPathGainDb, report.systemTruePeakDbfs);
}

/** What is known so far about a take's stems; undefined until the canceller has answered. */
export function echoCancelState(
	voicePath: string,
	systemPath: string,
): EchoCancelState | undefined {
	return settled.get(keyOf(voicePath, systemPath));
}

/** The echo-free voice to read in place of `voicePath`, when one is ready. */
export function echoFreeVoicePath(voicePath: string, systemPath: string): string | undefined {
	return settled.get(keyOf(voicePath, systemPath))?.path;
}

/** Runs (or joins) the canceller for one take. Null when it could not run. */
export function prepareEchoCancelledVoice(
	voicePath: string,
	systemPath: string,
): Promise<EchoCancelState | null> {
	const key = keyOf(voicePath, systemPath);
	const known = settled.get(key);
	if (known) return Promise.resolve(known);
	const running = pending.get(key);
	if (running) return running;
	const ask = window.electronAPI?.prepareEchoCancelledVoice;
	if (!ask) return Promise.resolve(null);
	const job = ask(voicePath, systemPath).then(
		(result) => {
			pending.delete(key);
			if (!result.success) return null;
			const state: EchoCancelState = { path: result.path, report: result.report };
			settled.set(key, state);
			for (const listener of listeners) listener();
			return state;
		},
		() => {
			pending.delete(key);
			return null;
		},
	);
	pending.set(key, job);
	return job;
}

/**
 * Before an export: the echo-free voice of every take with stems, when the project has the
 * canceller on. A take whose canceller fails exports with its voice as recorded.
 */
export async function prepareEchoCancel(document: AxcutDocument): Promise<void> {
	if (!getEditorSettings(document).echoCancel) return;
	await Promise.all(
		document.assets.flatMap((asset) =>
			asset.audioStems
				? [
						prepareEchoCancelledVoice(
							asset.audioStems.voicePath,
							asset.audioStems.systemPath,
						).catch(() => null),
					]
				: [],
		),
	);
}

/** A take's canceller state, run on demand while `enabled`, re-rendering when it lands. */
export function useEchoCancel(
	voicePath: string | undefined,
	systemPath: string | undefined,
	enabled: boolean,
): { state: EchoCancelState | undefined; running: boolean } {
	const [, setTick] = useState(0);
	useEffect(() => {
		const listener = () => setTick((tick) => tick + 1);
		listeners.add(listener);
		return () => {
			listeners.delete(listener);
		};
	}, []);
	useEffect(() => {
		if (!enabled || !voicePath || !systemPath) return;
		void prepareEchoCancelledVoice(voicePath, systemPath).then(() => setTick((tick) => tick + 1));
	}, [enabled, voicePath, systemPath]);
	if (!voicePath || !systemPath) return { state: undefined, running: false };
	const key = keyOf(voicePath, systemPath);
	return { state: settled.get(key), running: enabled && pending.has(key) };
}

/** Test seam: forget every answer. */
export function resetEchoCancelCache(): void {
	settled.clear();
	pending.clear();
}

/** Test seam: an answer as the main process would give it. */
export function seedEchoCancelState(
	voicePath: string,
	systemPath: string,
	state: EchoCancelState,
): void {
	settled.set(keyOf(voicePath, systemPath), state);
}
