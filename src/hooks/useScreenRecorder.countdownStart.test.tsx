// @vitest-environment jsdom
import { act, renderHook, waitFor } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";

vi.mock("@/contexts/I18nContext", () => ({
	useScopedT: () => (key: string) => key,
}));

vi.mock("sonner", () => ({
	toast: { error: vi.fn(), success: vi.fn(), info: vi.fn(), warning: vi.fn() },
}));

vi.mock("@/lib/requestCameraAccess", () => ({
	requestCameraAccess: vi.fn(async () => ({ success: true, granted: true, status: "granted" })),
}));

import { useScreenRecorder } from "./useScreenRecorder";

type ElectronAPI = Window["electronAPI"];
type RecordingPrefs = Awaited<ReturnType<ElectronAPI["getRecordingPrefs"]>>;

const CAMERA = { kind: "videoinput", deviceId: "cam-1", label: "HD Pro Webcam C920", groupId: "" };
const SOURCE = { id: "screen:0:0", name: "Screen 1", display_id: "1" };

const prefs: RecordingPrefs = {
	micEnabled: false,
	micDeviceId: null,
	micDeviceName: null,
	camEnabled: true,
	camDeviceId: null,
	camDeviceName: null,
	camQuality: "1080p",
	systemAudioEnabled: false,
	cursorCaptureMode: "editable-overlay",
	hideDesktopIcons: false,
	autoZoomEnabled: true,
	recordingsFolder: null,
	countdownSeconds: 1,
	micChannelMode: "auto",
	cameraLayout: "screen",
	micSilenceWarningEnabled: true,
	headphonesHintEnabled: true,
};

function stub(startResult: () => Promise<unknown>) {
	const api = {
		getRecordingPrefs: vi.fn(async () => prefs),
		setRecordingPrefs: vi.fn(async (patch: Partial<RecordingPrefs>) => ({ ...prefs, ...patch })),
		onRecordingPrefsChanged: vi.fn(() => () => undefined),
		getPlatform: vi.fn(() => "win32"),
		getSelectedSource: vi.fn(async () => SOURCE),
		showCountdownOverlay: vi.fn(async () => undefined),
		setCountdownOverlayValue: vi.fn(async () => undefined),
		hideCountdownOverlay: vi.fn(async () => undefined),
		checkRecordingStorage: vi.fn(async () => ({ success: true })),
		isNativeWindowsCaptureAvailable: vi.fn(async () => ({ success: true, available: true })),
		startNativeWindowsRecording: vi.fn(startResult),
		stopNativeWindowsRecording: vi.fn(async () => ({ success: true })),
		cancelNativeWindowsPendingStart: vi.fn(async () => true),
	};
	window.electronAPI = api as unknown as ElectronAPI;
	const getUserMedia = vi.fn(async () => ({ getVideoTracks: () => [], getTracks: () => [] }));
	Object.defineProperty(navigator, "mediaDevices", {
		configurable: true,
		value: { enumerateDevices: vi.fn(async () => [CAMERA]), getUserMedia },
	});
	return { api, getUserMedia };
}

