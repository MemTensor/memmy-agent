import type { BrowserWindow, IpcMainEvent, NativeImage } from 'electron';
import { isExternalBrowserExtensionDirectory } from './external-browser-extension-directory.js';

export const EXTERNAL_BROWSER_EXTENSION_DRAG_CHANNEL = 'memmy:browser-extension:drag';

/** The renderer requests only a gesture; the main process owns the folder and icon. */
export function createExternalBrowserExtensionDragHandler(
  getMainWindow: () => BrowserWindow | null,
  resolveDirectory: () => string | null,
  loadIcon: () => NativeImage,
): (event: IpcMainEvent) => void {
  return event => {
    let started = false;
    try {
      const window = getMainWindow();
      if (!window || window.isDestroyed() || event.sender !== window.webContents
        || event.senderFrame !== window.webContents.mainFrame) return;
      const directory = resolveDirectory();
      if (!directory || !isExternalBrowserExtensionDirectory(directory)) return;
      const icon = loadIcon();
      if (icon.isEmpty()) return;
      window.webContents.startDrag({ file: directory, icon });
      started = true;
    } catch { /* An unavailable asset or cancelled native gesture must release sendSync. */ }
    finally {
      // Reply only after startDrag so macOS still sees the initiating dragstart.
      // Always reply, including rejected requests, to avoid blocking the renderer.
      event.returnValue = started;
    }
  };
}
