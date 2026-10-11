#include "webcam_format.h"

#include <cstdio>
#include <string>
#include <tuple>

namespace {

int failures = 0;

void expectFormat(const std::string& label, WebcamFormat actual, int width, int height, int fps) {
    if (actual.width == width && actual.height == height && actual.fps == fps) {
        return;
    }
    std::printf(
        "FAIL %s: expected %dx%d@%d, got %dx%d@%d\n",
        label.c_str(),
        width,
        height,
        fps,
        actual.width,
        actual.height,
        actual.fps);
    ++failures;
}

// Every mode a Logitech BRIO advertises that this helper could drive, as read
// off the device with `ffmpeg -f dshow -list_options true`.
const std::vector<WebcamFormat> kBrio = {
    {640, 480, 30, false},   {640, 360, 30, false},  {1280, 720, 30, false},
    {1920, 1080, 30, false}, {1280, 720, 90, true},  {1920, 1080, 60, true},
    {2560, 1440, 30, true},  {3840, 2160, 30, true}, {160, 120, 30, false},
    {340, 340, 30, false},   {1600, 896, 30, false}, {1024, 576, 30, false},
};

// A Logitech C920, from `ffmpeg -f dshow -list_options true`, each mode at its
// highest rate. Uncompressed (YUY2) 1080p is only 5 fps here, and the two
// largest modes 2 fps; MJPEG and the camera's own H.264 reach 1080p30.
const std::vector<WebcamFormat> kC920 = {
    {640, 480, 30, false},          {160, 90, 30, false},          {320, 240, 30, false},
    {800, 448, 30, false},          {800, 600, 24, false},         {864, 480, 24, false},
    {960, 720, 15, false},          {1024, 576, 15, false},        {1280, 720, 10, false},
    {1600, 896, 8, false},          {1920, 1080, 5, false},        {2304, 1296, 2, false},
    {2304, 1536, 2, false},         {1280, 720, 30, true, false},  {1920, 1080, 30, true, false},
    {640, 480, 30, true, true},     {1280, 720, 30, true, true},   {1600, 896, 30, true, true},
    {1920, 1080, 30, true, true},
};

void expectMjpeg(const std::string& label, WebcamFormat actual, bool mjpeg) {
    if (actual.compressed == mjpeg && actual.mjpeg == mjpeg) {
        return;
    }
    std::printf(
        "FAIL %s: expected %s, got compressed=%d mjpeg=%d\n",
        label.c_str(),
        mjpeg ? "MJPEG" : "uncompressed",
        actual.compressed ? 1 : 0,
        actual.mjpeg ? 1 : 0);
    ++failures;
}

}  // namespace

