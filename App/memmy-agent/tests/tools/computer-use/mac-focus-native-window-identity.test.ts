import { execFile } from 'node:child_process';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';
import { expect, it } from 'vitest';

const run = promisify(execFile);

it.skipIf(process.platform !== 'darwin')('resolves the native reveal/restore AX target without a same-size sibling substitution', async () => {
  const scratch = await fs.mkdtemp(path.join(os.tmpdir(), 'memmy-focus-window-identity-'));
  try {
    const executable = path.join(scratch, 'identity-test');
    const source = fileURLToPath(new URL('./fixtures/focus-window-identity.c', import.meta.url));
    const nativeSource = fileURLToPath(new URL('../../../src/tools/computer-use/mac/', import.meta.url));
    await run('clang', ['-O2', '-std=c11', '-Wall', '-Wextra', '-Werror', '-I', nativeSource,
      source, '-lm', '-o', executable], { timeout: 10_000 });
    const { stdout } = await run(executable, [], { timeout: 3000 });
    expect(JSON.parse(stdout)).toEqual({ status: 'passed', cases: 15 });
  } finally { await fs.rm(scratch, { recursive: true, force: true }); }
}, 15_000);
