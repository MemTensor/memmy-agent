import type { Browser, Page } from "playwright";
import { revealNativeBrowser } from "../../../tools/computer-use/mac-focus-guard.js";

type WindowTarget = { windowId: number };

async function browserPid(browser: Browser): Promise<number | null> {
  const session = await browser.newBrowserCDPSession();
  try {
    const result = await session.send('SystemInfo.getProcessInfo') as {
      processInfo?: Array<{ type?: string; id?: number }>;
    };
    const pid = result.processInfo?.find(item => item.type === 'browser')?.id;
    return Number.isSafeInteger(pid) && (pid ?? 0) > 0 ? pid! : null;
  } catch { return null; }
  finally { await session.detach().catch(() => undefined); }
}

async function windowForPage(browser: Browser, page: Page): Promise<{ session: Awaited<ReturnType<Browser["newBrowserCDPSession"]>>; windowId: number } | null> {
  if (typeof browser.newBrowserCDPSession !== "function" || typeof page.context().newCDPSession !== "function") return null;
  const pageSession = await page.context().newCDPSession(page);
  let targetId: string;
  try {
    const info = await pageSession.send("Target.getTargetInfo") as { targetInfo?: { targetId?: string } };
    targetId = info.targetInfo?.targetId ?? "";
  } finally {
    await pageSession.detach().catch(() => undefined);
  }
  if (!targetId) return null;
  const session = await browser.newBrowserCDPSession();
  try {
    const window = await session.send("Browser.getWindowForTarget", { targetId }) as WindowTarget;
    if (typeof window.windowId !== "number") {
      await session.detach().catch(() => undefined);
      return null;
    }
    return { session, windowId: window.windowId };
  } catch (error) {
    await session.detach().catch(() => undefined);
    throw error;
  }
}

/** Keep the actual Playwright page available to the user without foregrounding it during Agent work. */
export async function setAgentBrowserPageVisible(browser: Browser, page: Page, visible: boolean,
  platform = process.platform): Promise<boolean> {
  if (platform === 'darwin') {
    if (!visible) return true;
    const pid = await browserPid(browser);
    if (!pid) return false;
    const target = await windowForPage(browser, page);
    if (target) {
      try {
        await target.session.send('Browser.setWindowBounds', {
          windowId: target.windowId,
          bounds: { state: 'normal', left: 100, top: 80, width: 1100, height: 760 },
        } as any);
      } finally { await target.session.detach().catch(() => undefined); }
    }
    if (!await revealNativeBrowser(pid)) return false;
    await page.bringToFront();
    return true;
  }
  const target = await windowForPage(browser, page);
  if (!target) return false;
  try {
    await target.session.send("Browser.setWindowBounds", {
      windowId: target.windowId,
      bounds: visible
        ? { state: "normal", left: 100, top: 80, width: 1100, height: 760 }
        : { state: "minimized" },
    } as any);
    if (visible) await page.bringToFront();
    return true;
  } finally {
    await target.session.detach().catch(() => undefined);
  }
}

/** Capture a headed browser page while its window remains behind the user's current app. */
export async function captureBackgroundBrowserPage(page: Page, format: 'jpeg' | 'png' = 'jpeg',
  fullPage = false): Promise<string> {
  const session = await page.context().newCDPSession(page);
  try {
    let clip: { x: number; y: number; width: number; height: number; scale: number } | undefined;
    if (fullPage) {
      const metrics = await session.send('Page.getLayoutMetrics') as {
        cssContentSize?: { width: number; height: number };
      };
      const content = metrics.cssContentSize;
      if (content) clip = { x: 0, y: 0, width: Math.min(16000, Math.ceil(content.width)),
        height: Math.min(16000, Math.ceil(content.height)), scale: 1 };
    }
    let timer: ReturnType<typeof setTimeout> | undefined;
    const frame = await Promise.race([
      session.send('Page.captureScreenshot', {
        format, ...(format === 'jpeg' ? { quality: 65 } : {}),
        fromSurface: false, captureBeyondViewport: fullPage, ...(clip ? { clip } : {}),
      }) as Promise<{ data?: string }>,
      new Promise<never>((_resolve, reject) => {
        timer = setTimeout(() => reject(new Error('Background browser screenshot timed out')), 8000);
        timer.unref?.();
      }),
    ]).finally(() => { if (timer) clearTimeout(timer); });
    if (typeof frame.data !== 'string' || !frame.data) throw new Error('Background browser frame unavailable');
    return frame.data;
  } finally { await session.detach().catch(() => undefined); }
}
