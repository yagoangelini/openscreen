/**
 * A timeout that only fires after `ms` WITHOUT activity, for child processes that
 * stream their output.
 *
 * Audio extraction used a fixed total timeout of 60 s. A 2-hour recording on a USB
 * drive can legitimately take longer than that to demux end to end, so transcription
 * and the waveform failed on exactly the recordings that need them most. What the
 * timeout is really for -- a wedged ffmpeg -- shows up as output stopping, so each
 * chunk of output re-arms it instead.
 */
export function createInactivityTimer(ms: number, onIdle: () => void) {
	let timer = setTimeout(onIdle, ms);
	return {
		/** Output arrived: the process is alive, start the wait over. */
		touch() {
			clearTimeout(timer);
			timer = setTimeout(onIdle, ms);
		},
		clear() {
			clearTimeout(timer);
		},
	};
}
