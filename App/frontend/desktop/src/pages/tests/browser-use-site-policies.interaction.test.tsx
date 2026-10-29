// @vitest-environment happy-dom
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import type { BrowserAllowAllState, BrowserUseSiteRule } from '@memmy/local-api-contracts';
import { I18nProvider } from '../../i18n/i18n-provider.js';
import { BrowserUseSitePolicies } from '../browser-use-site-policies.js';

(globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
type Access = { origin: string; decision: 'allow' | 'deny' };
let container: HTMLDivElement;
let root: Root;
let rules: BrowserUseSiteRule[];
let access: Access[];
let allowAll: BrowserAllowAllState;
let permissionChanged: ((state: BrowserAllowAllState) => void) | undefined;
let bridge: Record<string, ReturnType<typeof vi.fn>>;
const siteRule = (pattern: string, fullCdp: BrowserUseSiteRule['fullCdp'] = 'block'): BrowserUseSiteRule => ({
  pattern, access: 'ask', downloads: 'ask', uploads: 'ask', fullCdp,
});
beforeEach(() => {
  rules = []; access = []; allowAll = { enabled: false, inherited: false, effective: false }; permissionChanged = undefined;
  bridge = {
    getBrowserAllowAll: vi.fn(async () => allowAll),
    setBrowserAllowAll: vi.fn(async (enabled: boolean) => {
      allowAll = { enabled, inherited: false, effective: enabled }; return allowAll;
    }),
    onBrowserAllowAllChanged: vi.fn((listener: (state: BrowserAllowAllState) => void) => {
      permissionChanged = listener; return vi.fn();
    }),
    getBrowserUseSitePolicies: vi.fn(async () => rules),
    getBrowserAccessRules: vi.fn(async () => access),
    upsertBrowserUseSitePolicy: vi.fn(async (rule: BrowserUseSiteRule) => {
      rules = [...rules.filter(item => item.pattern !== rule.pattern), rule]; return rules;
    }),
    removeBrowserUseSitePolicy: vi.fn(async (pattern: string) => {
      rules = rules.filter(item => item.pattern !== pattern); return rules;
    }),
    setBrowserAccessRule: vi.fn(async (origin: string, decision: 'allow' | 'deny' | 'ask') => {
      access = access.filter(entry => entry.origin !== origin);
      if (decision !== 'ask') access.push({ origin, decision });
      return access;
    }),
    clearBrowserData: vi.fn(),
  };
  Object.defineProperty(window, 'memmy', { configurable: true, value: bridge });
  container = document.createElement('div'); document.body.append(container); root = createRoot(container);
});
afterEach(() => { act(() => root.unmount()); Reflect.deleteProperty(window, 'memmy'); container.remove(); });
async function render() {
  await act(async () => root.render(<I18nProvider language="en-US"><BrowserUseSitePolicies embedded /></I18nProvider>));
}
async function addWebsite(value: string) {
  const input = container.querySelector('input[aria-label="Website address"]') as HTMLInputElement;
  await act(async () => {
    Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')!.set!.call(input, value);
    input.dispatchEvent(new Event('input', { bubbles: true }));
  });
  await act(async () => container.querySelector('form')!.dispatchEvent(
    new Event('submit', { bubbles: true, cancelable: true })));
}
async function choose(label: string, value: string) {
  const select = container.querySelector(`select[aria-label="${label}"]`) as HTMLSelectElement;
  await act(async () => { select.value = value; select.dispatchEvent(new Event('change', { bubbles: true })); });
}

it('adds an ordinary website address with safe defaults and keeps advanced controls collapsed', async () => {
  await render();
  await addWebsite('example.com/account?view=profile');
  expect(bridge.upsertBrowserUseSitePolicy).toHaveBeenCalledWith(siteRule('https://example.com', 'ask'));
  expect((container.querySelector('input[aria-label="Website address"]') as HTMLInputElement).value).toBe('');
  expect(container.textContent).toContain('Visit webpages');
  expect(container.textContent).toContain('Download files');
  expect(container.textContent).toContain('Upload files');
  expect((container.querySelector('details') as HTMLDetailsElement).open).toBe(false);
  expect(container.textContent).not.toContain('*.example.com');
  await addWebsite('ftp://example.com');
  expect(bridge.upsertBrowserUseSitePolicy).toHaveBeenCalledOnce();
  expect(container.querySelector('[role="alert"]')!.textContent).toBe('Enter a valid website address.');
});

it('preserves existing advanced decisions when editing ordinary permissions or re-adding a site', async () => {
  rules = [siteRule('https://example.com', 'allow')];
  await render();
  await choose('https://example.com Upload files', 'block');
  expect(bridge.upsertBrowserUseSitePolicy).toHaveBeenLastCalledWith({ ...siteRule('https://example.com', 'allow'), uploads: 'block' });
  await addWebsite('https://example.com/other');
  expect(bridge.upsertBrowserUseSitePolicy).toHaveBeenLastCalledWith({ ...siteRule('https://example.com', 'allow'), uploads: 'block' });
  const details = container.querySelector('details') as HTMLDetailsElement;
  act(() => { details.open = true; });
  await choose('https://example.com Debug / CDP', 'ask');
  expect(bridge.upsertBrowserUseSitePolicy).toHaveBeenLastCalledWith(expect.objectContaining({ fullCdp: 'ask', uploads: 'block' }));
});

it('shows a remembered always-allow and revokes it without clearing browsing data', async () => {
  access = [{ origin: 'https://remembered.test', decision: 'allow' }];
  await render();
  const select = container.querySelector('select') as HTMLSelectElement;
  expect(select.value).toBe('allow');
  expect(container.textContent).toContain('Remembered permissions');
  await act(async () => ([...container.querySelectorAll('button')].find(button => button.textContent === 'Revoke permission')!).click());
  expect(bridge.setBrowserAccessRule).toHaveBeenCalledWith('https://remembered.test', 'ask');
  expect(container.textContent).not.toContain('https://remembered.test');
  expect(bridge.clearBrowserData).not.toHaveBeenCalled();
  expect(bridge.removeBrowserUseSitePolicy).not.toHaveBeenCalled();
});

it('allows a remembered denial to be changed and reports overlapping site settings', async () => {
  rules = [siteRule('https://example.com')];
  access = [{ origin: 'https://example.com', decision: 'deny' }];
  await render();
  expect(container.textContent).toContain('This website has its own settings, which take priority.');
  await choose('https://example.com Remembered permissions Visit webpages', 'allow');
  expect(bridge.setBrowserAccessRule).toHaveBeenCalledWith('https://example.com', 'allow');
  expect(bridge.upsertBrowserUseSitePolicy).not.toHaveBeenCalled();
});

it('removes stale remembered grants before resetting a matching site rule', async () => {
  const rule = siteRule('https://*.example.com'); rules = [rule];
  access = [{ origin: 'https://a.example.com', decision: 'allow' }, { origin: 'https://other.test', decision: 'allow' }];
  await render();
  await act(async () => ([...container.querySelectorAll('button')].find(button => button.textContent === 'Reset to default')!).click());
  expect(bridge.setBrowserAccessRule).toHaveBeenCalledWith('https://a.example.com', 'ask');
  expect(bridge.setBrowserAccessRule).toHaveBeenCalledOnce();
  expect(bridge.setBrowserAccessRule.mock.invocationCallOrder[0]).toBeLessThan(bridge.removeBrowserUseSitePolicy.mock.invocationCallOrder[0]);
  expect(bridge.removeBrowserUseSitePolicy).toHaveBeenCalledWith(rule.pattern);
  expect(access).toEqual([{ origin: 'https://other.test', decision: 'allow' }]);
});

it('does not remove a blocking rule when remembered grants could not be cleared', async () => {
  rules = [{ ...siteRule('https://example.com'), access: 'block' }];
  access = [{ origin: 'https://example.com', decision: 'allow' }];
  bridge.setBrowserAccessRule.mockRejectedValueOnce(new Error('disk failed'));
  await render();
  await act(async () => ([...container.querySelectorAll('button')].find(button => button.textContent === 'Reset to default')!).click());
  expect(bridge.removeBrowserUseSitePolicy).not.toHaveBeenCalled();
  expect((container.querySelector('[aria-label="https://example.com Visit webpages"]') as HTMLSelectElement).value).toBe('block');
  expect(container.querySelector('[role="alert"]')).not.toBeNull();
});

it('keeps readable rules but disables resetting them when remembered access could not be loaded', async () => {
  rules = [siteRule('https://example.com')];
  bridge.getBrowserAccessRules.mockRejectedValueOnce(new Error('access unavailable'));
  await render();
  expect(container.textContent).toContain('https://example.com');
  expect(([...container.querySelectorAll('button')].find(button => button.textContent === 'Reset to default')!).disabled).toBe(true);
  await choose('https://example.com Download files', 'block');
  expect(bridge.upsertBrowserUseSitePolicy).toHaveBeenCalledWith({ ...siteRule('https://example.com'), downloads: 'block' });
});

it('serializes permission writes and leaves saved values intact on failure', async () => {
  rules = [siteRule('https://example.com', 'ask')]; await render();
  let resolve!: (value: BrowserUseSiteRule[]) => void;
  bridge.upsertBrowserUseSitePolicy.mockReturnValueOnce(new Promise<BrowserUseSiteRule[]>(done => { resolve = done; }));
  await choose('https://example.com Download files', 'block');
  await choose('https://example.com Upload files', 'allow');
  expect(bridge.upsertBrowserUseSitePolicy).toHaveBeenCalledOnce();
  await act(async () => resolve([{ ...rules[0], downloads: 'block' }]));
  bridge.upsertBrowserUseSitePolicy.mockRejectedValueOnce(new Error('save failed'));
  await choose('https://example.com Upload files', 'allow');
  expect((container.querySelector('[aria-label="https://example.com Upload files"]') as HTMLSelectElement).value).toBe('ask');
  expect(container.querySelector('[role="alert"]')).not.toBeNull();
});

function allWebsitesSwitch(): HTMLInputElement {
  return container.querySelector('input[role="switch"][aria-label="Always allow all websites"]') as HTMLInputElement;
}

it('allows websites independently and restores saved site decisions when switched off', async () => {
  rules = [{ ...siteRule('https://example.com'), access: 'block' }];
  access = [{ origin: 'https://remembered.test', decision: 'deny' }];
  await render();
  await act(async () => allWebsitesSwitch().click());
  expect(bridge.setBrowserAllowAll).toHaveBeenLastCalledWith(true);
  expect(allWebsitesSwitch().checked).toBe(true);
  expect(allWebsitesSwitch().disabled).toBe(false);
  expect(container.textContent).toContain('Allow all temporarily overrides');
  const savedDecision = container.querySelector('select[aria-label="https://example.com Visit webpages"]') as HTMLSelectElement;
  expect(savedDecision.value).toBe('block');
  expect([...container.querySelectorAll('select')].every(select => select.disabled)).toBe(true);
  await choose('https://example.com Visit webpages', 'allow');
  expect(bridge.upsertBrowserUseSitePolicy).not.toHaveBeenCalled();
  expect(bridge.setBrowserAccessRule).not.toHaveBeenCalled();
  await act(async () => allWebsitesSwitch().click());
  expect(bridge.setBrowserAllowAll).toHaveBeenLastCalledWith(false);
  expect(savedDecision.value).toBe('block');
  expect(savedDecision.disabled).toBe(false);
  expect(rules[0]?.access).toBe('block');
  expect(access[0]?.decision).toBe('deny');
});

it.each([false, true])('preserves independent website consent = %s when inherited computer consent changes', async enabled => {
  allowAll = { enabled, inherited: true, effective: true };
  rules = [siteRule('https://example.com')];
  await render();
  expect(allWebsitesSwitch().checked).toBe(true);
  expect(allWebsitesSwitch().disabled).toBe(true);
  expect(container.querySelector('.memmy-browser-use-policies-inherited')?.textContent).toContain('Enabled through computer control.');
  expect((container.querySelector('select') as HTMLSelectElement).disabled).toBe(true);
  await act(async () => permissionChanged!({ enabled, inherited: false, effective: enabled }));
  expect(allWebsitesSwitch().checked).toBe(enabled);
  expect(allWebsitesSwitch().disabled).toBe(false);
  expect((container.querySelector('select') as HTMLSelectElement).disabled).toBe(enabled);
  expect(bridge.setBrowserAllowAll).not.toHaveBeenCalled();
});

it('keeps a permission event newer than a delayed initial read and refreshes on focus', async () => {
  let finishInitialRead!: (state: BrowserAllowAllState) => void;
  bridge.getBrowserAllowAll.mockReturnValueOnce(new Promise<BrowserAllowAllState>(resolve => { finishInitialRead = resolve; }));
  await render();
  expect(allWebsitesSwitch().disabled).toBe(true);
  await act(async () => permissionChanged!({ enabled: true, inherited: false, effective: true }));
  await act(async () => finishInitialRead({ enabled: false, inherited: false, effective: false }));
  expect(allWebsitesSwitch().checked).toBe(true);
  allowAll = { enabled: false, inherited: false, effective: false };
  await act(async () => window.dispatchEvent(new Event('focus')));
  expect(allWebsitesSwitch().checked).toBe(false);
  expect(bridge.getBrowserAllowAll).toHaveBeenCalledTimes(2);
});

it('keeps the saved global permission when a change cannot be persisted', async () => {
  bridge.setBrowserAllowAll.mockRejectedValueOnce(new Error('save unavailable'));
  await render();
  await act(async () => allWebsitesSwitch().click());
  expect(allWebsitesSwitch().checked).toBe(false);
  expect(allWebsitesSwitch().disabled).toBe(false);
  expect(container.querySelector('[role="alert"]')?.textContent).toBe('Could not load or save website permissions. Try again later.');
});
