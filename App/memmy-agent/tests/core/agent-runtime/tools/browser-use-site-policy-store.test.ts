import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { BrowserUseSitePolicyReader } from '../../../../src/core/agent-runtime/tools/browser-use-site-policy-store.js';

const directories: string[] = [];
afterEach(() => { for (const directory of directories.splice(0)) fs.rmSync(directory, { recursive: true, force: true }); });

describe('Agent browser use site policy reader', () => {
  it('reads the desktop file afresh and fails closed on corruption', () => {
    const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'agent-site-policy-')); directories.push(directory);
    const filePath = path.join(directory, 'site-policy.json');
    const reader = new BrowserUseSitePolicyReader(filePath);
    expect(reader.decision('https://example.com/', 'downloads')).toBe('ask');
    expect(reader.decision('https://example.com/', 'fullCdp')).toBe('block');
    fs.writeFileSync(filePath, JSON.stringify({ version: 1, rules: [{ pattern: 'https://example.com',
      access: 'allow', downloads: 'block', uploads: 'allow', fullCdp: 'block' }] }));
    expect(reader.decision('https://example.com/file', 'downloads')).toBe('block');
    expect(reader.decision('https://example.com/file', 'uploads')).toBe('allow');
    fs.writeFileSync(filePath, '{bad');
    expect(reader.decision('https://example.com/file', 'uploads')).toBe('block');
  });
});
