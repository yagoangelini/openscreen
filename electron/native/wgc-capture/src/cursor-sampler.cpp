#include <windows.h>
#include <dwmapi.h>
#include <gdiplus.h>
#include <objbase.h>
#include <tlhelp32.h>
#include <uiautomation.h>

#include "dpi_awareness.h"
#include "input_signals.h"
#include "realtime_scheduling.h"

#include <atomic>
#include <algorithm>
#include <chrono>
#include <cinttypes>
#include <condition_variable>
#include <cstdint>
#include <cstdio>
#include <cstring>
#include <deque>
#include <iostream>
#include <mutex>
#include <set>
#include <string>
#include <thread>
#include <vector>

// ─────────────────────────────────────────────────────────────────────────────
// Utilities
// ─────────────────────────────────────────────────────────────────────────────
static int64_t nowMs() {
    return static_cast<int64_t>(
        std::chrono::duration_cast<std::chrono::milliseconds>(
            std::chrono::system_clock::now().time_since_epoch())
        .count());
}

static std::mutex g_stdoutMtx;

static void writeJsonLine(const std::string& json) {
    std::lock_guard<std::mutex> lock(g_stdoutMtx);
    std::cout << json << '\n';
    std::cout.flush();
}

static std::string rectJson(const RECT& r) {
    char buf[128];
    std::snprintf(buf, sizeof(buf), "{\"x\":%ld,\"y\":%ld,\"width\":%ld,\"height\":%ld}",
                  r.left, r.top, r.right - r.left, r.bottom - r.top);
    return buf;
}

static std::string handleJson(const void* h) {
    char buf[32];
    std::snprintf(buf, sizeof(buf), "\"0x%" PRIX64 "\"",
                  static_cast<uint64_t>(reinterpret_cast<uintptr_t>(h)));
    return buf;
}

/// A window's visible bounds: DWM's extended frame, which leaves out the invisible resize
/// borders Windows 10+ adds around a window and which window capture does not draw.
/// GetWindowRect counts them, which put every cursor sample of a window capture ~7 px off.
static bool visibleWindowRect(HWND hwnd, RECT& out) {
    if (SUCCEEDED(DwmGetWindowAttribute(hwnd, DWMWA_EXTENDED_FRAME_BOUNDS, &out, sizeof(out))) &&
        out.right > out.left && out.bottom > out.top) {
        return true;
    }
    return GetWindowRect(hwnd, &out) != FALSE;
}

// ─────────────────────────────────────────────────────────────────────────────
// Input events: queued by the hooks (which must return at once, or Windows silently
// removes them), written by a worker thread that also asks UI Automation what was clicked.
// ─────────────────────────────────────────────────────────────────────────────
struct PendingInput {
    enum Kind { Press, Release, Wheel, Key } kind;
    int64_t timeMs;
    POINT pt;
    int button;          // 0 left, 1 right, 2 middle
    bool isDouble;
    int wheelDelta;
    bool horizontal;
    std::string combo;   // only ever a Ctrl/Alt/Win chord (input_signals::comboName)
};

static std::mutex                 g_inputMtx;
static std::condition_variable    g_inputCv;
static std::deque<PendingInput>   g_inputQueue;
static std::atomic<bool>          g_inputStop{false};

static void queueInput(PendingInput&& input) {
    {
        std::lock_guard<std::mutex> lock(g_inputMtx);
        // A stalled writer must not grow memory without bound; a burst this size is pathological.
        if (g_inputQueue.size() > 4096) g_inputQueue.pop_front();
        g_inputQueue.push_back(std::move(input));
    }
    g_inputCv.notify_one();
}

static const char* buttonName(int button) {
    return button == 1 ? "right" : button == 2 ? "middle" : "left";
}

/// UI Automation at a click: the element's bounds and control type, NEVER its name or value.
/// `uia` may be null (UIA unavailable): the click is still written, without a target.
static std::string clickTargetJson(IUIAutomation* uia, POINT pt) {
    if (!uia) return "";
    IUIAutomationElement* element = nullptr;
    if (FAILED(uia->ElementFromPoint(pt, &element)) || !element) return "";
    std::string out;
    RECT r{};
    CONTROLTYPEID controlType = 0;
    if (SUCCEEDED(element->get_CurrentBoundingRectangle(&r)) && r.right > r.left &&
        r.bottom > r.top) {
        out += ",\"target\":" + rectJson(r);
        if (SUCCEEDED(element->get_CurrentControlType(&controlType)) && controlType) {
            out += ",\"controlType\":" + std::to_string(controlType);
        }
    }
    element->Release();
    return out;
}

