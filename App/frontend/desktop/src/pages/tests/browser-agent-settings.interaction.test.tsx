// @vitest-environment happy-dom
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import type { BrowserUseSiteRule } from '@memmy/local-api-contracts';
import { I18nProvider } from '../../i18n/i18n-provider.js';
import { BrowserAgentSettings } from '../browser-agent-settings.js';

(globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
type DownloadSettings = { directory: string | null; approvedDirectories: string[]; askBeforeDownload: boolean };
let container: HTMLDivElement;
let root: Root;
let settings: DownloadSettings;
let rules: BrowserUseSiteRule[];
let bridge: Record<string, ReturnType<typeof vi.fn>>;
function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>(done => { resolve = done; });
  return { promise, resolve };
}
function button(text: string): HTMLButtonElement | undefined {
  return [...document.body.querySelectorAll('button')].find(item => item.textContent === text);
}
function saveLocationSwitch(): HTMLInputElement {
  return container.querySelector('input[role="switch"]') as HTMLInputElement;
}
async function render(language: 'en-US' | 'zh-CN' = 'en-US') {
  await act(async () => root.render(<I18nProvider language={language}><BrowserAgentSettings /></I18nProvider>));
}
beforeEach(() => {
  settings = { directory: '/saved/downloads', approvedDirectories: ['/saved/downloads'], askBeforeDownload: true };
  rules = [{ pattern: 'https://example.test', access: 'block', downloads: 'ask', uploads: 'block', fullCdp: 'allow' }];
  bridge = {
    getBrowserDownloadSettings: vi.fn(async () => settings),
    chooseBrowserDownloadDirectory: vi.fn(async () => { settings = { ...settings, directory: '/chosen/downloads' }; return settings; }),
    resetBrowserDownloadDirectory: vi.fn(async () => { settings = { ...settings, directory: null }; return settings; }),
    setBrowserAskBeforeDownload: vi.fn(async (enabled: boolean) => { settings = { ...settings, askBeforeDownload: enabled }; return settings; }),
    getBrowserUseSitePolicies: vi.fn(async () => rules),
    getBrowserAccessRules: vi.fn(async () => [{ origin: 'https://remembered.test', decision: 'allow' }]),
    setBrowserAccessRule: vi.fn(async () => []),
    upsertBrowserUseSitePolicy: vi.fn(async (rule: BrowserUseSiteRule) => { rules = [...rules.filter(item => item.pattern !== rule.pattern), rule]; return rules; }),
    removeBrowserUseSitePolicy: vi.fn(async (pattern: string) => { rules = rules.filter(item => item.pattern !== pattern); return rules; }),
  };
  Object.defineProperty(window, 'memmy', { configurable: true, value: bridge });
  container = document.createElement('div'); document.body.append(container); root = createRoot(container);
});
afterEach(() => { act(() => root.unmount()); Reflect.deleteProperty(window, 'memmy'); document.body.replaceChildren(); });

it('keeps a compact permissions row and existing download rows, and loads permissions only when managed', async () => {
  await render();
  expect(container.textContent).toContain('Website permissions');
  expect(container.textContent).toContain('/saved/downloads');
  expect(container.querySelectorAll('.memmy-browser-settings-row')).toHaveLength(2);
  expect(container.querySelectorAll('select')).toHaveLength(0);
  expect(container.textContent).not.toContain('CDP');
  expect(bridge.getBrowserUseSitePolicies).not.toHaveBeenCalled();
  expect(bridge.getBrowserAccessRules).not.toHaveBeenCalled();
  expect(saveLocationSwitch().checked).toBe(true);
  await act(async () => button('Change…')!.click());
  expect(container.textContent).toContain('/chosen/downloads');
  await act(async () => button('Reset to default')!.click());
  expect(container.textContent).toContain('Memmy data folder');
  await act(async () => saveLocationSwitch().click());
  expect(bridge.setBrowserAskBeforeDownload).toHaveBeenCalledWith(false);
  await act(async () => button('Manage')!.click());
  const dialog = document.body.querySelector('[role="dialog"]')!;
  expect(dialog.textContent).toContain('https://remembered.test');
  expect((dialog.querySelector('[aria-label="https://example.test Visit webpages"]') as HTMLSelectElement).value).toBe('block');
  expect((dialog.querySelector('details') as HTMLDetailsElement).open).toBe(false);
  expect(container.querySelector('[role="dialog"]')).toBeNull();
  await act(async () => (dialog.querySelector('[aria-label="Close"]') as HTMLButtonElement).click());
  expect(document.body.querySelector('[role="dialog"]')).toBeNull();
  expect(document.activeElement).toBe(button('Manage'));
});

