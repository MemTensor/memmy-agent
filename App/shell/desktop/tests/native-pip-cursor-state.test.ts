import { execFileSync } from 'node:child_process';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { expect, it } from 'vitest';

it.skipIf(process.platform !== 'darwin')('keeps concurrent task cursors when another task ends', () => {
  const temp = mkdtempSync(join(tmpdir(), 'memmy-pip-cursor-state-'));
  try {
    const source = join(temp, 'cursor.cpp'), binary = join(temp, 'cursor');
    writeFileSync(source, `#include "pip-cursor-state.h"
#include <cassert>
int main() {
  memmy_pip::CursorSourceState state;
  assert(!state.latest());
  state.update("task-A", .1, .2);
  state.update("task-B", .8, .9);
  state.remove("task-A");
  assert(state.latest()->x == .8 && state.latest()->y == .9);
  state.update("task-A", .3, .4);
  state.remove("task-A");
  assert(state.latest()->x == .8 && state.latest()->y == .9);
  state.remove("legacy");
  assert(state.latest()->x == .8);
  state.remove("task-B");
  assert(!state.latest());
  state.update("task-C", -1, 2);
  assert(state.latest()->x == 0 && state.latest()->y == 1);
  state.clear();
  assert(!state.latest());
}`);
    execFileSync('xcrun', ['clang++', '-std=c++17', '-I', fileURLToPath(new URL('../native-pip/', import.meta.url)), source, '-o', binary]);
    expect(() => execFileSync(binary)).not.toThrow();
  } finally { rmSync(temp, { recursive: true, force: true }); }
});
