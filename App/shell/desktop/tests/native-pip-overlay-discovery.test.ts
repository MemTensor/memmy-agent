import { execFileSync } from 'node:child_process';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { expect, it } from 'vitest';

it.skipIf(process.platform !== 'darwin')('discovers detached WPS overlays and recomputes membership without AX associations', () => {
  const temp = mkdtempSync(join(tmpdir(), 'memmy-pip-overlay-'));
  try {
    const source = join(temp, 'overlay.cpp'), binary = join(temp, 'overlay');
    writeFileSync(source, `#include "pip-capture-plan.h"
#include <cassert>
#include <limits>
int main() {
  using namespace memmy_pip;
  // Actual WPS New popup and home-window CG metadata. No association is injected.
  const CaptureWindowIdentity root = {1870, 82868, true, 0, {0, 32, 1512, 884}};
  const CaptureWindowIdentity popup = {1886, 82868, true, 24, {320, 145, 364, 634}};
  const CaptureWindowIdentity otherPID = {9000, 99, true, 24, {320, 145, 364, 634}};
  const CaptureWindowIdentity document = {9001, 82868, true, 0, {320, 145, 364, 634}};
  const std::vector<std::uint32_t> empty;
  auto discover = [&](std::vector<CaptureWindowIdentity> windows) {
    return combinedRelatedWindows(root.id, root.pid, empty, windows);
  };
  const auto first = discover({root});
  assert(first.empty());
  const auto appeared = discover({popup, otherPID, root, document});
  assert(appeared == std::vector<std::uint32_t>{popup.id});
  assert(appeared != first); // production geometry poll rebinds even with an empty AX list
  const auto scRootOnly = validatedRelatedWindows(root.id, root.pid, appeared, {root});
  assert(scRootOnly != appeared); // native capture must retry rather than silently omit a required overlay
  auto scInvisiblePopup = popup; scInvisiblePopup.onScreen = false;
  assert(validatedRelatedWindows(root.id, root.pid, appeared, {scInvisiblePopup, root}) != appeared);
  assert(validatedRelatedWindows(root.id, root.pid, appeared, {popup, root}) == appeared);
  const std::vector<CaptureDisplay> displays = {{1, {0, 0, 1512, 982}, 2}, {2, {-1440, 0, 1440, 900}, 1}};
  assert(capturePlanSupportsRelatedWindows(capturePlan(root.bounds, displays, true), appeared));
  for (const auto unsupported : {capturePlan({-100, 32, 1512, 884}, displays, true),
      capturePlan({1400, 32, 1512, 884}, displays, true), capturePlan(root.bounds, displays, false)}) {
    assert(!capturePlanSupportsRelatedWindows(unsupported, appeared)); // spanning/offscreen/old OS cannot mask an overlay
    assert(capturePlanSupportsRelatedWindows(unsupported, empty)); // popup closure can recover independent capture
  }
  auto spanningRoot = root; spanningRoot.bounds.x = -100;
  const auto beforeSpanningPopup = combinedRelatedWindows(root.id, root.pid, empty, {spanningRoot});
  const auto afterSpanningPopup = combinedRelatedWindows(root.id, root.pid, empty, {popup, spanningRoot});
  assert(afterSpanningPopup != beforeSpanningPopup); // independent stream must also revoke on group changes
  assert(!capturePlanSupportsRelatedWindows(capturePlan(spanningRoot.bounds, displays, true), afterSpanningPopup));
  assert(discover({root, popup}).empty()); // a popup behind the root is not visible over it
  assert(discover({popup, document, root}).empty()); // another same-app root owns foreground
  auto invisibleDocument = document; invisibleDocument.alpha = 0;
  assert(discover({popup, invisibleDocument, root}) == std::vector<std::uint32_t>{popup.id});
  assert(discover({otherPID, root}).empty());
  assert(discover({popup, popup, root}).empty()); // duplicate identity is ambiguous
  auto reused = popup; reused.pid = 99;
  assert(discover({reused, root}).empty());
  auto duplicateOtherPID = reused; duplicateOtherPID.id = popup.id;
  assert(discover({popup, duplicateOtherPID, root}).empty());
  auto closed = popup; closed.onScreen = false;
  const auto disappeared = discover({closed, root});
  assert(disappeared.empty() && disappeared != appeared);
  auto invisible = popup; invisible.alpha = 0;
  assert(discover({invisible, root}).empty());
  invisible = root; invisible.alpha = 0;
  assert(discover({popup, invisible}).empty());
  auto reopened = popup; reopened.id = 1887;
  assert(discover({reopened, root}) == std::vector<std::uint32_t>{1887});
  assert(discover({reopened, root}) != appeared);
  auto moved = root; moved.bounds.x = 1000;
  assert(discover({popup, moved}).empty()); // root movement removes stale crop membership
  auto restored = root; restored.onScreen = false;
  assert(discover({popup, restored}).empty());
  auto changedRoot = root; changedRoot.pid = 99;
  assert(discover({popup, changedRoot}).empty());
  assert(discover({popup, root, root}).empty());
  changedRoot = root; changedRoot.layer = 24;
  assert(discover({popup, changedRoot}).empty());
  for (int layer : {1, 25, 101}) {
    auto menu = popup; menu.layer = layer;
    assert(discover({menu, root}) == std::vector<std::uint32_t>{popup.id});
  }
  for (int layer : {-1, 0, 26, 100, 102}) {
    auto menu = popup; menu.layer = layer;
    assert(discover({menu, root}).empty());
  }
  auto distant = popup; distant.bounds = {2000, 2000, 10, 10};
  assert(discover({distant, root}).empty());
  auto edge = popup; edge.bounds = {1512, 145, 10, 10};
  assert(discover({edge, root}).empty()); // touching edges provide no captured pixels
  auto invalid = popup; invalid.bounds.width = std::numeric_limits<double>::infinity();
  assert(discover({invalid, root}).empty());
  invalid = root; invalid.bounds.width = 0;
  assert(discover({popup, invalid}).empty());
  auto tiny = popup; tiny.bounds = {320, 145, 1, 1};
  auto large = popup; large.bounds = {-10, 0, 2000, 1000};
  assert(discover({tiny, root}) == std::vector<std::uint32_t>{popup.id});
  assert(discover({large, root}) == std::vector<std::uint32_t>{popup.id}); // no size heuristic
  // Explicit AX proof remains supported independently of transient discovery.
  assert(combinedRelatedWindows(root.id, root.pid, {document.id, popup.id}, {popup, root, document})
    == (std::vector<std::uint32_t>{popup.id, document.id}));
}
`);
    execFileSync('xcrun', ['clang++', '-std=c++17', '-I', fileURLToPath(new URL('../native-pip/', import.meta.url)), source, '-o', binary]);
    expect(() => execFileSync(binary)).not.toThrow();
  } finally { rmSync(temp, { recursive: true, force: true }); }
});
