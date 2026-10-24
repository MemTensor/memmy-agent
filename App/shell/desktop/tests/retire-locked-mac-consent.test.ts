import { mkdtempSync, mkdirSync, readFileSync, rmSync, symlinkSync, writeFileSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { retireLockedMacConsent } from '../src/main/retire-locked-mac-consent.js';
import { NativeAppAllowAll } from '../src/main/native-app-allow-all.js';

const roots: string[] = [];
function root(): string {
  const directory = mkdtempSync(join(tmpdir(), 'memmy-retired-lock-consent-'));
  roots.push(directory);
  return directory;
}
afterEach(() => roots.splice(0).forEach(directory => rmSync(directory, { recursive: true, force: true })));

describe('retireLockedMacConsent', () => {
  it('removes only the old lock-screen consent and preserves other Computer Use permissions', () => {
    const userData = root();
    const directory = join(userData, 'computer-use');
    mkdirSync(directory);
    const consent = join(directory, 'locked-mac-consent.json');
    const appPermissions = join(directory, 'allow-all-apps.json');
    writeFileSync(consent, JSON.stringify({ version: 1, granted: true, grantedAt: new Date().toISOString() }));
    writeFileSync(appPermissions, '{"version":1,"enabled":true}');

    retireLockedMacConsent(userData);
    retireLockedMacConsent(userData);

    expect(existsSync(consent)).toBe(false);
    expect(readFileSync(appPermissions, 'utf8')).toBe('{"version":1,"enabled":true}');
    expect(new NativeAppAllowAll(userData).isEnabled()).toBe(true);
  });

  it('does not create any files on a fresh install', () => {
    const userData = root();
    retireLockedMacConsent(userData);
    expect(existsSync(join(userData, 'computer-use'))).toBe(false);
  });

  it('does not follow a symlinked permission directory', () => {
    const userData = root();
    const external = root();
    const consent = join(external, 'locked-mac-consent.json');
    writeFileSync(consent, 'keep');
    symlinkSync(external, join(userData, 'computer-use'), 'dir');

    retireLockedMacConsent(userData);

    expect(readFileSync(consent, 'utf8')).toBe('keep');
  });

  it('does not remove files through a symlinked consent path or remove directories', () => {
    const userData = root();
    const directory = join(userData, 'computer-use');
    mkdirSync(directory);
    const external = join(root(), 'keep.json');
    writeFileSync(external, 'keep');
    const consent = join(directory, 'locked-mac-consent.json');
    symlinkSync(external, consent);

    retireLockedMacConsent(userData);
    expect(readFileSync(external, 'utf8')).toBe('keep');
    expect(existsSync(consent)).toBe(true);

    rmSync(consent);
    mkdirSync(consent);
    retireLockedMacConsent(userData);
    expect(existsSync(consent)).toBe(true);
  });
});
