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

#include <algorithm>
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

/**
 * ocr-scan.exe --popups <video> <ms,ms,...>
 *
 * For each time (a click), what changed on screen just after it: the frame 150 ms before
 * against the one 600 ms after, compared on a coarse luma grid. A menu or dropdown drawn
 * inside a web page is invisible to UI Automation, but not to this. One line per time:
 *   {"type":"change","t":4210,"rect":[x,y,w,h],"share":0.031}   (fractions of the frame)
 *   {"type":"none","t":4210}
 * Decoded as NV12 and read on its Y plane only, so no frame is converted to colour.
 */
namespace popups {

constexpr int kGridW = 192;
constexpr int kGridH = 108;
constexpr LONGLONG kBeforeHns = 1'500'000;  // 150 ms
constexpr LONGLONG kAfterHns = 6'000'000;   // 600 ms
/** A cell this much brighter or darker, in luma levels, has changed. */
constexpr float kCellDelta = 14.0f;
/** Less than this share of the cells changing is a cursor hover, a caret, noise. */
constexpr double kMinChangedShare = 0.002;

struct Grid {
    std::vector<float> cells;
};

bool lumaGrid(IMFSample* sample, UINT32 width, UINT32 height, Grid& out) {
    ComPtr<IMFMediaBuffer> buffer;
    if (FAILED(sample->ConvertToContiguousBuffer(&buffer))) return false;
    BYTE* data = nullptr;
    LONG pitch = static_cast<LONG>(width);
    ComPtr<IMF2DBuffer> buffer2d;
    bool locked2d = false;
    if (SUCCEEDED(buffer.As(&buffer2d)) && SUCCEEDED(buffer2d->Lock2D(&data, &pitch))) {
        locked2d = true;
    } else if (FAILED(buffer->Lock(&data, nullptr, nullptr))) {
        return false;
    }
    out.cells.assign(kGridW * kGridH, 0.0f);
    for (int gy = 0; gy < kGridH; ++gy) {
        const UINT32 y0 = static_cast<UINT32>(static_cast<uint64_t>(gy) * height / kGridH);
        const UINT32 y1 = std::max(y0 + 1, static_cast<UINT32>(static_cast<uint64_t>(gy + 1) * height / kGridH));
        for (int gx = 0; gx < kGridW; ++gx) {
            const UINT32 x0 = static_cast<UINT32>(static_cast<uint64_t>(gx) * width / kGridW);
            const UINT32 x1 = std::max(x0 + 1, static_cast<UINT32>(static_cast<uint64_t>(gx + 1) * width / kGridW));
            // A few samples per cell: enough to see a menu, cheap enough for hundreds of clicks.
            float sum = 0.0f;
            int n = 0;
            for (UINT32 y = y0; y < y1; y += 2) {
                const BYTE* row = data + static_cast<ptrdiff_t>(y) * pitch;
                for (UINT32 x = x0; x < x1; x += 2) {
                    sum += row[x];
                    ++n;
                }
            }
            out.cells[gy * kGridW + gx] = n > 0 ? sum / n : 0.0f;
        }
    }
    if (locked2d) buffer2d->Unlock2D(); else buffer->Unlock();
    return true;
}

/** The first decoded frame at or after `target` (100 ns units), from wherever the reader is. */
bool readUntil(IMFSourceReader* reader, DWORD stream, LONGLONG target, ComPtr<IMFSample>& out) {
    for (int guard = 0; guard < 2000; ++guard) {
        DWORD flags = 0;
        LONGLONG timestamp = 0;
        ComPtr<IMFSample> sample;
        if (FAILED(reader->ReadSample(stream, 0, nullptr, &flags, &timestamp, &sample))) return false;
        if (flags & MF_SOURCE_READERF_ENDOFSTREAM) return false;
        if (!sample) continue;
        out = sample;
        if (timestamp + 170'000 >= target) return true;  // within a frame at 60 fps
    }
    return false;
}

int run(const std::wstring& videoPath, const std::wstring& timesArg) {
    std::vector<LONGLONG> times;
    size_t start = 0;
    while (start <= timesArg.size()) {
        const size_t comma = timesArg.find(L',', start);
        const std::wstring token = timesArg.substr(start, comma == std::wstring::npos ? std::wstring::npos : comma - start);
        if (!token.empty()) times.push_back(static_cast<LONGLONG>(_wtoi64(token.c_str())) * 10'000);
        if (comma == std::wstring::npos) break;
        start = comma + 1;
    }
    std::sort(times.begin(), times.end());

    ComPtr<IMFSourceReader> reader;
    if (FAILED(MFCreateSourceReaderFromURL(videoPath.c_str(), nullptr, &reader))) {
        return fail("could not open the video");
    }
    const DWORD stream = static_cast<DWORD>(MF_SOURCE_READER_FIRST_VIDEO_STREAM);
    reader->SetStreamSelection(static_cast<DWORD>(MF_SOURCE_READER_ALL_STREAMS), FALSE);
    reader->SetStreamSelection(stream, TRUE);
    ComPtr<IMFMediaType> wanted;
    MFCreateMediaType(&wanted);
    wanted->SetGUID(MF_MT_MAJOR_TYPE, MFMediaType_Video);
    wanted->SetGUID(MF_MT_SUBTYPE, MFVideoFormat_NV12);
    if (FAILED(reader->SetCurrentMediaType(stream, nullptr, wanted.Get()))) {
        return fail("the video cannot be decoded to NV12");
    }
    ComPtr<IMFMediaType> actual;
    reader->GetCurrentMediaType(stream, &actual);
    UINT32 width = 0, height = 0;
    MFGetAttributeSize(actual.Get(), MF_MT_FRAME_SIZE, &width, &height);
    if (width == 0 || height == 0) return fail("the video has no frame size");

    for (const LONGLONG t : times) {
        const LONGLONG before = std::max<LONGLONG>(0, t - kBeforeHns);
        const LONGLONG after = t + kAfterHns;
        PROPVARIANT position;
        InitPropVariantFromInt64(before, &position);
        const HRESULT seek = reader->SetCurrentPosition(GUID_NULL, position);
        PropVariantClear(&position);
        ComPtr<IMFSample> a;
        ComPtr<IMFSample> b;
        Grid ga, gb;
        const std::string tMs = std::to_string(t / 10'000);
        if (FAILED(seek) || !readUntil(reader.Get(), stream, before, a) || !readUntil(reader.Get(), stream, after, b) ||
            !lumaGrid(a.Get(), width, height, ga) || !lumaGrid(b.Get(), width, height, gb)) {
            emit("{\"type\":\"none\",\"t\":" + tMs + "}");
            continue;
        }
        // Changed cells, kept only with a changed neighbour: a lone cell is compression noise.
        std::vector<uint8_t> changed(kGridW * kGridH, 0);
        for (int i = 0; i < kGridW * kGridH; ++i) {
            changed[i] = std::fabs(ga.cells[i] - gb.cells[i]) > kCellDelta ? 1 : 0;
        }
        int count = 0, minX = kGridW, minY = kGridH, maxX = -1, maxY = -1;
        for (int gy = 0; gy < kGridH; ++gy) {
            for (int gx = 0; gx < kGridW; ++gx) {
                if (!changed[gy * kGridW + gx]) continue;
                int neighbours = 0;
                for (int dy = -1; dy <= 1; ++dy) {
                    for (int dx = -1; dx <= 1; ++dx) {
                        const int nx = gx + dx, ny = gy + dy;
                        if ((dx || dy) && nx >= 0 && ny >= 0 && nx < kGridW && ny < kGridH && changed[ny * kGridW + nx]) ++neighbours;
                    }
                }
                if (neighbours < 2) continue;
                ++count;
                minX = std::min(minX, gx); maxX = std::max(maxX, gx);
                minY = std::min(minY, gy); maxY = std::max(maxY, gy);
            }
        }
        if (count < kMinChangedShare * kGridW * kGridH) {
            emit("{\"type\":\"none\",\"t\":" + tMs + "}");
            continue;
        }
        const double x = static_cast<double>(minX) / kGridW, y = static_cast<double>(minY) / kGridH;
        const double w = static_cast<double>(maxX - minX + 1) / kGridW, h = static_cast<double>(maxY - minY + 1) / kGridH;
        emit("{\"type\":\"change\",\"t\":" + tMs + ",\"rect\":[" + fmt(x) + "," + fmt(y) + "," + fmt(w) + "," + fmt(h) +
             "],\"share\":" + fmt(static_cast<double>(count) / (kGridW * kGridH)) + "}");
    }
    emit("{\"type\":\"done\",\"times\":" + std::to_string(times.size()) + "}");
    return 0;
}

}  // namespace popups

int wmain(int argc, wchar_t** argv) {
    if (argc >= 4 && std::wstring(argv[1]) == L"--popups") {
        winrt::init_apartment(winrt::apartment_type::multi_threaded);
        if (FAILED(MFStartup(MF_VERSION))) return fail("MFStartup failed");
        const int code = popups::run(argv[2], argv[3]);
        MFShutdown();
        return code;
    }
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