static void runInputWorker() {
    const HRESULT coInit = CoInitializeEx(nullptr, COINIT_MULTITHREADED);
    IUIAutomation* uia = nullptr;
    IUIAutomation2* uia2 = nullptr;
    // CUIAutomation8 (Windows 8+) takes timeouts: an app that does not answer must not hold
    // up every later click behind it.
    if (SUCCEEDED(CoCreateInstance(__uuidof(CUIAutomation8), nullptr, CLSCTX_INPROC_SERVER,
                                   IID_PPV_ARGS(&uia2)))) {
        uia2->put_ConnectionTimeout(400);
        uia2->put_TransactionTimeout(400);
        uia = uia2;
    } else if (FAILED(CoCreateInstance(__uuidof(CUIAutomation), nullptr, CLSCTX_INPROC_SERVER,
                                       IID_PPV_ARGS(&uia)))) {
        uia = nullptr;
    }

    for (;;) {
        PendingInput input;
        {
            std::unique_lock<std::mutex> lock(g_inputMtx);
            g_inputCv.wait(lock, [] { return g_inputStop.load() || !g_inputQueue.empty(); });
            if (g_inputQueue.empty()) break;
            input = std::move(g_inputQueue.front());
            g_inputQueue.pop_front();
        }
        std::string out;
        out.reserve(256);
        out += "{\"type\":\"input\",\"timestampMs\":" + std::to_string(input.timeMs);
        out += ",\"x\":" + std::to_string(input.pt.x) + ",\"y\":" + std::to_string(input.pt.y);
        switch (input.kind) {
            case PendingInput::Press:
                out += ",\"kind\":\"press\",\"button\":\"";
                out += buttonName(input.button);
                out += "\",\"double\":";
                out += input.isDouble ? "true" : "false";
                out += clickTargetJson(uia, input.pt);
                break;
            case PendingInput::Release:
                out += ",\"kind\":\"release\",\"button\":\"";
                out += buttonName(input.button);
                out += "\"";
                break;
            case PendingInput::Wheel:
                out += ",\"kind\":\"wheel\",\"delta\":" + std::to_string(input.wheelDelta);
                out += ",\"horizontal\":";
                out += input.horizontal ? "true" : "false";
                break;
            case PendingInput::Key:
                out += ",\"kind\":\"key\"";
                if (!input.combo.empty()) out += ",\"combo\":\"" + input.combo + "\"";
                break;
        }
        out += "}";
        writeJsonLine(out);
    }

    if (uia) uia->Release();
    if (SUCCEEDED(coInit)) CoUninitialize();
}

// ─────────────────────────────────────────────────────────────────────────────
// Global hooks (installed on the main thread, which pumps their messages)
// ─────────────────────────────────────────────────────────────────────────────
static HHOOK              g_mouseHook    = nullptr;
static HHOOK              g_keyboardHook = nullptr;
static DWORD              g_mainThreadId = 0;
static std::atomic<int>   g_leftDownCount{0};
static std::atomic<int>   g_leftUpCount{0};
static std::atomic<bool>  g_stop{false};

static input_signals::DoubleClickTracker* g_doubleClicks = nullptr;
static input_signals::Modifiers           g_modifiers;
static std::set<DWORD>                    g_keysDown;

static void queuePress(PendingInput::Kind kind, int button, const MSLLHOOKSTRUCT* info) {
    PendingInput input{};
    input.kind = kind;
    input.timeMs = input_signals::eventTimeMs(nowMs(), GetTickCount(), info->time);
    input.pt = info->pt;
    input.button = button;
    input.isDouble = kind == PendingInput::Press && g_doubleClicks &&
                     g_doubleClicks->press(button, input.timeMs, info->pt.x, info->pt.y);
    queueInput(std::move(input));
}

static LRESULT CALLBACK LowLevelMouseProc(int nCode, WPARAM wParam, LPARAM lParam) {
    if (nCode >= 0) {
        const auto* info = reinterpret_cast<const MSLLHOOKSTRUCT*>(lParam);
        switch (wParam) {
            case WM_LBUTTONDOWN:
                g_leftDownCount.fetch_add(1, std::memory_order_relaxed);
                queuePress(PendingInput::Press, 0, info);
                break;
            case WM_LBUTTONUP:
                g_leftUpCount.fetch_add(1, std::memory_order_relaxed);
                queuePress(PendingInput::Release, 0, info);
                break;
            case WM_RBUTTONDOWN: queuePress(PendingInput::Press, 1, info); break;
            case WM_RBUTTONUP: queuePress(PendingInput::Release, 1, info); break;
            case WM_MBUTTONDOWN: queuePress(PendingInput::Press, 2, info); break;
            case WM_MBUTTONUP: queuePress(PendingInput::Release, 2, info); break;
            case WM_MOUSEWHEEL:
            case WM_MOUSEHWHEEL: {
                PendingInput input{};
                input.kind = PendingInput::Wheel;
                input.timeMs = input_signals::eventTimeMs(nowMs(), GetTickCount(), info->time);
                input.pt = info->pt;
                input.wheelDelta = static_cast<short>(HIWORD(info->mouseData));
                input.horizontal = wParam == WM_MOUSEHWHEEL;
                queueInput(std::move(input));
                break;
            }
            default:
                break;
        }
    }
    return CallNextHookEx(g_mouseHook, nCode, wParam, lParam);
}

