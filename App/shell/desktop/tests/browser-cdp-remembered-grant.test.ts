import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { evaluateBrowserUseSiteRule } from '@memmy/local-api-contracts';
import { BrowserUseSitePolicyStore } from '../src/main/browser-use-site-policy-store.js';
import { rememberBrowserCdpGrant } from '../src/main/browser-cdp-remembered-grant.js';

const directories: string[] = [];
function store() {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'cdp-grant-'));
  directories.push(directory);
  return new BrowserUseSitePolicyStore(directory);
}
afterEach(() => { for (const directory of directories.splice(0)) fs.rmSync(directory, { recursive: true, force: true }); });

describe('remembering the dialog Debug / CDP grant', () => {
  it('persists only the exact origin and port, leaving file permissions unchanged', () => {
    const policy = store();
    expect(rememberBrowserCdpGrant(policy, 'https://example.test:8443')).toBe(true);
    const rules = new BrowserUseSitePolicyStore(path.dirname(path.dirname(policy.filePath))).list();
    expect(rules).toEqual([{ pattern: 'https://example.test:8443', access: 'ask',
      downloads: 'ask', uploads: 'ask', fullCdp: 'allow' }]);
    expect(evaluateBrowserUseSiteRule(rules, 'https://other.example.test:8443', 'fullCdp')).toBe('ask');
    expect(evaluateBrowserUseSiteRule(rules, 'https://example.test', 'fullCdp')).toBe('ask');
  });

  it('preserves existing site access and file decisions', () => {
    const policy = store();
    policy.upsert({ pattern: 'https://example.test', access: 'allow', downloads: 'block', uploads: 'allow', fullCdp: 'ask' });
    expect(rememberBrowserCdpGrant(policy, 'https://example.test')).toBe(true);
    expect(policy.list()).toEqual([{ pattern: 'https://example.test', access: 'allow',
      downloads: 'block', uploads: 'allow', fullCdp: 'allow' }]);
  });

  it.each([['allow', 'allow'], ['deny', 'block']] as const)('carries a remembered %s access choice into the new exact rule', (remembered, access) => {
    const policy = store();
    expect(rememberBrowserCdpGrant(policy, 'https://example.test', remembered)).toBe(remembered === 'allow');
    expect(policy.list()).toEqual([{ pattern: 'https://example.test', access,
      downloads: 'ask', uploads: 'ask', fullCdp: 'allow' }]);
  });

  it('keeps decisions from a broader rule when it adds the exact rule after it', () => {
    const policy = store();
    policy.upsert({ pattern: 'https://**.example.test', access: 'allow', downloads: 'allow', uploads: 'block', fullCdp: 'ask' });
    expect(rememberBrowserCdpGrant(policy, 'https://tax.example.test', 'deny')).toBe(true);
    const rules = policy.list();
    for (const capability of ['access', 'downloads', 'uploads'] as const) {
      expect(evaluateBrowserUseSiteRule(rules, 'https://tax.example.test/form', capability))
        .toBe({ access: 'allow', downloads: 'allow', uploads: 'block' }[capability]);
    }
    expect(evaluateBrowserUseSiteRule(rules, 'https://tax.example.test/form', 'fullCdp')).toBe('allow');
  });

  it.each(['access', 'fullCdp'] as const)('respects a concurrent or wildcard %s denial', capability => {
    const policy = store();
    policy.upsert({ pattern: 'https://**.example.test', access: 'ask', downloads: 'ask',
      uploads: 'ask', fullCdp: 'ask', [capability]: 'block' });
    expect(rememberBrowserCdpGrant(policy, 'https://sub.example.test')).toBe(false);
    expect(policy.list()).toHaveLength(1);
  });

  it.each(['https://*.example.test', 'https://example.test/path', 'file:///tmp/page'])('rejects a non-origin grant: %s', origin => {
    const policy = store();
    expect(rememberBrowserCdpGrant(policy, origin)).toBe(false);
    expect(policy.list()).toEqual([]);
  });
});
