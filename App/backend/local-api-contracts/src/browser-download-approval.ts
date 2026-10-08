export const BROWSER_DOWNLOAD_REQUEST = 'memmy:browser-download:request';
export const BROWSER_DOWNLOAD_RESULT = 'memmy:browser-download:result';
export type BrowserDownloadRequest = { type: typeof BROWSER_DOWNLOAD_REQUEST; requestId: string; name: string; url: string };
export type BrowserDownloadResult = { type: typeof BROWSER_DOWNLOAD_RESULT; requestId: string; filePath: string | null };

export function isBrowserDownloadRequest(value: unknown): value is BrowserDownloadRequest {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return false;
  const request = value as Record<string, unknown>;
  return request.type === BROWSER_DOWNLOAD_REQUEST && typeof request.requestId === 'string'
    && /^[a-f\d-]{36}$/i.test(request.requestId)
    && typeof request.name === 'string' && request.name.length > 0 && request.name.length <= 255
    && typeof request.url === 'string' && request.url.length <= 4096
    && Object.keys(request).every(key => ['type', 'requestId', 'name', 'url'].includes(key));
}
export function isBrowserDownloadResult(value: unknown): value is BrowserDownloadResult {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return false;
  const result = value as Record<string, unknown>;
  return result.type === BROWSER_DOWNLOAD_RESULT && typeof result.requestId === 'string'
    && /^[a-f\d-]{36}$/i.test(result.requestId)
    && (result.filePath === null || (typeof result.filePath === 'string' && result.filePath.length <= 4096))
    && Object.keys(result).every(key => ['type', 'requestId', 'filePath'].includes(key));
}