// The modifiers the keyboard holds right now, whatever the hook did or did not see.
static input_signals::Modifiers physicalModifiers() {
    const auto held = [](int vk) { return (GetAsyncKeyState(vk) & 0x8000) != 0; };
    input_signals::Modifiers mods;
    mods.ctrl = held(VK_CONTROL);
    mods.alt = held(VK_MENU);
    mods.shift = held(VK_SHIFT);
    mods.win = held(VK_LWIN) || held(VK_RWIN);
    mods.rightAlt = held(VK_RMENU);
    return mods;
}

static LRESULT CALLBACK LowLevelKeyboardProc(int nCode, WPARAM wParam, LPARAM lParam) {
    if (nCode >= 0) {
        const auto* info = reinterpret_cast<const KBDLLHOOKSTRUCT*>(lParam);
        const DWORD vk = info->vkCode;
        const bool down = wParam == WM_KEYDOWN || wParam == WM_SYSKEYDOWN;
        if (input_signals::isModifierKey(vk)) {
            input_signals::applyModifier(g_modifiers, vk, down);
        } else if (!down) {
            g_keysDown.erase(vk);
        } else if (g_keysDown.insert(vk).second) {
            // A new key-down (not auto-repeat). Its time always; its name only inside a chord,
            // and only with the modifiers the keyboard really holds: a missed key-up stops here
            // instead of naming everything typed after it.
            g_modifiers = input_signals::heldModifiers(g_modifiers, physicalModifiers());
            PendingInput input{};
            input.kind = PendingInput::Key;
            input.timeMs = input_signals::eventTimeMs(nowMs(), GetTickCount(), info->time);
            GetCursorPos(&input.pt);
            input.combo = input_signals::comboName(
                g_modifiers, vk, MapVirtualKeyW(vk, MAPVK_VK_TO_CHAR));
            queueInput(std::move(input));
        }
    }
    return CallNextHookEx(g_keyboardHook, nCode, wParam, lParam);
}

// ─────────────────────────────────────────────────────────────────────────────
// Popups and menus (WinEvents, delivered on the main thread's message loop)
// ─────────────────────────────────────────────────────────────────────────────
static DWORD           g_parentPid = 0;
static std::set<HWND>  g_openPopups;

static DWORD parentProcessId() {
    const DWORD self = GetCurrentProcessId();
    DWORD parent = 0;
    HANDLE snapshot = CreateToolhelp32Snapshot(TH32CS_SNAPPROCESS, 0);
    if (snapshot == INVALID_HANDLE_VALUE) return 0;
    PROCESSENTRY32W entry{};
    entry.dwSize = sizeof(entry);
    if (Process32FirstW(snapshot, &entry)) {
        do {
            if (entry.th32ProcessID == self) {
                parent = entry.th32ParentProcessID;
                break;
            }
        } while (Process32NextW(snapshot, &entry));
    }
    CloseHandle(snapshot);
    return parent;
}

static void writePopup(const char* event, HWND hwnd, bool menu, const RECT* rect) {
    std::string out = "{\"type\":\"popup\",\"timestampMs\":" + std::to_string(nowMs());
    out += ",\"event\":\"";
    out += event;
    out += "\",\"id\":" + handleJson(hwnd);
    out += ",\"menu\":";
    out += menu ? "true" : "false";
    if (rect) out += ",\"rect\":" + rectJson(*rect);
    out += "}";
    writeJsonLine(out);
}

/// A window worth framing: a visible top-level popup (menus, dropdowns, flyouts, dialogs'
/// pickers) that is not a tooltip, not OpenScreen's own (its HUD is a popup too), and neither
/// a speck nor the whole screen.
static bool isFramablePopup(HWND hwnd, RECT& rect) {
    if (!IsWindowVisible(hwnd) || GetAncestor(hwnd, GA_ROOT) != hwnd) return false;
    const LONG_PTR style = GetWindowLongPtrW(hwnd, GWL_STYLE);
    if (!(style & WS_POPUP)) return false;
    DWORD pid = 0;
    GetWindowThreadProcessId(hwnd, &pid);
    if (pid == GetCurrentProcessId() || (g_parentPid && pid == g_parentPid)) return false;
    wchar_t cls[64] = {};
    GetClassNameW(hwnd, cls, 64);
    if (wcscmp(cls, L"tooltips_class32") == 0 || wcscmp(cls, L"Shell_TrayWnd") == 0) return false;
    if (!visibleWindowRect(hwnd, rect)) return false;
    const LONG w = rect.right - rect.left;
    const LONG h = rect.bottom - rect.top;
    if (w < 24 || h < 16) return false;
    const LONG screenW = GetSystemMetrics(SM_CXVIRTUALSCREEN);
    const LONG screenH = GetSystemMetrics(SM_CYVIRTUALSCREEN);
    return !(w >= screenW * 95 / 100 && h >= screenH * 95 / 100);
}

