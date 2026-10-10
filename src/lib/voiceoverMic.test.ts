import { describe, expect, it } from "vitest";
import { voiceoverAudioConstraints } from "./voiceoverMic";

const devices = [
	{ kind: "audioinput", deviceId: "default", label: "Padrão - Microfone (Realtek)" },
	{ kind: "audioinput", deviceId: "usb-1", label: "Microfone (Fifine K669)" },
	{ kind: "audioinput", deviceId: "nv-1", label: "Microfone (NVIDIA Broadcast)" },
	{ kind: "audiooutput", deviceId: "usb-1", label: "Fones (Fifine K669)" },
];

describe("voiceoverAudioConstraints", () => {
	it("records from the microphone picked in the HUD, not the Windows default", () => {
		expect(voiceoverAudioConstraints(devices, { micDeviceId: "usb-1" })).toEqual({
			deviceId: { exact: "usb-1" },
			echoCancellation: true,
			noiseSuppression: true,
		});
	});

	it("finds it by name when its id changed", () => {
		expect(
			voiceoverAudioConstraints(devices, {
				micDeviceId: "stale-id",
				micDeviceName: "Microfone (Fifine K669)",
			}).deviceId,
		).toEqual({ exact: "usb-1" });
	});

	it("does not suppress noise a second time over NVIDIA Broadcast", () => {
		expect(voiceoverAudioConstraints(devices, { micDeviceId: "nv-1" })).toMatchObject({
			deviceId: { exact: "nv-1" },
			noiseSuppression: false,
		});
	});

	it("falls back to the default microphone when none was picked or it is gone", () => {
		expect(voiceoverAudioConstraints(devices, null)).toEqual({
			echoCancellation: true,
			noiseSuppression: true,
		});
		expect(voiceoverAudioConstraints(devices, { micDeviceId: "unplugged" })).not.toHaveProperty(
			"deviceId",
		);
	});
});
