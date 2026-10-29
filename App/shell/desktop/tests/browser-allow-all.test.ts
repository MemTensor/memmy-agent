import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { BrowserAllowAll } from '../src/main/browser-allow-all.js';
import { NativeAppAllowAll } from '../src/main/native-app-allow-all.js';
import { BrowserUseSitePolicyStore } from '../src/main/browser-use-site-policy-store.js';

const directories: string[] = [];
function fixture() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'browser-global-'));
  directories.push(root);
  const data = path.join(root, 'agent');
  const native = new NativeAppAllowAll(path.join(root, 'desktop'));
  const browser = new BrowserAllowAll(data, () => native.isEnabled());
  const sites = new BrowserUseSitePolicyStore(data);
  return { root, data, native, browser, sites };
}
afterEach(() => { for (const directory of directories.splice(0)) fs.rmSync(directory, { recursive: true, force: true }); });

describe('browser global authorization', () => {
  it('inherits an existing computer setting without rewriting site choices', () => {
    const { native, browser, sites } = fixture();
    sites.upsert({ pattern: 'https://example.test', access: 'block', downloads: 'block', uploads: 'block', fullCdp: 'block' });
    const original = fs.readFileSync(sites.filePath, 'utf8');
    const permissionsFile = path.join(path.dirname(browser.filePath), 'permissions.json');
    fs.writeFileSync(permissionsFile, JSON.stringify({ 'https://example.test': ['camera'] }));
    const devices = fs.readFileSync(permissionsFile, 'utf8');
    native.setEnabled(true);
    expect(browser.read()).toEqual({ enabled: false, inherited: true, effective: true });
    for (const capability of ['access', 'downloads', 'uploads', 'fullCdp'] as const)
      expect(browser.decision('https://example.test', capability)).toBe('allow');
    expect(fs.existsSync(browser.filePath)).toBe(false);
    expect(fs.readFileSync(sites.filePath, 'utf8')).toBe(original);
    expect(fs.readFileSync(permissionsFile, 'utf8')).toBe(devices);
    native.setEnabled(false);
    expect(browser.read()).toEqual({ enabled: false, inherited: false, effective: false });
    expect(browser.decision('https://example.test', 'fullCdp')).toBe('block');
  });

  it('still reports a site block to grants that outlive the global switch', () => {
    const { browser, sites } = fixture();
    sites.upsert({ pattern: 'https://blocked.test', access: 'block', downloads: 'ask', uploads: 'ask', fullCdp: 'ask' });
    browser.setEnabled(true);
    expect(browser.decision('https://blocked.test', 'access')).toBe('allow');
    expect(browser.siteRuleDecision('https://blocked.test', 'access')).toBe('block');
    expect(browser.siteRuleDecision('https://other.test', 'access')).toBe('ask');
    expect(browser.siteRuleDecision('file:///tmp/page', 'access')).toBe('block');
  });

  it('remembers an independent website grant across restarts and parent on/off transitions', () => {
    const { data, native, browser } = fixture();
    expect(browser.setEnabled(true)).toEqual({ enabled: true, inherited: false, effective: true });
    native.setEnabled(true);
    expect(browser.read()).toEqual({ enabled: true, inherited: true, effective: true });
    native.setEnabled(false);
    const restarted = new BrowserAllowAll(data, () => native.isEnabled());
    expect(restarted.read()).toEqual({ enabled: true, inherited: false, effective: true });
    restarted.setEnabled(false);
    expect(restarted.decision('https://unconfigured.test', 'access')).toBe('ask');
  });

  it('does not let a global choice enable non-web schemes', () => {
    const { browser } = fixture();
    browser.setEnabled(true);
    for (const url of ['file:///tmp/page', 'chrome://settings', 'not a URL'])
      expect(browser.decision(url, 'access')).toBe('block');
  });

  it('never treats invalid, oversized, or symlinked website data as permission', () => {
    const { browser, root } = fixture();
    browser.setEnabled(false);
    for (const value of ['{"version":1,"enabled":"true"}', '{"version":2,"enabled":true}', 'x'.repeat(4097)]) {
      fs.writeFileSync(browser.filePath, value);
      expect(browser.read().effective).toBe(false);
    }
    fs.rmSync(browser.filePath);
    const linked = path.join(root, 'linked.json');
    fs.writeFileSync(linked, '{"version":1,"enabled":true}');
    fs.symlinkSync(linked, browser.filePath);
    expect(browser.read().effective).toBe(false);
    expect(() => browser.setEnabled(true)).toThrow('Unsafe browser approval path');
  });
});
