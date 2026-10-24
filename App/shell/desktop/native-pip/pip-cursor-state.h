#pragma once
#include <algorithm>
#include <cstdint>
#include <map>
#include <optional>
#include <string>

namespace memmy_pip {
struct CursorLocation {
  double x;
  double y;
  uint64_t sequence;
};

// Several task helpers can target one window. Releasing one helper's cursor
// must preserve the most recently updated cursor from the remaining helpers.
class CursorSourceState {
 public:
  void update(const std::string &source, double x, double y) {
    locations_[source] = {std::clamp(x, 0.0, 1.0), std::clamp(y, 0.0, 1.0), ++sequence_};
  }

  void remove(const std::string &source) { locations_.erase(source); }
  void clear() { locations_.clear(); }

  std::optional<CursorLocation> latest() const {
    std::optional<CursorLocation> result;
    for (const auto &[source, location] : locations_) {
      if (!result || location.sequence > result->sequence) result = location;
    }
    return result;
  }

 private:
  std::map<std::string, CursorLocation> locations_;
  uint64_t sequence_ = 0;
};
}  // namespace memmy_pip
