#include "webcam_preview.h"

#include <algorithm>
#include <cstring>
#include <iostream>

namespace {

BYTE clampByte(int value) {
    return static_cast<BYTE>(std::clamp(value, 0, 255));
}

void writeU16(std::vector<BYTE>& out, size_t offset, uint32_t value) {
    out[offset] = static_cast<BYTE>(value & 0xFF);
    out[offset + 1] = static_cast<BYTE>((value >> 8) & 0xFF);
}

void writeU32(std::vector<BYTE>& out, size_t offset, uint32_t value) {
    for (int i = 0; i < 4; i += 1) {
        out[offset + i] = static_cast<BYTE>((value >> (8 * i)) & 0xFF);
    }
}

}  // namespace

PreviewSize fitPreviewSize(int sourceWidth, int sourceHeight, int maxSide) {
    if (sourceWidth <= 0 || sourceHeight <= 0 || maxSide < 2) {
        return {};
    }
    const double scale = std::min(
        1.0, static_cast<double>(maxSide) / static_cast<double>(std::max(sourceWidth, sourceHeight)));
    const auto even = [](double value) { return std::max(2, (static_cast<int>(value) / 2) * 2); };
    return {even(sourceWidth * scale), even(sourceHeight * scale)};
}

bool downscaleFrameToRgba(
    const BYTE* source,
    size_t sourceBytes,
    int sourceWidth,
    int sourceHeight,
    bool nv12,
    PreviewSize target,
    std::vector<BYTE>& rgba) {
    if (!source || sourceWidth <= 0 || sourceHeight <= 0 || target.width <= 0 || target.height <= 0) {
        return false;
    }
    const size_t pixels = static_cast<size_t>(sourceWidth) * static_cast<size_t>(sourceHeight);
    const size_t needed = nv12 ? pixels + pixels / 2 : pixels * 4;
    if (sourceBytes < needed) {
        return false;
    }
    rgba.resize(static_cast<size_t>(target.width) * static_cast<size_t>(target.height) * 4);
    const BYTE* uvPlane = source + pixels;
    for (int y = 0; y < target.height; y += 1) {
        const int sy = static_cast<int>((static_cast<int64_t>(y) * sourceHeight) / target.height);
        for (int x = 0; x < target.width; x += 1) {
            const int sx = static_cast<int>((static_cast<int64_t>(x) * sourceWidth) / target.width);
            BYTE* out = rgba.data() + (static_cast<size_t>(y) * target.width + x) * 4;
            if (nv12) {
                // BT.601 studio range, the usual camera matrix, in 8.8 fixed point.
                const int c = static_cast<int>(source[static_cast<size_t>(sy) * sourceWidth + sx]) - 16;
                const BYTE* uv = uvPlane + static_cast<size_t>(sy / 2) * sourceWidth + (sx / 2) * 2;
                const int d = static_cast<int>(uv[0]) - 128;
                const int e = static_cast<int>(uv[1]) - 128;
                out[0] = clampByte((298 * c + 409 * e + 128) >> 8);
                out[1] = clampByte((298 * c - 100 * d - 208 * e + 128) >> 8);
                out[2] = clampByte((298 * c + 516 * d + 128) >> 8);
            } else {
                const BYTE* bgra = source + (static_cast<size_t>(sy) * sourceWidth + sx) * 4;
                out[0] = bgra[2];
                out[1] = bgra[1];
                out[2] = bgra[0];
            }
            out[3] = 255;
        }
    }
    return true;
}

void buildSelfViewPacket(PreviewSize size, const std::vector<BYTE>& rgba, std::vector<BYTE>& packet) {
    packet.assign(kSelfViewHeaderBytes + rgba.size(), 0);
    packet[0] = 'O';
    packet[1] = 'S';
    packet[2] = 'V';
    packet[3] = '1';
    writeU16(packet, 4, static_cast<uint32_t>(size.width));
    writeU16(packet, 6, static_cast<uint32_t>(size.height));
    packet[8] = kSelfViewFormatRgba;
    writeU32(packet, 12, static_cast<uint32_t>(rgba.size()));
    if (!rgba.empty()) {
        std::memcpy(packet.data() + kSelfViewHeaderBytes, rgba.data(), rgba.size());
    }
}

SelfViewPreviewPublisher::~SelfViewPreviewPublisher() {
    stop();
}

void SelfViewPreviewPublisher::start(
    const std::wstring& pipeName,
    bool nv12,
    bool enabled,
    FrameSource source) {
    if (thread_.joinable() || pipeName.empty() || !source) {
        return;
    }
    pipeName_ = pipeName;
    nv12_ = nv12;
    enabled_ = enabled;
    source_ = std::move(source);
    stopRequested_ = false;
    thread_ = std::thread([this] { run(); });
}

void SelfViewPreviewPublisher::stop() {
    if (!thread_.joinable()) {
        return;
    }
    stopRequested_ = true;
    // A write the app stopped reading would otherwise hold the join forever.
    CancelSynchronousIo(static_cast<HANDLE>(thread_.native_handle()));
    thread_.join();
    if (pipe_ != INVALID_HANDLE_VALUE) {
        CloseHandle(pipe_);
        pipe_ = INVALID_HANDLE_VALUE;
    }
}

void SelfViewPreviewPublisher::run() {
    // The app creates the pipe before it spawns the helper; a few tries cover a slow listen.
    for (int attempt = 0; attempt < 40 && !stopRequested_; attempt += 1) {
        pipe_ = CreateFileW(pipeName_.c_str(), GENERIC_WRITE, 0, nullptr, OPEN_EXISTING, 0, nullptr);
        if (pipe_ != INVALID_HANDLE_VALUE) {
            break;
        }
        std::this_thread::sleep_for(std::chrono::milliseconds(50));
    }
    if (pipe_ == INVALID_HANDLE_VALUE) {
        std::cerr << "WARNING: self-view pipe unavailable; no camera preview this take" << std::endl;
        return;
    }
    std::cerr << "[self-view] publishing camera preview frames" << std::endl;

    PreviewThrottle throttle{std::chrono::milliseconds(kSelfViewIntervalMs)};
    std::vector<BYTE> frame;
    std::vector<BYTE> rgba;
    std::vector<BYTE> packet;
    uint64_t lastSequence = 0;
    uint64_t sent = 0;
    while (!stopRequested_) {
        const auto now = std::chrono::steady_clock::now();
        if (!enabled_ || !throttle.due(now)) {
            std::this_thread::sleep_for(std::chrono::milliseconds(enabled_ ? 5 : 50));
            continue;
        }
        int width = 0;
        int height = 0;
        uint64_t sequence = 0;
        if (!source_(frame, width, height, lastSequence, sequence)) {
            std::this_thread::sleep_for(std::chrono::milliseconds(5));
            continue;
        }
        lastSequence = sequence;
        const PreviewSize size = fitPreviewSize(width, height, kSelfViewMaxSide);
        if (!downscaleFrameToRgba(frame.data(), frame.size(), width, height, nv12_, size, rgba)) {
            continue;
        }
        buildSelfViewPacket(size, rgba, packet);
        size_t offset = 0;
        while (offset < packet.size() && !stopRequested_) {
            DWORD written = 0;
            if (!WriteFile(
                    pipe_, packet.data() + offset, static_cast<DWORD>(packet.size() - offset), &written,
                    nullptr) ||
                written == 0) {
                std::cerr << "[self-view] pipe closed after " << sent << " frames" << std::endl;
                return;
            }
            offset += written;
        }
        throttle.sent(now);
        sent += 1;
    }
}
