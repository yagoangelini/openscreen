// What the speaker-echo canceller (Rust `echo_cancel.rs`, `EchoReport`) says about a take. Types
// only, with no `@/` import: the main process reads it too.

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
}

export interface EchoCancelResult {
	success: boolean;
	/** The echo-free voice, when an echo was found and removed. */
	path?: string;
	report?: EchoCancelReport;
	message?: string;
}
