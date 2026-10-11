#include "webcam_format.h"

#include <algorithm>

namespace {

bool isUsable(const WebcamFormat& format) {
    return format.width > 0 && format.height > 0;
}

bool fitsTarget(const WebcamFormat& format, int targetWidth, int targetHeight) {
    return format.width <= targetWidth && format.height <= targetHeight;
}

long long pixels(const WebcamFormat& format) {
    return static_cast<long long>(format.width) * static_cast<long long>(format.height);
}

// True when `candidate` is a better frame rate than `best` for a target of
// `targetFps`: the lowest rate that still reaches the target, or -- when no
// mode reaches it -- the highest one on offer.
bool betterFps(int candidate, int best, int targetFps) {
    const bool candidateReaches = candidate >= targetFps;
    const bool bestReaches = best >= targetFps;
    if (candidateReaches != bestReaches) {
        return candidateReaches;
    }
    return candidateReaches ? candidate < best : candidate > best;
}

// 0 for uncompressed, 1 for MJPEG, 2 for any other compressed mode: lower is
// cheaper to decode and safer to pin.
int decodeRank(const WebcamFormat& format) {
    if (!format.compressed) {
        return 0;
    }
    return format.mjpeg ? 1 : 2;
}

}  // namespace

WebcamFormat chooseWebcamFormat(
    const std::vector<WebcamFormat>& available,
    int targetWidth,
    int targetHeight,
    int targetFps,
    bool acceptCompressed) {
    const WebcamFormat target{targetWidth, targetHeight, targetFps, false};
    const int smoothFps = std::min(std::max(1, targetFps), kSmoothWebcamFps);

    // Without `acceptCompressed`, compressed modes are a last resort, only
    // considered when the camera offers nothing else at all.
    const bool anyUncompressed = std::any_of(available.begin(), available.end(), [](const WebcamFormat& format) {
        return isUsable(format) && !format.compressed;
    });

    const auto eligible = [&](const WebcamFormat& format) {
        return isUsable(format) && (acceptCompressed || !(anyUncompressed && format.compressed));
    };

    const bool anyFits = std::any_of(available.begin(), available.end(), [&](const WebcamFormat& format) {
        return eligible(format) && fitsTarget(format, targetWidth, targetHeight);
    });

    // True when `candidate` should replace `best`; false on a full tie, so the
    // first mode the camera lists wins it.
    const auto beats = [&](const WebcamFormat& candidate, const WebcamFormat& best) {
        const bool candidateSmooth = candidate.fps >= smoothFps;
        const bool bestSmooth = best.fps >= smoothFps;
        if (candidateSmooth != bestSmooth) {
            return candidateSmooth;
        }
        if (!candidateSmooth && candidate.fps != best.fps) {
            return candidate.fps > best.fps;
        }
        if (pixels(candidate) != pixels(best)) {
            return anyFits ? pixels(candidate) > pixels(best) : pixels(candidate) < pixels(best);
        }
        if (candidate.fps != best.fps) {
            return betterFps(candidate.fps, best.fps, targetFps);
        }
        return decodeRank(candidate) < decodeRank(best);
    };

    const WebcamFormat* best = nullptr;
    for (const WebcamFormat& format : available) {
        if (!eligible(format)) {
            continue;
        }
        // Once anything fits, oversized modes are out of the running entirely.
        // With nothing fitting we rank the oversized modes instead, smallest
        // first, so the scaler has the least work to do.
        if (anyFits != fitsTarget(format, targetWidth, targetHeight)) {
            continue;
        }
        if (best == nullptr || beats(format, *best)) {
            best = &format;
        }
    }

    return best ? *best : target;
}