static void CALLBACK WinEventProc(HWINEVENTHOOK, DWORD event, HWND hwnd, LONG idObject,
                                  LONG idChild, DWORD, DWORD) {
    const bool menu = event == EVENT_SYSTEM_MENUPOPUPSTART || event == EVENT_SYSTEM_MENUPOPUPEND;
    if (!hwnd) return;
    // A menu event names its window with OBJID_CLIENT; a show/hide is about a window only when
    // it names the window itself (it fires for every control inside one too).
    if (!menu && (idObject != OBJID_WINDOW || idChild != CHILDID_SELF)) return;
    if (event == EVENT_OBJECT_SHOW || event == EVENT_SYSTEM_MENUPOPUPSTART) {
        RECT rect{};
        if (g_openPopups.count(hwnd) || !isFramablePopup(hwnd, rect)) return;
        g_openPopups.insert(hwnd);
        writePopup("open", hwnd, menu, &rect);
    } else if (event == EVENT_OBJECT_HIDE || event == EVENT_SYSTEM_MENUPOPUPEND ||
               event == EVENT_OBJECT_DESTROY) {
        if (g_openPopups.erase(hwnd)) writePopup("close", hwnd, menu, nullptr);
    }
}

static std::string jsonEscape(const std::string& s) {
    std::string r;
    r.reserve(s.size());
    for (unsigned char c : s) {
        switch (c) {
            case '"':  r += "\\\""; break;
            case '\\': r += "\\\\"; break;
            case '\n': r += "\\n";  break;
            case '\r': r += "\\r";  break;
            case '\t': r += "\\t";  break;
            default:   r.push_back(static_cast<char>(c)); break;
        }
    }
    return r;
}

static const char kBase64Chars[] =
    "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/";

static std::string base64Encode(const uint8_t* data, size_t len) {
    std::string out;
    out.reserve(((len + 2) / 3) * 4);
    for (size_t i = 0; i < len; i += 3) {
        const uint32_t b =
            (static_cast<uint32_t>(data[i])              << 16) |
            (i + 1 < len ? static_cast<uint32_t>(data[i + 1]) << 8 : 0u) |
            (i + 2 < len ? static_cast<uint32_t>(data[i + 2])      : 0u);
        out.push_back(kBase64Chars[(b >> 18) & 0x3F]);
        out.push_back(kBase64Chars[(b >> 12) & 0x3F]);
        out.push_back(i + 1 < len ? kBase64Chars[(b >>  6) & 0x3F] : '=');
        out.push_back(i + 2 < len ? kBase64Chars[(b      ) & 0x3F] : '=');
    }
    return out;
}

// ─────────────────────────────────────────────────────────────────────────────
// GDI+ PNG encoder CLSID
// ─────────────────────────────────────────────────────────────────────────────
static bool getPngClsid(CLSID& out) {
    UINT num = 0, sz = 0;
    if (Gdiplus::GetImageEncodersSize(&num, &sz) != Gdiplus::Ok || sz == 0) return false;
    std::vector<uint8_t> buf(sz);
    auto* enc = reinterpret_cast<Gdiplus::ImageCodecInfo*>(buf.data());
    if (Gdiplus::GetImageEncoders(num, sz, enc) != Gdiplus::Ok) return false;
    for (UINT i = 0; i < num; ++i) {
        if (std::wstring(enc[i].MimeType) == L"image/png") {
            out = enc[i].Clsid;
            return true;
        }
    }
    return false;
}

// ─────────────────────────────────────────────────────────────────────────────
// Standard cursor-type lookup
// ─────────────────────────────────────────────────────────────────────────────
static const char* standardCursorType(HCURSOR hc) {
    if (!hc) return nullptr;
    static const struct { WORD id; const char* name; } kMap[] = {
        {32512, "arrow"},
        {32513, "text"},
        {32514, "wait"},
        {32515, "crosshair"},
        {32516, "up-arrow"},
        {32642, "resize-nwse"},
        {32643, "resize-nesw"},
        {32644, "resize-ew"},
        {32645, "resize-ns"},
        {32646, "move"},
        {32648, "not-allowed"},
        {32649, "pointer"},
        {32650, "app-starting"},
        {32651, "help"},
    };
    static constexpr int N = static_cast<int>(sizeof(kMap) / sizeof(kMap[0]));
    static HCURSOR g_handles[N] = {};
    static bool    g_init       = false;
    if (!g_init) {
        for (int i = 0; i < N; ++i)
            g_handles[i] = LoadCursor(nullptr, MAKEINTRESOURCE(kMap[i].id));
        g_init = true;
    }
    for (int i = 0; i < N; ++i)
        if (g_handles[i] && g_handles[i] == hc) return kMap[i].name;
    return nullptr;
}

