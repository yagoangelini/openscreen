// What the speaker-echo canceller (Rust `echo_cancel.rs`, `EchoReport`) says about a take, and
// the strengths it runs at. No `@/` import: the main process reads it too.

/** "Intensidade" of "Remover eco do alto-falante", mildest first (Rust `Strength::parse`). */
export const ECHO_CANCEL_STRENGTHS = ["gentle", "normal", "strong"] as const;
export type EchoCancelStrength = (typeof ECHO_CANCEL_STRENGTHS)[number];

export function isEchoCancelStrength(value: unknown): value is EchoCancelStrength {
	return typeof value === "string" && (ECHO_CANCEL_STRENGTHS as readonly string[]).includes(value);
}

export interface EchoCancelReport {
	/** A consistent speaker echo was found in the voice stem. */
	detected: boolean;
	/** Echo delay at the start and at the end of the take, in ms (the two clocks drift). */
	delayMs: number;
	delayEndMs: number;
	driftPpm: number;
	/** Windows where the computer played, and those whose peak agreed with the echo path. */
	windows: number;
	consistentWindows: number;
	/** Echo level in the microphone relative to the user's own voice, in dB. */
	echoToVoiceDb: number;
	/** How much quieter the frames where only the speakers were heard came out, in dB. */
	erleDb: number;
	linearErleDb: number;
	processedShare: number;
	adaptShare: number;
	durationSec: number;
	/** How loud the speakers reached the microphone relative to the computer stem, in dB. */
	echoPathGainDb?: number;
	/** The computer stem's true peak, in dBFS. */
	systemTruePeakDbfs?: number;
	/** The computer lane's automatic compensation (`system_compensation_db`), in dB. */
	systemCompensationDb?: number;
	/** Share of the processed frames the near-end gate held closed (cache version 3 on). */
	gateClosedShare?: number;
}

export interface EchoCancelResult {
	success: boolean;
	/** The echo-free voice, when an echo was found and removed. */
	path?: string;
	report?: EchoCancelReport;
	message?: string;
}
