#include "common/trigger_queue.h"
#include <string_view>

namespace memmy {

InputAction ClassifyKeyboard(std::uint32_t key, std::uint8_t modifiers, bool injected) {
  InputAction action;
  action.injected = injected;
  const bool navigation = key == 0x08 || key == 0x09 || key == 0x0D || key == 0x1B ||
                          (key >= 0x21 && key <= 0x28) || key == 0x2E || (key >= 0x70 && key <= 0x7B);
  // Ctrl+Alt can be AltGr and produce text. Never retain its printable key identity.
  const bool controlShortcut = (modifiers & 1) && !(modifiers & (2 | 8)) &&
      std::string_view("ACVXYZSFPTWNLR").find(static_cast<char>(key)) != std::string_view::npos && key >= 'A' && key <= 'Z';
  const bool windowsShortcut = (modifiers & 8) && !(modifiers & (1 | 2)) &&
      (key == 'D' || key == 'E' || key == 'L' || key == 'R');
  if (navigation || controlShortcut || windowsShortcut) {
    action.kind = ActionKind::KeyPress;
    action.key = static_cast<std::uint16_t>(key);
    action.modifiers = modifiers;
  } else if (!(modifiers & 8) && ((key >= 0x30 && key <= 0x5A) || key == 0x20 ||
             (key >= 0x60 && key <= 0x6F) || (key >= 0xBA && key <= 0xE2) || key == 0xE7)) {
    action.kind = ActionKind::TextKey;  // identity is erased; counts are key presses, not characters
  }
  return action;
}

std::string SemanticKey(const InputAction& action) {
  if (action.kind != ActionKind::KeyPress) return {};
  std::string name;
  switch (action.key) {
    case 0x08: name = "Backspace"; break;
    case 0x09: name = "Tab"; break;
    case 0x0D: name = "Enter"; break;
    case 0x1B: name = "Escape"; break;
    case 0x21: name = "PageUp"; break;
    case 0x22: name = "PageDown"; break;
    case 0x23: name = "End"; break;
    case 0x24: name = "Home"; break;
    case 0x25: name = "ArrowLeft"; break;
    case 0x26: name = "ArrowUp"; break;
    case 0x27: name = "ArrowRight"; break;
    case 0x28: name = "ArrowDown"; break;
    case 0x2E: name = "Delete"; break;
    default:
      if (action.key >= 0x70 && action.key <= 0x7B) name = "F" + std::to_string(action.key - 0x70 + 1);
      else if (action.key >= 'A' && action.key <= 'Z') name = static_cast<char>(action.key);
      else return {};
  }
  std::string prefix;
  if (action.modifiers & 1) prefix += "Control+";
  if (action.modifiers & 2) prefix += "Alt+";
  if (action.modifiers & 4) prefix += "Shift+";
  if (action.modifiers & 8) prefix += "Meta+";
  return prefix + name;
}

const char* TriggerKindName(TriggerKind kind) {
  switch (kind) {
    case TriggerKind::Foreground: return "foreground";
    case TriggerKind::Focus: return "focus";
    case TriggerKind::NameChange: return "name_change";
    case TriggerKind::ValueChange: return "value_change";
    case TriggerKind::Show: return "show";
    case TriggerKind::Input: return "input";
    case TriggerKind::Pointer: return "pointer";
  }
  return "unknown";
}

TriggerQueue::TriggerQueue(std::size_t capacity) : capacity_(capacity == 0 ? 1 : capacity) {}

bool TriggerQueue::Push(const Trigger& trigger) {
  std::lock_guard lock(mutex_);
  if (!items_.empty() && trigger.action.kind == ActionKind::None && items_.back().action.kind == ActionKind::None &&
      items_.back().kind == trigger.kind && items_.back().hwnd == trigger.hwnd && items_.back().generation == trigger.generation) {
    items_.back() = trigger;
    ++counters_.coalesced;
    return true;
  }
  if (items_.size() >= capacity_) {
    ++counters_.dropped;
    overflowed_ = true;
    return false;
  }
  items_.push_back(trigger);
  ++counters_.accepted;
  return true;
}

std::vector<Trigger> TriggerQueue::Drain(bool& overflowed) {
  std::lock_guard lock(mutex_);
  std::vector<Trigger> out(items_.begin(), items_.end());
  items_.clear();
  overflowed = overflowed_;
  overflowed_ = false;
  return out;
}

void TriggerQueue::Clear() {
  std::lock_guard lock(mutex_);
  counters_.discarded += items_.size();
  items_.clear();
  overflowed_ = false;
}

TriggerCounters TriggerQueue::Counters() const {
  std::lock_guard lock(mutex_);
  return counters_;
}

std::size_t TriggerQueue::Size() const {
  std::lock_guard lock(mutex_);
  return items_.size();
}

}  // namespace memmy
