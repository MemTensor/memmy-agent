// @vitest-environment happy-dom
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import type { BrowserUseSiteRule } from '@memmy/local-api-contracts';
import { I18nProvider } from '../../i18n/i18n-provider.js';
import { BrowserUseSitePolicies } from '../browser-use-site-policies.js';

(globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
let container: HTMLDivElement;
let root: Root;
let rules: BrowserUseSiteRule[];
let bridge: { getBrowserUseSitePolicies: ReturnType<typeof vi.fn>;
  upsertBrowserUseSitePolicy: ReturnType<typeof vi.fn>;
  removeBrowserUseSitePolicy: ReturnType<typeof vi.fn> };
beforeEach(() => {
  rules = [];
  bridge = {
    getBrowserUseSitePolicies: vi.fn(async () => rules),
    upsertBrowserUseSitePolicy: vi.fn(async (rule: BrowserUseSiteRule) => {
      rules = [...rules.filter(item => item.pattern !== rule.pattern), rule]; return rules;
    }),
    removeBrowserUseSitePolicy: vi.fn(async (pattern: string) => {
      rules = rules.filter(item => item.pattern !== pattern); return rules;
    }),
  };
  Object.defineProperty(window, 'memmy', { configurable: true, value: bridge });
  container = document.createElement('div'); document.body.append(container); root = createRoot(container);
});
afterEach(() => { act(() => root.unmount()); Reflect.deleteProperty(window, 'memmy'); container.remove(); });

it('lets the user persist a visible site matrix including controlled CDP reads', async () => {
  await act(async () => root.render(<I18nProvider language="en-US"><BrowserUseSitePolicies /></I18nProvider>));
  const input = container.querySelector('input[aria-label="Site pattern"]') as HTMLInputElement;
  Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')!.set!.call(input, 'https://*.example.com');
  input.dispatchEvent(new Event('input', { bubbles: true }));
  await act(async () => (container.querySelector('form') as HTMLFormElement).dispatchEvent(
    new Event('submit', { bubbles: true, cancelable: true })));
  expect(bridge.upsertBrowserUseSitePolicy).toHaveBeenCalledWith({ pattern: 'https://*.example.com',
    access: 'ask', downloads: 'ask', uploads: 'ask', fullCdp: 'block' });
  const uploads = container.querySelector('select[aria-label="https://*.example.com Uploads"]') as HTMLSelectElement;
  await act(async () => { uploads.value = 'block'; uploads.dispatchEvent(new Event('change', { bubbles: true })); });
  expect(bridge.upsertBrowserUseSitePolicy).toHaveBeenLastCalledWith(expect.objectContaining({ uploads: 'block' }));
  const debug = container.querySelector('select[aria-label="https://*.example.com Debug / CDP"]') as HTMLSelectElement;
  expect(debug.disabled).toBe(false);
  await act(async () => { debug.value = 'ask'; debug.dispatchEvent(new Event('change', { bubbles: true })); });
  expect(bridge.upsertBrowserUseSitePolicy).toHaveBeenLastCalledWith(expect.objectContaining({ fullCdp: 'ask' }));
  await act(async () => ([...container.querySelectorAll('button')].find(button => button.textContent === 'Remove') as HTMLButtonElement).click());
  expect(bridge.removeBrowserUseSitePolicy).toHaveBeenCalledWith('https://*.example.com');
});
