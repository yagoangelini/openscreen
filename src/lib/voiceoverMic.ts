/**
 * What the voiceover recorder asks the browser for. The microphone picked in the HUD,
 * not the Windows default: a voiceover from the laptop's built-in mic over a take made
 * on a USB one is a different voice. Matched by id, then by name (the id is per origin
 * and can change when the device is replugged).
 *
 * The browser's own noise suppression stays on, as before, except over NVIDIA
 * Broadcast's microphone, which has already cleaned the voice: suppressing twice leaves
 * it thin and warbling. Echo cancellation stays on because the timeline plays while
 * the voiceover records, and through speakers it would be recorded back.
 */
export function voiceoverAudioConstraints(
	devices: ReadonlyArray<{ kind: string; deviceId: string; label: string }>,
	prefs: { micDeviceId?: string | null; micDeviceName?: string | null } | null | undefined,
): MediaTrackConstraints {
	const inputs = devices.filter((device) => device.kind === "audioinput");
	const chosen =
		inputs.find(
			(device) => Boolean(prefs?.micDeviceId) && device.deviceId === prefs?.micDeviceId,
		) ??
		inputs.find((device) => Boolean(prefs?.micDeviceName) && device.label === prefs?.micDeviceName);
	const broadcast = /nvidia broadcast/i.test(chosen?.label ?? "");
	return {
		...(chosen ? { deviceId: { exact: chosen.deviceId } } : {}),
		echoCancellation: true,
		noiseSuppression: !broadcast,
	};
}
