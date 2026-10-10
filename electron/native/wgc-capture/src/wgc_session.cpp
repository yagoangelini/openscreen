#include "wgc_session.h"

#include <Windows.Graphics.Capture.Interop.h>
#include <d3d10.h>
#include <dxgi1_2.h>
#include <inspectable.h>
#include <winrt/base.h>

#include <chrono>
#include <iostream>
#include <string>
#include <thread>

namespace wf = winrt::Windows::Foundation;
namespace wgcap = winrt::Windows::Graphics::Capture;
namespace wgdx = winrt::Windows::Graphics::DirectX;
namespace wgd3d = winrt::Windows::Graphics::DirectX::Direct3D11;

extern "C" HRESULT __stdcall CreateDirect3D11DeviceFromDXGIDevice(
    ::IDXGIDevice* dxgiDevice,
    ::IInspectable** graphicsDevice);

namespace {

bool succeeded(HRESULT hr, const char* label) {
    if (SUCCEEDED(hr)) {
        return true;
    }

    std::cerr << "ERROR: " << label << " failed (hr=0x" << std::hex << hr << std::dec << ")"
              << std::endl;
    return false;
}

int64_t timeSpanToHns(wf::TimeSpan const& value) {
    return value.count();
}

// H.264 encoding (and the RGB32->NV12 conversion feeding it) requires even
// frame dimensions. Monitor resolutions are always even in practice, so
// CreateForMonitor items never hit this. Windows, however, frequently have
// odd client-area dimensions (arbitrary drag-resize, DPI rounding), and
// GraphicsCaptureItem::Size() reports the window's *actual* size verbatim.
// If we requested a Direct3D11CaptureFramePool sized to that odd value while
// the rest of the pipeline (main.cpp's bitrate calc, MFEncoder) rounds down
// to even, the frame pool's real DXGI textures end up one pixel wider/taller
// than the staging texture the encoder allocates. ID3D11DeviceContext::
// CopyResource silently no-ops on a size mismatch (it only emits a debug-
// layer warning), so the staging texture never receives pixel data and the
// output is solid black for the entire recording -- or, if the mismatch
// trips up the video MFT's input negotiation, SetInputMediaType fails
// outright. Rounding up to the nearest even size here, and using that
// rounded size (not the raw item size) for both the frame pool and
// `captureWidth()`/`captureHeight()`, keeps every consumer of this session
// looking at the exact same dimensions as the real captured texture.
int roundUpToEven(int value) {
    const int clamped = std::max(2, value);
    return (clamped % 2 == 0) ? clamped : clamped + 1;
}

// The adapter driving `monitor`, or null when none claims it (or the lookup
// fails). Creating the capture device there keeps every captured frame on the
// GPU it was rendered on: on a hybrid laptop the default adapter is the iGPU, so
// recording a monitor wired to the discrete GPU made WGC copy each frame across
// the bus, driver work on both GPUs, before the encoder ever saw it -- and the
// reverse for the laptop panel when the app runs on the discrete GPU.
// OPENSCREEN_WGC_ADAPTER=default restores the old default-adapter behaviour.
Microsoft::WRL::ComPtr<IDXGIAdapter1> findAdapterForMonitor(HMONITOR monitor) {
    if (!monitor) {
        return nullptr;
    }
    char override[32]{};
    if (GetEnvironmentVariableA("OPENSCREEN_WGC_ADAPTER", override, sizeof(override)) > 0 &&
        std::string(override) == "default") {
        return nullptr;
    }
    Microsoft::WRL::ComPtr<IDXGIFactory1> factory;
    if (FAILED(CreateDXGIFactory1(IID_PPV_ARGS(&factory)))) {
        return nullptr;
    }
    for (UINT adapterIndex = 0;; ++adapterIndex) {
        Microsoft::WRL::ComPtr<IDXGIAdapter1> adapter;
        if (FAILED(factory->EnumAdapters1(adapterIndex, &adapter)) || !adapter) {
            return nullptr;
        }
        for (UINT outputIndex = 0;; ++outputIndex) {
            Microsoft::WRL::ComPtr<IDXGIOutput> output;
            if (FAILED(adapter->EnumOutputs(outputIndex, &output)) || !output) {
                break;
            }
            DXGI_OUTPUT_DESC desc{};
            if (SUCCEEDED(output->GetDesc(&desc)) && desc.Monitor == monitor) {
                return adapter;
            }
        }
    }
}

} // namespace