// ─────────────────────────────────────────────────────────────────────────────
// Custom cursor-type detection (replicates the PowerShell heuristic)
// ─────────────────────────────────────────────────────────────────────────────
static const char* detectCustomCursorType(
    const uint32_t* pixels, int w, int h, int hotX, int hotY)
{
    if (w < 24 || h < 24 || w > 64 || h > 64) return nullptr;
    if (hotX < w * 0.25 || hotX > w * 0.75)   return nullptr;
    if (hotY < h * 0.15 || hotY > h * 0.55)   return nullptr;

    int opaque = 0, topHalf = 0;
    int left = w, top = h, right = -1, bottom = -1;

    for (int y = 0; y < h; ++y) {
        for (int x = 0; x < w; ++x) {
            const uint8_t a = static_cast<uint8_t>(pixels[y * w + x] >> 24);
            if (a <= 32) continue;
            ++opaque;
            if (y < h / 2) ++topHalf;
            if (x < left)   left   = x;
            if (x > right)  right  = x;
            if (y < top)    top    = y;
            if (y > bottom) bottom = y;
        }
    }

    if (opaque < 90 || right < left || bottom < top) return nullptr;

    const int ow = right - left + 1;
    const int oh = bottom - top + 1;
    if (ow < w * 0.35 || ow > w * 0.9)                   return nullptr;
    if (oh < h * 0.45 || oh > static_cast<double>(h))    return nullptr;
    if (top > h * 0.45 || bottom < h * 0.65)             return nullptr;

    return topHalf > opaque * 0.55 ? "closed-hand" : "open-hand";
}

