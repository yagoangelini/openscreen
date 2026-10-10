import type { CursorRecordingData } from "../../../../src/native/contracts";

export interface CursorRecordingSession {
	start(): Promise<void>;
	stop(): Promise<CursorRecordingData>;
	/**
	 * What has been recorded so far, without stopping -- the live arrays, in
	 * arrival order, for the crash-safe checkpoint to append from. Optional: a
	 * session without it simply is not checkpointed.
	 */
	peek?(): Pick<CursorRecordingData, "samples" | "assets">;
}
