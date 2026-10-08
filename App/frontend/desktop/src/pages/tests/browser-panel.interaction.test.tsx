// @vitest-environment happy-dom
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { BrowserPanel, readBrowserPreferences } from "../browser-panel.js";
import { I18nProvider } from '../../i18n/i18n-provider.js';

(globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

describe("browser sidebar settings", () => {
  let root: Root;
  let container: HTMLDivElement;

  beforeEach(() => {
    const values = new Map<string, string>();
    Object.defineProperty(window, "localStorage", { configurable: true, value: {
      getItem: (key: string) => values.get(key) ?? null,
      setItem: (key: string, value: string) => values.set(key, value),
      removeItem: (key: string) => values.delete(key),
      clear: () => values.clear(),
    } });
    container = document.createElement("div");
    document.body.append(container);
    root = createRoot(container);
    Object.defineProperty(window, "memmy", { configurable: true, value: {
      clearBrowserData: vi.fn(async () => undefined),
      markEmbeddedBrowserUserNavigation: vi.fn(async () => undefined),
      getBrowserHistory: vi.fn(async () => []),
      importLegacyBrowserHistory: vi.fn(async () => true),
      removeBrowserHistory: vi.fn(async () => true),
      removeSelectedBrowserHistory: vi.fn(async (urls: string[]) => urls.length),
      onBrowserSidebarSurface: vi.fn(() => () => undefined),
      getBrowserSidebarSurface: vi.fn(async () => null),
      sendBrowserSidebarAction: vi.fn(async () => true),
      getBrowserDownloads: vi.fn(async () => [{ id: 'download-1', name: 'report.txt',
        relativePath: 'download-1/report.txt', url: 'https://example.com/report.txt', downloadedAt: 1 }]),
      controlBrowserDownload: vi.fn(async () => true),
      onBrowserDownloadsUpdate: vi.fn(() => () => undefined),
      revealBrowserDownload: vi.fn(async () => true),
      removeBrowserDownloadRecord: vi.fn(async () => true),
    } });
  });

  afterEach(() => {
    act(() => root.unmount());
    Reflect.deleteProperty(window, "memmy");
    container.remove();
  });

  it("opens a typed URL in the live webview without invoking Computer Use", async () => {
    await act(async () => root.render(<I18nProvider language="zh-CN"><BrowserPanel /></I18nProvider>));
    const view = container.querySelector('webview') as HTMLElement & {
      loadURL: ReturnType<typeof vi.fn>; getURL: () => string; getTitle: () => string;
      canGoBack: () => boolean; canGoForward: () => boolean;
    };
    let url = 'about:blank';
    view.loadURL = vi.fn(async (target: string) => { url = target; view.dispatchEvent(new Event('did-navigate')); });
    view.getURL = () => url;
    view.getTitle = () => 'Example';
    view.canGoBack = () => false;
    view.canGoForward = () => false;
    await act(async () => view.dispatchEvent(new Event('dom-ready')));
    const input = container.querySelector('[aria-label="网页地址"]') as HTMLInputElement;
    act(() => {
      Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')!.set!.call(input, 'example.com');
      input.dispatchEvent(new Event('input', { bubbles: true }));
    });
    await act(async () => input.closest('form')!.dispatchEvent(new Event('submit', { bubbles: true, cancelable: true })));
    expect(view.getAttribute('partition')).toBe('persist:memmy-browser');
    expect(view.loadURL).toHaveBeenCalledWith('https://example.com/');
    expect(window.memmy?.sendBrowserSidebarAction).not.toHaveBeenCalled();
    expect(container.querySelector('.memmy-agent-browser-surface')).toBeNull();
    act(() => (container.querySelector('[aria-label="浏览器设置"]') as HTMLButtonElement).click());
    const fullUrl = [...container.querySelectorAll("label")].find(node => node.textContent?.includes("显示完整网址"))?.querySelector("input") as HTMLInputElement;
    act(() => fullUrl.click());
    expect(readBrowserPreferences().showFullUrl).toBe(true);
  });

  it('opens saved password and contact management, then fills only the ready selected webview', async () => {
    Object.assign(window.memmy!, { getBrowserAutofill: vi.fn(async () => ({ available: true,
      credentials: [{ id: 'sample-id', origin: 'https://example.test', username: 'sample-user' }],
      contactSaved: true })),
      fillBrowserWebviewCredential: vi.fn(async () => 2), fillBrowserWebviewContact: vi.fn(async () => 2),
      selectEmbeddedBrowserTab: vi.fn() });
    await act(async () => root.render(<I18nProvider language="zh-CN"><BrowserPanel
      initialAddress="https://example.test/account" /></I18nProvider>));
    const settings = container.querySelector('[aria-label="浏览器设置"]') as HTMLButtonElement;
    act(() => settings.click());
    const manage = (label: string) => {
      const row = [...container.querySelectorAll('.memmy-browser-settings-row')]
        .find(item => item.querySelector('span')?.textContent?.trim() === label);
      return row?.querySelector('button') as HTMLButtonElement;
    };
    await act(async () => manage('密码管理器').click());
    expect(window.memmy?.getBrowserAutofill).toHaveBeenCalledOnce();
    expect(container.textContent).toContain('sample-user');
    expect(container.textContent).not.toContain('填入当前网页');
    const view = container.querySelector('webview') as HTMLElement & {
      getWebContentsId: () => number; getURL: () => string; getTitle: () => string;
      canGoBack: () => boolean; canGoForward: () => boolean;
    };
    view.getWebContentsId = () => 27;
    view.getURL = () => 'https://example.test/account';
    view.getTitle = () => 'Account';
    view.canGoBack = () => false;
    view.canGoForward = () => false;
    await act(async () => view.dispatchEvent(new Event('dom-ready')));
    const fillPassword = [...container.querySelectorAll('button')]
      .find(item => item.textContent?.trim() === '填入当前网页') as HTMLButtonElement;
    await act(async () => fillPassword.click());
    expect(window.memmy?.fillBrowserWebviewCredential).toHaveBeenCalledWith(27, 'sample-id');
    act(() => settings.click());
    await act(async () => manage('联系人信息').click());
    expect(container.textContent).toContain('联系人信息已加密保存');
    const fillContact = [...container.querySelectorAll('button')]
      .find(item => item.textContent?.trim() === '填入当前网页') as HTMLButtonElement;
    await act(async () => fillContact.click());
    expect(window.memmy?.fillBrowserWebviewContact).toHaveBeenCalledWith(27);
  });

  it('keeps the same live webview while its sidebar is hidden and shown again', async () => {
    await act(async () => root.render(<I18nProvider language="zh-CN"><BrowserPanel /></I18nProvider>));
    const tab = container.querySelector('webview');
    expect(tab).not.toBeNull();
    await act(async () => root.render(<I18nProvider language="zh-CN"><BrowserPanel hidden /></I18nProvider>));
    expect(container.querySelector('webview')).toBe(tab);
    expect(container.querySelector('.memmy-browser-panel')?.getAttribute('aria-hidden')).toBe('true');
    await act(async () => root.render(<I18nProvider language="zh-CN"><BrowserPanel /></I18nProvider>));
    expect(container.querySelector('webview')).toBe(tab);
  });

  it("calls the Electron partition clearing service before removing visible history", async () => {
    act(() => root.render(<I18nProvider language="zh-CN"><BrowserPanel /></I18nProvider>));
    act(() => (container.querySelector('[aria-label="浏览器设置"]') as HTMLButtonElement).click());
    const clear = [...container.querySelectorAll("button")].find(node => node.textContent?.includes("清除浏览数据")) as HTMLButtonElement;
    act(() => clear.click());
    const confirm = [...container.querySelectorAll('button')].find(node => node.textContent?.includes('清除所选数据')) as HTMLButtonElement;
    await act(async () => confirm.click());
    expect(window.memmy?.clearBrowserData).toHaveBeenCalledWith([
      'cookies', 'siteData', 'cache', 'downloadHistory', 'browsingHistory',
    ]);
  });

  it('shows and removes the same in-app history exposed by the desktop host', async () => {
    vi.mocked(window.memmy!.getBrowserHistory!).mockResolvedValueOnce([
      { url: 'https://example.com/', title: 'Example', visitedAt: 1 },
    ]);
    await act(async () => root.render(<I18nProvider language="zh-CN"><BrowserPanel /></I18nProvider>));
    await act(async () => (container.querySelector('[aria-label="浏览历史"]') as HTMLButtonElement).click());
    expect(window.memmy?.getBrowserHistory).toHaveBeenCalledOnce();
    expect(container.textContent).toContain('https://example.com/');
    const remove = container.querySelector('[aria-label="删除 Example"]') as HTMLButtonElement;
    await act(async () => remove.click());
    expect(window.memmy?.removeBrowserHistory).toHaveBeenCalledWith('https://example.com/');
    expect(container.textContent).not.toContain('https://example.com/');
  });

  it('removes one selected visit when the same page was visited twice', async () => {
    const firstId = '11111111-1111-4111-8111-111111111111';
    const secondId = '22222222-2222-4222-8222-222222222222';
    vi.mocked(window.memmy!.getBrowserHistory!).mockResolvedValueOnce([
      { id: secondId, url: 'https://example.com/', title: 'Second visit', visitedAt: 2, visitSource: 'agent' },
      { id: firstId, url: 'https://example.com/', title: 'First visit', visitedAt: 1, visitSource: 'other' },
    ]);
    await act(async () => root.render(<I18nProvider language="zh-CN"><BrowserPanel /></I18nProvider>));
    await act(async () => (container.querySelector('[aria-label="浏览历史"]') as HTMLButtonElement).click());
    expect(container.querySelectorAll('.memmy-browser-history-entry')).toHaveLength(2);
    await act(async () => (container.querySelector('[aria-label="删除 Second visit"]') as HTMLButtonElement).click());
    expect(window.memmy?.removeBrowserHistory).toHaveBeenCalledWith(secondId);
    expect(container.textContent).toContain('First visit');
    expect(container.textContent).not.toContain('Second visit');
  });

  it('imports old sidebar history before reading the host history and removes the old key', async () => {
    const old = [{ url: 'https://legacy.example/', title: 'Legacy', visitedAt: 100 }];
    window.localStorage.setItem('memmy.browser.history.v1', JSON.stringify(old));
    vi.mocked(window.memmy!.getBrowserHistory!).mockResolvedValueOnce(old);
    await act(async () => root.render(<I18nProvider language="zh-CN"><BrowserPanel /></I18nProvider>));
    expect(window.memmy?.importLegacyBrowserHistory).toHaveBeenCalledWith(old);
    expect(window.localStorage.getItem('memmy.browser.history.v1')).toBeNull();
    await act(async () => (container.querySelector('[aria-label="浏览历史"]') as HTMLButtonElement).click());
    expect(vi.mocked(window.memmy!.importLegacyBrowserHistory!).mock.invocationCallOrder[0]).toBeLessThan(
      vi.mocked(window.memmy!.getBrowserHistory!).mock.invocationCallOrder[0]);
    expect(container.textContent).toContain('https://legacy.example/');
  });

  it('clears old renderer history after host data clearing succeeds', async () => {
    window.localStorage.setItem('memmy.browser.history.v1', JSON.stringify([
      { url: 'https://legacy.example/', title: 'Legacy', visitedAt: 100 },
    ]));
    vi.mocked(window.memmy!.importLegacyBrowserHistory!).mockResolvedValue(false);
    await act(async () => root.render(<I18nProvider language="zh-CN"><BrowserPanel /></I18nProvider>));
    expect(window.localStorage.getItem('memmy.browser.history.v1')).not.toBeNull();
    act(() => (container.querySelector('[aria-label="浏览器设置"]') as HTMLButtonElement).click());
    const clear = [...container.querySelectorAll('button')].find(node => node.textContent?.includes('清除浏览数据')) as HTMLButtonElement;
    act(() => clear.click());
    const confirm = [...container.querySelectorAll('button')].find(node => node.textContent?.includes('清除所选数据')) as HTMLButtonElement;
    await act(async () => confirm.click());
    expect(window.memmy?.clearBrowserData).toHaveBeenCalledOnce();
    expect(window.localStorage.getItem('memmy.browser.history.v1')).toBeNull();
  });

  it('shows saved downloads and reveals the selected file', async () => {
    await act(async () => root.render(<I18nProvider language="zh-CN"><BrowserPanel /></I18nProvider>));
    await act(async () => (container.querySelector('[aria-label="下载记录"]') as HTMLButtonElement).click());
    expect(container.textContent).toContain('report.txt');
    const file = [...container.querySelectorAll('button')].find(node => node.textContent?.includes('report.txt')) as HTMLButtonElement;
    await act(async () => file.click());
    expect(window.memmy?.revealBrowserDownload).toHaveBeenCalledWith('download-1');
  });

  it('opens the embedded extension manager and delegates install to the native host', async () => {
    Object.assign(window.memmy!, {
      getBrowserWebviewExtensions: vi.fn(async () => [{ id: 'a'.repeat(32), name: 'Example', version: '1.0',
        directory: '/selected/example', loaded: true, needsReapproval: true }]),
      installBrowserWebviewExtension: vi.fn(async () => ({ status: 'cancelled' as const })),
      reapproveBrowserWebviewExtension: vi.fn(async () => ({ status: 'cancelled' as const })),
      removeBrowserWebviewExtension: vi.fn(async () => true),
    });
    await act(async () => root.render(<I18nProvider language="zh-CN"><BrowserPanel /></I18nProvider>));
    act(() => (container.querySelector('[aria-label="浏览器设置"]') as HTMLButtonElement).click());
    const row = [...container.querySelectorAll('.memmy-browser-settings-row')]
      .find(item => item.textContent?.includes('扩展管理')) as HTMLElement;
    await act(async () => (row.querySelector('button') as HTMLButtonElement).click());
    expect(window.memmy?.getBrowserWebviewExtensions).toHaveBeenCalled();
    expect(container.textContent).toContain('目录或批准的副本已更改');
    await act(async () => ([...container.querySelectorAll('button')]
      .find(item => item.textContent === '安装未打包扩展') as HTMLButtonElement).click());
    expect(window.memmy?.installBrowserWebviewExtension).toHaveBeenCalledWith();
  });

  it('shows live progress and pause, resume, cancel controls, then keeps a deleted-file record', async () => {
    let publish: (entries: MemmyBrowserDownloadEntry[]) => void = () => undefined;
    vi.mocked(window.memmy!.onBrowserDownloadsUpdate!).mockImplementation(callback => {
      publish = callback;
      return () => undefined;
    });
    await act(async () => root.render(<I18nProvider language="zh-CN"><BrowserPanel /></I18nProvider>));
    await act(async () => (container.querySelector('[aria-label="下载记录"]') as HTMLButtonElement).click());
    const base = { id: 'live-1', name: 'large.zip', relativePath: '', url: 'https://example.com/large.zip', downloadedAt: 2 };
    act(() => publish([{ ...base, status: 'in_progress', receivedBytes: 40, totalBytes: 100,
      canPause: true, canCancel: true }]));
    expect((container.querySelector('progress') as HTMLProgressElement).value).toBe(40);
    await act(async () => (container.querySelector('[aria-label="暂停下载 large.zip"]') as HTMLButtonElement).click());
    expect(window.memmy?.controlBrowserDownload).toHaveBeenCalledWith('live-1', 'pause');
    act(() => publish([{ ...base, status: 'paused', receivedBytes: 40, totalBytes: 100,
      canResume: true, canCancel: true }]));
    await act(async () => (container.querySelector('[aria-label="继续下载 large.zip"]') as HTMLButtonElement).click());
    expect(window.memmy?.controlBrowserDownload).toHaveBeenCalledWith('live-1', 'resume');
    await act(async () => (container.querySelector('[aria-label="取消下载 large.zip"]') as HTMLButtonElement).click());
    expect(window.memmy?.controlBrowserDownload).toHaveBeenCalledWith('live-1', 'cancel');
    act(() => publish([{ ...base, status: 'complete', fileExists: false }]));
    expect(container.textContent).toContain('文件已删除');
    expect(container.querySelector('[aria-label="删除 large.zip 的下载记录"]')).not.toBeNull();
    expect(container.querySelector('[title="https://example.com/large.zip"]')?.tagName).not.toBe('BUTTON');
  });

  it('filters history by Agent or Other and removes selected URLs from the host', async () => {
    vi.mocked(window.memmy!.getBrowserHistory!).mockResolvedValueOnce([
      { url: 'https://agent.example/', title: 'Agent page', visitedAt: 2, visitSource: 'agent' },
      { url: 'https://user.example/', title: 'User page', visitedAt: 1, visitSource: 'other' },
    ]);
    await act(async () => root.render(<I18nProvider language="zh-CN"><BrowserPanel /></I18nProvider>));
    await act(async () => (container.querySelector('[aria-label="浏览历史"]') as HTMLButtonElement).click());
    const source = container.querySelector('[aria-label="历史来源"]') as HTMLSelectElement;
    await act(async () => { source.value = 'agent'; source.dispatchEvent(new Event('change', { bubbles: true })); });
    expect(container.textContent).toContain('https://agent.example/');
    expect(container.textContent).not.toContain('https://user.example/');
    const selected = container.querySelector('[aria-label="选择 Agent page"]') as HTMLInputElement;
    await act(async () => selected.click());
    const remove = [...container.querySelectorAll('button')].find(node => node.textContent?.includes('删除所选记录')) as HTMLButtonElement;
    await act(async () => remove.click());
    expect(window.memmy?.removeSelectedBrowserHistory).toHaveBeenCalledWith(['https://agent.example/']);
    expect(container.textContent).not.toContain('https://agent.example/');
  });

  it('clears only cookies when that is the selected data type', async () => {
    window.localStorage.setItem('memmy.browser.last-url.v1', 'https://example.com/');
    await act(async () => root.render(<I18nProvider language="zh-CN"><BrowserPanel /></I18nProvider>));
    act(() => (container.querySelector('[aria-label="浏览器设置"]') as HTMLButtonElement).click());
    act(() => ([...container.querySelectorAll('button')].find(node => node.textContent?.includes('清除浏览数据')) as HTMLButtonElement).click());
    for (const label of [...container.querySelectorAll('label')]) {
      const checkbox = label.querySelector('input[type="checkbox"]') as HTMLInputElement | null;
      if (checkbox && !label.textContent?.includes('Cookie')) await act(async () => checkbox.click());
    }
    await act(async () => ([...container.querySelectorAll('button')].find(node => node.textContent?.includes('清除所选数据')) as HTMLButtonElement).click());
    expect(window.memmy?.clearBrowserData).toHaveBeenCalledWith(['cookies']);
    expect(window.localStorage.getItem('memmy.browser.last-url.v1')).toBe('https://example.com/');
  });

  it('removes a download record through the host without requesting file deletion', async () => {
    await act(async () => root.render(<I18nProvider language="zh-CN"><BrowserPanel /></I18nProvider>));
    await act(async () => (container.querySelector('[aria-label="下载记录"]') as HTMLButtonElement).click());
    await act(async () => (container.querySelector('[aria-label="删除 report.txt 的下载记录"]') as HTMLButtonElement).click());
    expect(window.memmy?.removeBrowserDownloadRecord).toHaveBeenCalledWith('download-1');
    expect(container.textContent).not.toContain('report.txt');
    expect(window.memmy?.clearBrowserData).not.toHaveBeenCalled();
  });

});
