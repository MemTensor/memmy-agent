#pragma once

#include <cstddef>
#include <map>
#include <optional>
#include <string>
#include <vector>

namespace memmy {

// Full-then-delta tracking for one authorized capture context. The identity string must
// change whenever the window instance, foreground generation, policy revision or pause epoch
// changes; callers also Reset() on any blocked/failed capture so a delta never spans a gap.
// Removed entries are reported by node key only, never by content.
class Baseline {
 public:
  struct Diff {
    bool full = true;
    std::vector<std::size_t> added;    // indices into the keys passed to Apply
    std::vector<std::string> removed;  // keys only
    std::size_t unchanged = 0;
  };

  // Partial snapshots cannot prove absence and never establish a delta baseline.
  Diff Apply(const std::string& identity, const std::vector<std::string>& keys, bool complete = true);
  void Reset();
  bool HasIdentity() const { return identity_.has_value(); }

 private:
  std::optional<std::string> identity_;
  std::map<std::string, std::size_t> counts_;
};

}  // namespace memmy
