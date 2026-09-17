import assert from 'node:assert/strict';
import test from 'node:test';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { prepareComputerUseSource } from '../scripts/internal/mac/prepare-computer-use-source.mjs';

const vendor = fileURLToPath(new URL('../scripts/vendor/open-computer-use', import.meta.url));
const unixOnly = { skip: process.platform === 'win32' };
const addedSources = [
  'apps/OpenComputerUse/Sources/OpenComputerUse/MemmyNativeBuild.swift',
  'packages/OpenComputerUseKit/Sources/OpenComputerUseKit/AppAgentIdentity.swift',
  'packages/OpenComputerUseKit/Sources/OpenComputerUseKit/ScreenCaptureObservation.swift',
  'packages/OpenComputerUseKit/Sources/OpenComputerUseKit/ScreenObservation.swift',
];

function fixture(t) {
  const cache = fs.mkdtempSync(path.join(os.tmpdir(), 'ocu-source-test-'));
  t.after(() => fs.rmSync(cache, { recursive: true, force: true }));
  return { cache, prepare: () => prepareComputerUseSource({ cache, vendor, buildIdentifier: 'fixture-build' }) };
}

function sourceSnapshot(cache) {
  return fs.readdirSync(cache, { recursive: true, withFileTypes: true })
    .filter((entry) => entry.isFile())
    .map((entry) => path.relative(cache, path.join(entry.parentPath, entry.name)))
    .filter((file) => /^(apps|packages|Tests)\//.test(file) || file === 'Package.swift')
    .sort()
    .map((file) => [file, fs.readFileSync(path.join(cache, file), 'utf8')]);
}

test('repeated production source preparation preserves every patched source and compiler cache', unixOnly, (t) => {
  const { cache, prepare } = fixture(t);
  prepare();
  for (const file of addedSources) assert.ok(fs.readFileSync(path.join(cache, file), 'utf8').length > 0, file);
  const first = sourceSnapshot(cache);
  for (const directory of ['.build', '.cache', '.module-cache']) {
    fs.mkdirSync(path.join(cache, directory));
    fs.writeFileSync(path.join(cache, directory, 'sentinel'), 'preserve compiler work');
  }
  // npm ci removes the package marker, and explicit test runs bypass that marker.
  // Both paths prepare an existing cache even when the source hash is unchanged.
  prepare();
  assert.deepEqual(sourceSnapshot(cache), first);
  for (const directory of ['.build', '.cache', '.module-cache']) {
    assert.equal(fs.readFileSync(path.join(cache, directory, 'sentinel'), 'utf8'), 'preserve compiler work');
  }
});

test('production preparation recovers an incomplete source tree without keeping stale additions', unixOnly, (t) => {
  const { cache, prepare } = fixture(t);
  prepare();
  const first = sourceSnapshot(cache);
  fs.unlinkSync(path.join(cache, addedSources[1]));
  fs.writeFileSync(path.join(cache, addedSources[2]), 'interrupted patch');
  fs.writeFileSync(path.join(cache, 'packages/stale.swift'), 'removed source');
  fs.writeFileSync(path.join(cache, 'Tests/stale.swift'), 'removed test');
  prepare();
  assert.deepEqual(sourceSnapshot(cache), first);
});
