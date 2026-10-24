import { EventEmitter } from 'node:events';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { EMBEDDED_BROWSER_REQUEST, type EmbeddedBrowserRequest } from '@memmy/local-api-contracts';
import { EmbeddedBrowserDriver } from '../src/main/embedded-browser-driver.js';

const TARGET = 'https://example.test/form';
const drivers: EmbeddedBrowserDriver[] = [];

/** Model Electron navigation events separately from URL commits and loading. */
function harness() {
  let hostDestroyed = false;
  const guests = new Map<number, ReturnType<typeof createGuest>>();
  const host = { isDestroyed: () => hostDestroyed,
    webContents: Object.assign(new EventEmitter(), { send: vi.fn() }) };
  const driver = new EmbeddedBrowserDriver(() => host as any);
  drivers.push(driver);
  function createGuest(id: number, initialUrl = 'about:blank') {
    let url = initialUrl;
    let loading = false;
    let destroyed = false;
    const guest = Object.assign(new EventEmitter(), { id,
      isDestroyed: () => destroyed, isLoading: () => loading,
      getURL: () => url, getTitle: () => `Tab ${id}`,
      loadURL: vi.fn(),
      debugger: Object.assign(new EventEmitter(), { attach: vi.fn(), detach: vi.fn(), sendCommand: vi.fn() }),
      close: vi.fn(() => destroy()),
    });
    const destroy = () => {
      if (destroyed) return;
      destroyed = true;
      guest.emit('destroyed');
    };
    const start = (target = TARGET, sameDocument = false) => {
      if (!sameDocument) loading = true;
      guest.emit('did-start-navigation', { url: target, isMainFrame: true, isSameDocument: sameDocument });
    };
    const commit = (target = TARGET) => {
      url = target;
      guest.emit('did-navigate', {}, target);
    };
    const finish = () => {
      // did-finish-load and did-stop-loading are distinct Electron events.
      guest.emit('did-finish-load');
      stop();
    };
    const stop = () => { loading = false; guest.emit('did-stop-loading'); };
    const inPage = (target: string) => {
      start(target, true);
      url = target;
      guest.emit('did-navigate-in-page', {}, target, true);
    };
    const redirect = (target: string) => {
      guest.emit('did-redirect-navigation', { url: target, isMainFrame: true });
    };
    const fail = (code = -105, description = 'ERR_NAME_NOT_RESOLVED', target = url, provisional = false) => {
      guest.emit(provisional ? 'did-fail-provisional-load' : 'did-fail-load', {}, code, description, target, true);
    };
    const result = { guest, start, commit, finish, stop, inPage, redirect, fail, destroy };
    guests.set(id, result);
    driver.attach(guest as any, host as any);
    return result;
  }
  const user = createGuest(27, 'https://user.test/');
  driver.selectTab(27, host as any);
  let open: (() => void) | undefined;
  host.webContents.send.mockImplementation((channel: string, tabIdOrUrl: string | number) => {
    if (channel === 'memmy:browser:open-url') open?.();
    if (channel === 'memmy:browser:close-tab') guests.get(Number(tabIdOrUrl))?.destroy();
  });
  const request: EmbeddedBrowserRequest = { type: EMBEDDED_BROWSER_REQUEST,
    requestId: 'open-test', command: 'openTab', args: { url: TARGET, scopeKey: 'test-owner' } };
  const openTab = (isCurrent?: () => boolean) => {
    let settled = false;
    const outcome = driver.handle(request, undefined, undefined, isCurrent)
      .then(value => { settled = true; return { value, error: undefined }; },
        error => { settled = true; return { value: undefined, error: error as Error }; });
    return { outcome, settled: () => settled };
  };
  return { driver, host, user, createGuest, openTab,
    onOpen: (callback: () => void) => { open = callback; },
    destroyHost: () => { hostDestroyed = true; },
    tabs: () => driver.handle({ ...request, command: 'listTabs', args: {} }),
    closeMessages: () => host.webContents.send.mock.calls
      .filter(([channel]) => channel === 'memmy:browser:close-tab').map(([, id]) => id),
  };
}

beforeEach(() => { vi.useFakeTimers(); });
afterEach(() => {
  for (const driver of drivers.splice(0)) driver.dispose();
  vi.clearAllTimers();
  vi.useRealTimers();
});

