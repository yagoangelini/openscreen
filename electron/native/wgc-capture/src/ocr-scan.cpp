// ocr-scan.exe <video> [intervalMs]
//
// Reads the text on screen in a recording, for the editor's automatic privacy blur. Windows'
// own OCR (Windows.Media.Ocr), offline: nothing leaves the machine.
//
// One frame every `intervalMs` (default 2000), taken at the keyframe the seek lands on, so
// each sample costs one decoded frame rather than a run of them -- the recorder writes a
// keyframe every two seconds. A frame that looks like the last one read is not read again:
// a screen recording is mostly still, and OCR is the expensive part.
//
// NDJSON on stdout, coordinates as fractions of the frame:
//   {"type":"info","width":1920,"height":1080,"durationSec":61.2,"language":"pt-BR"}
//   {"type":"frame","t":12.0,"words":[[x,y,w,h,"text"],...],"lines":[[first,count],...]}
//   {"type":"same","t":14.0}
//   {"type":"done","frames":31,"read":12,"ocrMs":2310}
//   {"type":"error","message":"..."}            (then exit 1)
// `lines` groups `words` by OCR line: [index of its first word, how many].

#include <Windows.h>
#include <mfapi.h>
#include <mferror.h>
#include <mfidl.h>
#include <mfreadwrite.h>
#include <propvarutil.h>
#include <wrl/client.h>

#include <winrt/Windows.Foundation.Collections.h>
#include <winrt/Windows.Foundation.h>
#include <winrt/Windows.Globalization.h>
#include <winrt/Windows.Graphics.Imaging.h>
#include <winrt/Windows.Media.Ocr.h>
#include <winrt/Windows.Storage.Streams.h>

#include <chrono>
#include <cmath>
#include <cstdint>
#include <cstdio>
#include <string>
#include <vector>

using Microsoft::WRL::ComPtr;
namespace imaging = winrt::Windows::Graphics::Imaging;
namespace ocr = winrt::Windows::Media::Ocr;

namespace {

std::string wideToUtf8(const std::wstring& value) {
    if (value.empty()) return {};
    const int size = WideCharToMultiByte(CP_UTF8, 0, value.data(), static_cast<int>(value.size()), nullptr, 0, nullptr, nullptr);
    std::string out(static_cast<size_t>(size), '\0');
    WideCharToMultiByte(CP_UTF8, 0, value.data(), static_cast<int>(value.size()), out.data(), size, nullptr, nullptr);
    return out;
}

std::string jsonEscape(const std::string& value) {
    std::string out;
    out.reserve(value.size() + 2);
    for (const unsigned char c : value) {
        switch (c) {
            case '"': out += "\\\""; break;
            case '\\': out += "\\\\"; break;
            case '\n': out += "\\n"; break;
            case '\r': out += "\\r"; break;
            case '\t': out += "\\t"; break;
            default:
                if (c < 0x20) {
                    char buf[8];
                    std::snprintf(buf, sizeof(buf), "\\u%04x", c);
                    out += buf;
                } else {
                    out += static_cast<char>(c);
                }
        }
    }
    return out;
}

void emit(const std::string& line) {
    std::fwrite(line.data(), 1, line.size(), stdout);
    std::fputc('\n', stdout);
    std::fflush(stdout);
}

int fail(const std::string& message) {
    emit("{\"type\":\"error\",\"message\":\"" + jsonEscape(message) + "\"}");
    return 1;
}

std::string fmt(double value) {
    char buf[32];
    std::snprintf(buf, sizeof(buf), "%.4f", value);
    return buf;
}

/** A 64x36 grey thumbnail: enough to tell a still screen from a changed one. */
std::vector<float> thumbnail(const std::vector<uint8_t>& bgra, UINT32 width, UINT32 height) {
    constexpr int TW = 64, TH = 36;
    std::vector<float> out(TW * TH, 0.0f);
    for (int ty = 0; ty < TH; ++ty) {
        for (int tx = 0; tx < TW; ++tx) {
            const UINT32 x = static_cast<UINT32>((tx + 0.5) * width / TW);
            const UINT32 y = static_cast<UINT32>((ty + 0.5) * height / TH);
            const uint8_t* p = &bgra[(static_cast<size_t>(y) * width + x) * 4];
            out[ty * TW + tx] = 0.114f * p[0] + 0.587f * p[1] + 0.299f * p[2];
        }
    }
    return out;
}

/** Fraction of thumbnail cells that moved by more than a few grey levels. */
double changedFraction(const std::vector<float>& a, const std::vector<float>& b) {
    if (a.size() != b.size() || a.empty()) return 1.0;
    size_t changed = 0;
    for (size_t i = 0; i < a.size(); ++i) {
        if (std::fabs(a[i] - b[i]) > 6.0f) ++changed;
    }
    return static_cast<double>(changed) / static_cast<double>(a.size());
}

/** The frame as top-down BGRA, whatever the buffer's pitch. */
bool copyFrame(IMFSample* sample, UINT32 width, UINT32 height, LONG defaultStride, std::vector<uint8_t>& out) {
    ComPtr<IMFMediaBuffer> buffer;
    if (FAILED(sample->ConvertToContiguousBuffer(&buffer))) return false;
    out.resize(static_cast<size_t>(width) * height * 4);
    ComPtr<IMF2DBuffer> buffer2d;
    if (SUCCEEDED(buffer.As(&buffer2d))) {
        BYTE* scan0 = nullptr;
        LONG pitch = 0;
        if (FAILED(buffer2d->Lock2D(&scan0, &pitch))) return false;
        for (UINT32 y = 0; y < height; ++y) {
            std::memcpy(&out[static_cast<size_t>(y) * width * 4], scan0 + static_cast<ptrdiff_t>(y) * pitch, width * 4);
        }
        buffer2d->Unlock2D();
        return true;
    }
    BYTE* data = nullptr;
    DWORD length = 0;
    if (FAILED(buffer->Lock(&data, nullptr, &length))) return false;
    const LONG stride = defaultStride != 0 ? defaultStride : static_cast<LONG>(width * 4);
    const BYTE* row0 = stride < 0 ? data + static_cast<size_t>(-stride) * (height - 1) : data;
    for (UINT32 y = 0; y < height; ++y) {
        const BYTE* row = row0 + static_cast<ptrdiff_t>(y) * stride;
        if (row < data || row + width * 4 > data + length) {
            buffer->Unlock();
            return false;
        }
        std::memcpy(&out[static_cast<size_t>(y) * width * 4], row, width * 4);
    }
    buffer->Unlock();
    return true;
}

}  // namespace

