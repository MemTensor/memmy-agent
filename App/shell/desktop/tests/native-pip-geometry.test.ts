import { execFileSync } from 'node:child_process';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { expect, it } from 'vitest';

it.skipIf(process.platform !== 'darwin')('maps native scroll coordinates inside the displayed image and rejects letterboxing', () => {
  const temp = mkdtempSync(join(tmpdir(), 'memmy-pip-geometry-'));
  try {
    const source = join(temp, 'geometry.cpp'), binary = join(temp, 'geometry');
    writeFileSync(source, `#include "pip-geometry.h"
#include <cassert>
int main() {
  using namespace memmy_pip;
  double x, y;
  auto wide = aspectFit(200, 150, 1000, 500);
  assert(wide.x == 0 && wide.y == 25 && wide.width == 200 && wide.height == 100);
  assert(!normalizedPoint(wide, 100, 5, x, y));
  assert(normalizedPoint(wide, 50, 100, x, y) && x == .25 && y == .25);
  auto tall = aspectFit(200, 150, 500, 1000);
  assert(tall.x == 62.5 && tall.y == 0 && tall.width == 75 && tall.height == 150);
  assert(!normalizedPoint(tall, 50, 75, x, y));
  assert(normalizedPoint(tall, 100, 75, x, y) && x == .5 && y == .5);
  assert(!normalizedPoint(tall, 137.5, 75, x, y));
  assert(!normalizedPoint({0, 0, 0, 0}, 0, 0, x, y));
  return 0;
}`);
    execFileSync('xcrun', ['clang++', '-std=c++17', '-I', fileURLToPath(new URL('../native-pip/', import.meta.url)), source, '-o', binary]);
    expect(() => execFileSync(binary)).not.toThrow();
  } finally { rmSync(temp, { recursive: true, force: true }); }
});
