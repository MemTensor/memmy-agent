export const BROWSER_CAPABILITY_REQUEST = 'memmy:browser-capability:request';
export const BROWSER_CAPABILITY_RESULT = 'memmy:browser-capability:result';

export type BrowserCapabilityKind = 'download' | 'upload' | 'debug' | 'debug-write';
export type BrowserCapabilityRequest = {
  type: typeof BROWSER_CAPABILITY_REQUEST;
  requestId: string;
  capability: BrowserCapabilityKind;
  origin: string;
  names: string[];
};
export type BrowserCapabilityResult = {
  type: typeof BROWSER_CAPABILITY_RESULT;
  requestId: string;
  approved: boolean;
};

const requestIdPattern = /^[a-f\d-]{36}$/i;
export function isBrowserCapabilityRequest(value: unknown): value is BrowserCapabilityRequest {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return false;
  const request = value as Record<string, unknown>;
  if (request.type !== BROWSER_CAPABILITY_REQUEST || typeof request.requestId !== 'string'
    || !requestIdPattern.test(request.requestId)
    || (request.capability !== 'download' && request.capability !== 'upload'
      && request.capability !== 'debug' && request.capability !== 'debug-write')
    || typeof request.origin !== 'string' || request.origin.length > 320
    || !Array.isArray(request.names) || request.names.length < 1 || request.names.length > 20
    || request.names.some(name => typeof name !== 'string' || !name || name.length > 120
      || name === '.' || name === '..' || /[\\/\x00-\x1f]/.test(name))) return false;
  try {
    const url = new URL(request.origin);
    if (!['http:', 'https:'].includes(url.protocol) || url.origin !== request.origin) return false;
  } catch { return false; }
  return Object.keys(request).every(key => ['type', 'requestId', 'capability', 'origin', 'names'].includes(key));
}

export function isBrowserCapabilityResult(value: unknown): value is BrowserCapabilityResult {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return false;
  const result = value as Record<string, unknown>;
  return result.type === BROWSER_CAPABILITY_RESULT && typeof result.requestId === 'string'
    && requestIdPattern.test(result.requestId) && typeof result.approved === 'boolean'
    && Object.keys(result).every(key => ['type', 'requestId', 'approved'].includes(key));
}
