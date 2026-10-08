import { SCREEN_CAPTURE_PREFIX, SCREEN_CAPTURE_PROTOCOL, isScreenCaptureMessage, isScreenCaptureRequest, SCREEN_CAPTURE_MAX_BYTES, SCREEN_CAPTURE_MAX_EDGE, type ScreenCaptureResult } from '@memmy/local-api-contracts';

type Display = { id: number; bounds: { x: number; y: number; width: number; height: number } };
export type ScreenCaptureHandler = (displayId?: string, signal?: AbortSignal) => Promise<ScreenCaptureResult>;
export type HelperScreenShot = { ok: true; png: Buffer; width: number; height: number; displayId: string }
  | { ok: false; code: 'permission_required' | 'capture_failed' | 'unavailable' };
export const memmyPermissionMessage = [
  'Memmy 需要同一套权限才能查看屏幕并操作其他应用。',
  '请在引导里把 **Memmy** 拖进系统设置并打开开关：\n**系统设置 → 隐私与安全性 → 屏幕与系统音频录制（屏幕录制）**\n如果辅助功能还没打开，也请一并打开。',
  '不需要再单独授权另一个程序。完成后请重新发送消息。此次没有向模型返回屏幕图片。',
].join('\n\n');

/** Seeing the screen and operating other apps use one Memmy permission. */
export function createDesktopScreenCapture(deps: {
  capture(displayId: string | undefined, signal?: AbortSignal): Promise<HelperScreenShot>;
  guide(): Promise<void>;
  getDisplays(): Display[]; getPrimaryDisplay(): Display;
}): ScreenCaptureHandler {
  let guidanceShown = false;
  let busy = false;
  return async (displayId, signal) => {
    const failed = (code: 'unavailable' | 'capture_failed' | 'cancelled', message: string): ScreenCaptureResult => ({ ok: false, code, message });
    if (busy) return failed('unavailable', '另一项屏幕请求正在处理中，请稍后重新发送消息。');
    if (signal?.aborted) return failed('cancelled', '屏幕请求已取消。');
    busy = true;
    try {
      const shot = await deps.capture(displayId, signal);
      if (signal?.aborted) return failed('cancelled', '屏幕请求已取消。');
      if (!shot.ok) {
        if (shot.code === 'capture_failed') return failed('capture_failed', '未取得屏幕图片。');
        if (!guidanceShown) {
          guidanceShown = true;
          void deps.guide().catch(() => undefined);
        }
        return { ok: false, code: 'permission_required', message: memmyPermissionMessage };
      }
      guidanceShown = false;
      const display = deps.getDisplays().find(item => String(item.id) === shot.displayId) ?? (displayId ? undefined : deps.getPrimaryDisplay());
      if (!display) return failed('capture_failed', '指定显示器不存在。');
      if (!shot.png.length || shot.png.length > SCREEN_CAPTURE_MAX_BYTES || shot.width > SCREEN_CAPTURE_MAX_EDGE || shot.height > SCREEN_CAPTURE_MAX_EDGE || shot.width < 1 || shot.height < 1) {
        return failed('capture_failed', '屏幕图片超过传输限制。');
      }
      return { ok: true, pngBase64: shot.png.toString('base64'), displayId: shot.displayId, bounds: display.bounds, width: shot.width, height: shot.height };
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