WgcSession::~WgcSession() {
    stop();
}

bool WgcSession::createD3DDevice(HMONITOR targetMonitor) {
    UINT flags = D3D11_CREATE_DEVICE_BGRA_SUPPORT | D3D11_CREATE_DEVICE_VIDEO_SUPPORT;
#if defined(_DEBUG)
    flags |= D3D11_CREATE_DEVICE_DEBUG;
#endif

    D3D_FEATURE_LEVEL featureLevels[] = {
        D3D_FEATURE_LEVEL_11_1,
        D3D_FEATURE_LEVEL_11_0,
        D3D_FEATURE_LEVEL_10_1,
        D3D_FEATURE_LEVEL_10_0,
    };
    D3D_FEATURE_LEVEL featureLevel{};

    HRESULT hr = E_FAIL;
    const Microsoft::WRL::ComPtr<IDXGIAdapter1> monitorAdapter = findAdapterForMonitor(targetMonitor);
    if (monitorAdapter) {
        // An explicit adapter requires D3D_DRIVER_TYPE_UNKNOWN.
        hr = D3D11CreateDevice(
            monitorAdapter.Get(),
            D3D_DRIVER_TYPE_UNKNOWN,
            nullptr,
            flags,
            featureLevels,
            ARRAYSIZE(featureLevels),
            D3D11_SDK_VERSION,
            &d3dDevice_,
            &featureLevel,
            &d3dContext_);
        if (FAILED(hr)) {
            std::cerr << "WARNING: Could not create the capture device on the monitor's adapter (hr=0x"
                      << std::hex << static_cast<uint32_t>(hr) << std::dec
                      << "); using the default adapter" << std::endl;
        }
    }
    if (FAILED(hr)) {
        hr = D3D11CreateDevice(
            nullptr,
            D3D_DRIVER_TYPE_HARDWARE,
            nullptr,
            flags,
            featureLevels,
            ARRAYSIZE(featureLevels),
            D3D11_SDK_VERSION,
            &d3dDevice_,
            &featureLevel,
            &d3dContext_);
    }

#if defined(_DEBUG)
    if (FAILED(hr)) {
        flags &= ~D3D11_CREATE_DEVICE_DEBUG;
        hr = D3D11CreateDevice(
            nullptr,
            D3D_DRIVER_TYPE_HARDWARE,
            nullptr,
            flags,
            featureLevels,
            ARRAYSIZE(featureLevels),
            D3D11_SDK_VERSION,
            &d3dDevice_,
            &featureLevel,
            &d3dContext_);
    }
#endif

    if (!succeeded(hr, "D3D11CreateDevice")) {
        return false;
    }

    Microsoft::WRL::ComPtr<ID3D10Multithread> multithread;
    if (!succeeded(d3dContext_.As(&multithread), "Query ID3D10Multithread")) {
        return false;
    }
    multithread->SetMultithreadProtected(TRUE);

    Microsoft::WRL::ComPtr<IDXGIDevice> dxgiDevice;
    if (!succeeded(d3dDevice_.As(&dxgiDevice), "Query IDXGIDevice")) {
        return false;
    }

    winrt::com_ptr<::IInspectable> inspectableDevice;
    if (!succeeded(CreateDirect3D11DeviceFromDXGIDevice(dxgiDevice.Get(), inspectableDevice.put()),
                   "CreateDirect3D11DeviceFromDXGIDevice")) {
        return false;
    }

    winrtDevice_ = inspectableDevice.as<wgd3d::IDirect3DDevice>();
    return true;
}

