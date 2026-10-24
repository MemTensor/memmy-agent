import { execFileSync } from 'node:child_process';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { expect, it } from 'vitest';

it.skipIf(process.platform !== 'darwin')('keeps child-window capture scoped to an exact root and recomputes crop when geometry changes', () => {
  const temp = mkdtempSync(join(tmpdir(), 'memmy-pip-capture-plan-'));
  try {
    const source = join(temp, 'plan.cpp'), binary = join(temp, 'plan');
    writeFileSync(source, `#include "pip-capture-plan.h"
#include <cassert>
#include <limits>
int main() {
  using namespace memmy_pip;
  const std::vector<CaptureDisplay> screens = {{1, {0, 0, 1512, 982}, 2}, {2, {-1440, 0, 1440, 900}, 1}};
  auto root = capturePlan({0, 32, 1512, 884}, screens, true);
  assert(root.includesChildren && root.displayID == 1 && root.scale == 2);
  assert(root.sourceRect.x == 0 && root.sourceRect.y == 32 && root.sourceRect.width == 1512 && root.sourceRect.height == 884);
  auto moved = capturePlan({-1200, 50, 800, 600}, screens, true);
  assert(moved.displayID == 2 && moved.sourceRect.x == 240 && moved.sourceRect.y == 50 && moved.scale == 1);
  auto resized = capturePlan({20, 40, 900, 500}, screens, true);
  assert(resized.sourceRect.x == 20 && resized.sourceRect.width == 900 && resized.sourceRect.height == 500);
  assert(!capturePlan({-100, 50, 800, 600}, screens, true).includesChildren); // spans two displays
  assert(!capturePlan({1400, 50, 800, 600}, screens, true).includesChildren); // partially offscreen
  assert(!capturePlan({20, 40, 900, 500}, screens, false).includesChildren); // old OS or minimized
  assert(!capturePlan({20, 40, 900, 500}, {{1, {0, 0, 1512, 982}, 2}, {3, {0, 0, 1512, 982}, 2}}, true).includesChildren);
  assert(!capturePlan({0, 0, 0, 600}, screens, true).includesChildren);
  assert(!capturePlan({0, 0, std::numeric_limits<double>::infinity(), 600}, screens, true).includesChildren);
  const std::vector<CaptureWindowIdentity> available = {{10, 42, true}, {11, 42, true}, {12, 99, true},
    {13, 42, false}, {14, 42, true}, {14, 42, true}, {15, 42, true}};
  assert(validatedRelatedWindows(10, 42, {0, 10, 11, 11, 12, 13, 14}, available) == std::vector<std::uint32_t>{11});
  assert(validatedRelatedWindows(10, 42, {}, available).empty()); // same PID alone grants no membership
  auto shown = available; shown[3].onScreen = true;
  assert(validatedRelatedWindows(10, 42, {13}, available).empty());
  assert(validatedRelatedWindows(10, 42, {13}, shown) == std::vector<std::uint32_t>{13});
}`);
    execFileSync('xcrun', ['clang++', '-std=c++17', '-I', fileURLToPath(new URL('../native-pip/', import.meta.url)), source, '-o', binary]);
    expect(() => execFileSync(binary)).not.toThrow();
  } finally { rmSync(temp, { recursive: true, force: true }); }
});
