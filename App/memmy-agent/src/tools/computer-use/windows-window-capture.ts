import { randomUUID } from 'node:crypto';

type Parent = Pick<NodeJS.Process, 'send' | 'connected' | 'on' | 'removeListener'>;
const PREFIX = 'memmy:computer-use-window-capture:';

/** Ask the Electron parent for an isolated window frame; never expose CopyFromScreen's occluded image. */
export class WindowsWindowCaptureClient {
  constructor(private readonly parent: Parent = process) {}
  capture(target: string, width: number, height: number, signal?: AbortSignal | null, pid?: number): Promise<string | null> {
    if (!this.parent.connected || !this.parent.send || signal?.aborted) return Promise.resolve(null);
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
        if (typeof data !== 'string' || data.length > 8_000_000 || !/^[A-Za-z0-9+/]+={0,2}$/.test(data)) return finish(null);
        const png = Buffer.from(data, 'base64');
        finish(png.length >= 33 && png.length <= 6_000_000 && png.toString('base64') === data
          && png.toString('hex', 0, 8) === '89504e470d0a1a0a'
          && png.toString('ascii', 12, 16) === 'IHDR'
          && png.readUInt32BE(16) === width && png.readUInt32BE(20) === height ? data : null);
      };
      const timer = setTimeout(cancel, 8000);
      this.parent.on('message', receive);
      this.parent.on('disconnect', cancel);
      signal?.addEventListener('abort', cancel, { once: true });
      try { this.parent.send!({ type: `${PREFIX}request`, requestId, target, width, height,
        ...(Number.isSafeInteger(pid) && pid! > 0 ? { pid } : {}) }, error => { if (error) cancel(); }); }
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
  const original = typeof image?.data === 'string' ? Buffer.from(image.data.slice(0, 48), 'base64') : null;
  const validHeader = original && original.length >= 24
    && original.toString('hex', 0, 8) === '89504e470d0a1a0a'
    && original.toString('ascii', 12, 16) === 'IHDR';
  const width = validHeader ? original.readUInt32BE(16) : undefined;
  const height = validHeader ? original.readUInt32BE(20) : undefined;
  const firstText = Array.isArray(content) ? content.find((item: any) => item?.type === 'text')?.text : null;
  const pidMatch = typeof firstText === 'string' ? /^App=.+? \(pid ([1-9]\d{0,9})\)/m.exec(firstText) : null;
  const pid = pidMatch ? Number(pidMatch[1]) : undefined;
  const captured = width && height && width <= 4096 && height <= 4096
    ? await client.capture(appName, width, height, signal, pid) : null;
  if (!captured) return { isError: true, content: [{ type: 'text', text: '无法可靠捕获目标 Windows 窗口。已停止本次桌面观察，以免把遮挡窗口误当作目标应用。' }] };
  return { ...result, content: content.map((item: any) => item === image ? { ...item, data: captured } : item) };
}
