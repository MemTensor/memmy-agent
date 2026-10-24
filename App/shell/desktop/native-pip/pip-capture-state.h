#pragma once
#include <algorithm>
#include <atomic>
#include <cstdint>

namespace memmy_pip {

class PendingFrame {
  std::atomic_bool pending{false};
public:
  bool acquire() { return !pending.exchange(true, std::memory_order_acquire); }
  void release() { pending.store(false, std::memory_order_release); }
};

enum class CaptureTimeout { none, firstFrame, invalidFrames, blankFrames, visibleSuspension };

// All transitions run on the AppKit main thread. Each asynchronous producer
// carries an immutable attempt, independent of the host's binding epoch.
struct CaptureState {
  std::uint64_t attempt = 0;
  unsigned failures = 0;
  bool active = false;
  bool live = false;
  bool suspended = false;
  bool everDecoded = false;
  bool blank = false;
  double startedAt = 0;
  double liveSince = 0;
  double invalidSince = 0;
  double blankSince = 0;
  double visibleSuspensionSince = 0;

  std::uint64_t begin(double now) {
    ++attempt;
    active = true;
    live = false;
    suspended = false;
    everDecoded = blank = false;
    startedAt = now;
    liveSince = 0;
    invalidSince = 0;
    blankSince = 0;
    visibleSuspensionSince = 0;
    return attempt;
  }
  bool accepts(std::uint64_t candidate) const { return active && attempt == candidate; }
  void invalidate() { ++attempt; active = live = suspended = false; }
  bool decoded(std::uint64_t candidate, double now) {
    if (!accepts(candidate)) return false;
    const bool becameLive = !live;
    live = true;
    everDecoded = true;
    suspended = blank = false;
    invalidSince = 0;
    visibleSuspensionSince = 0;
    if (becameLive) liveSince = now;
    return becameLive;
  }
  bool pause(std::uint64_t candidate, bool isSuspended, double now) {
    if (!accepts(candidate)) return false;
    const bool wasLive = live;
    live = false;
    suspended = isSuspended;
    if (!isSuspended && !blank) blankSince = now;
    blank = !isSuspended;
    if (!isSuspended) visibleSuspensionSince = 0;
    invalidSince = 0;
    return wasLive;
  }
  void idle(std::uint64_t candidate) {
    if (accepts(candidate) && live) invalidSince = 0;
  }
  void invalidFrame(std::uint64_t candidate, double now) {
    if (!accepts(candidate)) return;
    suspended = blank = false;
    visibleSuspensionSince = 0;
    if (invalidSince == 0) invalidSince = now;
  }
  void confirmVisibility(std::uint64_t candidate, bool onScreen, double now) {
    if (!accepts(candidate)) return;
    if (!suspended || !onScreen) visibleSuspensionSince = 0;
    else if (visibleSuspensionSince == 0) visibleSuspensionSince = now;
  }
  CaptureTimeout timeout(std::uint64_t candidate, double now) const {
    if (!accepts(candidate)) return CaptureTimeout::none;
    if (!everDecoded && now - startedAt >= 3) return CaptureTimeout::firstFrame;
    if (blank && now - blankSince >= 1) return CaptureTimeout::blankFrames;
    if (suspended) return visibleSuspensionSince > 0 && now - visibleSuspensionSince >= 3
      ? CaptureTimeout::visibleSuspension : CaptureTimeout::none;
    if (invalidSince > 0 && now - invalidSince >= 3) return CaptureTimeout::invalidFrames;
    // An unchanged window is allowed to produce no new image. A lack of
    // decoded frames alone is not evidence that a static stream has stopped.
    return CaptureTimeout::none;
  }
  int fail(std::uint64_t candidate, double now) {
    if (!accepts(candidate)) return -1;
    if (liveSince > 0 && now - liveSince >= 5) failures = 0;
    active = live = suspended = false;
    ++attempt; // immediately invalidate queued frame, stop and timer callbacks
    const unsigned failure = failures;
    failures = std::min(failures + 1, 3u);
    constexpr int fastRetries[] = {250, 1000, 3000};
    return failure < 3 ? fastRetries[failure] : 15000;
  }
};

} // namespace memmy_pip