it('shows loading failures without enabling writes or clearing existing personal data', async () => {
  bridge.getBrowserDownloadSettings.mockRejectedValueOnce(new Error('read failed'));
  bridge.getBrowserUseSitePolicies.mockRejectedValueOnce(new Error('rules failed'));
  await render();
  expect(button('Change…')!.disabled).toBe(true);
  expect(saveLocationSwitch().disabled).toBe(true);
  await act(async () => button('Manage')!.click());
  expect(document.body.textContent).toContain('Could not load the download location');
  expect(document.body.textContent).toContain('Could not load or save website permissions. Try again later.');
  expect(button('Add website')!.disabled).toBe(true);
  expect(document.body.textContent).toContain('https://remembered.test');
});

it('keeps saved download values when a mutation fails and clears the error after success', async () => {
  await render();
  bridge.chooseBrowserDownloadDirectory.mockRejectedValueOnce(new Error('change failed'));
  await act(async () => button('Change…')!.click());
  expect(container.textContent).toContain('/saved/downloads');
  expect(container.querySelector('[role="alert"]')?.textContent).toBe('Could not set the download location');
  bridge.setBrowserAskBeforeDownload.mockRejectedValueOnce(new Error('switch failed'));
  await act(async () => saveLocationSwitch().click());
  expect(saveLocationSwitch().checked).toBe(true);
  await act(async () => button('Change…')!.click());
  expect(container.textContent).toContain('/chosen/downloads');
  expect(container.querySelector('[role="alert"]')).toBeNull();
});

it('waits for download settings and serializes changes without a language refresh resetting them', async () => {
  const load = deferred<DownloadSettings>(); bridge.getBrowserDownloadSettings.mockReturnValueOnce(load.promise);
  await render();
  expect(button('Change…')!.disabled).toBe(true);
  await act(async () => load.resolve(settings));
  const change = deferred<DownloadSettings>(); bridge.chooseBrowserDownloadDirectory.mockReturnValueOnce(change.promise);
  await act(async () => { button('Change…')!.click(); button('Change…')!.click(); button('Reset to default')!.click(); saveLocationSwitch().click(); });
  expect(bridge.chooseBrowserDownloadDirectory).toHaveBeenCalledOnce();
  expect(bridge.resetBrowserDownloadDirectory).not.toHaveBeenCalled();
  expect(bridge.setBrowserAskBeforeDownload).not.toHaveBeenCalled();
  await render('zh-CN');
  expect(bridge.getBrowserDownloadSettings).toHaveBeenCalledOnce();
  expect(bridge.getBrowserUseSitePolicies).not.toHaveBeenCalled();
  await act(async () => change.resolve({ ...settings, directory: '/latest/downloads', askBeforeDownload: false }));
  expect(container.textContent).toContain('/latest/downloads');
  expect(saveLocationSwitch().checked).toBe(false);
});

it('closes using Escape and reloads remembered permissions when reopened', async () => {
  await render();
  await act(async () => button('Manage')!.click());
  await act(async () => document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true })));
  expect(document.body.querySelector('[role="dialog"]')).toBeNull();
  bridge.getBrowserAccessRules.mockResolvedValueOnce([]);
  await act(async () => button('Manage')!.click());
  expect(bridge.getBrowserAccessRules).toHaveBeenCalledTimes(2);
  expect(document.body.querySelector('[role="dialog"]')!.textContent).not.toContain('https://remembered.test');
});
