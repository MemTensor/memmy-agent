import { execFile } from 'node:child_process';
import { createRequire } from 'node:module';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';
import { build } from 'esbuild';
import { expect, it } from 'vitest';

const directory = path.dirname(fileURLToPath(import.meta.url));
let executable = process.env.MEMMY_ELECTRON_TEST_EXECUTABLE;
if (!executable) {
  try { executable = createRequire(import.meta.url)('electron') as string; } catch { /* Opt in with a staged Electron binary. */ }
}

// Uses only localhost fixture pages and a hidden window with an isolated profile.
// Run with MEMMY_ELECTRON_TEST_EXECUTABLE=/path/to/Electron when Electron is staged separately.
it.skipIf(!executable || !fs.existsSync(executable))('keeps CDP text in the exact background guest and restores animation scheduling after each lease', async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'memmy-browser-input-regression-'));
  try {
    const bundle = path.join(root, 'driver.cjs');
    await build({ entryPoints: [path.resolve(directory, '../src/main/embedded-browser-driver.ts')],
      bundle: true, platform: 'node', format: 'cjs', external: ['electron'], outfile: bundle,
      logLevel: 'silent' });
    const { ELECTRON_RUN_AS_NODE: _ignored, ...environment } = process.env;
    const result = await promisify(execFile)(executable!, [path.join(directory, 'fixtures/embedded-browser-input.cjs')], {
      env: { ...environment, MEMMY_INPUT_FIXTURE_ROOT: root, MEMMY_INPUT_FIXTURE_DRIVER: bundle },
      timeout: 30_000, maxBuffer: 1024 * 1024,
    });
    const line = result.stdout.split('\n').find(value => value.startsWith('MEMMY_ELECTRON_INPUT_RESULT '));
    expect(line).toBeTruthy();
    expect(JSON.parse(line!.slice('MEMMY_ELECTRON_INPUT_RESULT '.length))).toMatchObject({
      baseline: { inputMisdirected: true, animationPaused: true },
      repaired: { exactGuest: true, hostUnchanged: true, selectedTabUnchanged: true,
        animationResumed: true, endRestored: true, cancellationRestored: true,
        focusLossBlocked: true, otherGuestBlocked: true,
        repeatedLeaseInput: true, repeatedEndRestored: true },
    });
  } finally { fs.rmSync(root, { recursive: true, force: true }); }
}, 40_000);
