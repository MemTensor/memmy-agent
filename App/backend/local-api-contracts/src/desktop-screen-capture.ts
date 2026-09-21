export const SCREEN_CAPTURE_PROTOCOL = 1;
export const SCREEN_CAPTURE_MAX_BYTES = 900 * 1024;
export const SCREEN_CAPTURE_MAX_EDGE = 1280;
export const SCREEN_CAPTURE_PREFIX = 'memmy:screen-capture:';
export type ScreenCaptureResult = {
  ok: true; pngBase64: string; displayId: string;
  bounds: { x: number; y: number; width: number; height: number };
  width: number; height: number;
} | { ok: false; code: 'permission_required' | 'unavailable' | 'capture_failed' | 'cancelled'; message: string };
export type ScreenCaptureRequest = { type: 'memmy:screen-capture:request'; requestId: string; displayId?: string };
export function isScreenCaptureMessage(value: unknown): value is Record<string, any> {
  return !!value && typeof value === 'object' && !Array.isArray(value)
    && typeof (value as any).type === 'string' && (value as any).type.startsWith(SCREEN_CAPTURE_PREFIX)
    && typeof (value as any).requestId === 'string' && /^[A-Za-z0-9-]{1,80}$/.test((value as any).requestId);
}
export function isScreenCaptureRequest(value: unknown): value is ScreenCaptureRequest {
  return isScreenCaptureMessage(value) && value.type === `${SCREEN_CAPTURE_PREFIX}request`
    && (value.displayId === undefined || (typeof value.displayId === 'string' && /^\d{1,16}$/.test(value.displayId)))
    && Object.keys(value).every(key => ['type', 'requestId', 'displayId'].includes(key));
}
export function isScreenCaptureResult(value: any): value is ScreenCaptureResult {
  if (!value || typeof value !== 'object') return false;
  if (value.ok === false) return ['permission_required', 'unavailable', 'capture_failed', 'cancelled'].includes(value.code)
    && typeof value.message === 'string' && value.message.length <= 2000;
  return value.ok === true && typeof value.pngBase64 === 'string'
    && value.pngBase64.length <= Math.ceil(SCREEN_CAPTURE_MAX_BYTES / 3) * 4
    && typeof value.displayId === 'string' && /^\d{1,16}$/.test(value.displayId)
    && [value.width, value.height].every(n => Number.isInteger(n) && n > 0 && n <= SCREEN_CAPTURE_MAX_EDGE)
    && !!value.bounds && ['x', 'y', 'width', 'height'].every(key => Number.isFinite(value.bounds[key]))
    && value.bounds.width > 0 && value.bounds.height > 0;
}
