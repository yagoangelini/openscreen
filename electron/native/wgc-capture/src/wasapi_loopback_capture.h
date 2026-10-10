#pragma once

#include "audio_sample_utils.h"
#include "mf_encoder.h"

#include <Windows.h>
#include <audioclient.h>
#include <mmdeviceapi.h>
#include <wrl/client.h>

#include <atomic>
#include <cstdint>
#include <functional>
#include <string>
#include <thread>
#include <vector>

enum class WasapiCaptureEndpoint {
    SystemLoopback,
    Microphone,
};

class WasapiLoopbackCapture {
public:
    using AudioCallback = std::function<void(const BYTE* data, DWORD byteCount, int64_t timestampHns, int64_t durationHns)>;

    WasapiLoopbackCapture() = default;
    ~WasapiLoopbackCapture();

    WasapiLoopbackCapture(const WasapiLoopbackCapture&) = delete;
    WasapiLoopbackCapture& operator=(const WasapiLoopbackCapture&) = delete;

    bool initializeSystemLoopback();
    bool initializeMicrophone(const std::wstring& deviceId, const std::wstring& deviceName);
    bool start(AudioCallback callback);
    void stop();

    const AudioInputFormat& inputFormat() const;
    const std::wstring& selectedDeviceName() const;

private:
    bool initialize(WasapiCaptureEndpoint endpoint, const std::wstring& deviceId, const std::wstring& deviceName);
    bool resolveMicrophoneByName(const std::wstring& deviceName);
    void captureLoop();
    bool resolveInputFormat(WAVEFORMATEX* mixFormat);
    // Drops the dead endpoint and opens it again (the same microphone if it came
    // back, otherwise the default one), started and ready to read.
    bool reopen();
    void releaseEndpoint();

    Microsoft::WRL::ComPtr<IMMDeviceEnumerator> deviceEnumerator_;
    Microsoft::WRL::ComPtr<IMMDevice> device_;
    Microsoft::WRL::ComPtr<IAudioClient> audioClient_;
    Microsoft::WRL::ComPtr<IAudioCaptureClient> captureClient_;
    WAVEFORMATEX* mixFormat_ = nullptr;
    // What the consumer was told at start and keeps receiving. A reopened device
    // can have another format; its packets are converted into this one.
    AudioInputFormat inputFormat_{};
    AudioInputFormat deviceFormat_{};
    bool initialized_ = false;
    WasapiCaptureEndpoint endpoint_ = WasapiCaptureEndpoint::SystemLoopback;
    std::wstring requestedDeviceId_;
    std::wstring requestedDeviceName_;
    std::vector<BYTE> convertBuffer_;
    AudioDecimatorState convertDecimator_;
    std::wstring selectedDeviceName_;
    AudioCallback callback_;
    std::thread thread_;
    std::atomic<bool> stopRequested_ = false;
    std::vector<BYTE> silenceBuffer_;
    uint64_t writtenFrames_ = 0;
    uint64_t lastDevicePositionEnd_ = 0;
    bool hasLastDevicePosition_ = false;
};
