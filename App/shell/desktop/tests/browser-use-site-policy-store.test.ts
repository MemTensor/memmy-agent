import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { BrowserUseSitePolicyStore } from '../src/main/browser-use-site-policy-store.js';

const directories: string[] = [];
afterEach(() => { for (const directory of directories.splice(0)) fs.rmSync(directory, { recursive: true, force: true }); });

describe('desktop browser use site policy store', () => {
  it('persists validated rules in the Agent data directory and removes them', () => {
    const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'site-policy-')); directories.push(directory);
    const store = new BrowserUseSitePolicyStore(directory);
    const rule = { pattern: 'https://*.Example.com', access: 'ask' as const,
      downloads: 'block' as const, uploads: 'allow' as const, fullCdp: 'block' as const };
    expect(store.upsert(rule)).toMatchObject([{ ...rule, pattern: 'https://*.example.com' }]);
    expect(new BrowserUseSitePolicyStore(directory).list()).toHaveLength(1);
    expect(fs.statSync(store.filePath).mode & 0o777).toBe(0o600);
    expect(store.remove('https://*.example.com')).toEqual([]);
    expect(store.list()).toEqual([]);
  });

  it('rejects invalid or corrupted rules rather than silently clearing a restriction', () => {
    const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'site-policy-')); directories.push(directory);
    const store = new BrowserUseSitePolicyStore(directory);
    expect(() => store.upsert({ pattern: 'https://example.com/path', access: 'allow',
      downloads: 'allow', uploads: 'allow', fullCdp: 'allow' })).toThrow(/Invalid browser site pattern/);
    fs.mkdirSync(path.dirname(store.filePath), { recursive: true });
    fs.writeFileSync(store.filePath, '{bad');
    expect(() => store.list()).toThrow();
  });
});
