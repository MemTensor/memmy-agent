export const BROWSER_ACCESS_REQUEST = 'memmy:browser-access:request';
export const BROWSER_ACCESS_RESULT = 'memmy:browser-access:result';

export type BrowserAccessRequest = { type: typeof BROWSER_ACCESS_REQUEST; requestId: string; origin: string; url: string };
export type BrowserAccessResult = { type: typeof BROWSER_ACCESS_RESULT; requestId: string; decision: 'allow-once' | 'allow-always' | 'deny' };

function validOrigin(value: unknown): value is string {
  if (typeof value !== 'string' || value.length > 320) return false;
  try {
    const parsed = new URL(value);
    return ['http:', 'https:'].includes(parsed.protocol) && parsed.origin === value;
  } catch { return false; }
}
export function isBrowserAccessRequest(value: unknown): value is BrowserAccessRequest {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return false;
  const request = value as Record<string, unknown>;
  if (request.type !== BROWSER_ACCESS_REQUEST || typeof request.requestId !== 'string'
    || !/^[a-f\d-]{36}$/i.test(request.requestId) || !validOrigin(request.origin)
    || typeof request.url !== 'string' || request.url.length > 4096) return false;
  try { if (new URL(request.url).origin !== request.origin) return false; }
  catch { return false; }
  return Object.keys(request).every(key => ['type', 'requestId', 'origin', 'url'].includes(key));
}
export function isBrowserAccessResult(value: unknown): value is BrowserAccessResult {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return false;
  const result = value as Record<string, unknown>;
  return result.type === BROWSER_ACCESS_RESULT && typeof result.requestId === 'string'
    && /^[a-f\d-]{36}$/i.test(result.requestId)
    && ['allow-once', 'allow-always', 'deny'].includes(String(result.decision))
    && Object.keys(result).every(key => ['type', 'requestId', 'decision'].includes(key));
}
