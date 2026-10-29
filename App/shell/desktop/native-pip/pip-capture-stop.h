#pragma once
#include <cstdint>

namespace memmy_pip {

enum class CaptureStopResult { ignored, stopped, retry, exhausted };

// One detached stream owns one policy. A pending attempt never authorizes a
// second stop; only its matching, explicitly failed completion can do that.
struct CaptureStopState {
  static constexpr unsigned maxAttempts = 3;
  unsigned attempts = 0;
  bool pending = false;
  bool terminal = false;

  unsigned begin() {
    if (pending || terminal || attempts >= maxAttempts) return 0;
    pending = true;
    return ++attempts;
  }
  CaptureStopResult complete(unsigned attempt, bool failed) {
    if (!pending || terminal || attempt != attempts) return CaptureStopResult::ignored;
    pending = false;
    if (!failed) {
      terminal = true;
      return CaptureStopResult::stopped;
    }
    if (attempts == maxAttempts) {
      terminal = true;
      return CaptureStopResult::exhausted;
    }
    return CaptureStopResult::retry;
  }
  unsigned retryDelayMs() const { return attempts * 250; }
};

} // namespace memmy_pip
