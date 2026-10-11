#pragma once

#include <vector>

// One capture format a camera advertises.
struct WebcamFormat {
    int width = 0;
    int height = 0;
    int fps = 0;
    /**
     * True for MJPEG/H264 modes, which reach higher resolutions than a camera's
     * uncompressed ones but need a decoder MFT in front of the RGB32 conversion.
     */
    bool compressed = false;
    /**
     * True for a compressed mode that is MJPEG. Media Foundation ships the MJPEG
     * decoder every camera app relies on; a camera's own H.264 stream needs the
     * full H.264 decoder and its latency, so MJPEG is preferred when both exist.
     */
    bool mjpeg = false;
};

// The frame rate below which a mode counts as choppy: at 24 fps and up a face
// looks like video, at the 5 fps a C920 manages for uncompressed 1080p it looks
// like a slide show.
constexpr int kSmoothWebcamFps = 24;

// Picks the format to drive the camera at, given everything it advertises.
//
// Both capture backends used to leave this to the driver: Media Foundation was
// handed a media type with no MF_MT_FRAME_SIZE, and the DirectShow graph was
// rendered without touching IAMStreamConfig. In both cases the device answers
// with its *default* type, and for a UVC camera that is the first format it
// enumerates -- 640x480 even on a BRIO that offers 3840x2160. The recording was
// then upscaled into the overlay, which is the pixelation users reported.
//
// Rules, in order:
//   * with `acceptCompressed` false, uncompressed modes beat compressed ones
//     outright, whatever their size. Pinning a camera's MJPEG mode and asking
//     the source reader for RGB32 left it delivering no samples at all on some
//     hosts, so the BGRA paths keep this rule. The NV12 path, where the reader
//     decodes MJPEG straight to the encoder's format, passes true;
//   * only formats that fit inside the target in BOTH dimensions are eligible,
//     so an ultrawide mode cannot sneak in on pixel count alone;
//   * a mode that keeps up -- min(target fps, kSmoothWebcamFps) -- beats one
//     that does not, whatever their sizes. A C920 offers 1080p uncompressed only
//     at 5 fps but 1080p MJPEG at 30; choosing on pixels alone recorded the
//     slide show (or, asked for 4K, a 2 fps 2304x1536 mode the driver then
//     refused, landing on its 640x480 default);
//   * among the modes that keep up, the most pixels wins. Among those that do
//     not, the highest frame rate wins first, then the most pixels;
//   * ties go to the lowest frame rate that still reaches the target, else the
//     highest available -- a 1080p60 mode is no help when we encode at 30;
//   * then uncompressed beats MJPEG, and MJPEG beats any other compressed mode;
//   * if nothing fits (a camera that only does 4K), the smallest mode wins, so
//     we scale down rather than push 1 GB/s of RGB32 through the encoder;
//   * an empty list returns the target unchanged, letting the caller fall back
//     to whatever the driver would have picked on its own.
WebcamFormat chooseWebcamFormat(
    const std::vector<WebcamFormat>& available,
    int targetWidth,
    int targetHeight,
    int targetFps,
    bool acceptCompressed = false);
