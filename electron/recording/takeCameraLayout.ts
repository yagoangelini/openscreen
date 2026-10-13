import {
	parseRecordingLayout,
	type RecordingCameraLayout,
	type RecordingLayoutFile,
	type RecordingLayoutSwitch,
} from "../../src/lib/recordingLayout";

/**
 * Where a running take is on its own media clock: ms since its first frame, with the
 * paused time left out -- the clock the markers use, so a switch lands on the frame the
 * editor shows at that time. `null` before the first frame (a countdown, or the helper
 * still opening its devices). While paused the clock stands at the moment of the pause.
 */
export function takeMediaTimeMs(clock: {
	nowMs: number;
	captureStartedAtMs: number | null;
	pausedTotalMs: number;
	pausedSinceMs: number | null;
}): number | null {
	if (clock.captureStartedAtMs === null) return null;
	const reference = clock.pausedSinceMs ?? clock.nowMs;
	return Math.max(0, Math.round(reference - clock.captureStartedAtMs - clock.pausedTotalMs));
}

/**
 * The "Rosto / Tela + câmera" switches of one take. A switch before the first frame
 * changes where the take starts; after it, it is a switch at that media time. Switching to
 * the layout already shown records nothing.
 */
export class TakeCameraLayoutLog {
	private initialLayout: RecordingCameraLayout;
	private readonly switchesLog: RecordingLayoutSwitch[] = [];

	constructor(initial: RecordingCameraLayout) {
		this.initialLayout = initial;
	}

	get current(): RecordingCameraLayout {
		return this.switchesLog.at(-1)?.layout ?? this.initialLayout;
	}

	/** `mediaMs` null: before the first frame. Returns the layout now shown. */
	switchTo(layout: RecordingCameraLayout, mediaMs: number | null): RecordingCameraLayout {
		if (layout === this.current) return layout;
		if (mediaMs === null) {
			this.initialLayout = layout;
			return layout;
		}
		const last = this.switchesLog.at(-1);
		// Two switches on one media ms (twice while paused): the later one is what shows.
		if (last && mediaMs <= last.atMs) {
			this.switchesLog.pop();
		}
		if (layout !== this.current) {
			this.switchesLog.push({ atMs: Math.max(0, Math.round(mediaMs)), layout });
		}
		return this.current;
	}

	/** True when the take is not the default from start to end, so a sidecar is worth writing. */
	get isWorthWriting(): boolean {
		return this.initialLayout === "face" || this.switchesLog.length > 0;
	}

	toFile(): RecordingLayoutFile {
		// Through the parser, so what is written is exactly what the import will read.
		return (
			parseRecordingLayout({ initial: this.initialLayout, switches: this.switchesLog }) ?? {
				version: 1,
				initial: this.initialLayout,
				switches: [],
			}
		);
	}
}

/**
 * The wall clock of a take's media time 0: the helper's own first-frame time when it gave a
 * plausible one (at most 2 s before this process heard of the first frame), else the moment
 * it heard. Switches, markers and the stop are all measured from it.
 */
export function mediaClockOriginMs(firstFrameEpochMs: number | null, heardAtMs: number): number {
	if (
		firstFrameEpochMs === null ||
		!Number.isFinite(firstFrameEpochMs) ||
		firstFrameEpochMs > heardAtMs ||
		firstFrameEpochMs < heardAtMs - 2_000
	) {
		return heardAtMs;
	}
	return firstFrameEpochMs;
}
