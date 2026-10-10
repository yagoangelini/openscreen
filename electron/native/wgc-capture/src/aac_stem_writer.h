#pragma once

#include "mf_encoder.h"

#include <Windows.h>
#include <mfreadwrite.h>
#include <wrl/client.h>

#include <cstdint>
#include <mutex>
#include <string>

// One audio source of a take on its own, as an AAC .m4a beside the video: the voice or the
// computer sound, so the editor can set their volumes apart. The video keeps the mixed track
// as before; these are extra. Plain MP4, so a take that does not stop cleanly loses its stems
// (the index is written by finalize) but never its mixed track, which is fragmented.
class AacStemWriter {
public:
    AacStemWriter() = default;
    ~AacStemWriter();

    AacStemWriter(const AacStemWriter&) = delete;
    AacStemWriter& operator=(const AacStemWriter&) = delete;

    // `format` is the PCM the mixer emits (16-bit, the encoder's rate and channel count).
    bool open(const std::wstring& path, const AudioInputFormat& format);
    bool write(const BYTE* data, DWORD byteCount, int64_t timestampHns, int64_t durationHns);
    bool finalize();
    bool isOpen() const { return writer_ != nullptr; }

private:
    std::mutex mutex_;
    Microsoft::WRL::ComPtr<IMFSinkWriter> writer_;
    DWORD stream_ = 0;
    bool started_ = false;
    bool finalized_ = false;
    bool mfStarted_ = false;
};
