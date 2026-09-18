import { SCREEN_CAPTURE_PREFIX, SCREEN_CAPTURE_PROTOCOL, isScreenCaptureMessage, isScreenCaptureRequest, SCREEN_CAPTURE_MAX_BYTES, SCREEN_CAPTURE_MAX_EDGE, type ScreenCaptureResult } from '@memmy/local-api-contracts';

type Image = { isEmpty(): boolean; getSize(): { width: number; height: number }; toPNG(): Buffer; resize(size: { width: number; height: number }): Image };
type Display = { id: number; bounds: { x: number; y: number; width: number; height: number } };
export type ScreenCaptureHandler = (displayId?: string, signal?: AbortSignal) => Promise<ScreenCaptureResult>;
export function createDesktopScreenCapture(deps: {
  getStatus(): string;
  getSources(options: { types: ('screen')[]; thumbnailSize: { width: number; height: number }; fetchWindowIcons: boolean }): Promise<Array<{ display_id: string; thumbnail: Image }>>;
  getDisplays(): Display[]; getPrimaryDisplay(): Display;
  openSettings(): Promise<unknown>;
}): ScreenCaptureHandler {
  let guidanceShown = false;
  let busy = false;
  return async (displayId, signal) => {
    const failed = (code: 'unavailable' | 'capture_failed' | 'cancelled', message: string): ScreenCaptureResult => ({ ok: false, code, message });
    if (busy) return failed('unavailable', '另一项屏幕请求正在处理中，请稍后重新发送消息。');
    if (signal?.aborted) return failed('cancelled', '屏幕请求已取消。');
    busy = true;
    try {
      const status = deps.getStatus();
      const options = { types: ['screen'] as ('screen')[], thumbnailSize: { width: SCREEN_CAPTURE_MAX_EDGE, height: SCREEN_CAPTURE_MAX_EDGE }, fetchWindowIcons: false };
      if (status === 'not-determined' || status === 'denied') {
        if (!guidanceShown) {
          guidanceShown = true;
          if (status === 'not-determined') await deps.getSources(options).catch(() => undefined);
          else await deps.openSettings();
        }
        return { ok: false, code: 'permission_required', message: '查看当前屏幕需要 Memmy 的屏幕录制权限。请在系统设置 → 隐私与安全性 → 屏幕录制中允许当前 Memmy/Electron 应用；按系统要求重启后，重新发送消息。此次未返回屏幕图片。' };
      }
      if (status !== 'granted') return failed('unavailable', '无法确认 Memmy 的屏幕录制权限，或权限受系统限制。此次未截图。');
      guidanceShown = false;
      const display = displayId ? deps.getDisplays().find(d => String(d.id) === displayId) : deps.getPrimaryDisplay();
      if (!display) return failed('capture_failed', '指定显示器不存在。');
      const sources = await deps.getSources(options);
      if (signal?.aborted) return failed('cancelled', '屏幕请求已取消。');
      if (deps.getStatus() !== 'granted') return { ok: false, code: 'permission_required', message: 'Memmy 的屏幕录制权限已改变，请完成授权后重新发送消息。此次未返回屏幕图片。' };
      let image = sources.find(s => s.display_id === String(display.id))?.thumbnail;
      if (!image || image.isEmpty()) return failed('capture_failed', '未取得所选屏幕的有效图片。');
      for (let attempt = 0; attempt < 10; attempt++) {
        let { width, height } = image.getSize();
        const scale = Math.min(1, SCREEN_CAPTURE_MAX_EDGE / Math.max(width, height));
        if (scale < 1) image = image.resize({ width: Math.max(1, Math.floor(width * scale)), height: Math.max(1, Math.floor(height * scale)) });
        ({ width, height } = image.getSize());
        const png = image.toPNG();
        if (png.length && png.length <= SCREEN_CAPTURE_MAX_BYTES) return { ok: true, pngBase64: png.toString('base64'), displayId: String(display.id), bounds: display.bounds, width, height };
        if (Math.min(width, height) <= 64) break;
        image = image.resize({ width: Math.floor(width * 0.75), height: Math.floor(height * 0.75) });
      }
      return failed('capture_failed', '屏幕图片超过传输限制。');
    } catch {
      return failed('capture_failed', '屏幕读取失败，请检查系统权限并重新发送消息。');
    } finally { busy = false; }
  };
}

/** Private parent/child IPC only; no renderer or network endpoint. */
export function bindScreenCaptureIpc(
  child: import('node:child_process').ChildProcess,
  live: () => boolean,
  handler?: ScreenCaptureHandler,
): () => void {
  const pending = new Map<string, { controller: AbortController; timer: ReturnType<typeof setTimeout> }>();
  const finish = (id: string) => {
    const job = pending.get(id);
    if (job) { clearTimeout(job.timer); job.controller.abort(); pending.delete(id); }
  };
  const send = (message: object) => { if (live() && child.connected) { try { child.send(message, () => undefined); } catch { /* Child exited. */ } } };
  const receive = (raw: unknown) => {
    if (!live() || !isScreenCaptureMessage(raw)) return;
    if (raw.type === `${SCREEN_CAPTURE_PREFIX}capabilities`) {
      send({ type: raw.type, requestId: raw.requestId, version: SCREEN_CAPTURE_PROTOCOL, available: raw.version === SCREEN_CAPTURE_PROTOCOL && Boolean(handler) });
      return;
    }
    if (raw.type === `${SCREEN_CAPTURE_PREFIX}cancel`) { finish(raw.requestId); return; }
    if (!isScreenCaptureRequest(raw)) return;
    if (!handler || pending.size || pending.has(raw.requestId)) {
      send({ type: `${SCREEN_CAPTURE_PREFIX}response`, requestId: raw.requestId, result: { ok: false, code: 'unavailable', message: '桌面截图服务不可用或正在处理其他请求。' } });
      return;
    }
    const controller = new AbortController();
    const timer = setTimeout(() => {
      finish(raw.requestId);
      send({ type: `${SCREEN_CAPTURE_PREFIX}response`, requestId: raw.requestId, result: { ok: false, code: 'unavailable', message: '屏幕读取超时，请重新发送消息。' } });
    }, 10_000);
    pending.set(raw.requestId, { controller, timer });
    Promise.resolve().then(() => handler(raw.displayId, controller.signal)).then(result => {
      if (!pending.has(raw.requestId)) return;
      finish(raw.requestId);
      send({ type: `${SCREEN_CAPTURE_PREFIX}response`, requestId: raw.requestId, result });
    }, () => {
      if (!pending.has(raw.requestId)) return;
      finish(raw.requestId);
      send({ type: `${SCREEN_CAPTURE_PREFIX}response`, requestId: raw.requestId, result: { ok: false, code: 'capture_failed', message: '屏幕读取失败。' } });
    });
  };
  const dispose = () => {
    child.removeListener('message', receive);
    child.removeListener('close', dispose);
    child.removeListener('disconnect', dispose);
    for (const id of pending.keys()) finish(id);
  };
  child.on('message', receive);
  child.once('close', dispose);
  child.once('disconnect', dispose);
  return dispose;
}
