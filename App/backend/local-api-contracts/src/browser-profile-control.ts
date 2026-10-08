/** Desktop main process <-> managed Agent child browser data command. */
export const BROWSER_PROFILE_CLEAR_REQUEST = 'memmy:browser-profile:clear';
export const BROWSER_PROFILE_CLEAR_RESULT = 'memmy:browser-profile:clear-result';

export type BrowserProfileClearRequest = { type: typeof BROWSER_PROFILE_CLEAR_REQUEST; requestId: string };
export type BrowserProfileClearResult = { type: typeof BROWSER_PROFILE_CLEAR_RESULT; requestId: string; ok: boolean; error?: string };

function validId(value: unknown): value is string {
  return typeof value === 'string' && /^[a-zA-Z0-9-]{1,128}$/.test(value);
}
export function isBrowserProfileClearRequest(value: unknown): value is BrowserProfileClearRequest {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return false;
  const item = value as Record<string, unknown>;
  return item.type === BROWSER_PROFILE_CLEAR_REQUEST && validId(item.requestId)
    && Object.keys(item).every(key => ['type', 'requestId'].includes(key));
}
export function isBrowserProfileClearResult(value: unknown): value is BrowserProfileClearResult {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return false;
  const item = value as Record<string, unknown>;
  return item.type === BROWSER_PROFILE_CLEAR_RESULT && validId(item.requestId)
    && typeof item.ok === 'boolean'
    && (item.error === undefined || (typeof item.error === 'string' && item.error.length <= 512))
    && Object.keys(item).every(key => ['type', 'requestId', 'ok', 'error'].includes(key));
}
