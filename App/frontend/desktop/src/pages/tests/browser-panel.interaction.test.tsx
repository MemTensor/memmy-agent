// @vitest-environment happy-dom
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { BrowserPanel, readBrowserPreferences, requestBrowserNewTab, takePendingBrowserNewTab,
  hasPendingBrowserOpen, MEMMY_BROWSER_OPEN_EVENT } from "../browser-panel.js";
import { I18nProvider } from '../../i18n/i18n-provider.js';

(globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

describe("browser sidebar settings", () => {
  let root: Root;
  let container: HTMLDivElement;
  function managePermissions(): HTMLButtonElement {
    return ([...container.querySelectorAll('.memmy-browser-settings-row')]
      .find(row => row.textContent?.includes('网站权限'))!.querySelector('button')) as HTMLButtonElement;
  }

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
      getBrowserDownloadSettings: vi.fn(async () => ({ directory: '/saved/downloads', askBeforeDownload: true })),
      chooseBrowserDownloadDirectory: vi.fn(async () => ({ directory: '/chosen/downloads', askBeforeDownload: true })),
      resetBrowserDownloadDirectory: vi.fn(async () => ({ directory: null, askBeforeDownload: true })),
      setBrowserAskBeforeDownload: vi.fn(async (enabled: boolean) => ({ directory: '/chosen/downloads', askBeforeDownload: enabled })),
      getBrowserUseSitePolicies: vi.fn(async () => [{ pattern: 'https://example.test', access: 'ask', downloads: 'ask', uploads: 'ask', fullCdp: 'block' }]),
      getBrowserAccessRules: vi.fn(async () => []),
      setBrowserAccessRule: vi.fn(async () => []),
      upsertBrowserUseSitePolicy: vi.fn(async rule => [rule]),
      removeBrowserUseSitePolicy: vi.fn(async () => []),
    } });
  });

  afterEach(() => {
    act(() => root.unmount());
    while (takePendingBrowserNewTab()) { /* Drain queued test requests. */ }
    Reflect.deleteProperty(window, "memmy");
    container.remove();
  });

  it('queues background tab requests with their owners without opening another chat or navigating its current tab', () => {
    const openings: unknown[] = [];
    const observe = (event: Event) => openings.push((event as CustomEvent).detail);
    window.addEventListener(MEMMY_BROWSER_OPEN_EVENT, observe);
    try {
      requestBrowserNewTab('https://example.test/a', { scopeKey: 'old-chat' });
      requestBrowserNewTab('https://example.test/b', { sourceGuestId: 27 });
      expect(hasPendingBrowserOpen()).toBe(true);
      expect(hasPendingBrowserOpen('old-chat')).toBe(true);
      expect(hasPendingBrowserOpen('new-chat')).toBe(false);
      expect(openings).toEqual([{ scopeKey: 'old-chat', newTab: true }, { sourceGuestId: 27, newTab: true }]);
      expect(takePendingBrowserNewTab()).toEqual({ url: 'https://example.test/a', scopeKey: 'old-chat' });
      expect(takePendingBrowserNewTab()).toEqual({ url: 'https://example.test/b', sourceGuestId: 27 });
      expect(takePendingBrowserNewTab()).toBeNull();
      expect(hasPendingBrowserOpen()).toBe(false);
    } finally { window.removeEventListener(MEMMY_BROWSER_OPEN_EVENT, observe); }
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
    expect((container.querySelector('[aria-label="网页地址"]') as HTMLInputElement).value).toBe('example.com');
    act(() => (container.querySelector('[aria-label="浏览器设置"]') as HTMLButtonElement).click());
    const fullUrl = [...container.querySelectorAll("label")].find(node => node.textContent?.includes("显示完整网址"))?.querySelector("input") as HTMLInputElement;
    act(() => fullUrl.click());
    expect(readBrowserPreferences().showFullUrl).toBe(true);
  });

  it('leaves a new tab address empty when the page is about:blank', async () => {
    await act(async () => root.render(<I18nProvider language="zh-CN"><BrowserPanel initialAddress="" /></I18nProvider>));
    const view = container.querySelector('webview') as HTMLElement & {
      getURL: () => string; getTitle: () => string; canGoBack: () => boolean; canGoForward: () => boolean;
    };
    view.getURL = () => 'about:blank';
    view.getTitle = () => 'about:blank';
    view.canGoBack = () => false;
    view.canGoForward = () => false;
    await act(async () => view.dispatchEvent(new Event('dom-ready')));
    const input = container.querySelector('[aria-label="网页地址"]') as HTMLInputElement;
    expect(input.value).toBe('');
    expect(input.placeholder).toBe('输入网址');
    expect(container.querySelector('.memmy-browser-status')).toBeNull();
    await act(async () => input.focus());
    expect(input.value).toBe('');
  });

  it('keeps website rules and download preferences in Memmy browser settings without restoring removed managers', async () => {
    await act(async () => root.render(<I18nProvider language="zh-CN"><BrowserPanel /></I18nProvider>));
    expect(container.querySelector('[aria-label="下载记录"]')).toBeNull();
    await act(async () => (container.querySelector('[aria-label="浏览器设置"]') as HTMLButtonElement).click());
    expect(container.textContent).toContain('网页 URL 和链接打开位置');
    expect(container.textContent).toContain('本地 URL 打开位置');
    expect(container.textContent).toContain('显示完整网址');
    expect(container.textContent).toContain('清除浏览数据');
    expect(container.textContent).toContain('浏览历史');
    for (const label of ['网站权限', '下载位置', '每次下载前询问保存位置']) {
      expect(container.textContent).toContain(label);
    }
    expect(container.querySelectorAll('.memmy-browser-use-policies--embedded')).toHaveLength(0);
    expect(document.body.querySelector('[role="dialog"]')).toBeNull();
    expect(container.textContent).not.toContain('CDP');
    expect(window.memmy?.getBrowserUseSitePolicies).not.toHaveBeenCalled();
    await act(async () => managePermissions().click());
    expect(document.body.querySelector('[role="dialog"]')).not.toBeNull();
    expect(document.body.querySelectorAll('.memmy-browser-use-policies--embedded')).toHaveLength(1);
    for (const label of ['下载记录', '扩展管理', '密码管理器', '联系人信息']) {
      expect(container.textContent).not.toContain(label);
    }
  });

  it('loads browser preferences when settings open and sends changes through the existing desktop IPC', async () => {
    await act(async () => root.render(<I18nProvider language="zh-CN"><BrowserPanel /></I18nProvider>));
    expect(window.memmy?.getBrowserDownloadSettings).not.toHaveBeenCalled();
    expect(window.memmy?.getBrowserUseSitePolicies).not.toHaveBeenCalled();
    await act(async () => (container.querySelector('[aria-label="浏览器设置"]') as HTMLButtonElement).click());
    expect(window.memmy?.getBrowserDownloadSettings).toHaveBeenCalledOnce();
    expect(window.memmy?.getBrowserUseSitePolicies).not.toHaveBeenCalled();
    expect(container.textContent).toContain('/saved/downloads');
    const change = [...container.querySelectorAll('button')].find(node => node.textContent === '更改…') as HTMLButtonElement;
    await act(async () => change.click());
    expect(window.memmy?.chooseBrowserDownloadDirectory).toHaveBeenCalledOnce();
    expect(container.textContent).toContain('/chosen/downloads');
    const ask = container.querySelector('[aria-label="每次下载前询问保存位置"]') as HTMLInputElement;
    expect(ask.checked).toBe(true);
    await act(async () => ask.click());
    expect(window.memmy?.setBrowserAskBeforeDownload).toHaveBeenCalledWith(false);
    expect(ask.checked).toBe(false);
    await act(async () => managePermissions().click());
    expect(window.memmy?.getBrowserUseSitePolicies).toHaveBeenCalledOnce();
    expect(window.memmy?.getBrowserAccessRules).toHaveBeenCalledOnce();
    const browsing = document.body.querySelector('[aria-label="https://example.test 访问网页"]') as HTMLSelectElement;
    await act(async () => {
      browsing.value = 'block'; browsing.dispatchEvent(new Event('change', { bubbles: true }));
    });
    expect(window.memmy?.upsertBrowserUseSitePolicy).toHaveBeenCalledWith({
      pattern: 'https://example.test', access: 'block', downloads: 'ask', uploads: 'ask', fullCdp: 'block',
    });
    expect(browsing.value).toBe('block');
  });

  it('keeps publishing the ready tab and navigation while the active tab changes', async () => {
    const onTabReady = vi.fn();
    const onNavigation = vi.fn();
    const selectEmbeddedBrowserTab = vi.fn();
    Object.assign(window.memmy!, { selectEmbeddedBrowserTab });
    await act(async () => root.render(<I18nProvider language="zh-CN"><BrowserPanel active={false}
      onTabReady={onTabReady} onNavigation={onNavigation} /></I18nProvider>));
    const view = container.querySelector('webview') as HTMLElement & {
      getWebContentsId: () => number; getURL: () => string; getTitle: () => string;
      canGoBack: () => boolean; canGoForward: () => boolean;
    };
    let url = 'https://example.test/account';
    view.getWebContentsId = () => 27;
    view.getURL = () => url;
    view.getTitle = () => 'Account';
    view.canGoBack = () => false;
    view.canGoForward = () => false;
    await act(async () => view.dispatchEvent(new Event('dom-ready')));
    expect(onTabReady).toHaveBeenCalledWith(27);
    expect(onNavigation).toHaveBeenCalledWith(url, 'Account');
    expect(selectEmbeddedBrowserTab).not.toHaveBeenCalled();
    await act(async () => root.render(<I18nProvider language="zh-CN"><BrowserPanel
      onTabReady={onTabReady} onNavigation={onNavigation} /></I18nProvider>));
    expect(selectEmbeddedBrowserTab).toHaveBeenCalledWith(27);
    url = 'https://example.test/home';
    await act(async () => view.dispatchEvent(new Event('did-navigate')));
    expect(onNavigation).toHaveBeenLastCalledWith(url, 'Account');
    expect(container.querySelector('webview')).toBe(view);
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

  it('removes a website permissions portal when its browser tab is hidden without recreating the live webview', async () => {
    await act(async () => root.render(<I18nProvider language="zh-CN"><BrowserPanel /></I18nProvider>));
    const tab = container.querySelector('webview');
    await act(async () => (container.querySelector('[aria-label="浏览器设置"]') as HTMLButtonElement).click());
    await act(async () => managePermissions().click());
    expect(document.body.querySelector('[role="dialog"]')).not.toBeNull();
    await act(async () => root.render(<I18nProvider language="zh-CN"><BrowserPanel hidden /></I18nProvider>));
    expect(document.body.querySelector('[role="dialog"]')).toBeNull();
    expect(container.querySelector('webview')).toBe(tab);
    await act(async () => root.render(<I18nProvider language="zh-CN"><BrowserPanel /></I18nProvider>));
    expect(managePermissions()).not.toBeNull();
    expect(document.body.querySelector('[role="dialog"]')).toBeNull();
    expect(container.querySelector('webview')).toBe(tab);
    await act(async () => managePermissions().click());
    await act(async () => (container.querySelector('[aria-label="浏览器设置"]') as HTMLButtonElement).click());
    expect(document.body.querySelector('[role="dialog"]')).toBeNull();
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

});