bool WgcSession::createCaptureItem(HMONITOR monitor) {
    monitor_ = monitor;
    window_ = nullptr;
    auto factory = winrt::get_activation_factory<wgcap::GraphicsCaptureItem>();
    auto interop = factory.as<IGraphicsCaptureItemInterop>();

    wgcap::GraphicsCaptureItem item{nullptr};
    HRESULT hr = interop->CreateForMonitor(
        monitor,
        winrt::guid_of<wgcap::GraphicsCaptureItem>(),
        reinterpret_cast<void**>(winrt::put_abi(item)));
    if (!succeeded(hr, "CreateForMonitor")) {
        return false;
    }

    item_ = item;
    const auto size = item_.Size();
    // Rounded up for the same reason as a window (see roundUpToEven): the
    // encoder takes an even size, and a pool one pixel off makes every
    // CopyResource a silent no-op -- a whole take of black frames on a monitor
    // whose mode has an odd dimension.
    width_ = roundUpToEven(static_cast<int>(size.Width));
    height_ = roundUpToEven(static_cast<int>(size.Height));
    return width_ > 0 && height_ > 0;
}

bool WgcSession::createCaptureItem(HWND window) {
    window_ = window;
    monitor_ = nullptr;
    auto factory = winrt::get_activation_factory<wgcap::GraphicsCaptureItem>();
    auto interop = factory.as<IGraphicsCaptureItemInterop>();

    wgcap::GraphicsCaptureItem item{nullptr};
    HRESULT hr = interop->CreateForWindow(
        window,
        winrt::guid_of<wgcap::GraphicsCaptureItem>(),
        reinterpret_cast<void**>(winrt::put_abi(item)));
    if (!succeeded(hr, "CreateForWindow")) {
        return false;
    }

    item_ = item;
    const auto size = item_.Size();
    width_ = roundUpToEven(static_cast<int>(size.Width));
    height_ = roundUpToEven(static_cast<int>(size.Height));
    return width_ > 0 && height_ > 0;
}

bool WgcSession::applySessionOptions(bool captureCursor) {
    captureCursor_ = captureCursor;

    try {
        auto session2 = session_.try_as<wgcap::IGraphicsCaptureSession2>();
        if (!session2) {
            if (!captureCursor) {
                std::cerr << "ERROR: WGC cursor suppression is not supported by this Windows runtime"
                          << std::endl;
                return false;
            }
        } else {
            session2.IsCursorCaptureEnabled(captureCursor);
            const bool appliedCursorCapture = session2.IsCursorCaptureEnabled();
            std::cout << "{\"event\":\"cursor-capture\",\"schemaVersion\":2,\"requested\":"
                      << (captureCursor ? "true" : "false")
                      << ",\"applied\":" << (appliedCursorCapture ? "true" : "false") << "}"
                      << std::endl;

            if (appliedCursorCapture != captureCursor) {
                std::cerr << "ERROR: WGC cursor capture setting did not apply" << std::endl;
                return false;
            }
        }
    } catch (winrt::hresult_error const& error) {
        std::cerr << "ERROR: Failed to configure WGC cursor capture (hr=0x" << std::hex
                  << static_cast<uint32_t>(error.code()) << std::dec << ")" << std::endl;
        if (!captureCursor) {
            return false;
        }
    } catch (...) {
        std::cerr << "ERROR: Failed to configure WGC cursor capture" << std::endl;
        if (!captureCursor) {
            return false;
        }
    }

    try {
        session_.IsBorderRequired(false);
    } catch (...) {
        // IsBorderRequired is Windows 11-only. Ignore it on older builds.
    }

    // Best effort, never a reason to fail the recording: a menu missing from the
    // video is today's behavior, a recording that does not start is not.
    if (includeSecondaryWindows_ && !secondaryWindowsReported_) {
        bool applied = false;
#if defined(NTDDI_WIN11_GE)
        // IGraphicsCaptureSession6 (Windows 11 24H2, SDK 26100). try_as returns
        // null on an older runtime, so it degrades to the window alone.
        try {
            if (auto session6 = session_.try_as<wgcap::IGraphicsCaptureSession6>()) {
                session6.IncludeSecondaryWindows(true);
                applied = session6.IncludeSecondaryWindows();
            }
        } catch (...) {
            // Left at applied=false; the event below says so.
        }
#endif
        secondaryWindowsReported_ = true;
        std::cout << "{\"event\":\"secondary-windows\",\"applied\":" << (applied ? "true" : "false")
                  << "}" << std::endl;
    }

    return true;
}

