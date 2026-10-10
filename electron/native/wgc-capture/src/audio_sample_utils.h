#pragma once

#include "mf_encoder.h"

#include <Windows.h>

#include <atomic>
#include <condition_variable>
#include <cstdint>
#include <functional>
#include <mutex>
#include <string>
#include <thread>
#include <vector>

bool sameAudioFormatForMixing(const AudioInputFormat& left, const AudioInputFormat& right);
AudioInputFormat makeAacCompatibleAudioFormat(const AudioInputFormat& source);
void copyAudioWithGain(
    const BYTE* source,
    DWORD byteCount,
    const AudioInputFormat& format,
    double gain,
    std::vector<BYTE>& destination);
void convertAudioWithGain(
    const BYTE* source,
    DWORD byteCount,
    const AudioInputFormat& sourceFormat,
    const AudioInputFormat& targetFormat,
    double gain,
    std::vector<BYTE>& destination);
// Cross-packet state for the integer-factor downsample path (96/192 kHz -> 48).
// Dropping frames is only safe once everything above the new Nyquist is gone,
// and a filter long enough to do that reaches back further than one packet — so
// its history has to outlive the call. `pendingFrames()` is how far into the
// current output group the stream has got, which is the same accounting the
// caller used to read off a leftover-bytes buffer: a group only produces an
// output frame once all `factor` of its frames have arrived.
class AudioDecimatorState {
public:
    void reset();
    size_t pendingFrames() const { return phase_; }

    // Used by the decimation path; not part of the caller's contract. `consume`
    // takes one source frame and writes `channels` filtered samples into `out`
    // on the frame that completes a group, which is the only frame that
    // survives the decimation.
    void prepare(UINT32 factor, UINT32 channels);
    bool consume(const double* frame, double* out);

private:
    std::vector<double> taps_;
    std::vector<double> history_;
    size_t position_ = 0;
    size_t phase_ = 0;
    UINT32 factor_ = 0;
    UINT32 channels_ = 0;
};

void convertAudioWithGain(
    const BYTE* source,
    DWORD byteCount,
    const AudioInputFormat& sourceFormat,
    const AudioInputFormat& targetFormat,
    double gain,
    std::vector<BYTE>& destination,
    AudioDecimatorState& decimator);
// Mixes `source` into `destination`, scaling the source by `sourceGain` first.
// The gain rides in the double-domain sum and the result is clamped exactly
// once, at the write: a source whose scaled samples exceed full scale must
// saturate against the OTHER sources too (sum-then-clamp), not arrive
// pre-flattened by its own conversion (clamp-then-sum, which distorts twice
// and loses whatever headroom the opposite polarity of the mix had).
void mixAudioInPlace(
    std::vector<BYTE>& destination,
    const BYTE* source,
    DWORD byteCount,
    const AudioInputFormat& format,
    double sourceGain = 1.0);

// A microphone that reports two channels but only carries signal on one -- the
// usual shape of a USB interface with the mic in input 1 -- would otherwise be
// recorded in one ear. This watches the long-run level of each channel and, once
// exactly one of them is live and every other sits 30 dB under it, copies the live
// one over the rest. A genuinely stereo (or array) mic is left as it is.
enum class MicrophoneChannelMode { Auto, Left, Right, Mix };
MicrophoneChannelMode parseMicrophoneChannelMode(const std::string& value);

class MicrophoneChannelPicker {
public:
    void setMode(MicrophoneChannelMode mode) { mode_ = mode; }
    void reset();
    // Rewrites the interleaved packet in place. Returns the channel being copied
    // to the others, or -1 while every channel is kept.
    int process(BYTE* data, DWORD byteCount, const AudioInputFormat& format);
    int liveChannel() const { return liveChannel_; }

private:
    std::vector<double> energy_;
    int liveChannel_ = -1;
    MicrophoneChannelMode mode_ = MicrophoneChannelMode::Auto;
};

// A peak limiter on the final mix: instant attack, ~150 ms release. A boosted
// microphone over loud system audio is pulled down under the ceiling instead of
// being flat-topped at full scale; anything under the ceiling passes untouched.
class PeakLimiter {
public:
    static constexpr double kCeiling = 0.95;  // about -0.45 dBFS
    void reset() { gain_ = 1.0; }
    void process(double* interleaved, size_t frames, UINT32 channels, UINT32 sampleRate);
    double gain() const { return gain_; }

private:
    double gain_ = 1.0;
};

// Adds `source`, scaled by `gain`, into an interleaved double sum of the same
// layout, and writes such a sum back out in `format` (clamped at full scale).
void accumulateAudio(
    std::vector<double>& sum,
    const BYTE* source,
    DWORD byteCount,
    const AudioInputFormat& format,
    double gain);
void writeAudioFromDoubles(
    const std::vector<double>& samples,
    const AudioInputFormat& format,
    std::vector<BYTE>& destination);

class AudioMixer {
public:
    using OutputCallback = std::function<bool(const BYTE* data, DWORD byteCount, int64_t timestampHns, int64_t durationHns)>;

    AudioMixer(
        const AudioInputFormat& format,
        const AudioInputFormat& systemFormat,
        const AudioInputFormat& microphoneFormat,
        bool includeSystem,
        bool includeMicrophone,
        double microphoneGain,
        OutputCallback output);
    ~AudioMixer();

    AudioMixer(const AudioMixer&) = delete;
    AudioMixer& operator=(const AudioMixer&) = delete;

    bool start();
    void setMicrophoneChannelMode(MicrophoneChannelMode mode) { microphoneChannels_.setMode(mode); }
    // Each source on its own, chunk for chunk with the mix and on its timestamps: the system
    // sound as captured and the microphone at unity, before any gain or limiter. Set before
    // start(); either may be empty.
    void setStemOutputs(OutputCallback system, OutputCallback microphone) {
        systemStem_ = std::move(system);
        microphoneStem_ = std::move(microphone);
    }
    void beginTimeline();
    void setPaused(bool paused);
    void stop();
    void pushSystem(const BYTE* data, DWORD byteCount);
    void pushMicrophone(const BYTE* data, DWORD byteCount);

private:
    void append(
        std::vector<BYTE>& queue,
        const BYTE* data,
        DWORD byteCount,
        const AudioInputFormat& sourceFormat,
        double gain,
        AudioDecimatorState& decimator);
    bool pop(std::vector<BYTE>& queue, std::vector<BYTE>& chunk, size_t byteCount);
    void mixLoop();

    AudioInputFormat format_{};
    AudioInputFormat systemFormat_{};
    AudioInputFormat microphoneFormat_{};
    bool includeSystem_ = false;
    bool includeMicrophone_ = false;
    double microphoneGain_ = 1.0;
    OutputCallback output_;
    OutputCallback systemStem_;
    OutputCallback microphoneStem_;
    std::mutex mutex_;
    std::condition_variable cv_;
    std::vector<BYTE> systemQueue_;
    std::vector<BYTE> microphoneQueue_;
    AudioDecimatorState systemDecimator_;
    AudioDecimatorState microphoneDecimator_;
    MicrophoneChannelPicker microphoneChannels_;
    std::vector<BYTE> microphoneScratch_;
    PeakLimiter limiter_;
    std::vector<BYTE> gainBuffer_;
    std::thread thread_;
    std::atomic<bool> stopRequested_ = false;
    bool timelineStarted_ = false;
    bool paused_ = false;
    uint64_t emittedFrames_ = 0;
};
