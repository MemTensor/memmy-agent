#define MEMMY_FOCUS_GUARD_IDENTITY_TEST 1
#include "focus-guard.m"
#include <assert.h>
#include <stdio.h>

int main(void) {
  const MemmyWindowBounds bounds = { 100, 80, 900, 650, true };
  const MemmyCGWindowIdentity both[] = { { 500, 101, bounds }, { 500, 202, bounds } };
  const MemmyCGWindowIdentity onlyA[] = { { 500, 101, bounds } };
  const MemmyAXWindowIdentity a[] = { { 101, bounds } };
  const MemmyAXWindowIdentity b[] = { { 202, bounds } };
  const MemmyAXWindowIdentity unknown[] = { { 0, bounds } };
  const MemmyAXWindowIdentity knownBoth[] = { { 202, bounds }, { 101, bounds } };
  const MemmyAXWindowIdentity unknownTwice[] = { { 0, bounds }, { 0, bounds } };
  const MemmyAXWindowIdentity aTwice[] = { { 101, bounds }, { 101, bounds } };
  // An exact native ID selects A even when B occupies the same geometry.
  assert(memmyResolveAXWindowIndex(500, 101, both, 2, knownBoth, 2) == 1);
  // A absent from AX must never be replaced by the listed B.
  assert(memmyResolveAXWindowIndex(500, 101, both, 2, b, 1) == -1);
  // Even a unique geometry does not override B's known incompatible ID.
  assert(memmyResolveAXWindowIndex(500, 101, onlyA, 1, b, 1) == -1);
  // Missing AX IDs require uniqueness across the complete same-PID CG list.
  assert(memmyResolveAXWindowIndex(500, 101, both, 2, unknown, 1) == -1);
  assert(memmyResolveAXWindowIndex(500, 101, onlyA, 1, unknown, 1) == 0);
  assert(memmyResolveAXWindowIndex(500, 101, onlyA, 1, unknownTwice, 2) == -1);
  // Known exact IDs do not need geometry and duplicated exact IDs fail closed.
  const MemmyAXWindowIdentity noBounds[] = { { 101, { 0, 0, 0, 0, false } } };
  assert(memmyResolveAXWindowIndex(500, 101, onlyA, 1, noBounds, 1) == 0);
  assert(memmyResolveAXWindowIndex(500, 101, onlyA, 1, aTwice, 2) == -1);
  // Other processes cannot satisfy ownership or make a same-PID tie.
  const MemmyCGWindowIdentity mixedPIDs[] = { { 600, 202, bounds }, { 500, 101, bounds } };
  assert(memmyResolveAXWindowIndex(500, 101, mixedPIDs, 2, unknown, 1) == 0);
  assert(memmyResolveAXWindowIndex(600, 101, onlyA, 1, a, 1) == -1);
  // All-window callers can identify hidden A without substituting visible B.
  assert(memmyResolveAXWindowIndex(500, 101, both, 2, a, 1) == 0);
  assert(memmyResolveAXWindowIndex(500, 303, both, 2, unknown, 1) == -1);
  const MemmyAXWindowIdentity near[] = { { 0, { 101, 79, 901, 649, true } } };
  const MemmyAXWindowIdentity far[] = { { 0, { 103, 80, 900, 650, true } } };
  assert(memmyResolveAXWindowIndex(500, 101, onlyA, 1, near, 1) == 0);
  assert(memmyResolveAXWindowIndex(500, 101, onlyA, 1, far, 1) == -1);
  const MemmyAXWindowIdentity invalid[] = { { 0, { NAN, 80, 900, 650, true } } };
  assert(memmyResolveAXWindowIndex(500, 101, onlyA, 1, invalid, 1) == -1);
  puts("{\"status\":\"passed\",\"cases\":15}");
  return 0;
}