bool WgcSession::initialize(HMONITOR monitor, int fps, bool captureCursor) {
    fps_ = fps > 0 ? fps : 60;
    if (!createD3DDevice(monitor)) {
        return false;
    }
    if (!createCaptureItem(monitor)) {
        return false;
    }

    framePool_ = wgcap::Direct3D11CaptureFramePool::CreateFreeThreaded(
        winrtDevice_,
        wgdx::DirectXPixelFormat::B8G8R8A8UIntNormalized,
        2,
        winrt::Windows::Graphics::SizeInt32{width_, height_});
    session_ = framePool_.CreateCaptureSession(item_);

    if (!applySessionOptions(captureCursor)) {
        return false;
    }

    return true;
}

bool WgcSession::initialize(HWND window, int fps, bool captureCursor, bool includeSecondaryWindows) {
    fps_ = fps > 0 ? fps : 60;
    includeSecondaryWindows_ = includeSecondaryWindows;
    // A window is captured from the monitor it sits on when the take starts.
    if (!createD3DDevice(MonitorFromWindow(window, MONITOR_DEFAULTTONEAREST))) {
        return false;
    }
    if (!createCaptureItem(window)) {
        return false;
    }

    framePool_ = wgcap::Direct3D11CaptureFramePool::CreateFreeThreaded(
        winrtDevice_,
        wgdx::DirectXPixelFormat::B8G8R8A8UIntNormalized,
        2,
        winrt::Windows::Graphics::SizeInt32{width_, height_});
    session_ = framePool_.CreateCaptureSession(item_);

    if (!applySessionOptions(captureCursor)) {
        return false;
    }

    return true;
}

bool WgcSession::start() {
    if (!session_) {
        return false;
    }
    if (!applySessionOptions(captureCursor_)) {
        return false;
    }
    session_.StartCapture();
    started_ = true;
    return true;
}

bool WgcSession::tryGetNextFrame(ID3D11Texture2D** outTexture, int64_t* outTimestampHns) {
    if (!framePool_) {
        return false;
    }

    // TryGetNextFrame() and frame.Close() are the only WGC calls this makes;
    // neither performs the GPU copy itself, so neither is where a wedge in
    // #252 was ever observed. The copy (CopyResource, on whatever the caller
    // does with *outTexture) is the caller's own doing on the caller's own
    // thread -- this class has no thread of its own left to hang on their
    // behalf.
    if (frameSourceFailed_) {
        return false;
    }

    // Every call below is a C++/WinRT projection, and a projection reports a
    // failed HRESULT by throwing. Nothing up the stack catches it -- this runs
    // on the writer thread -- so a device removed by a driver reset, a GPU
    // switch on a hybrid laptop, or a closed capture item used to end in
    // std::terminate: no Finalize(), and the take lost with it. Catching here
    // turns that into a failure the writer loop can stop on cleanly.
    winrt::Windows::Graphics::Capture::Direct3D11CaptureFrame frame{nullptr};
    Microsoft::WRL::ComPtr<ID3D11Texture2D> texture;
    int64_t timestampHns = 0;
    try {
        frame = framePool_.TryGetNextFrame();
        if (!frame) {
            checkSourceStillExists();
            return false;
        }

        auto surface = frame.Surface();
        auto access = surface.as<::Windows::Graphics::DirectX::Direct3D11::IDirect3DDxgiInterfaceAccess>();
        HRESULT hr = access->GetInterface(__uuidof(ID3D11Texture2D), reinterpret_cast<void**>(texture.GetAddressOf()));
        if (FAILED(hr) || !texture) {
            return false;
        }
        timestampHns = timeSpanToHns(frame.SystemRelativeTime());
    } catch (const winrt::hresult_error& error) {
        frameSourceError_ = error.code();
        frameSourceFailed_ = true;
        return false;
    }

    // Closing the previous frame here (rather than right after this class
    // copied out of it) returns it to the pool only once the caller has had a
    // full interval to read the one before that -- the pool has 2 buffers, so
    // closing eagerly would let WGC recycle a buffer the caller might still
    // be mid-CopyResource on across the two-call boundary. currentFrame_
    // holds the reference that keeps *outTexture valid until this class's
    // next call or stop() closes it.
    currentFrame_ = frame;

    *outTexture = texture.Get();
    *outTimestampHns = timestampHns;
    return true;
}

