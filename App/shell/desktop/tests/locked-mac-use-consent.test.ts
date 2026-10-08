import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { LockedMacUseConsent } from '../src/main/locked-mac-use-consent.js';

const directories: string[] = [];
function store(): LockedMacUseConsent {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'memmy-lock-consent-test-'));
  directories.push(directory);
  return new LockedMacUseConsent(directory);
}

afterEach(() => {
  for (const directory of directories.splice(0)) fs.rmSync(directory, { recursive: true, force: true });
});

describe('separate locked Mac use consent', () => {
  it('defaults to denied, persists an explicit grant, and revokes it', () => {
    const value = store();
    expect(value.isGranted()).toBe(false);
    value.setGranted(true);
    expect(new LockedMacUseConsent(path.dirname(path.dirname(value.filePath))).isGranted()).toBe(true);
    value.setGranted(false);
    expect(value.isGranted()).toBe(false);
  });

  it('fails closed for invalid or symlinked consent data', () => {
    const value = store();
    fs.mkdirSync(path.dirname(value.filePath), { recursive: true });
    fs.writeFileSync(value.filePath, '{"version":1,"granted":true}');
    expect(value.isGranted()).toBe(false);
    fs.rmSync(value.filePath);
    fs.symlinkSync(path.join(os.tmpdir(), 'missing-locked-mac-consent'), value.filePath);
    expect(value.isGranted()).toBe(false);
    expect(() => value.setGranted(true)).toThrow('Unsafe locked Mac consent path');
  });
});
