#include "aac_stem_writer.h"

#include <mfapi.h>
#include <mferror.h>

#include <algorithm>
#include <cstring>
#include <iostream>

namespace {

void setFormat(IMFMediaType* type, UINT32 channels, UINT32 sampleRate) {
    type->SetGUID(MF_MT_MAJOR_TYPE, MFMediaType_Audio);
    type->SetUINT32(MF_MT_AUDIO_NUM_CHANNELS, channels);
    type->SetUINT32(MF_MT_AUDIO_SAMPLES_PER_SECOND, sampleRate);
    type->SetUINT32(MF_MT_AUDIO_BITS_PER_SAMPLE, 16);
}

}  // namespace

AacStemWriter::~AacStemWriter() {
    finalize();
}

bool AacStemWriter::open(const std::wstring& path, const AudioInputFormat& format) {
    std::scoped_lock lock(mutex_);
    if (writer_ || format.sampleRate == 0 || format.channels == 0) {
        return false;
    }
    if (FAILED(MFStartup(MF_VERSION))) {
        return false;
    }
    mfStarted_ = true;

    Microsoft::WRL::ComPtr<IMFAttributes> attributes;
    MFCreateAttributes(&attributes, 1);
    attributes->SetGUID(MF_TRANSCODE_CONTAINERTYPE, MFTranscodeContainerType_MPEG4);
    Microsoft::WRL::ComPtr<IMFSinkWriter> writer;
    if (FAILED(MFCreateSinkWriterFromURL(path.c_str(), nullptr, attributes.Get(), &writer))) {
        std::wcerr << L"WARNING: [stems] could not create " << path << std::endl;
        return false;
    }

    Microsoft::WRL::ComPtr<IMFMediaType> output;
    MFCreateMediaType(&output);
    output->SetGUID(MF_MT_SUBTYPE, MFAudioFormat_AAC);
    setFormat(output.Get(), format.channels, format.sampleRate);
    output->SetUINT32(MF_MT_AUDIO_AVG_BYTES_PER_SECOND, 24'000);
    output->SetUINT32(MF_MT_AAC_PAYLOAD_TYPE, 0);
    DWORD stream = 0;
    if (FAILED(writer->AddStream(output.Get(), &stream))) {
        return false;
    }

    Microsoft::WRL::ComPtr<IMFMediaType> input;
    MFCreateMediaType(&input);
    input->SetGUID(MF_MT_SUBTYPE, MFAudioFormat_PCM);
    setFormat(input.Get(), format.channels, format.sampleRate);
    input->SetUINT32(MF_MT_AUDIO_BLOCK_ALIGNMENT, format.channels * 2);
    input->SetUINT32(MF_MT_AUDIO_AVG_BYTES_PER_SECOND, format.sampleRate * format.channels * 2);
    input->SetUINT32(MF_MT_ALL_SAMPLES_INDEPENDENT, TRUE);
    if (FAILED(writer->SetInputMediaType(stream, input.Get(), nullptr)) || FAILED(writer->BeginWriting())) {
        return false;
    }
    writer_ = writer;
    stream_ = stream;
    started_ = true;
    return true;
}

bool AacStemWriter::write(const BYTE* data, DWORD byteCount, int64_t timestampHns, int64_t durationHns) {
    std::scoped_lock lock(mutex_);
    if (!writer_ || finalized_ || !started_ || failed_) {
        return false;
    }
    if (!data || byteCount == 0 || durationHns <= 0) {
        return true;
    }
    if (!writeSampleLocked(data, byteCount, timestampHns, durationHns)) {
        failed_ = true;
        return false;
    }
    return true;
}

bool AacStemWriter::writeSampleLocked(const BYTE* data, DWORD byteCount, int64_t timestampHns, int64_t durationHns) {
    Microsoft::WRL::ComPtr<IMFMediaBuffer> buffer;
    if (FAILED(MFCreateMemoryBuffer(byteCount, &buffer))) {
        return false;
    }
    BYTE* destination = nullptr;
    DWORD maxLength = 0;
    if (FAILED(buffer->Lock(&destination, &maxLength, nullptr)) || maxLength < byteCount) {
        return false;
    }
    std::memcpy(destination, data, byteCount);
    buffer->Unlock();
    buffer->SetCurrentLength(byteCount);
    Microsoft::WRL::ComPtr<IMFSample> sample;
    if (FAILED(MFCreateSample(&sample))) {
        return false;
    }
    sample->AddBuffer(buffer.Get());
    sample->SetSampleTime(std::max<int64_t>(0, timestampHns));
    sample->SetSampleDuration(durationHns);
    return SUCCEEDED(writer_->WriteSample(stream_, sample.Get()));
}

bool AacStemWriter::finalize() {
    std::scoped_lock lock(mutex_);
    if (finalized_) {
        return true;
    }
    finalized_ = true;
    bool ok = true;
    if (writer_) {
        ok = SUCCEEDED(writer_->Finalize());
        writer_.Reset();
    }
    if (mfStarted_) {
        MFShutdown();
        mfStarted_ = false;
    }
    // Closed either way, so the file is not left open; announced only when it is whole.
    return ok && !failed_;
}
