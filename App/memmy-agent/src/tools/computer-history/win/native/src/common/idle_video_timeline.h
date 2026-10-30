#pragma once
#include <algorithm>
#include <optional>
#include <utility>
#include <vector>

namespace memmy {
// The source clock never changes. Only encoded presentation time omits idle spans.
class IdleVideoTimeline {
 public:
  explicit IdleVideoTimeline(bool enabled) : enabled_(enabled) {}
  bool Observe(double now, bool changed) {
    if (!enabled_) return true;
    if (changed) { Finish(now); lastChange_ = now; return true; }
    if (now - lastChange_ >= 10000) { if (!idleStart_) idleStart_ = lastChange_ + 10000; return false; }
    return true;
  }
  double VideoTime(double now) const {
    return std::max(0.0, now - skipped_ - (idleStart_ ? std::max(0.0, now - *idleStart_) : 0.0));
  }
  void Finish(double now) {
    if (!idleStart_) return;
    if (now > *idleStart_) { spans_.emplace_back(*idleStart_, now); skipped_ += now - *idleStart_; }
    idleStart_.reset();
  }
  const auto& Spans() const { return spans_; }
  auto IdleStart() const { return idleStart_; }
 private:
  bool enabled_;
  double lastChange_ = 0, skipped_ = 0;
  std::optional<double> idleStart_;
  std::vector<std::pair<double, double>> spans_;
};
}
