#pragma once

#include <Windows.h>

#include <atomic>
#include <chrono>
#include <cstdint>
#include <functional>
#include <string>
#include <thread>
#include <vector>

// The live camera for the app's floating self-view, while this helper owns the camera.
//
// During a take the camera belongs to the helper (Media Foundation hands it to one reader),
// so the app cannot open it to show the user their own face. Instead the helper publishes a
// small copy of the frames it already has: downscaled to fit kSelfViewMaxSide, converted to
// RGBA and written at most every kSelfViewIntervalMs to a named pipe the app listens on. All
// of it runs on its own thread, reading the camera's latest frame the same way the video
// writer does, so neither the writer's cadence nor the camera's is touched; a reader that
// stops reading blocks only this thread.

constexpr int kSelfViewMaxSide = 320;
constexpr int kSelfViewIntervalMs = 66;  // ~15 fps
constexpr size_t kSelfViewHeaderBytes = 16;
constexpr BYTE kSelfViewFormatRgba = 1;

struct PreviewSize {
    int width = 0;
    int height = 0;
};

// The largest size with the frame's aspect that fits `maxSide` on both axes, never upscaled,
// both sides even and at least 2.
PreviewSize fitPreviewSize(int sourceWidth, int sourceHeight, int maxSide);

// Nearest-neighbour downscale of a camera frame (packed NV12, BT.601 studio range, or BGRA)
// into tightly packed RGBA of `target`. Returns false for a buffer too short for its size.
bool downscaleFrameToRgba(
    const BYTE* source,
    size_t sourceBytes,
    int sourceWidth,
    int sourceHeight,
    bool nv12,
    PreviewSize target,
    std::vector<BYTE>& rgba);

// One frame on the wire: "OSV1", width and height (u16 LE), format (u8), 3 reserved bytes,
// payload length (u32 LE), then the payload. Parsed by electron/recording/selfViewStream.ts.
void buildSelfViewPacket(PreviewSize size, const std::vector<BYTE>& rgba, std::vector<BYTE>& packet);

// At most one frame per interval; a slow round is not caught up with a burst.
class PreviewThrottle {
public:
    explicit PreviewThrottle(std::chrono::milliseconds interval) : interval_(interval) {}
    bool due(std::chrono::steady_clock::time_point now) const {
        return !started_ || now - last_ >= interval_;
    }
    void sent(std::chrono::steady_clock::time_point now) {
        last_ = now;
        started_ = true;
    }

private:
    std::chrono::milliseconds interval_;
    std::chrono::steady_clock::time_point last_{};
    bool started_ = false;
};

class SelfViewPreviewPublisher {
public:
    // Hands over the camera's latest frame when it is newer than `lastSequence`.
    using FrameSource = std::function<bool(
        std::vector<BYTE>& data, int& width, int& height, uint64_t lastSequence, uint64_t& sequence)>;

    SelfViewPreviewPublisher() = default;
    ~SelfViewPreviewPublisher();
    SelfViewPreviewPublisher(const SelfViewPreviewPublisher&) = delete;
    SelfViewPreviewPublisher& operator=(const SelfViewPreviewPublisher&) = delete;

    void start(const std::wstring& pipeName, bool nv12, bool enabled, FrameSource source);
    // The app shows the self-view, or hides it: frames are only made while it is shown.
    void setEnabled(bool enabled) { enabled_ = enabled; }
    void stop();

private:
    void run();

    std::wstring pipeName_;
    bool nv12_ = false;
    FrameSource source_;
    std::thread thread_;
    std::atomic<bool> stopRequested_ = false;
    std::atomic<bool> enabled_ = false;
    HANDLE pipe_ = INVALID_HANDLE_VALUE;
};
