#pragma once

#include <cstddef>
#include <cstdint>
#include <deque>
#include <mutex>
#include <string>
#include <vector>

namespace memmy {

enum class TriggerKind : std::uint8_t {
  Foreground,   // EVENT_SYSTEM_FOREGROUND / minimize / desktop switch
  Focus,        // EVENT_OBJECT_FOCUS
  NameChange,   // EVENT_OBJECT_NAMECHANGE
  ValueChange,  // EVENT_OBJECT_VALUECHANGE
  Show,         // EVENT_OBJECT_SHOW
  Input,        // WH_KEYBOARD_LL key down (no key data retained)
  Pointer,      // WH_MOUSE_LL button up / wheel (no coordinates retained)
  Checkpoint,   // ordered marker; never coalesced with observations
  Gap,          // loss interval, emitted even when the observation queue was full
};

const char* TriggerKindName(TriggerKind kind);

enum class ActionKind : std::uint8_t { None, MouseClick, Scroll, KeyPress, TextKey, Unsupported };
struct InputAction {
  ActionKind kind = ActionKind::None;
  std::uint16_t key = 0;  // only a navigation key or an allowlisted shortcut, never plain text
  std::uint8_t modifiers = 0;  // control=1, alt=2, shift=4, windows=8
  std::uint8_t button = 0;  // left=1, right=2
  std::int32_t x = 0, y = 0, wheel = 0;
  bool horizontal = false, injected = false;
  std::uint64_t timestamp = 0;  // FILETIME, formatted outside the callback
  std::uint64_t qpc = 0;  // task protocol only; never added to the legacy v1 JSON
};
InputAction ClassifyKeyboard(std::uint32_t virtualKey, std::uint8_t modifiers, bool injected);
std::string SemanticKey(const InputAction& action);

struct Trigger {
  TriggerKind kind = TriggerKind::Foreground;
  std::uint64_t hwnd = 0;
  std::uint64_t generation = 0;
  std::uint64_t tickMs = 0;
  InputAction action;
  std::string checkpointId;
  std::uint64_t captureSequence = 0;
  std::uint64_t lostFromTickMs = 0, lostThroughTickMs = 0;
  std::uint64_t firstTickMs = 0;  // preserve the oldest notification when coalescing
};

struct TriggerCounters {
  std::uint64_t accepted = 0;
  std::uint64_t coalesced = 0;
  std::uint64_t dropped = 0;
  std::uint64_t discarded = 0;  // cleared while paused/stopping
};

// Bounded FIFO shared by hook callbacks (producers) and the collector loop (consumer).
// Consecutive triggers of the same kind for the same window are merged in place, and a full
// queue drops the newest trigger while recording an overflow so the consumer re-reads the
// current foreground state instead of trusting the queue to be complete.
class TriggerQueue {
 public:
  explicit TriggerQueue(std::size_t capacity);

  // Returns false only when the trigger was dropped because the queue was full.
  bool Push(const Trigger& trigger);
  // A separate bounded reserve prevents a full observation queue from losing its fence.
  bool PushCheckpoint(const std::string& id, std::uint64_t tickMs);
  // Moves all queued triggers out. overflowed reports whether any drop happened since the
  // previous drain.
  std::vector<Trigger> Drain(bool& overflowed);
  void Clear();
  TriggerCounters Counters() const;
  std::size_t Size() const;
  std::size_t Capacity() const { return capacity_; }

 private:
  const std::size_t capacity_;
  mutable std::mutex mutex_;
  std::deque<Trigger> items_;
  TriggerCounters counters_;
  bool overflowed_ = false;
  std::size_t checkpoints_ = 0;
  std::uint64_t sequence_ = 0;
  std::uint64_t lostFrom_ = 0, lostThrough_ = 0;
};

}  // namespace memmy