it('opens once and waits for the new page to finish after its URL has committed', async () => {
  const h = harness();
  const page = h.createGuest(28);
  // Guests that already existed when the request started cannot satisfy it.
  const requested = h.createGuest.bind(null, 29);
  let next: ReturnType<typeof requested>;
  h.onOpen(() => { next = requested(); next.start(); next.commit(); });
  const opening = h.openTab();
  await vi.advanceTimersByTimeAsync(500);
  expect(next!.guest.isLoading()).toBe(true);
  expect(opening.settled()).toBe(false);
  next!.finish();
  await vi.advanceTimersByTimeAsync(100);
  expect(await opening.outcome).toEqual({ value: { tabId: 29, title: 'Tab 29', url: TARGET }, error: undefined });
  expect(h.host.webContents.send.mock.calls.filter(([channel]) => channel === 'memmy:browser:open-url'))
    .toEqual([['memmy:browser:open-url', TARGET, { scopeKey: 'test-owner' }]]);
  expect(next!.guest.loadURL).not.toHaveBeenCalled();
  expect(page.guest.loadURL).not.toHaveBeenCalled();
  expect(await h.tabs()).toMatchObject({ selectedTabId: 27, tabs: [{ tabId: 27 }, { tabId: 28 }, { tabId: 29 }] });
});

it('follows an HTTP redirect without waiting for the requested URL to become the committed URL', async () => {
  const h = harness();
  const landing = 'https://login.test/landing';
  let next: ReturnType<typeof h.createGuest>;
  h.onOpen(() => {
    next = h.createGuest(28);
    next.start();
    next.redirect(landing);
    next.commit(landing);
  });
  const opening = h.openTab();
  await vi.advanceTimersByTimeAsync(200);
  expect(opening.settled()).toBe(false);
  next!.finish();
  await vi.advanceTimersByTimeAsync(100);
  expect(await opening.outcome).toMatchObject({ value: { tabId: 28, url: landing }, error: undefined });
  expect(h.closeMessages()).toEqual([]);
});

it.each([false, true])('waits for a client redirect that starts before the first 100ms poll (initial finish: %s)', async initialFinish => {
  const h = harness();
  const landing = 'https://example.test/client-destination';
  let next: ReturnType<typeof h.createGuest>;
  h.onOpen(() => {
    // Simulate the renderer attaching the webview and emitting the entire first
    // navigation while the driver is asleep, before it can claim the guest.
    setTimeout(() => {
      next = h.createGuest(28);
      next.start();
      next.commit();
      if (initialFinish) next.finish();
      next.start(landing);
      next.commit(landing);
    }, 10);
  });
  const opening = h.openTab();
  await vi.advanceTimersByTimeAsync(100);
  expect(opening.settled()).toBe(false);
  next!.finish();
  await vi.advanceTimersByTimeAsync(100);
  expect(await opening.outcome).toMatchObject({ value: { tabId: 28, url: landing }, error: undefined });
  expect(next!.guest.loadURL).not.toHaveBeenCalled();
});

it.each([false, true])('retains the requested guest through a hash navigation (initial finish: %s)', async initialFinish => {
  const h = harness();
  const hashUrl = `${TARGET}#details`;
  let next: ReturnType<typeof h.createGuest>;
  h.onOpen(() => {
    setTimeout(() => {
      next = h.createGuest(28);
      next.start();
      next.commit();
      if (initialFinish) next.finish();
      next.inPage(hashUrl);
    }, 10);
  });
  const opening = h.openTab();
  await vi.advanceTimersByTimeAsync(100);
  if (!initialFinish) {
    expect(opening.settled()).toBe(false);
    next!.finish();
    await vi.advanceTimersByTimeAsync(100);
  }
  expect(await opening.outcome).toMatchObject({ value: { tabId: 28, url: hashUrl }, error: undefined });
});

it.each([false, true])('rejects a main-frame load failure even if the error page later finishes (provisional: %s)', async provisional => {
  const h = harness();
  let next: ReturnType<typeof h.createGuest>;
  h.onOpen(() => { next = h.createGuest(28); next.start(); next.commit(); });
  const opening = h.openTab();
  next!.fail(-105, 'ERR_NAME_NOT_RESOLVED', TARGET, provisional);
  next!.finish();
  await vi.advanceTimersByTimeAsync(100);
  expect((await opening.outcome).error?.message).toContain('ERR_NAME_NOT_RESOLVED (-105)');
  expect(h.closeMessages()).toEqual([28]);
  expect(h.user.guest.isDestroyed()).toBe(false);
});

it('treats ERR_ABORTED as a failure when loading stops without a successful replacement', async () => {
  const h = harness();
  let next: ReturnType<typeof h.createGuest>;
  h.onOpen(() => { next = h.createGuest(28); next.start(); next.commit(); });
  const opening = h.openTab();
  next!.fail(-3, 'ERR_ABORTED');
  await vi.advanceTimersByTimeAsync(100);
  expect(opening.settled()).toBe(false);
  next!.stop();
  await vi.advanceTimersByTimeAsync(100);
  expect((await opening.outcome).error?.message).toContain('ERR_ABORTED (-3)');
  expect(h.closeMessages()).toEqual([28]);
});