// ─────────────────────────────────────────────────────────────────────────────
// Build asset JSON for the given cursor (returns empty string on failure)
//
// Renders the cursor via GDI DrawIconEx onto a 32-bpp transparent DIB section
// and then encodes to PNG — matching the PowerShell approach of
// Graphics.Clear(Transparent) + Graphics.DrawIcon().  This correctly preserves
// per-pixel alpha for 32-bit cursors, unlike Gdiplus::Bitmap::FromHICON which
// can produce incorrect alpha for cursor handles.
// ─────────────────────────────────────────────────────────────────────────────
static std::string buildAssetJson(
    HCURSOR            hCursor,
    const std::string& handleStr,
    const CLSID&       pngClsid,
    const char**       outCustomType)
{
    *outCustomType = nullptr;

    // Get hotspot and cursor dimensions from the icon info.
    // For color cursors hbmColor gives the size; for monochrome cursors the
    // mask bitmap is twice the cursor height (AND mask stacked on XOR mask).
    ICONINFO ii{};
    if (!GetIconInfo(hCursor, &ii)) return {};
    const int hotX = static_cast<int>(ii.xHotspot);
    const int hotY = static_cast<int>(ii.yHotspot);

    int w = 0, h = 0;
    if (ii.hbmColor) {
        BITMAP bm{};
        if (GetObject(ii.hbmColor, sizeof(bm), &bm)) { w = bm.bmWidth; h = bm.bmHeight; }
    }
    if (ii.hbmMask && (w == 0 || h == 0)) {
        BITMAP bm{};
        if (GetObject(ii.hbmMask, sizeof(bm), &bm)) {
            w = bm.bmWidth;
            h = ii.hbmColor ? bm.bmHeight : bm.bmHeight / 2;
        }
    }
    if (ii.hbmMask)  DeleteObject(ii.hbmMask);
    if (ii.hbmColor) DeleteObject(ii.hbmColor);
    if (w <= 0 || h <= 0) return {};

    // Copy the cursor handle so DrawIconEx cannot affect the live system cursor.
    const HICON hCopy = CopyIcon(hCursor);
    if (!hCopy) return {};

    // Allocate a 32-bpp top-down DIB section and clear it to transparent black,
    // then draw the cursor with DI_NORMAL.  For 32-bit alpha cursors Windows
    // writes correct per-pixel alpha into the high byte of each BGRA pixel.
    const int stride = w * 4;
    BITMAPINFOHEADER bih{};
    bih.biSize        = sizeof(bih);
    bih.biWidth       = w;
    bih.biHeight      = -h;   // negative = top-down scanline order
    bih.biPlanes      = 1;
    bih.biBitCount    = 32;
    bih.biCompression = BI_RGB;

    void*   pBits = nullptr;
    HDC     hDC   = CreateCompatibleDC(nullptr);
    HBITMAP hBmp  = hDC ? CreateDIBSection(hDC,
                              reinterpret_cast<const BITMAPINFO*>(&bih),
                              DIB_RGB_COLORS, &pBits, nullptr, 0)
                        : nullptr;

    if (!hBmp || !pBits) {
        if (hBmp) DeleteObject(hBmp);
        if (hDC)  DeleteDC(hDC);
        DestroyIcon(hCopy);
        return {};
    }

    HGDIOBJ hOld = SelectObject(hDC, hBmp);
    std::memset(pBits, 0, static_cast<size_t>(stride * h)); // transparent black
    DrawIconEx(hDC, 0, 0, hCopy, w, h, 0, nullptr, DI_NORMAL);
    GdiFlush();
    SelectObject(hDC, hOld);
    DeleteDC(hDC);
    DestroyIcon(hCopy);

    // GDI's 32-bit DIB stores pixels as BGRA in memory.  GDI+'s
    // PixelFormat32bppARGB interprets each 32-bit word as 0xAARRGGBB which is
    // identical to BGRA on little-endian, so the alpha byte is always >> 24.
    {
        const auto* px = static_cast<const uint32_t*>(pBits);
        *outCustomType = detectCustomCursorType(px, w, h, hotX, hotY);
    }

    // Wrap the DIB pixels in a GDI+ Bitmap (zero-copy) and save to PNG.
    // Keep hBmp alive until after gBmp is destroyed so pBits remains valid.
    std::vector<uint8_t> pngData;
    {
        Gdiplus::Bitmap gBmp(w, h, stride, PixelFormat32bppARGB,
                             static_cast<BYTE*>(pBits));
        if (gBmp.GetLastStatus() == Gdiplus::Ok) {
            IStream* pStream = nullptr;
            if (SUCCEEDED(CreateStreamOnHGlobal(nullptr, TRUE, &pStream))) {
                if (gBmp.Save(pStream, &pngClsid) == Gdiplus::Ok) {
                    ULARGE_INTEGER sz{};
                    LARGE_INTEGER  zero{};
                    pStream->Seek(zero, STREAM_SEEK_END, &sz);
                    pStream->Seek(zero, STREAM_SEEK_SET, nullptr);
                    pngData.resize(static_cast<size_t>(sz.QuadPart));
                    ULONG n = 0;
                    pStream->Read(pngData.data(), static_cast<ULONG>(pngData.size()), &n);
                    pngData.resize(n);
                }
                pStream->Release();
            }
        }
    } // gBmp destroyed here; pBits (owned by hBmp) still valid
    DeleteObject(hBmp);

    if (pngData.empty()) return {};

    const std::string dataUrl =
        "data:image/png;base64," + base64Encode(pngData.data(), pngData.size());

    std::string json;
    json.reserve(dataUrl.size() + 128);
    json  = "{\"id\":\"" + handleStr + "\"";
    json += ",\"imageDataUrl\":\"" + jsonEscape(dataUrl) + "\"";
    json += ",\"width\":"    + std::to_string(w);
    json += ",\"height\":"   + std::to_string(h);
    json += ",\"hotspotX\":" + std::to_string(hotX);
    json += ",\"hotspotY\":" + std::to_string(hotY);
    if (*outCustomType) {
        json += ",\"cursorType\":\"";
        json += *outCustomType;
        json += "\"";
    } else {
        json += ",\"cursorType\":null";
    }
    json += "}";
    return json;
}

