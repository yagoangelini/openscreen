// Unit tests for input_signals.cpp. Run by scripts/build-windows-wgc-helper.mjs after the build.
#include "input_signals.h"

#include <windows.h>

#include <cstdio>
#include <string>

using namespace input_signals;

static int g_failures = 0;

static void expectEq(const std::string& actual, const std::string& expected, const char* what) {
    if (actual != expected) {
        std::printf("FAIL %s: got \"%s\", expected \"%s\"\n", what, actual.c_str(), expected.c_str());
        ++g_failures;
    }
}

static void expectTrue(bool value, const char* what) {
    if (!value) {
        std::printf("FAIL %s\n", what);
        ++g_failures;
    }
}

static Modifiers mods(bool ctrl, bool alt, bool shift, bool win, bool rightAlt = false) {
    Modifiers m;
    m.ctrl = ctrl;
    m.alt = alt;
    m.shift = shift;
    m.win = win;
    m.rightAlt = rightAlt;
    return m;
}

int main() {
    // A plain key and Shift+key are typing: no name ever leaves.
    expectEq(comboName(mods(false, false, false, false), 'K', 0), "", "plain key");
    expectEq(comboName(mods(false, false, true, false), 'K', 0), "", "shift+key");
    expectEq(comboName(mods(false, false, false, false), VK_RETURN, 0), "", "plain enter");
    // Shortcuts are named, modifiers in a fixed order.
    expectEq(comboName(mods(true, false, false, false), 'K', 0), "Ctrl+K", "ctrl+k");
    expectEq(comboName(mods(true, false, true, false), 'P', 0), "Ctrl+Shift+P", "ctrl+shift+p");
    expectEq(comboName(mods(false, true, false, false), VK_F4, 0), "Alt+F4", "alt+f4");
    expectEq(comboName(mods(false, false, true, true), 'S', 0), "Shift+Win+S", "win+shift+s");
    expectEq(comboName(mods(true, false, false, false), VK_OEM_2, '/'), "Ctrl+/", "ctrl+/");
    expectEq(comboName(mods(true, false, false, false), VK_RETURN, 0), "Ctrl+Enter", "ctrl+enter");
    // AltGr types characters: never a chord.
    expectEq(comboName(mods(true, true, false, false), 'Q', 0), "", "ctrl+alt is altgr");
    expectEq(comboName(mods(false, true, false, false, true), 'Q', 0), "", "right alt is altgr");
    expectEq(comboName(mods(true, true, false, true), 'D', 0), "Ctrl+Alt+Win+D", "win keeps it");
    // A modifier on its own is no chord.
    expectEq(comboName(mods(true, false, false, false), VK_LSHIFT, 0), "", "modifier alone");

    Modifiers m;
    applyModifier(m, VK_LCONTROL, true);
    applyModifier(m, VK_RMENU, true);
    expectTrue(m.ctrl && m.alt && m.rightAlt, "modifiers tracked down");
    applyModifier(m, VK_RMENU, false);
    expectTrue(m.ctrl && !m.alt && !m.rightAlt, "modifiers tracked up");

    // The hook's own stamp moves the event back to when it happened.
    expectTrue(eventTimeMs(10'000, 500, 480) == 9'980, "event 20 ms ago");
    expectTrue(eventTimeMs(10'000, 5, 0xFFFFFFF0u) == 9'979, "tick wrap");
    expectTrue(eventTimeMs(10'000, 500, 900) == 10'000, "stamp from the future is ignored");

    DoubleClickTracker clicks(500, 4, 4);
    expectTrue(!clicks.press(0, 1000, 100, 100), "first press");
    expectTrue(clicks.press(0, 1300, 102, 101), "double click");
    expectTrue(!clicks.press(0, 1400, 102, 101), "third press starts a new pair");
    expectTrue(!clicks.press(1, 1500, 102, 101), "other button");
    expectTrue(!clicks.press(1, 2100, 102, 101), "too slow");
    expectTrue(!clicks.press(1, 2200, 120, 101), "too far");

    if (g_failures == 0) std::printf("input_signals_test: all passed\n");
    return g_failures == 0 ? 0 : 1;
}