it.each([false, true])('accepts a successful same-URL replacement despite the aborted original (late abort: %s)', async lateAbort => {
  const h = harness();
  let next: ReturnType<typeof h.createGuest>;
  h.onOpen(() => { next = h.createGuest(28); next.start(); next.commit(); });
  const opening = h.openTab();
  if (!lateAbort) next!.fail(-3, 'ERR_ABORTED');
  next!.start();
  if (lateAbort) next!.fail(-3, 'ERR_ABORTED');
  next!.commit();
  await vi.advanceTimersByTimeAsync(100);
  expect(opening.settled()).toBe(false);
  next!.finish();
  await vi.advanceTimersByTimeAsync(100);
  expect(await opening.outcome).toMatchObject({ value: { tabId: 28, url: TARGET }, error: undefined });
  expect(h.closeMessages()).toEqual([]);
});

it('ignores a failed subframe or superseded URL while the requested main frame loads', async () => {
  const h = harness();
  let next: ReturnType<typeof h.createGuest>;
  h.onOpen(() => { next = h.createGuest(28); next.start(); next.commit(); });
  const opening = h.openTab();
  next!.guest.emit('did-fail-load', {}, -105, 'ERR_NAME_NOT_RESOLVED', TARGET, false);
  next!.fail(-105, 'ERR_NAME_NOT_RESOLVED', 'https://other.test/stale');
  await vi.advanceTimersByTimeAsync(100);
  expect(opening.settled()).toBe(false);
  next!.finish();
  await vi.advanceTimersByTimeAsync(100);
  expect((await opening.outcome).error).toBeUndefined();
});

it('reports a closed requested guest without closing the existing or unrelated tabs', async () => {
  const h = harness();
  let next: ReturnType<typeof h.createGuest>;
  let unrelated: ReturnType<typeof h.createGuest>;
  h.onOpen(() => {
    unrelated = h.createGuest(28, 'https://unrelated.test/');
    unrelated.start('https://unrelated.test/');
    next = h.createGuest(29);
    next.start(); next.commit();
  });
  const opening = h.openTab();
  next!.destroy();
  await vi.advanceTimersByTimeAsync(100);
  expect((await opening.outcome).error?.message).toContain('tab closed while opening');
  expect(h.closeMessages()).toEqual([]);
  expect(h.user.guest.isDestroyed()).toBe(false);
  expect(unrelated!.guest.isDestroyed()).toBe(false);
});

it('on cancellation discovers and closes only the requested guest created during the first poll delay', async () => {
  const h = harness();
  let current = true;
  let next: ReturnType<typeof h.createGuest>;
  let unrelated: ReturnType<typeof h.createGuest>;
  h.onOpen(() => {
    setTimeout(() => {
      unrelated = h.createGuest(28, 'https://unrelated.test/');
      unrelated.start('https://unrelated.test/');
      next = h.createGuest(29); next.start(); next.commit();
      current = false;
    }, 10);
  });
  const opening = h.openTab(() => current);
  await vi.advanceTimersByTimeAsync(100);
  expect((await opening.outcome).error?.message).toContain('opening was canceled');
  expect(h.closeMessages()).toEqual([29]);
  expect(next!.guest.isDestroyed()).toBe(true);
  expect(h.user.guest.isDestroyed()).toBe(false);
  expect(unrelated!.guest.isDestroyed()).toBe(false);
});

it('on host closure falls back to closing only the requested guest', async () => {
  const h = harness();
  let next: ReturnType<typeof h.createGuest>;
  h.onOpen(() => { next = h.createGuest(28); next.start(); next.commit(); });
  const opening = h.openTab();
  h.destroyHost();
  await vi.advanceTimersByTimeAsync(100);
  expect((await opening.outcome).error?.message).toContain('window is not available');
  expect(next!.guest.close).toHaveBeenCalledOnce();
  expect(h.user.guest.close).not.toHaveBeenCalled();
  expect(h.closeMessages()).toEqual([]);
});

it('times out a committed page that never finishes and cleans up only that guest', async () => {
  const h = harness();
  let next: ReturnType<typeof h.createGuest>;
  let unrelated: ReturnType<typeof h.createGuest>;
  h.onOpen(() => {
    unrelated = h.createGuest(28, 'about:blank');
    next = h.createGuest(29); next.start(); next.commit();
  });
  const opening = h.openTab();
  await vi.advanceTimersByTimeAsync(19_900);
  expect(opening.settled()).toBe(false);
  await vi.advanceTimersByTimeAsync(100);
  expect((await opening.outcome).error?.message).toContain('did not finish loading within 20 seconds');
  expect(h.closeMessages()).toEqual([29]);
  expect(h.user.guest.isDestroyed()).toBe(false);
  expect(unrelated!.guest.isDestroyed()).toBe(false);
});
