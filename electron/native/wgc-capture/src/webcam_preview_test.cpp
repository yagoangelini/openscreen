#include "webcam_preview.h"

#include <iostream>
#include <string>
#include <vector>

namespace {

int g_ran = 0;
int g_failed = 0;

void expect(const char* name, bool ok, const std::string& detail = "") {
    g_ran += 1;
    if (ok) {
        std::cout << "PASS " << name << "\n";
        return;
    }
    g_failed += 1;
    std::cout << "FAIL " << name << " " << detail << "\n";
}

}  // namespace

int main() {
    {
        const auto hd = fitPreviewSize(1920, 1080, 320);
        expect("fit-1080p-into-320", hd.width == 320 && hd.height == 180,
               std::to_string(hd.width) + "x" + std::to_string(hd.height));
        const auto portrait = fitPreviewSize(1080, 1920, 320);
        expect("fit-portrait", portrait.width == 180 && portrait.height == 320,
               std::to_string(portrait.width) + "x" + std::to_string(portrait.height));
        const auto small = fitPreviewSize(160, 120, 320);
        expect("fit-never-upscales", small.width == 160 && small.height == 120);
        const auto odd = fitPreviewSize(1280, 721, 320);
        expect("fit-even-sides", odd.width % 2 == 0 && odd.height % 2 == 0);
        expect("fit-rejects-empty", fitPreviewSize(0, 1080, 320).width == 0);
    }
    {
        // NV12 4x2: Y studio white (235) left half, black (16) right half, neutral chroma.
        std::vector<BYTE> nv12 = {235, 235, 16, 16, 235, 235, 16, 16, 128, 128, 128, 128};
        std::vector<BYTE> rgba;
        const bool ok = downscaleFrameToRgba(nv12.data(), nv12.size(), 4, 2, true, {2, 2}, rgba);
        expect("nv12-to-rgba-size", ok && rgba.size() == 16);
        expect("nv12-white-is-255", ok && rgba[0] == 255 && rgba[1] == 255 && rgba[2] == 255 && rgba[3] == 255,
               std::to_string(rgba.empty() ? -1 : rgba[0]));
        expect("nv12-black-is-0", ok && rgba[4] == 0 && rgba[5] == 0 && rgba[6] == 0,
               std::to_string(rgba.size() > 4 ? rgba[4] : -1));
        expect("nv12-short-buffer-rejected",
               !downscaleFrameToRgba(nv12.data(), 8, 4, 2, true, {2, 2}, rgba));
    }
    {
        // BGRA 2x1: pure blue then pure red, swapped into RGBA.
        std::vector<BYTE> bgra = {255, 0, 0, 255, 0, 0, 255, 255};
        std::vector<BYTE> rgba;
        const bool ok = downscaleFrameToRgba(bgra.data(), bgra.size(), 2, 1, false, {2, 1}, rgba);
        expect("bgra-to-rgba", ok && rgba[0] == 0 && rgba[2] == 255 && rgba[4] == 255 && rgba[6] == 0);
    }
    {
        std::vector<BYTE> rgba(320 * 180 * 4, 7);
        std::vector<BYTE> packet;
        buildSelfViewPacket({320, 180}, rgba, packet);
        const uint32_t length = packet[12] | (packet[13] << 8) | (packet[14] << 16) |
                                (static_cast<uint32_t>(packet[15]) << 24);
        expect("packet-magic", packet[0] == 'O' && packet[1] == 'S' && packet[2] == 'V' && packet[3] == '1');
        expect("packet-size-le", packet[4] == (320 & 0xFF) && packet[5] == (320 >> 8) && packet[6] == 180 &&
                                     packet[7] == 0 && packet[8] == kSelfViewFormatRgba);
        expect("packet-length", length == rgba.size() && packet.size() == kSelfViewHeaderBytes + rgba.size());
    }
    {
        PreviewThrottle throttle{std::chrono::milliseconds(66)};
        const auto t0 = std::chrono::steady_clock::time_point{} + std::chrono::seconds(10);
        const bool first = throttle.due(t0);
        throttle.sent(t0);
        const bool tooSoon = throttle.due(t0 + std::chrono::milliseconds(40));
        const bool onTime = throttle.due(t0 + std::chrono::milliseconds(66));
        expect("throttle-first-frame-due", first);
        expect("throttle-holds-inside-the-interval", !tooSoon);
        expect("throttle-due-after-the-interval", onTime);
        // Sent late: the next one is an interval after THAT, not an immediate catch-up.
        throttle.sent(t0 + std::chrono::milliseconds(200));
        expect("throttle-no-burst-after-a-late-round",
               !throttle.due(t0 + std::chrono::milliseconds(220)));
    }

    std::cout << "ran " << g_ran << " tests\n";
    if (g_failed != 0) {
        std::cout << g_failed << " failed\n";
        return 1;
    }
    return 0;
}
