import { describe, expect, it, vi } from "vitest";
import type { Browser, Page } from "playwright";
import { captureBackgroundBrowserPage, setAgentBrowserPageVisible } from "../../../../src/core/agent-runtime/tools/browser-window-visibility.js";
import { revealNativeBrowser } from "../../../../src/tools/computer-use/mac-focus-guard.js";

vi.mock('../../../../src/tools/computer-use/mac-focus-guard.js', () => ({
  revealNativeBrowser: vi.fn(async () => true),
}));

describe("Agent browser window visibility", () => {
  it("minimizes the Agent-owned page during background work and reveals the same page on takeover", async () => {
    const targetSession = { send: vi.fn(async () => ({ targetInfo: { targetId: "target-1" } })), detach: vi.fn(async () => undefined) };
    const windowSession = { send: vi.fn(async (method: string) => {
      if (method === 'SystemInfo.getProcessInfo') return { processInfo: [{ type: 'browser', id: 123 }] };
      if (method === 'Browser.getWindowForTarget') return { windowId: 42 };
      return {};
    }), detach: vi.fn(async () => undefined) };
    const page = {
      context: () => ({ newCDPSession: vi.fn(async () => targetSession) }),
      bringToFront: vi.fn(async () => undefined),
    } as unknown as Page;
    const browser = { newBrowserCDPSession: vi.fn(async () => windowSession) } as unknown as Browser;

    expect(await setAgentBrowserPageVisible(browser, page, false)).toBe(true);
    if (process.platform === 'darwin') expect(revealNativeBrowser).not.toHaveBeenCalled();
    else expect(windowSession.send).toHaveBeenCalledWith("Browser.setWindowBounds", {
      windowId: 42, bounds: { state: "minimized" },
    });
    expect(page.bringToFront).not.toHaveBeenCalled();

    expect(await setAgentBrowserPageVisible(browser, page, true)).toBe(true);
    expect(windowSession.send).toHaveBeenCalledWith("Browser.setWindowBounds", {
      windowId: 42, bounds: { state: "normal", left: 100, top: 80, width: 1100, height: 760 },
    });
    if (process.platform === 'darwin') expect(revealNativeBrowser).toHaveBeenCalledWith(123);
    expect(page.bringToFront).toHaveBeenCalledOnce();
  });
});

it('captures a background page through CDP and bounds full-page dimensions', async () => {
  const cdp = { send: vi.fn(async (method: string) => {
    if (method === 'Page.getLayoutMetrics') return { cssContentSize: { width: 2000, height: 3000 } };
    return { data: 'YWJj' };
  }), detach: vi.fn(async () => undefined) };
  const page = { context: () => ({ newCDPSession: vi.fn(async () => cdp) }) } as unknown as Page;
  await expect(captureBackgroundBrowserPage(page, 'jpeg', true)).resolves.toBe('YWJj');
  expect(cdp.send).toHaveBeenCalledWith('Page.captureScreenshot', {
    format: 'jpeg', quality: 65, fromSurface: false, captureBeyondViewport: true,
    clip: { x: 0, y: 0, width: 2000, height: 3000, scale: 1 },
  });
  expect(cdp.detach).toHaveBeenCalledOnce();
});

it('minimizes the Windows browser window while keeping its page target available', async () => {
  const pageSession = { send: vi.fn(async () => ({ targetInfo: { targetId: 'tab-1' } })),
    detach: vi.fn(async () => undefined) };
  const browserSession = { send: vi.fn(async (method: string) =>
    method === 'Browser.getWindowForTarget' ? { windowId: 51 } : {}),
  detach: vi.fn(async () => undefined) };
  const page = { context: () => ({ newCDPSession: async () => pageSession }),
    bringToFront: vi.fn(async () => undefined) } as unknown as Page;
  const browser = { newBrowserCDPSession: async () => browserSession } as unknown as Browser;
  await expect(setAgentBrowserPageVisible(browser, page, false, 'win32')).resolves.toBe(true);
  expect(browserSession.send).toHaveBeenCalledWith('Browser.setWindowBounds', {
    windowId: 51, bounds: { state: 'minimized' },
  });
});
