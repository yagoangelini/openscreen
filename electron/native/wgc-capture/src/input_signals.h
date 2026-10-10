// Pure pieces of the cursor sampler's input signals (cursor-sampler.cpp), split out so a
// unit test (input_signals_test.cpp) can hold them without installing a global hook.
//
// Privacy contract, enforced here and nowhere else: a key-down is recorded as a TIME only.
// A key's identity leaves the process only inside a shortcut chord that holds Ctrl, Alt or
// Win ("Ctrl+K") — never for a plain key, never for Shift+key (that is typing a capital), and
// never under AltGr (Ctrl+Alt, or the right Alt key), which TYPES characters on most layouts
// outside the US one (pt-BR: AltGr+Q is "/").
#pragma once

#include <cstdint>
#include <string>

namespace input_signals {

struct Modifiers {
    bool ctrl = false;
    bool alt = false;
    bool shift = false;
    bool win = false;
    /// The right Alt key, which Windows reports as AltGr on layouts that have one.
    bool rightAlt = false;
};

/// Whether `vk` is a modifier key (its own down/up only updates `Modifiers`).
bool isModifierKey(uint32_t vk);

/// Applies a modifier key's down (`down`) or up to `mods`. No-op for any other key.
void applyModifier(Modifiers& mods, uint32_t vk, bool down);

/// The modifiers a chord may be named with: those the hook saw go down AND the keyboard
/// still holds (`physical`, read with GetAsyncKeyState). Tracked from the hook's own events
/// alone, a key-up it never received -- Win+L, the UAC prompt, an elevated window in front --
/// left Ctrl "held" for good and named every plain key after it as a shortcut, passwords
/// included. Both have to agree, so a disagreement names less, never more.
Modifiers heldModifiers(const Modifiers& tracked, const Modifiers& physical);

/// The chord a key-down under `mods` forms, e.g. "Ctrl+Shift+K", or an empty string when it
/// is not a shortcut (no Ctrl/Alt/Win, or AltGr). `baseChar` is the key's unshifted character
/// for punctuation keys (MapVirtualKey(vk, MAPVK_VK_TO_CHAR)); 0 when unknown.
std::string comboName(const Modifiers& mods, uint32_t vk, uint32_t baseChar);

/// The wall-clock time (ms) of a hook event stamped `eventTick` (GetTickCount domain), read at
/// `nowMs` / `nowTick`: the hook runs a moment after the event, and the stamp says how long.
/// A stamp from the future or more than 5 s old (a wrapped or bogus tick) is ignored.
int64_t eventTimeMs(int64_t nowMs, uint32_t nowTick, uint32_t eventTick);

/// Tells a double click from two clicks, the way the system does: same button, within the
/// double-click time and inside the double-click rectangle around the first press.
class DoubleClickTracker {
public:
    DoubleClickTracker(uint32_t maxIntervalMs, int maxDx, int maxDy)
        : maxIntervalMs_(maxIntervalMs), maxDx_(maxDx), maxDy_(maxDy) {}

    /// Registers a press and returns whether it completes a double click. The press after a
    /// double click starts a new pair, as in Windows.
    bool press(int button, int64_t timeMs, int x, int y);

private:
    uint32_t maxIntervalMs_;
    int maxDx_;
    int maxDy_;
    int lastButton_ = -1;
    int64_t lastTimeMs_ = 0;
    int lastX_ = 0;
    int lastY_ = 0;
};

}  // namespace input_signals