describe("useScreenRecorder: a Windows take starts with its countdown", () => {
	afterEach(() => {
		vi.restoreAllMocks();
	});

	it("asks the helper for the take as the countdown begins, timed to its end", async () => {
		const { api, getUserMedia } = stub(async () => ({ success: true, recordingId: 7 }));
		const view = renderHook(() => useScreenRecorder());
		await waitFor(() => expect(view.result.current.recordingPrefsLoaded).toBe(true));

		const pressedAt = Date.now();
		act(() => view.result.current.toggleRecording());

		// Before the one-second countdown is over.
		await waitFor(() => expect(api.startNativeWindowsRecording).toHaveBeenCalled());
		expect(Date.now() - pressedAt).toBeLessThan(900);
		const [request] = api.startNativeWindowsRecording.mock.calls[0] as unknown as [
			{ startAtEpochMs?: number; webcam: { deviceId?: string; deviceName?: string } },
		];
		expect(request.startAtEpochMs).toBeGreaterThanOrEqual(pressedAt + 1000);
		expect(request.startAtEpochMs).toBeLessThan(pressedAt + 1500);
		// Named off the device list: the helper is the camera's only opener.
		expect(request.webcam).toMatchObject({ deviceId: "cam-1", deviceName: "HD Pro Webcam C920" });
		expect(getUserMedia).not.toHaveBeenCalled();

		await waitFor(() => expect(view.result.current.recording).toBe(true));
	});

	/**
	 * D-2 of the 2.4.0 E2E: the source was read (and its sources enumerated, ~0.4 s) a
	 * second time after the countdown had begun, and the checks ran one after another,
	 * leaving the helper 0.9-2.1 s of a 3 s countdown to open everything in.
	 */
	it("reads the source once and has the checks done by the time the countdown begins", async () => {
		const { api } = stub(async () => ({ success: true, recordingId: 7 }));
		const view = renderHook(() => useScreenRecorder());
		await waitFor(() => expect(view.result.current.recordingPrefsLoaded).toBe(true));

		act(() => view.result.current.toggleRecording());
		await waitFor(() => expect(api.startNativeWindowsRecording).toHaveBeenCalled());

		expect(api.getSelectedSource).toHaveBeenCalledTimes(1);
		expect(api.checkRecordingStorage).toHaveBeenCalledTimes(1);
		expect(api.isNativeWindowsCaptureAvailable).toHaveBeenCalledTimes(1);
		await waitFor(() => expect(view.result.current.recording).toBe(true));
	});

	/**
	 * A helper still opening its encoder when the countdown runs out starts late; the
	 * countdown stays up until it has, so the user does not start talking into nothing.
	 */
	it("keeps the countdown up until a late start has begun", async () => {
		let begin: (value: unknown) => void = () => undefined;
		const { api } = stub(() => new Promise((resolve) => (begin = resolve)));
		const view = renderHook(() => useScreenRecorder());
		await waitFor(() => expect(view.result.current.recordingPrefsLoaded).toBe(true));

		act(() => view.result.current.toggleRecording());
		await waitFor(() => expect(api.startNativeWindowsRecording).toHaveBeenCalled());
		// Past the one-second countdown.
		await new Promise((resolve) => setTimeout(resolve, 1300));
		expect(api.hideCountdownOverlay).not.toHaveBeenCalled();
		expect(view.result.current.recording).toBe(false);

		await act(async () => begin({ success: true, recordingId: 7 }));
		await waitFor(() => expect(api.hideCountdownOverlay).toHaveBeenCalled());
		await waitFor(() => expect(view.result.current.recording).toBe(true));
	});

	it("takes the countdown down on its end, the take's first frame, not before", async () => {
		let hiddenAt = 0;
		const { api } = stub(async () => ({ success: true, recordingId: 7 }));
		api.hideCountdownOverlay.mockImplementation(async () => {
			hiddenAt = Date.now();
		});
		const view = renderHook(() => useScreenRecorder());
		await waitFor(() => expect(view.result.current.recordingPrefsLoaded).toBe(true));

		act(() => view.result.current.toggleRecording());
		await waitFor(() => expect(api.startNativeWindowsRecording).toHaveBeenCalled());
		const [request] = api.startNativeWindowsRecording.mock.calls[0] as unknown as [
			{ startAtEpochMs: number },
		];
		await waitFor(() => expect(api.hideCountdownOverlay).toHaveBeenCalled(), { timeout: 3000 });
		// Timers can fire a hair early in jsdom; the old code took it down 150 ms early.
		expect(hiddenAt).toBeGreaterThanOrEqual(request.startAtEpochMs - 20);
		await waitFor(() => expect(view.result.current.recording).toBe(true));
	});

	it("passes the press on Stop to the main process, for the take to end there", async () => {
		const { api } = stub(async () => ({ success: true, recordingId: 7 }));
		const view = renderHook(() => useScreenRecorder());
		await waitFor(() => expect(view.result.current.recordingPrefsLoaded).toBe(true));
		act(() => view.result.current.toggleRecording());
		await waitFor(() => expect(view.result.current.recording).toBe(true), { timeout: 3000 });

		act(() => view.result.current.toggleRecording(1_234_567));
		await waitFor(() => expect(api.stopNativeWindowsRecording).toHaveBeenCalled());
		expect(api.stopNativeWindowsRecording).toHaveBeenCalledWith(false, 1_234_567);
	});

	it("ends the helper when the countdown is cancelled, and records nothing", async () => {
		const { api } = stub(
			() =>
				new Promise((resolve) =>
					setTimeout(() => resolve({ success: false, cancelled: true }), 300),
				),
		);
		const view = renderHook(() => useScreenRecorder());
		await waitFor(() => expect(view.result.current.recordingPrefsLoaded).toBe(true));

		act(() => view.result.current.toggleRecording());
		await waitFor(() => expect(api.startNativeWindowsRecording).toHaveBeenCalled());
		act(() => view.result.current.toggleRecording());

		expect(api.cancelNativeWindowsPendingStart).toHaveBeenCalled();
		await new Promise((resolve) => setTimeout(resolve, 1300));
		expect(view.result.current.recording).toBe(false);
	});
});