void WgcSession::checkSourceStillExists() {
    // The captured window closed, or the monitor was unplugged or switched
    // off. WGC simply stops delivering frames, so the writer kept re-encoding
    // the last one for the rest of the take: a frozen picture, with sound, and
    // no word to anyone. GraphicsCaptureItem::Closed would say so, but it is
    // never raised in this helper -- it has no dispatcher queue to raise it on
    // (measured: a captured window killed mid-take, no event in 12 s). Asking
    // the source directly works anywhere. Only while frames are not arriving,
    // and at most once a second, so a live take pays nothing for it.
    const auto now = std::chrono::steady_clock::now();
    if (now - lastSourceCheck_ < std::chrono::seconds(1)) {
        return;
    }
    lastSourceCheck_ = now;

    bool exists = true;
    if (window_) {
        exists = IsWindow(window_) != FALSE;
    } else if (monitor_) {
        MONITORINFO info{};
        info.cbSize = sizeof(info);
        exists = GetMonitorInfoW(monitor_, &info) != FALSE;
    }
    if (!exists) {
        sourceClosed_ = true;
        frameSourceError_ = HRESULT_FROM_WIN32(ERROR_INVALID_WINDOW_HANDLE);
        frameSourceFailed_ = true;
    }
}

void WgcSession::setFrameCallback(FrameCallback callback) {
    if (!legacyCallbackRegistered_ && framePool_) {
        frameArrivedToken_ = framePool_.FrameArrived({this, &WgcSession::onFrameArrived});
        legacyCallbackRegistered_ = true;
    }
    std::scoped_lock lock(callbackMutex_);
    frameCallback_ = std::move(callback);
}

void WgcSession::onFrameArrived(
    wgcap::Direct3D11CaptureFramePool const& sender,
    wf::IInspectable const&) {
    // Scoped rather than a bare decrement at the end, for two reasons: a
    // callback that left by exception would otherwise strand
    // quiesceLegacyCallback()'s drain forever, and the guard has to outlive
    // every pool-owned object this handler touches -- dropping the count
    // first would let quiesce return and close the frame pool while this
    // handler still holds a reference into it.
    struct InFlightGuard {
        std::atomic<int>& counter;
        ~InFlightGuard() {
            counter -= 1;
        }
    };

    // Captured and counted before TryGetNextFrame(), not after: this handler
    // starts touching the pool (TryGetNextFrame, Surface(), GetInterface())
    // immediately below, and none of that is safe to run concurrently with
    // framePool_.Close(). Counting only after those calls succeeded left a
    // window where quiesceLegacyCallback() could see callbacksInFlight_ == 0
    // and return while this handler was still mid-frame -- registering the
    // guard first, before anything pool-related, closes that window instead
    // of narrowing it.
    //
    // Returns here, before incrementing the counter or touching the pool, if
    // frameCallback_ is already null: there is nothing to do with a frame in
    // that case, so the handler should not acquire one. This also means a
    // handler that starts after quiesceLegacyCallback() has cleared
    // frameCallback_ is never counted at all -- which is fine, since it never
    // reaches the pool either.
    FrameCallback callback;
    {
        std::scoped_lock lock(callbackMutex_);
        callback = frameCallback_;
        if (!callback) {
            return;
        }
        // Counted under the same lock quiesceLegacyCallback() clears the
        // callback under, so once it has cleared it no new handler can start
        // and the counter it then drains cannot go back up.
        callbacksInFlight_ += 1;
    }
    InFlightGuard guard{callbacksInFlight_};

    auto frame = sender.TryGetNextFrame();
    if (!frame) {
        return;
    }

    auto surface = frame.Surface();
    auto access = surface.as<::Windows::Graphics::DirectX::Direct3D11::IDirect3DDxgiInterfaceAccess>();
    Microsoft::WRL::ComPtr<ID3D11Texture2D> texture;
    HRESULT hr = access->GetInterface(__uuidof(ID3D11Texture2D), reinterpret_cast<void**>(texture.GetAddressOf()));
    if (FAILED(hr) || !texture) {
        frame.Close();
        return;
    }

    // callback is never null here: the only path that reaches this point
    // returned earlier if frameCallback_ was null when captured.
    callback(texture.Get(), timeSpanToHns(frame.SystemRelativeTime()));
    frame.Close();
}

