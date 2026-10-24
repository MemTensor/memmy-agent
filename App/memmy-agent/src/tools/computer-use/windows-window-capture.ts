import { randomUUID } from 'node:crypto';
import { mcpTargetWindowId } from './surface-preview.js';

type Parent = Pick<NodeJS.Process, 'send' | 'connected' | 'on' | 'removeListener'>;
const PREFIX = 'memmy:computer-use-window-capture:';
/** A maximized window is wider than its monitor by the resize border, e.g. 4122 px on a 4096 px display. */
export const WINDOWS_MAX_CAPTURE_DIMENSION = 8192;

export function windowsCapturedPngMatchesSize(data: unknown, width: number, height: number): data is string {
  if (typeof data !== 'string' || data.length > 8_000_000 || !/^[A-Za-z0-9+/]+={0,2}$/.test(data)) return false;
  const png = Buffer.from(data, 'base64');
  return png.length >= 33 && png.length <= 6_000_000 && png.toString('base64') === data
    && png.toString('hex', 0, 8) === '89504e470d0a1a0a'
    && png.toString('ascii', 12, 16) === 'IHDR'
    && png.readUInt32BE(16) === width && png.readUInt32BE(20) === height;
}

/** Ask the Electron parent for an isolated window frame; never expose CopyFromScreen's occluded image. */
export class WindowsWindowCaptureClient {
  constructor(private readonly parent: Parent = process) {}
  capture(target: string, width: number, height: number, signal?: AbortSignal | null,
    pid?: number, targetWindowId?: number): Promise<string | null> {
    if (!this.parent.connected || !this.parent.send || signal?.aborted
      || !Number.isSafeInteger(pid) || pid! <= 0
      || !Number.isSafeInteger(targetWindowId) || targetWindowId! <= 0) return Promise.resolve(null);
    const requestId = randomUUID();
    return new Promise(resolve => {
      const finish = (value: string | null) => {
        clearTimeout(timer);
        this.parent.removeListener('message', receive);
        this.parent.removeListener('disconnect', cancel);
        signal?.removeEventListener('abort', cancel);
        resolve(value);
      };
      const cancel = () => finish(null);
      const receive = (raw: any) => {
        if (raw?.type !== `${PREFIX}response` || raw.requestId !== requestId) return;
        const data = raw.pngBase64;
        finish(windowsCapturedPngMatchesSize(data, width, height) ? data : null);
      };
      const timer = setTimeout(cancel, 8000);
      this.parent.on('message', receive);
      this.parent.on('disconnect', cancel);
      signal?.addEventListener('abort', cancel, { once: true });
      try { this.parent.send!({ type: `${PREFIX}request`, requestId, target, width, height,
        ...(Number.isSafeInteger(pid) && pid! > 0 ? { pid } : {}),
        ...(Number.isSafeInteger(targetWindowId) && targetWindowId! > 0 ? { targetWindowId } : {}) },
        error => { if (error) cancel(); }); }
      catch { cancel(); }
    });
  }
}

export const windowsWindowCaptureClient = new WindowsWindowCaptureClient();

export async function replaceOccludedWindowsFrame(result: any, appName: string, signal?: AbortSignal | null,
  client: Pick<WindowsWindowCaptureClient, 'capture'> = windowsWindowCaptureClient): Promise<any> {
  if (result?.isError === true) return result;
  const content = result?.content;
  const image = Array.isArray(content) ? content.find((item: any) => item?.type === 'image' && item.mimeType === 'image/png') : null;
  // A reliable PrintWindow frame is already tied to the native observation and
  // pixel safety check. Replacing it with a thumbnail would break that identity.
  if (image && result?._meta?.memmyComputerUse?.screenshotIsolated === true) return result;
  const native = result?._meta?.memmyComputerUse;
  // Electron's exact-root thumbnail cannot restore a refused native popup
  // composite. Returning that image would hide an observed, visible popup.
  if (Array.isArray(native?.relatedWindowIDs) && native.relatedWindowIDs.length > 0) {
    return { ...result, content: [
      ...(Array.isArray(content) ? content.filter((item: any) => item?.type !== 'image') : []),
      { type: 'text', text: 'The target window and its owned popups could not be captured reliably. Observe again before continuing.' },
    ] };
  }
  // A failed PrintWindow snapshot has no PNG. The native helper still supplies
  // the bound window geometry so Electron can capture exactly that HWND.
  if (!image && !native?.windowBounds) return result;
  const original = typeof image?.data === 'string' ? Buffer.from(image.data.slice(0, 48), 'base64') : null;
  const validHeader = original && original.length >= 24
    && original.toString('hex', 0, 8) === '89504e470d0a1a0a'
    && original.toString('ascii', 12, 16) === 'IHDR';
  const dimension = (value: unknown): number | undefined => typeof value === 'number'
    && Number.isFinite(value) && value >= 1 && value <= WINDOWS_MAX_CAPTURE_DIMENSION ? Math.round(value) : undefined;
  const width = validHeader ? original.readUInt32BE(16) : dimension(native?.windowBounds?.width);
  const height = validHeader ? original.readUInt32BE(20) : dimension(native?.windowBounds?.height);
  const pid = native?.pid;
  const targetWindowId = mcpTargetWindowId(result, 'win32');
  const captured = width && height && width <= WINDOWS_MAX_CAPTURE_DIMENSION && height <= WINDOWS_MAX_CAPTURE_DIMENSION
    && Number.isSafeInteger(pid) && pid > 0 && targetWindowId !== undefined
    ? await client.capture(appName, width, height, signal, pid, targetWindowId) : null;
  if (!windowsCapturedPngMatchesSize(captured, width ?? 0, height ?? 0)) return { ...result, isError: true,
    content: [{ type: 'text', text: '无法可靠捕获目标 Windows 窗口。本次未提供画面，请重新观察目标窗口。' }] };
  return { ...result, _meta: { ...result?._meta, memmyComputerUse: {
    ...result?._meta?.memmyComputerUse, screenshotIsolated: true, screenshotSource: 'desktop-capture',
  } }, content: image ? content.map((item: any) => item === image ? { ...item, data: captured } : item)
    : [...(Array.isArray(content) ? content : []), { type: 'image', mimeType: 'image/png', data: captured }] };
}