// ─────────────────────────────────────────────────────────────────────────────
// Sampling loop (background thread)
// ─────────────────────────────────────────────────────────────────────────────
static void runSamplingLoop(int intervalMs, HWND targetWindow, const CLSID& pngClsid) {
    HCURSOR lastCursor = nullptr;

    while (!g_stop.load(std::memory_order_relaxed)) {
        const int downCount = g_leftDownCount.exchange(0, std::memory_order_relaxed);
        const int upCount   = g_leftUpCount.exchange(0,   std::memory_order_relaxed);

        CURSORINFO ci{};
        ci.cbSize = sizeof(ci);
        if (!GetCursorInfo(&ci)) {
            char buf[160];
            std::snprintf(buf, sizeof(buf),
                "{\"type\":\"error\",\"timestampMs\":%" PRId64 ",\"message\":\"GetCursorInfo failed\"}",
                nowMs());
            writeJsonLine(buf);
            std::this_thread::sleep_for(std::chrono::milliseconds(intervalMs));
            continue;
        }

        const bool    visible   = (ci.flags & CURSOR_SHOWING) != 0;
        const HCURSOR hc        = ci.hCursor;

        // Handle string ("0xHEX" or empty for null cursor)
        char handleBuf[32] = {};
        if (hc)
            std::snprintf(handleBuf, sizeof(handleBuf),
                "0x%" PRIX64, static_cast<uint64_t>(reinterpret_cast<uintptr_t>(hc)));
        const std::string handleStr = hc ? handleBuf : "";

        // Standard cursor type
        const char* cursorType = standardCursorType(hc);

        // Mouse button state
        const SHORT ks          = GetAsyncKeyState(VK_LBUTTON);
        const bool  leftDown    = (ks & 0x8000) != 0;
        const bool  leftPressed = downCount > 0 || (ks & 0x0001) != 0;
        const bool  leftReleased = upCount > 0;

        // Asset — only when the cursor handle changes
        std::string assetJson;
        if (visible && hc && hc != lastCursor) {
            const char* customType = nullptr;
            assetJson = buildAssetJson(hc, handleStr, pngClsid, &customType);
            if (!assetJson.empty() && !cursorType && customType)
                cursorType = customType;
            lastCursor = hc;
        }

        // Window bounds
        std::string boundsJson = "null";
        if (targetWindow && IsWindow(targetWindow)) {
            RECT r{};
            if (visibleWindowRect(targetWindow, r)) {
                const int bw = r.right  - r.left;
                const int bh = r.bottom - r.top;
                if (bw > 0 && bh > 0) {
                    char buf[128];
                    std::snprintf(buf, sizeof(buf),
                        "{\"x\":%ld,\"y\":%ld,\"width\":%d,\"height\":%d}",
                        r.left, r.top, bw, bh);
                    boundsJson = buf;
                }
            }
        }

        // Emit sample JSON
        std::string out;
        out.reserve(256);
        out += "{\"type\":\"sample\"";
        out += ",\"timestampMs\":";        out += std::to_string(nowMs());
        out += ",\"x\":";                  out += std::to_string(ci.ptScreenPos.x);
        out += ",\"y\":";                  out += std::to_string(ci.ptScreenPos.y);
        out += ",\"visible\":";            out += visible      ? "true" : "false";
        out += ",\"handle\":";             out += hc ? ("\"" + handleStr + "\"") : "null";
        out += ",\"cursorType\":";         out += cursorType   ? ("\"" + std::string(cursorType) + "\"") : "null";
        out += ",\"leftButtonDown\":";     out += leftDown     ? "true" : "false";
        out += ",\"leftButtonPressed\":";  out += leftPressed  ? "true" : "false";
        out += ",\"leftButtonReleased\":"; out += leftReleased ? "true" : "false";
        out += ",\"bounds\":";             out += boundsJson;
        out += ",\"asset\":";              out += assetJson.empty() ? "null" : assetJson;
        out += "}";

        writeJsonLine(out);

        // Exit if stdout pipe is broken (parent process died)
        if (std::cout.fail()) {
            PostThreadMessage(g_mainThreadId, WM_QUIT, 0, 0);
            break;
        }

        std::this_thread::sleep_for(std::chrono::milliseconds(intervalMs));
    }
}