bool WgcSession::quiesceLegacyCallback(int drainTimeoutMs) {
    if (quiesced_) {
        return callbacksInFlight_.load() == 0;
    }
    quiesced_ = true;

    if (!legacyCallbackRegistered_) {
        return true;
    }

    try {
        if (framePool_) {
            framePool_.FrameArrived(frameArrivedToken_);
        }
    } catch (...) {
        // Revoking a handler the runtime has already torn down is not a reason
        // to abandon the rest of the shutdown.
    }
    {
        // Drop the callback under the same lock onFrameArrived copies it
        // under, so any handler that has not read it yet becomes a no-op...
        std::scoped_lock lock(callbackMutex_);
        frameCallback_ = nullptr;
    }
    // ...then wait out the handlers that already read it. Without this,
    // stop() could Reset() the D3D context while a callback was still
    // issuing CopyResource on it.
    //
    // Bounded, because a callback wedged inside the display driver never
    // finishes (this is #252 -- the exact failure this legacy path is kept
    // around to let a user opt back into, so its own known weakness needs no
    // further comment here). Giving up is reported rather than papered over:
    // the caller keeps the device alive instead, which leaks it until the
    // process exits and is the lesser of the two failures.
    const auto drainDeadline =
        std::chrono::steady_clock::now() + std::chrono::milliseconds(drainTimeoutMs);
    while (callbacksInFlight_.load() > 0) {
        if (std::chrono::steady_clock::now() >= drainDeadline) {
            std::cerr << "WARNING: A WGC frame callback did not finish; leaving the device alive"
                      << std::endl;
            return false;
        }
        std::this_thread::sleep_for(std::chrono::milliseconds(1));
    }
    return true;
}

void WgcSession::stop() {
    if (!started_ && !framePool_) {
        return;
    }

    if (legacyCallbackRegistered_ && !quiesceLegacyCallback()) {
        // A callback is still inside the driver holding this context.
        // Releasing it now would pull the device out from under a live
        // CopyResource, so leak it and let process exit reclaim it. This is
        // the exact hang class the pull-based default avoids; it is only
        // reachable via OPENSCREEN_WGC_LEGACY_FRAME_CALLBACK=1.
        return;
    }

    // Close() is a C++/WinRT projection and throws hresult_error on failure.
    // Letting that escape would take the process down through std::terminate
    // mid-shutdown, discarding a recording that is already finalized by the
    // time this runs. There is nothing to do about a capture session that
    // refuses to close except stop caring about it.
    //
    // On the pull-based (default) path, there is no other thread that could
    // be mid-copy on currentFrame_'s texture when this runs: the caller only
    // ever calls tryGetNextFrame() and stop() from its own thread, so by the
    // time stop() is reached whatever the caller was doing with the last
    // texture it read is already done. On the legacy path, the
    // quiesceLegacyCallback() call above already established the same
    // invariant before falling through to here.
    try {
        currentFrame_ = nullptr;
        if (session_) {
            session_.Close();
        }
        if (framePool_) {
            framePool_.Close();
        }
    } catch (winrt::hresult_error const& error) {
        std::cerr << "WARNING: Failed to close the WGC session (hr=0x" << std::hex
                  << static_cast<uint32_t>(error.code()) << std::dec << ")" << std::endl;
    } catch (...) {
        std::cerr << "WARNING: Failed to close the WGC session" << std::endl;
    }
    session_ = nullptr;
    framePool_ = nullptr;
    started_ = false;
    item_ = nullptr;
    winrtDevice_ = nullptr;
    d3dContext_.Reset();
    d3dDevice_.Reset();
}

int WgcSession::captureWidth() const {
    return width_;
}

int WgcSession::captureHeight() const {
    return height_;
}

ID3D11Device* WgcSession::device() const {
    return d3dDevice_.Get();
}

ID3D11DeviceContext* WgcSession::context() const {
    return d3dContext_.Get();
}
