import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { NativeAppAllowAll, nativeAppAccessDecision } from '../src/main/native-app-allow-all.js';

const directories: string[] = [];
function store(): NativeAppAllowAll {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'memmy-allow-all-test-'));
  directories.push(directory);
  return new NativeAppAllowAll(directory);
}

afterEach(() => {
  for (const directory of directories.splice(0)) fs.rmSync(directory, { recursive: true, force: true });
});

describe('native app allow-all', () => {
  it('defaults off, then remembers an explicit choice', () => {
    const value = store();
    expect(value.isEnabled()).toBe(false);
    expect(value.setEnabled(true)).toBe(true);
    expect(new NativeAppAllowAll(path.dirname(path.dirname(value.filePath))).isEnabled()).toBe(true);
    value.setEnabled(false);
    expect(value.isEnabled()).toBe(false);
  });

  it('fails closed for invalid or symlinked data', () => {
    const value = store();
    fs.mkdirSync(path.dirname(value.filePath), { recursive: true });
    fs.writeFileSync(value.filePath, '{"version":1,"enabled":"yes"}');
    expect(value.isEnabled()).toBe(false);
    fs.rmSync(value.filePath);
    fs.symlinkSync(path.join(os.tmpdir(), 'missing-allow-all'), value.filePath);
    expect(value.isEnabled()).toBe(false);
    expect(() => value.setEnabled(true)).toThrow('Unsafe native app allow-all path');
  });

  it('asks for each app until the user allows every app', () => {
    const app = { platform: 'darwin', appId: 'com.apple.calculator', displayName: 'Calculator', hostPlatform: 'darwin' };
    expect(nativeAppAccessDecision({ ...app, allowAll: false })).toBe('ask');
    expect(nativeAppAccessDecision({ ...app, allowAll: true })).toBe('allow-once');
    expect(nativeAppAccessDecision({ ...app, platform: 'win32', allowAll: true })).toBe('deny');
    expect(nativeAppAccessDecision({ ...app, appId: '', allowAll: true })).toBe('deny');
  });
});
