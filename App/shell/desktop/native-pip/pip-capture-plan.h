#pragma once
#include <cmath>
#include <cstdint>
#include <vector>
#include <algorithm>

namespace memmy_pip {
struct CaptureRect { double x, y, width, height; };
struct CaptureDisplay { std::uint32_t id; CaptureRect bounds; double scale; };
struct CaptureWindowIdentity {
  std::uint32_t id;
  std::int32_t pid;
  bool onScreen;
  int layer = 0;
  CaptureRect bounds{};
  double alpha = 1;
};
inline std::vector<std::uint32_t> validatedRelatedWindows(std::uint32_t root, std::int32_t pid,
    const std::vector<std::uint32_t> &requested, const std::vector<CaptureWindowIdentity> &available) {
  std::vector<std::uint32_t> result;
  for (auto id : requested) {
    if (!id || id == root) continue;
    unsigned matches = 0;
    bool valid = false;
    for (const auto &window : available) if (window.id == id) {
      ++matches;
      valid = window.pid == pid && window.onScreen;
    }
    if (matches == 1 && valid) result.push_back(id);
  }
  std::sort(result.begin(), result.end());
  result.erase(std::unique(result.begin(), result.end()), result.end());
  return result;
}
struct CapturePlan {
  std::uint32_t displayID = 0;
  CaptureRect sourceRect{};
  double scale = 1;
  bool includesChildren = false;
};
inline bool validCaptureRect(CaptureRect r) {
  return std::isfinite(r.x) && std::isfinite(r.y) && std::isfinite(r.width)
    && std::isfinite(r.height) && r.width > 0 && r.height > 0;
}
// CG records are front-to-back. Non-document surfaces may supplement the exact
// visible root only while no other document of that process is in front of it.
// The result contains exact IDs, revalidated again against SCShareableContent.
inline std::vector<std::uint32_t> discoveredOverlayWindows(std::uint32_t root, std::int32_t pid,
    const std::vector<CaptureWindowIdentity> &available) {
  if (!root || pid <= 0) return {};
  std::size_t rootIndex = available.size();
  unsigned rootMatches = 0;
  for (std::size_t index = 0; index < available.size(); ++index) if (available[index].id == root) {
    ++rootMatches;
    rootIndex = index;
  }
  if (rootMatches != 1) return {};
  const auto &target = available[rootIndex];
  if (target.pid != pid || !target.onScreen || !(target.alpha > 0)
      || target.layer != 0 || !validCaptureRect(target.bounds)) return {};
  for (std::size_t index = 0; index < rootIndex; ++index) {
    const auto &window = available[index];
    if (window.pid == pid && window.onScreen && window.alpha > 0 && window.layer == 0) return {};
  }
  std::vector<std::uint32_t> result;
  for (std::size_t index = 0; index < rootIndex; ++index) {
    const auto &window = available[index];
    if (!window.id || window.pid != pid || !window.onScreen || !(window.alpha > 0)
        || !((window.layer >= 1 && window.layer <= 25) || window.layer == 101)
        || !validCaptureRect(window.bounds)) continue;
    unsigned matches = 0;
    for (const auto &candidate : available) if (candidate.id == window.id) ++matches;
    if (matches != 1) continue;
    const auto a = target.bounds, b = window.bounds;
    if (b.x >= a.x + a.width || b.x + b.width <= a.x
        || b.y >= a.y + a.height || b.y + b.height <= a.y) continue;
    result.push_back(window.id);
  }
  std::sort(result.begin(), result.end());
  return result;
}
inline std::vector<std::uint32_t> combinedRelatedWindows(std::uint32_t root, std::int32_t pid,
    const std::vector<std::uint32_t> &requested, const std::vector<CaptureWindowIdentity> &available) {
  auto result = validatedRelatedWindows(root, pid, requested, available);
  const auto discovered = discoveredOverlayWindows(root, pid, available);
  result.insert(result.end(), discovered.begin(), discovered.end());
  std::sort(result.begin(), result.end());
  result.erase(std::unique(result.begin(), result.end()), result.end());
  return result;
}
inline CapturePlan capturePlan(CaptureRect target, const std::vector<CaptureDisplay> &displays,
                               bool canIncludeChildren) {
  CapturePlan plan;
  if (!canIncludeChildren || !validCaptureRect(target)) return plan;
  const CaptureDisplay *containing = nullptr;
  for (const auto &display : displays) {
    const auto b = display.bounds;
    if (!display.id || !validCaptureRect(b) || !std::isfinite(display.scale) || display.scale <= 0) continue;
    if (target.x < b.x || target.y < b.y || target.x + target.width > b.x + b.width
        || target.y + target.height > b.y + b.height) continue;
    // Mirrored/overlapping display identities must not pick an arbitrary owner.
    if (containing) return plan;
    containing = &display;
  }
  if (!containing) return plan;
  plan.displayID = containing->id;
  plan.sourceRect = {target.x - containing->bounds.x, target.y - containing->bounds.y, target.width, target.height};
  plan.scale = containing->scale;
  plan.includesChildren = true;
  return plan;
}
inline bool capturePlanSupportsRelatedWindows(const CapturePlan &plan,
    const std::vector<std::uint32_t> &required) {
  return required.empty() || plan.includesChildren;
}
} // namespace memmy_pip
