// @vitest-environment happy-dom
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { I18nProvider } from '../../i18n/i18n-provider.js';
import { BrowserAutofill } from '../browser-autofill.js';

(globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

type Summary = { available: boolean; credentials: Array<{ id: string; origin: string; username: string }>; contactSaved: boolean };
let container: HTMLDivElement;
let root: Root;
let summary: Summary;
let bridge: {
  getBrowserAutofill: ReturnType<typeof vi.fn>;
  saveBrowserCredential: ReturnType<typeof vi.fn>;
  deleteBrowserCredential: ReturnType<typeof vi.fn>;
  fillBrowserCredential: ReturnType<typeof vi.fn>;
  fillBrowserWebviewCredential: ReturnType<typeof vi.fn>;
  saveBrowserContact: ReturnType<typeof vi.fn>;
  deleteBrowserContact: ReturnType<typeof vi.fn>;
  fillBrowserContact: ReturnType<typeof vi.fn>;
  fillBrowserWebviewContact: ReturnType<typeof vi.fn>;
};

function button(label: string): HTMLButtonElement {
  const found = [...container.querySelectorAll('button')].find(item => item.textContent?.trim() === label);
  if (!found) throw new Error(`Missing button: ${label}`);
  return found;
}

function input(label: string): HTMLInputElement {
  const found = [...container.querySelectorAll('label')].find(item => item.textContent?.trim() === label)?.querySelector('input');
  if (!found) throw new Error(`Missing input: ${label}`);
  return found;
}

function enter(field: HTMLInputElement, value: string): void {
  Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')!.set!.call(field, value);
  field.dispatchEvent(new Event('input', { bubbles: true }));
}

beforeEach(() => {
  summary = { available: true, credentials: [
    { id: 'same-site', origin: 'https://example.test', username: 'sample-user' },
    { id: 'other-site', origin: 'https://other.test', username: 'other-user' },
  ], contactSaved: true };
  bridge = {
    getBrowserAutofill: vi.fn(async () => summary),
    saveBrowserCredential: vi.fn(async (origin: string, username: string) => {
      summary = { ...summary, credentials: summary.credentials.map(item =>
        item.origin === origin && item.username === username ? { ...item, id: 'updated-site' } : item) };
      return summary;
    }),
    deleteBrowserCredential: vi.fn(async (id: string) => {
      summary = { ...summary, credentials: summary.credentials.filter(item => item.id !== id) };
      return summary;
    }),
    fillBrowserCredential: vi.fn(async () => true),
    fillBrowserWebviewCredential: vi.fn(async () => 2),
    saveBrowserContact: vi.fn(async () => { summary = { ...summary, contactSaved: true }; return summary; }),
    deleteBrowserContact: vi.fn(async () => { summary = { ...summary, contactSaved: false }; return summary; }),
    fillBrowserContact: vi.fn(async () => true),
    fillBrowserWebviewContact: vi.fn(async () => 2),
  };
  Object.defineProperty(window, 'memmy', { configurable: true, value: bridge });
  container = document.createElement('div');
  document.body.append(container);
  root = createRoot(container);
});

afterEach(() => {
  act(() => root.unmount());
  Reflect.deleteProperty(window, 'memmy');
  container.remove();
});

describe('browser autofill management', () => {
  it('fills the selected built-in webview through tab ID without using Agent surface IPC', async () => {
    await act(async () => root.render(<I18nProvider language="en-US"><BrowserAutofill
      section="passwords" origin="https://example.test/account" sessionKey={null} tabId={27} /></I18nProvider>));
    await act(async () => button('Fill this page').click());
    expect(bridge.fillBrowserWebviewCredential).toHaveBeenCalledWith(27, 'same-site');
    expect(bridge.fillBrowserCredential).not.toHaveBeenCalled();
    await act(async () => root.render(<I18nProvider language="en-US"><BrowserAutofill
      section="contact" origin="https://example.test/account" sessionKey={null} tabId={27} /></I18nProvider>));
    await act(async () => button('Fill this page').click());
    expect(bridge.fillBrowserWebviewContact).toHaveBeenCalledWith(27);
    expect(bridge.fillBrowserContact).not.toHaveBeenCalled();
  });

  it('shows metadata only, fills the current site, and replaces a password without reading its old value', async () => {
    await act(async () => root.render(<I18nProvider language="en-US"><BrowserAutofill
      section="passwords" origin="https://example.test/account" sessionKey="session-1" /></I18nProvider>));
    expect(bridge.getBrowserAutofill).toHaveBeenCalledOnce();
    expect(container.textContent).toContain('sample-user');
    expect(container.textContent).toContain('other-user');
    expect(container.querySelectorAll('button').length).toBeGreaterThan(0);
    expect([...container.querySelectorAll('button')].filter(item => item.textContent?.trim() === 'Fill this page')).toHaveLength(1);
    expect(input('Password').value).toBe('');

    await act(async () => button('Fill this page').click());
    expect(bridge.fillBrowserCredential).toHaveBeenCalledWith('session-1', 'same-site');
    await act(async () => button('Edit').click());
    expect(input('Site').value).toBe('https://example.test');
    expect(input('Username').value).toBe('sample-user');
    expect(input('Site').readOnly).toBe(true);
    expect(input('Password').value).toBe('');
    act(() => enter(input('Password'), 'new-test-secret'));
    await act(async () => input('Password').closest('form')!.dispatchEvent(new Event('submit', { bubbles: true, cancelable: true })));
    expect(bridge.saveBrowserCredential).toHaveBeenCalledWith('https://example.test', 'sample-user', 'new-test-secret');
    expect(input('Password').value).toBe('');
    expect(container.textContent).not.toContain('new-test-secret');
  });

  it('deletes a saved password through the vault and disables writes without OS encryption', async () => {
    await act(async () => root.render(<I18nProvider language="en-US"><BrowserAutofill
      section="passwords" origin="https://example.test" sessionKey={null} /></I18nProvider>));
    expect([...container.querySelectorAll('button')].some(item => item.textContent?.trim() === 'Fill this page')).toBe(false);
    const row = [...container.querySelectorAll('.memmy-browser-settings-row')]
      .find(item => item.textContent?.includes('other-user'))!;
    await act(async () => (row.querySelectorAll('button')[1] as HTMLButtonElement).click());
    expect(bridge.deleteBrowserCredential).toHaveBeenCalledWith('other-site');
    expect(container.textContent).not.toContain('other-user');
    summary = { ...summary, available: false };
    // A fresh mount checks the unavailable state without attempting a write.
    act(() => root.unmount());
    root = createRoot(container);
    await act(async () => root.render(<I18nProvider language="en-US"><BrowserAutofill
      section="passwords" origin="https://example.test" sessionKey={null} /></I18nProvider>));
    expect(button('Save password').disabled).toBe(true);
    expect(container.textContent).toContain('OS encryption is unavailable');
  });

  it('keeps saved contact fields private and uses the current site for fill, replace, and delete', async () => {
    await act(async () => root.render(<I18nProvider language="en-US"><BrowserAutofill
      section="contact" origin="https://example.test/form" sessionKey="session-2" /></I18nProvider>));
    expect(input('Name').value).toBe('');
    expect(input('Email').value).toBe('');
    expect(container.textContent).toContain('Re-enter to replace it');
    await act(async () => button('Fill this page').click());
    expect(bridge.fillBrowserContact).toHaveBeenCalledWith('session-2', 'https://example.test');
    act(() => {
      enter(input('Name'), 'Test Person');
      enter(input('Email'), 'test@example.test');
    });
    await act(async () => input('Name').closest('form')!.dispatchEvent(new Event('submit', { bubbles: true, cancelable: true })));
    expect(bridge.saveBrowserContact).toHaveBeenCalledWith({
      name: 'Test Person', email: 'test@example.test', phone: '', address: '',
    });
    expect(input('Name').value).toBe('');
    await act(async () => button('Delete contact information').click());
    expect(bridge.deleteBrowserContact).toHaveBeenCalledOnce();
    expect(container.textContent).toContain('No contact information saved');
  });
});
