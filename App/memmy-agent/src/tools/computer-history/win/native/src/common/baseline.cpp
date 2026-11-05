#include "common/baseline.h"

namespace memmy {

Baseline::Diff Baseline::Apply(const std::string& identity, const std::vector<std::string>& keys, bool complete) {
  if (!complete) {
    Reset();
    Diff partial;
    for (std::size_t i = 0; i < keys.size(); ++i) partial.added.push_back(i);
    return partial;
  }
  std::map<std::string, std::size_t> next;
  for (const auto& key : keys) ++next[key];

  Diff diff;
  if (!identity_ || *identity_ != identity) {
    identity_ = identity;
    counts_ = std::move(next);
    diff.full = true;
    for (std::size_t i = 0; i < keys.size(); ++i) diff.added.push_back(i);
    return diff;
  }

  diff.full = false;
  auto remaining = counts_;
  for (std::size_t i = 0; i < keys.size(); ++i) {
    auto it = remaining.find(keys[i]);
    if (it != remaining.end() && it->second > 0) {
      --it->second;
      ++diff.unchanged;
    } else {
      diff.added.push_back(i);
    }
  }
  for (const auto& [key, count] : remaining) {
    for (std::size_t i = 0; i < count; ++i) diff.removed.push_back(key);
  }
  counts_ = std::move(next);
  return diff;
}

void Baseline::Reset() {
  identity_.reset();
  counts_.clear();
}

}  // namespace memmy