int main() {
    // The regression this file exists for: a BRIO asked for 1080p must not come
    // back with the 640x480 default it enumerates first.
    expectFormat("brio targets 1080p", chooseWebcamFormat(kBrio, 1920, 1080, 30), 1920, 1080, 30);

    // Asked for more than the camera can do uncompressed, it must stop at the
    // best uncompressed mode rather than pin an MJPEG one. Pinning MJPEG and
    // asking the source reader for RGB32 produced a reader that delivered no
    // samples at all, so the take had no camera in it.
    expectFormat(
        "4K request settles for the best uncompressed mode",
        chooseWebcamFormat(kBrio, 3840, 2160, 30),
        1920,
        1080,
        30);
    if (chooseWebcamFormat(kBrio, 3840, 2160, 30).compressed) {
        std::printf("FAIL 4K request must not pin a compressed mode\n");
        ++failures;
    }

    // A camera with nothing but compressed modes still has to be usable.
    expectFormat(
        "compressed-only camera is still driven",
        chooseWebcamFormat({{1920, 1080, 30, true}, {1280, 720, 30, true}}, 1920, 1080, 30),
        1920,
        1080,
        30);

    // Uncompressed wins even when it is much smaller than a compressed option.
    expectFormat(
        "uncompressed beats a larger compressed mode",
        chooseWebcamFormat({{3840, 2160, 30, true}, {640, 480, 30, false}}, 3840, 2160, 30),
        640,
        480,
        30);

    // 1080p60 exists too; at a 30 fps encode the extra frames only cost bandwidth.
    expectFormat(
        "prefers the frame rate we encode at",
        chooseWebcamFormat({{1920, 1080, 60}, {1920, 1080, 30}}, 1920, 1080, 30),
        1920,
        1080,
        30);

    // Nothing reaches 30, so take the best the camera can do rather than fail.
    expectFormat(
        "falls back to the highest rate offered",
        chooseWebcamFormat({{1920, 1080, 15}, {1920, 1080, 24}}, 1920, 1080, 30),
        1920,
        1080,
        24);

    // A 720p-only camera keeps working, just smaller.
    expectFormat(
        "720p camera stays 720p",
        chooseWebcamFormat({{1280, 720, 30}, {640, 480, 30}}, 1920, 1080, 30),
        1280,
        720,
        30);

    // 2560x800 has fewer pixels than 1920x1080 but is far wider; picking it
    // would letterbox the overlay and cost a needless downscale.
    expectFormat(
        "rejects an oversized dimension even when pixel count fits",
        chooseWebcamFormat({{2560, 800, 30}, {1280, 720, 30}}, 1920, 1080, 30),
        1280,
        720,
        30);

    // Only modes above the target: scale down from the cheapest of them.
    expectFormat(
        "oversized-only camera takes the smallest mode",
        chooseWebcamFormat({{3840, 2160, 30}, {2560, 1440, 30}}, 1920, 1080, 30),
        2560,
        1440,
        30);

    // The C920 regressions: at the default 4K quality the old ranking chose the
    // 2 fps 2304x1536 YUY2 mode, which the driver refused, so the take fell back
    // to the 640x480 default; at 1080p it recorded the 5 fps YUY2 mode. With
    // compressed modes accepted, both land on MJPEG 1080p30 -- MJPEG over the
    // camera's own H.264, which ties on size and rate.
    for (const auto& [label, width, height] : {
             std::tuple<const char*, int, int>{"c920 at 2160p", 3840, 2160},
             std::tuple<const char*, int, int>{"c920 at 1440p", 2560, 1440},
             std::tuple<const char*, int, int>{"c920 at 1080p", 1920, 1080},
         }) {
        const WebcamFormat chosen = chooseWebcamFormat(kC920, width, height, 30, true);
        expectFormat(label, chosen, 1920, 1080, 30);
        expectMjpeg(label, chosen, true);
    }
    // Its uncompressed 720p is 10 fps, so 720p is MJPEG too...
    {
        const WebcamFormat chosen = chooseWebcamFormat(kC920, 1280, 720, 30, true);
        expectFormat("c920 at 720p", chosen, 1280, 720, 30);
        expectMjpeg("c920 at 720p", chosen, true);
    }
    // ...while at 640x480, where YUY2 keeps up, no decoder is needed.
    {
        const WebcamFormat chosen = chooseWebcamFormat(kC920, 640, 480, 30, true);
        expectFormat("c920 at 480p", chosen, 640, 480, 30);
        expectMjpeg("c920 at 480p", chosen, false);
    }
    // Without compressed modes (the BGRA paths) the C920 still must not record
    // a slide show: the largest uncompressed mode that keeps up wins over the
    // 5 fps 1080p one.
    {
        const WebcamFormat chosen = chooseWebcamFormat(kC920, 1920, 1080, 30);
        expectFormat("c920 uncompressed keeps up", chosen, 800, 600, 24);
        expectMjpeg("c920 uncompressed keeps up", chosen, false);
    }

    // The same C920 through Media Foundation (the helper's "Native webcam
    // modes" line), which adds NV12 twins of the MJPEG modes, decoded by the
    // Windows camera frame server. The measured regression: at 2160p the old
    // ranking took 2304x1536 YUY2 at 2 fps, the driver refused it and the take
    // fell back to 640x480. The 1080p30 NV12 mode is what it should have taken,
    // on either path.
    {
        std::vector<WebcamFormat> c920Mf = kC920;
        c920Mf.push_back({1920, 1080, 30, false});
        c920Mf.push_back({1280, 720, 30, false});
        for (const bool acceptCompressed : {false, true}) {
            const WebcamFormat chosen = chooseWebcamFormat(c920Mf, 3840, 2160, 30, acceptCompressed);
            expectFormat("c920 via Media Foundation at 2160p", chosen, 1920, 1080, 30);
            expectMjpeg("c920 via Media Foundation at 2160p", chosen, false);
        }
    }

    // With compressed modes accepted, the BRIO reaches its real 4K.
    expectFormat(
        "brio 4K with compressed accepted",
        chooseWebcamFormat(kBrio, 3840, 2160, 30, true),
        3840,
        2160,
        30);
    // ...and at 1080p30 its uncompressed mode still beats the MJPEG one.
    {
        const WebcamFormat chosen = chooseWebcamFormat(kBrio, 1920, 1080, 30, true);
        expectFormat("brio 1080p with compressed accepted", chosen, 1920, 1080, 30);
        expectMjpeg("brio 1080p with compressed accepted", chosen, false);
    }

    // Nothing keeps up: the fastest mode beats the biggest one.
    expectFormat(
        "no smooth mode: frame rate before size",
        chooseWebcamFormat({{1920, 1080, 5}, {1280, 720, 10}}, 1920, 1080, 30),
        1280,
        720,
        10);

    // A 15 fps target is reached by a 15 fps mode, so size decides again.
    expectFormat(
        "a low target fps lowers the bar",
        chooseWebcamFormat({{1280, 720, 30}, {1920, 1080, 15}}, 1920, 1080, 15),
        1920,
        1080,
        15);

    // Nothing to choose from: hand the target back and let the driver decide.
    expectFormat("empty list returns the target", chooseWebcamFormat({}, 1920, 1080, 30), 1920, 1080, 30);

    // Drivers do report junk; it must not win.
    expectFormat(
        "ignores degenerate entries",
        chooseWebcamFormat({{0, 0, 30}, {-1920, 1080, 30}, {1280, 720, 30}}, 1920, 1080, 30),
        1280,
        720,
        30);

    if (failures == 0) {
        std::printf("webcam_format_test: all assertions passed\n");
        return 0;
    }
    std::printf("webcam_format_test: %d assertion(s) failed\n", failures);
    return 1;
}
