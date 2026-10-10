#include "input_signals.h"

#include <windows.h>

#include <cstdlib>

namespace input_signals {

bool isModifierKey(uint32_t vk) {
    switch (vk) {
        case VK_CONTROL: case VK_LCONTROL: case VK_RCONTROL:
        case VK_MENU:    case VK_LMENU:    case VK_RMENU:
        case VK_SHIFT:   case VK_LSHIFT:   case VK_RSHIFT:
        case VK_LWIN:    case VK_RWIN:
            return true;
        default:
            return false;
    }
}

void applyModifier(Modifiers& mods, uint32_t vk, bool down) {
    switch (vk) {
        case VK_CONTROL: case VK_LCONTROL: case VK_RCONTROL: mods.ctrl = down; break;
        case VK_MENU: case VK_LMENU: mods.alt = down; break;
        case VK_RMENU: mods.alt = down; mods.rightAlt = down; break;
        case VK_SHIFT: case VK_LSHIFT: case VK_RSHIFT: mods.shift = down; break;
        case VK_LWIN: case VK_RWIN: mods.win = down; break;
        default: break;
    }
}

Modifiers heldModifiers(const Modifiers& tracked, const Modifiers& physical) {
    Modifiers held;
    held.ctrl = tracked.ctrl && physical.ctrl;
    held.alt = tracked.alt && physical.alt;
    held.shift = tracked.shift && physical.shift;
    held.win = tracked.win && physical.win;
    held.rightAlt = tracked.rightAlt && physical.rightAlt;
    return held;
}

static std::string keyName(uint32_t vk, uint32_t baseChar) {
    if (vk >= 'A' && vk <= 'Z') return std::string(1, static_cast<char>(vk));
    if (vk >= '0' && vk <= '9') return std::string(1, static_cast<char>(vk));
    if (vk >= VK_F1 && vk <= VK_F24) return "F" + std::to_string(vk - VK_F1 + 1);
    if (vk >= VK_NUMPAD0 && vk <= VK_NUMPAD9) return "Num" + std::to_string(vk - VK_NUMPAD0);
    switch (vk) {
        case VK_RETURN: return "Enter";
        case VK_ESCAPE: return "Esc";
        case VK_TAB: return "Tab";
        case VK_SPACE: return "Space";
        case VK_BACK: return "Backspace";
        case VK_DELETE: return "Delete";
        case VK_INSERT: return "Insert";
        case VK_HOME: return "Home";
        case VK_END: return "End";
        case VK_PRIOR: return "PageUp";
        case VK_NEXT: return "PageDown";
        case VK_LEFT: return "Left";
        case VK_RIGHT: return "Right";
        case VK_UP: return "Up";
        case VK_DOWN: return "Down";
        case VK_SNAPSHOT: return "PrintScreen";
        case VK_ADD: return "Num+";
        case VK_SUBTRACT: return "Num-";
        case VK_MULTIPLY: return "Num*";
        case VK_DIVIDE: return "Num/";
        default: break;
    }
    // Punctuation: the key's unshifted character, upper-cased if it is a letter (dead keys
    // report theirs with the high bit set).
    const uint32_t c = baseChar & 0x7FFFu;
    if (c >= 0x21 && c < 0x7F) {
        char ch = static_cast<char>(c);
        if (ch >= 'a' && ch <= 'z') ch = static_cast<char>(ch - 'a' + 'A');
        return std::string(1, ch);
    }
    return "";
}

std::string comboName(const Modifiers& mods, uint32_t vk, uint32_t baseChar) {
    if (isModifierKey(vk)) return "";
    // AltGr types characters: Ctrl+Alt is what Windows makes of it, and the right Alt key is
    // it on any layout that has one. Win keeps it a shortcut (Win+Ctrl+Alt is no AltGr).
    const bool altGr = !mods.win && (mods.rightAlt || (mods.ctrl && mods.alt));
    if (altGr) return "";
    if (!mods.ctrl && !mods.alt && !mods.win) return "";
    const std::string key = keyName(vk, baseChar);
    if (key.empty()) return "";
    std::string out;
    if (mods.ctrl) out += "Ctrl+";
    if (mods.alt) out += "Alt+";
    if (mods.shift) out += "Shift+";
    if (mods.win) out += "Win+";
    return out + key;
}

int64_t eventTimeMs(int64_t nowMs, uint32_t nowTick, uint32_t eventTick) {
    // Unsigned subtraction survives the 49.7-day wrap of GetTickCount.
    const uint32_t ago = nowTick - eventTick;
    if (ago > 5000u) return nowMs;
    return nowMs - static_cast<int64_t>(ago);
}

bool DoubleClickTracker::press(int button, int64_t timeMs, int x, int y) {
    const bool isDouble = button == lastButton_ && timeMs >= lastTimeMs_ &&
                          timeMs - lastTimeMs_ <= static_cast<int64_t>(maxIntervalMs_) &&
                          std::abs(x - lastX_) <= maxDx_ && std::abs(y - lastY_) <= maxDy_;
    if (isDouble) {
        lastButton_ = -1;  // a third press starts a new pair
    } else {
        lastButton_ = button;
        lastTimeMs_ = timeMs;
        lastX_ = x;
        lastY_ = y;
    }
    return isDouble;
}

}  // namespace input_signals
