import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { BROWSER_NATIVE_ALLOW_ALL_FILE_ENV } from '@memmy/local-api-contracts';
import { BrowserUseSitePolicyReader } from '../../../../src/core/agent-runtime/tools/browser-use-site-policy-store.js';

const directories: string[] = [];
afterEach(() => {
  vi.unstubAllEnvs();
  for (const directory of directories.splice(0)) fs.rmSync(directory, { recursive: true, force: true });
});

describe('Agent browser use site policy reader', () => {
  it('reads the desktop file afresh and fails closed on corruption', () => {
    const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'agent-site-policy-')); directories.push(directory);
    const filePath = path.join(directory, 'site-policy.json');
    const reader = new BrowserUseSitePolicyReader(filePath);
    expect(reader.decision('https://example.com/', 'downloads')).toBe('ask');
    expect(reader.decision('https://example.com/', 'fullCdp')).toBe('ask');
    fs.writeFileSync(filePath, JSON.stringify({ version: 1, rules: [{ pattern: 'https://example.com',
      access: 'allow', downloads: 'block', uploads: 'allow', fullCdp: 'block' }] }));
    expect(reader.decision('https://example.com/file', 'downloads')).toBe('block');
    expect(reader.decision('https://example.com/file', 'uploads')).toBe('allow');
    fs.writeFileSync(filePath, '{bad');
    expect(reader.decision('https://example.com/file', 'uploads')).toBe('block');
  });

  it('fails closed on a malformed access decision without rewriting valid legacy policies', () => {
    const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'agent-legacy-site-policy-')); directories.push(directory);
    const filePath = path.join(directory, 'site-policy.json');
    const reader = new BrowserUseSitePolicyReader(filePath);
    const legacy = JSON.stringify({ version: 1, rules: [{ pattern: 'https://example.com',
      access: 'allow', downloads: 'block', uploads: 'allow', fullCdp: 'block' }] });
    fs.writeFileSync(filePath, legacy);
    expect(reader.decision('https://example.com/', 'access')).toBe('allow');
    expect(reader.decision('https://example.com/', 'fullCdp')).toBe('block');
    expect(reader.decision('https://unconfigured.example/', 'fullCdp')).toBe('ask');
    expect(fs.readFileSync(filePath, 'utf8')).toBe(legacy);
    const malformed = JSON.stringify({ version: 1, rules: [{ pattern: 'https://example.com',
      access: ['block'], downloads: 'allow', uploads: 'allow', fullCdp: 'allow' }] });
    fs.writeFileSync(filePath, malformed);
    for (const capability of ['access', 'downloads', 'uploads', 'fullCdp'] as const) {
      expect(reader.decision('https://example.com/', capability)).toBe('block');
    }
    expect(fs.readFileSync(filePath, 'utf8')).toBe(malformed);
  });

  it.each(['website', 'computer'] as const)('reads %s allow-all live and restores every site rule after disabling it', source => {
    const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'agent-global-browser-policy-')); directories.push(directory);
    const filePath = path.join(directory, 'site-policy.json');
    const nativeAllowAllFilePath = path.join(directory, 'native-allow-all.json');
    const reader = new BrowserUseSitePolicyReader(filePath, { nativeAllowAllFilePath });
    const globalPath = source === 'website' ? reader.allowAllFilePath : nativeAllowAllFilePath;
    const original = JSON.stringify({ version: 1, rules: [{ pattern: 'https://example.com',
      access: 'block', downloads: 'block', uploads: 'block', fullCdp: 'block' }] });
    fs.writeFileSync(filePath, original);
    for (const capability of ['access', 'downloads', 'uploads', 'fullCdp'] as const) {
      expect(reader.resolve('https://example.com/page', capability)).toEqual({ decision: 'block', matched: true });
    }
    fs.writeFileSync(globalPath, JSON.stringify({ version: 1, enabled: true }));
    for (const capability of ['access', 'downloads', 'uploads', 'fullCdp'] as const) {
      expect(reader.resolve('https://example.com/page', capability)).toEqual({ decision: 'allow', matched: true });
      expect(reader.resolve('https://new.example/page', capability)).toEqual({ decision: 'allow', matched: true });
    }
    fs.writeFileSync(globalPath, JSON.stringify({ version: 1, enabled: false }));
    expect(reader.decision('https://example.com/page', 'access')).toBe('block');
    expect(reader.resolve('https://new.example/page', 'access')).toEqual({ decision: 'ask', matched: false });
    expect(fs.readFileSync(filePath, 'utf8')).toBe(original);
  });

  it('inherits the supplied Computer Use path and preserves an independent website choice', () => {
    const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'agent-global-browser-inheritance-')); directories.push(directory);
    const nativePath = path.join(directory, 'allow-all-apps.json');
    vi.stubEnv(BROWSER_NATIVE_ALLOW_ALL_FILE_ENV, nativePath);
    const reader = new BrowserUseSitePolicyReader(path.join(directory, 'site-policy.json'));
    fs.writeFileSync(nativePath, JSON.stringify({ version: 1, enabled: true }));
    expect(reader.decision('https://example.com/', 'fullCdp')).toBe('allow');
    fs.writeFileSync(reader.allowAllFilePath, JSON.stringify({ version: 1, enabled: true }));
    fs.writeFileSync(nativePath, JSON.stringify({ version: 1, enabled: false }));
    expect(reader.decision('https://example.com/', 'fullCdp')).toBe('allow');
    fs.writeFileSync(reader.allowAllFilePath, JSON.stringify({ version: 1, enabled: false }));
    expect(reader.decision('https://example.com/', 'fullCdp')).toBe('ask');
  });

  it('never extends website allow-all to privileged, local or malformed URLs', () => {
    const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'agent-browser-global-protocol-')); directories.push(directory);
    const reader = new BrowserUseSitePolicyReader(path.join(directory, 'site-policy.json'));
    fs.writeFileSync(reader.allowAllFilePath, JSON.stringify({ version: 1, enabled: true }));
    for (const url of ['about:blank', 'chrome://settings/', 'edge://settings/', 'file:///private/report.txt', 'not-a-url']) {
      expect(reader.resolve(url, 'access')).toEqual({ decision: 'block', matched: true });
      expect(reader.decision(url, 'fullCdp')).toBe('block');
    }
  });

  it.each(['website', 'computer'] as const)('never treats missing, malformed, oversized or symlinked %s grants as allow-all', source => {
    const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'agent-invalid-global-browser-policy-')); directories.push(directory);
    const nativeAllowAllFilePath = path.join(directory, 'native-allow-all.json');
    const reader = new BrowserUseSitePolicyReader(path.join(directory, 'site-policy.json'), { nativeAllowAllFilePath });
    const globalPath = source === 'website' ? reader.allowAllFilePath : nativeAllowAllFilePath;
    expect(reader.decision('https://example.com/', 'access')).toBe('ask');
    for (const raw of ['{bad', 'null', '[]', '{"version":2,"enabled":true}',
      '{"version":1,"enabled":"true"}', ` ${' '.repeat(4096)}{"version":1,"enabled":true}`]) {
      fs.writeFileSync(globalPath, raw);
      expect(reader.decision('https://example.com/', 'access')).toBe('ask');
    }
    fs.rmSync(globalPath);
    const target = path.join(directory, 'actual-grant.json');
    fs.writeFileSync(target, JSON.stringify({ version: 1, enabled: true }));
    fs.symlinkSync(target, globalPath);
    expect(reader.decision('https://example.com/', 'access')).toBe('ask');
  });
});