int wmain(int argc, wchar_t** argv) {
    if (argc < 2) {
        return fail("usage: ocr-scan.exe <video> [intervalMs]");
    }
    const std::wstring videoPath = argv[1];
    const int intervalMs = argc >= 3 ? std::max(250, _wtoi(argv[2])) : 2000;

    winrt::init_apartment(winrt::apartment_type::multi_threaded);
    if (FAILED(MFStartup(MF_VERSION))) {
        return fail("MFStartup failed");
    }

    ocr::OcrEngine engine = ocr::OcrEngine::TryCreateFromUserProfileLanguages();
    if (!engine) {
        for (const wchar_t* tag : {L"pt-BR", L"en-US"}) {
            winrt::Windows::Globalization::Language language{tag};
            if (ocr::OcrEngine::IsLanguageSupported(language)) {
                engine = ocr::OcrEngine::TryCreateFromLanguage(language);
                if (engine) break;
            }
        }
    }
    if (!engine) {
        return fail("no OCR language is installed");
    }

    ComPtr<IMFAttributes> attributes;
    MFCreateAttributes(&attributes, 1);
    attributes->SetUINT32(MF_SOURCE_READER_ENABLE_VIDEO_PROCESSING, TRUE);
    ComPtr<IMFSourceReader> reader;
    if (FAILED(MFCreateSourceReaderFromURL(videoPath.c_str(), attributes.Get(), &reader))) {
        return fail("could not open the video");
    }
    const DWORD stream = static_cast<DWORD>(MF_SOURCE_READER_FIRST_VIDEO_STREAM);
    reader->SetStreamSelection(static_cast<DWORD>(MF_SOURCE_READER_ALL_STREAMS), FALSE);
    reader->SetStreamSelection(stream, TRUE);

    ComPtr<IMFMediaType> wanted;
    MFCreateMediaType(&wanted);
    wanted->SetGUID(MF_MT_MAJOR_TYPE, MFMediaType_Video);
    wanted->SetGUID(MF_MT_SUBTYPE, MFVideoFormat_RGB32);
    if (FAILED(reader->SetCurrentMediaType(stream, nullptr, wanted.Get()))) {
        return fail("the video cannot be decoded to RGB");
    }
    ComPtr<IMFMediaType> actual;
    reader->GetCurrentMediaType(stream, &actual);
    UINT32 width = 0, height = 0;
    MFGetAttributeSize(actual.Get(), MF_MT_FRAME_SIZE, &width, &height);
    LONG defaultStride = static_cast<LONG>(MFGetAttributeUINT32(actual.Get(), MF_MT_DEFAULT_STRIDE, 0));
    if (width == 0 || height == 0) {
        return fail("the video has no frame size");
    }

    PROPVARIANT durationVar;
    PropVariantInit(&durationVar);
    LONGLONG durationHns = 0;
    if (SUCCEEDED(reader->GetPresentationAttribute(static_cast<DWORD>(MF_SOURCE_READER_MEDIASOURCE), MF_PD_DURATION, &durationVar))) {
        durationHns = static_cast<LONGLONG>(durationVar.uhVal.QuadPart);
    }
    PropVariantClear(&durationVar);

    emit("{\"type\":\"info\",\"width\":" + std::to_string(width) + ",\"height\":" + std::to_string(height) +
         ",\"durationSec\":" + fmt(durationHns / 1e7) + ",\"language\":\"" +
         jsonEscape(wideToUtf8(std::wstring(engine.RecognizerLanguage().LanguageTag()))) + "\"}");

    std::vector<uint8_t> bgra;
    std::vector<float> lastThumb;
    int frames = 0, read = 0;
    double ocrMs = 0;
    LONGLONG lastSampleTime = -1;
    const LONGLONG stepHns = static_cast<LONGLONG>(intervalMs) * 10'000;

    for (LONGLONG target = 0; durationHns <= 0 || target < durationHns; target += stepHns) {
        PROPVARIANT position;
        InitPropVariantFromInt64(target, &position);
        const HRESULT seek = reader->SetCurrentPosition(GUID_NULL, position);
        PropVariantClear(&position);
        if (FAILED(seek)) break;

        DWORD flags = 0;
        LONGLONG timestamp = 0;
        ComPtr<IMFSample> sample;
        HRESULT hr = S_OK;
        // The first decoded frame after the seek: the keyframe at or before `target`.
        while (SUCCEEDED(hr)) {
            hr = reader->ReadSample(stream, 0, nullptr, &flags, &timestamp, &sample);
            if (FAILED(hr) || (flags & MF_SOURCE_READERF_ENDOFSTREAM) || sample) break;
        }
        if (FAILED(hr) || !sample) break;
        if (flags & MF_SOURCE_READERF_CURRENTMEDIATYPECHANGED) {
            actual.Reset();
            reader->GetCurrentMediaType(stream, &actual);
            MFGetAttributeSize(actual.Get(), MF_MT_FRAME_SIZE, &width, &height);
            defaultStride = static_cast<LONG>(MFGetAttributeUINT32(actual.Get(), MF_MT_DEFAULT_STRIDE, 0));
            lastThumb.clear();
        }
        // Two seeks that land on the same keyframe give the same frame: skip the repeat.
        if (timestamp == lastSampleTime) continue;
        lastSampleTime = timestamp;
        ++frames;
        const double t = timestamp / 1e7;

        if (!copyFrame(sample.Get(), width, height, defaultStride, bgra)) continue;
        const std::vector<float> thumb = thumbnail(bgra, width, height);
        if (!lastThumb.empty() && changedFraction(thumb, lastThumb) < 0.002) {
            emit("{\"type\":\"same\",\"t\":" + fmt(t) + "}");
            continue;
        }
        lastThumb = thumb;

        winrt::Windows::Storage::Streams::Buffer pixels(static_cast<uint32_t>(bgra.size()));
        std::memcpy(pixels.data(), bgra.data(), bgra.size());
        pixels.Length(static_cast<uint32_t>(bgra.size()));
        const imaging::SoftwareBitmap bitmap = imaging::SoftwareBitmap::CreateCopyFromBuffer(
            pixels, imaging::BitmapPixelFormat::Bgra8, static_cast<int32_t>(width), static_cast<int32_t>(height),
            imaging::BitmapAlphaMode::Ignore);

        const auto started = std::chrono::steady_clock::now();
        ocr::OcrResult result{nullptr};
        try {
            result = engine.RecognizeAsync(bitmap).get();
        } catch (const winrt::hresult_error&) {
            continue;
        }
        ocrMs += std::chrono::duration<double, std::milli>(std::chrono::steady_clock::now() - started).count();
        ++read;

        std::string words;
        std::string lines;
        size_t wordIndex = 0;
        for (const auto& line : result.Lines()) {
            const size_t first = wordIndex;
            for (const auto& word : line.Words()) {
                const auto r = word.BoundingRect();
                if (!words.empty()) words += ",";
                words += "[" + fmt(r.X / width) + "," + fmt(r.Y / height) + "," + fmt(r.Width / width) + "," +
                         fmt(r.Height / height) + ",\"" + jsonEscape(wideToUtf8(std::wstring(word.Text()))) + "\"]";
                ++wordIndex;
            }
            if (wordIndex > first) {
                if (!lines.empty()) lines += ",";
                lines += "[" + std::to_string(first) + "," + std::to_string(wordIndex - first) + "]";
            }
        }
        emit("{\"type\":\"frame\",\"t\":" + fmt(t) + ",\"words\":[" + words + "],\"lines\":[" + lines + "]}");
    }

    emit("{\"type\":\"done\",\"frames\":" + std::to_string(frames) + ",\"read\":" + std::to_string(read) +
         ",\"ocrMs\":" + std::to_string(static_cast<long long>(ocrMs)) + "}");
    reader.Reset();
    MFShutdown();
    return 0;
}
