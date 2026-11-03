import { execFile, execFileSync } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { createRequire } from 'node:module';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';
import { build } from 'esbuild';
import { expect, it } from 'vitest';

const directory = path.dirname(fileURLToPath(import.meta.url));

function cleanupTemporaryStartupEntries(itemName: string): void {
  const systemRoot = process.env.SystemRoot ?? process.env.WINDIR ?? 'C:\\Windows';
  const reg = path.join(systemRoot, 'System32', 'reg.exe');
  const powershell = path.join(systemRoot, 'System32', 'WindowsPowerShell', 'v1.0', 'powershell.exe');
  const errors: unknown[] = [];
  for (const subkey of [
    'Software\\Microsoft\\Windows\\CurrentVersion\\Run',
    'Software\\Microsoft\\Windows\\CurrentVersion\\Explorer\\StartupApproved\\Run',
  ]) {
    for (const name of [itemName, `${itemName}-unrelated`, `${itemName}-same-command`]) {
      try {
        execFileSync(reg, ['delete', `HKCU\\${subkey}`, '/v', name, '/f'], {
          windowsHide: true, timeout: 10_000, stdio: ['ignore', 'pipe', 'pipe'],
        });
      } catch (deletionError) {
        if ((deletionError as { status?: number }).status !== 1) {
          errors.push(deletionError);
          continue;
        }
        try {
          // reg.exe uses the same exit code for missing and inaccessible values.
          // Ignore a failure only after WMI confirms that this exact value is absent.
          const source = `$ErrorActionPreference = 'Stop'
$result = Invoke-CimMethod -Namespace root/default -ClassName StdRegProv -MethodName EnumValues -Arguments @{
  hDefKey = [uint32]2147483649
  sSubKeyName = $env:MEMMY_LOGIN_CLEANUP_SUBKEY
}
if ($result.ReturnValue -eq 2) { [Console]::Write('missing'); exit 0 }
if ($result.ReturnValue -ne 0) { throw "Cannot inspect temporary startup key: $($result.ReturnValue)" }
if (@($result.sNames) -ccontains $env:MEMMY_LOGIN_CLEANUP_NAME) { throw 'Temporary startup value remains after reg.exe deletion failed' }
[Console]::Write('missing')
`;
          const verification = execFileSync(powershell, ['-NoProfile', '-NonInteractive', '-EncodedCommand',
            Buffer.from(source, 'utf16le').toString('base64')], {
            env: { ...process.env, MEMMY_LOGIN_CLEANUP_SUBKEY: subkey, MEMMY_LOGIN_CLEANUP_NAME: name },
            encoding: 'utf8', windowsHide: true, timeout: 12_000, stdio: ['ignore', 'pipe', 'pipe'],
          });
          if (verification.replace(/^\uFEFF/, '').trim() !== 'missing') throw deletionError;
        } catch (verificationError) {
          errors.push(new AggregateError([deletionError, verificationError], `Cannot clean temporary startup value ${name}`));
        }
      }
    }
  }
  if (errors.length) throw new AggregateError(errors, 'Temporary startup cleanup failed; fixture files were retained');
}

// The fixture writes only a unique temporary startup entry and removes it in finally.
it.runIf(process.platform === 'win32')('repairs real Electron startup commands and executes the registered VBS path', async () => {
  let executable = process.env.MEMMY_ELECTRON_TEST_EXECUTABLE;
  if (!executable) executable = createRequire(import.meta.url)('electron') as string;
  expect(executable, 'Windows startup integration requires a staged Electron executable').toBeTruthy();
  if (!executable || !fs.existsSync(executable)) throw new Error('Windows startup integration requires a staged Electron executable');

  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'memmy-login-integration-'));
  const itemName = `memmy-login-probe-${randomUUID()}`;
  let testError: unknown;
  try {
    const bundle = path.join(root, 'login-item.cjs');
    await build({ entryPoints: [path.resolve(directory, '../src/main/windows-launch-at-login.ts')],
      bundle: true, platform: 'node', format: 'cjs', outfile: bundle, logLevel: 'silent' });
    const { ELECTRON_RUN_AS_NODE: _ignored, ...environment } = process.env;
    const result = await promisify(execFile)(executable, [path.join(directory, 'fixtures/windows-launch-at-login.cjs')], {
      env: { ...environment, MEMMY_LOGIN_FIXTURE_ROOT: root, MEMMY_LOGIN_FIXTURE_ADAPTER: bundle,
        MEMMY_LOGIN_FIXTURE_ITEM_NAME: itemName },
      timeout: 75_000, maxBuffer: 1024 * 1024,
    });
    const line = result.stdout.split('\n').find(value => value.startsWith('MEMMY_ELECTRON_LOGIN_RESULT '));
    expect(line).toBeTruthy();
    if (!line) throw new Error('Windows startup fixture did not report its result');
    expect(JSON.parse(line.slice('MEMMY_ELECTRON_LOGIN_RESULT '.length))).toEqual({
      rawCommandExecuted: true,
      migrations: [{ enabled: true, executed: true }, { enabled: false, executed: true }],
      disabledPreservedWithUnrelatedEntry: true,
      exactCommandAliasStates: [true, true, false, true],
      idempotent: true,
      closedStartupPreserved: true,
    });
  } catch (error) {
    testError = error;
    throw error;
  } finally {
    try {
      // The parent also cleans up when execFile kills or cannot launch the Electron child.
      cleanupTemporaryStartupEntries(itemName);
    } catch (cleanupError) {
      if (testError) throw new AggregateError([testError, cleanupError], 'Windows startup regression and cleanup failed');
      throw cleanupError;
    }
    fs.rmSync(root, { recursive: true, force: true });
  }
}, 85_000);