// ─────────────────────────────────────────────────────────────────────────────
// main
// ─────────────────────────────────────────────────────────────────────────────
int main(int argc, char* argv[]) {
    // Without this the process is DPI-unaware and Win32 virtualises every
    // coordinate it hands back — GetCursorInfo().ptScreenPos and GetWindowRect
    // come out divided by the primary display's scale factor — while the WGC
    // capture and the consumer both work in physical pixels.  On any scaled
    // display the cursor then lands short of its real position, by more the
    // further it is from the origin (getopenscreen/openscreen#272).
    //
    // Bail out rather than sample, and bail out before `ready`: for a display
    // capture the caller normalizes these coordinates against a *physical* rect,
    // so an unaware sampler puts every point at 1/scale of its real offset. The
    // caller turns an exit-before-ready into "record without cursor data"
    // (handlers.ts catches the failed start and drops the session), which is the
    // outcome we want -- no overlay beats an overlay in the wrong place.
    if (!enablePerMonitorV2DpiAwareness()) {
        std::cerr << "ERROR: Could not enable per-monitor-v2 DPI awareness" << std::endl;
        return 1;
    }
    const HighResolutionTiming highResolutionTiming;

    if (argc < 2) {
        std::cerr << "Usage: cursor-sampler <intervalMs> [windowHandle]" << std::endl;
        return 1;
    }

    const int intervalMs = std::max(1, std::atoi(argv[1]));

    HWND targetWindow = nullptr;
    if (argc >= 3) {
        const std::string arg = argv[2];
        if (!arg.empty() && arg != "null") {
            try {
                const int      base = (arg.rfind("0x", 0) == 0 || arg.rfind("0X", 0) == 0) ? 16 : 10;
                const uint64_t v    = std::stoull(arg, nullptr, base);
                if (v) targetWindow = reinterpret_cast<HWND>(static_cast<uintptr_t>(v));
            } catch (...) {}
        }
    }

    // Initialize GDI+
    Gdiplus::GdiplusStartupInput gdipInput{};
    ULONG_PTR gdipToken = 0;
    if (Gdiplus::GdiplusStartup(&gdipToken, &gdipInput, nullptr) != Gdiplus::Ok) {
        std::cerr << "GDI+ init failed" << std::endl;
        return 1;
    }

    CLSID pngClsid{};
    if (!getPngClsid(pngClsid)) {
        std::cerr << "PNG encoder not found" << std::endl;
        Gdiplus::GdiplusShutdown(gdipToken);
        return 1;
    }

    // Double clicks are told apart the way the system does it, by its own settings.
    input_signals::DoubleClickTracker doubleClicks(
        GetDoubleClickTime(), GetSystemMetrics(SM_CXDOUBLECLK) / 2,
        GetSystemMetrics(SM_CYDOUBLECLK) / 2);
    g_doubleClicks = &doubleClicks;
    g_parentPid = parentProcessId();

    // The worker writes the input events; it must be running before the hooks queue any.
    std::thread inputWorker(runInputWorker);

    // Install global low-level mouse hook on this thread
    g_mouseHook = SetWindowsHookEx(WH_MOUSE_LL, LowLevelMouseProc, GetModuleHandle(nullptr), 0);
    if (!g_mouseHook) {
        std::cerr << "SetWindowsHookEx failed" << std::endl;
        g_inputStop.store(true);
        g_inputCv.notify_all();
        inputWorker.join();
        Gdiplus::GdiplusShutdown(gdipToken);
        return 1;
    }
    // Keyboard: key-down TIMES (and shortcut chords) for the auto-zoom's typing hold. Optional:
    // without it the recording only loses that signal.
    g_keyboardHook =
        SetWindowsHookEx(WH_KEYBOARD_LL, LowLevelKeyboardProc, GetModuleHandle(nullptr), 0);
    // Popups and menus, for the auto-zoom's framing. Optional as well.
    const HWINEVENTHOOK menuHook =
        SetWinEventHook(EVENT_SYSTEM_MENUPOPUPSTART, EVENT_SYSTEM_MENUPOPUPEND, nullptr,
                        WinEventProc, 0, 0, WINEVENT_OUTOFCONTEXT | WINEVENT_SKIPOWNPROCESS);
    const HWINEVENTHOOK showHook =
        SetWinEventHook(EVENT_OBJECT_DESTROY, EVENT_OBJECT_HIDE, nullptr, WinEventProc, 0, 0,
                        WINEVENT_OUTOFCONTEXT | WINEVENT_SKIPOWNPROCESS);

    // Prime GetAsyncKeyState so the first poll doesn't return stale "since-last-call" bits
    GetAsyncKeyState(VK_LBUTTON);

    // Signal readiness. `inputEvents`: presses, releases, wheel and keys arrive as their own
    // `input` events, stamped by the hook, so the reader stops deriving clicks from the ticks.
    g_mainThreadId = GetCurrentThreadId();
    {
        char buf[160];
        std::snprintf(buf, sizeof(buf),
            "{\"type\":\"ready\",\"timestampMs\":%" PRId64
            ",\"inputEvents\":true,\"keyboard\":%s,\"popups\":%s}",
            nowMs(), g_keyboardHook ? "true" : "false",
            (menuHook && showHook) ? "true" : "false");
        writeJsonLine(buf);
    }

    // Start sampling on a background thread
    std::thread sampler(runSamplingLoop, intervalMs, targetWindow, std::cref(pngClsid));

    // Run the message pump on the main thread — required for WH_MOUSE_LL callbacks
    MSG msg;
    while (GetMessage(&msg, nullptr, 0, 0) > 0) {
        TranslateMessage(&msg);
        DispatchMessage(&msg);
    }

    g_stop.store(true, std::memory_order_relaxed);
    if (sampler.joinable()) sampler.join();
    if (showHook) UnhookWinEvent(showHook);
    if (menuHook) UnhookWinEvent(menuHook);
    if (g_keyboardHook) UnhookWindowsHookEx(g_keyboardHook);
    UnhookWindowsHookEx(g_mouseHook);
    g_doubleClicks = nullptr;
    g_inputStop.store(true);
    g_inputCv.notify_all();
    if (inputWorker.joinable()) inputWorker.join();
    Gdiplus::GdiplusShutdown(gdipToken);
    return 0;
}
