import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { parseDesktopManifestArgs, writeDesktopEditionManifest } from '../scripts/internal/shared/write-desktop-edition-manifest-lib.mjs';

test('signed local marker is present only in a signed test build manifest', async () => {
  const root = mkdtempSync(join(tmpdir(), 'memmy-signed-local-manifest-'));
  try {
    const base = { output: join(root, 'desktop-edition.json'), edition: 'cn', accountChannel: 'phone',
      environment: { MEMMY_CLOUD_SERVICE: 'https://example.com' } };
    const ordinary = await writeDesktopEditionManifest({ ...base, signing: 'signed' });
    assert.equal(ordinary.localTestProfile, undefined);
    const marked = await writeDesktopEditionManifest({ ...base, signing: 'signed', localTestProfile: 'signed-local' });
    assert.equal(marked.localTestProfile, 'signed-local');
    assert.equal(JSON.parse(readFileSync(base.output, 'utf8')).localTestProfile, 'signed-local');
    await assert.rejects(
      writeDesktopEditionManifest({ ...base, signing: 'unsigned', localTestProfile: 'signed-local' }),
      /requires a signed macOS package/,
    );
    assert.equal(parseDesktopManifestArgs(['--output', base.output, '--edition', 'cn', '--account-channel', 'phone',
      '--signing', 'signed', '--local-test-profile', 'signed-local']).localTestProfile, 'signed-local');
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});
