import type { BrowserWindow, WebContents } from 'electron';

/** CDP keyboard commands follow Chromium's focused widget, including the embedder. */
export function assertEmbeddedBrowserInputReceiver(guest: WebContents, host: BrowserWindow): void {
  if (guest.isDestroyed() || host.isDestroyed()) throw new Error('Browser input target is no longer open');
  if (!hasEmbeddedBrowserInputReceiver(guest, host)) {
    throw new Error('Browser input receiver changed; no further input was sent. Take a new snapshot.');
  }
}

function hasEmbeddedBrowserInputReceiver(guest: WebContents, host: BrowserWindow): boolean {
  const focused = host.webContents.focusedFrame;
  return !!focused && guest.mainFrame.framesInSubtree.some(frame => frame.frameTreeNodeId === focused.frameTreeNodeId);
}

/** Focus the exact webview's frame; WebContents.focus() is a no-op for Electron guests. */
export async function focusEmbeddedBrowserInput(guest: WebContents, host: BrowserWindow,
  checkCurrent: () => void): Promise<void> {
  checkCurrent();
  const focused = await host.webContents.executeJavaScript(`(() => {
    const candidates = Array.from(document.querySelectorAll('webview')).filter(view => {
      try { return view.isConnected && view.getWebContentsId() === ${guest.id}; }
      catch { return false; }
    });
    if (candidates.length !== 1) return false;
    const view = candidates[0];
    // Electron's webview.focus() calls contentWindow.focus(). That can update
    // DOM focus without moving Chromium's input receiver when switching back
    // from another guest. Focus the same underlying frame as an element.
    const frame = view.shadowRoot?.querySelector('iframe');
    if (!frame) return false;
    frame.focus({ preventScroll: true });
    return document.activeElement === view && view.shadowRoot.activeElement === frame;
  })()`);
  checkCurrent();
  if (focused !== true) throw new Error('The exact browser tab could not receive input; no input was sent.');
  // DOM focus and Chromium's native focused widget travel on different IPC
  // messages. Wait for that acknowledgement without refocusing or sending input.
  const deadline = Date.now() + 750;
  while (!hasEmbeddedBrowserInputReceiver(guest, host) && Date.now() < deadline) {
    await new Promise(resolve => setTimeout(resolve, 10));
    checkCurrent();
  }
  assertEmbeddedBrowserInputReceiver(guest, host);
}

/** Playwright actionability needs real animation frames even for an offscreen webview. */
export function keepEmbeddedBrowserAnimating(guest: WebContents): () => void {
  const previous = guest.backgroundThrottling;
  guest.setBackgroundThrottling(false);
  let restored = false;
  return () => {
    if (restored) return;
    restored = true;
    if (!guest.isDestroyed()) guest.setBackgroundThrottling(previous);
  };
}
