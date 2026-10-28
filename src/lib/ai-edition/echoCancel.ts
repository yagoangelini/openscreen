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
