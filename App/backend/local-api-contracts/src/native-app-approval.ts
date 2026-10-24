export const NATIVE_APP_ACCESS_REQUEST = 'memmy:native-app-access:request';
export const NATIVE_APP_ACCESS_RESULT = 'memmy:native-app-access:result';

export type NativeAppAccessDecision = 'allow-once' | 'allow-always' | 'deny';
export type NativeAppAccessRequest = {
  type: typeof NATIVE_APP_ACCESS_REQUEST;
  requestId: string;
  appId: string;
  displayName: string;
  platform: 'darwin' | 'win32';
};
export type NativeAppAccessResult = {
  type: typeof NATIVE_APP_ACCESS_RESULT;
  requestId: string;
  decision: NativeAppAccessDecision;
};

const uuid = /^[a-f\d-]{36}$/i;
const appId = /^[\w.!-]{1,256}$/;

export function isNativeAppAccessRequest(value: unknown): value is NativeAppAccessRequest {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return false;
  const item = value as Record<string, unknown>;
  return item.type === NATIVE_APP_ACCESS_REQUEST && typeof item.requestId === 'string' && uuid.test(item.requestId)
    && typeof item.appId === 'string' && appId.test(item.appId)
    && typeof item.displayName === 'string' && item.displayName.trim().length > 0 && item.displayName.length <= 256
    && (item.platform === 'darwin' || item.platform === 'win32')
    && Object.keys(item).every(key => ['type', 'requestId', 'appId', 'displayName', 'platform'].includes(key));
}

export function isNativeAppAccessResult(value: unknown): value is NativeAppAccessResult {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return false;
  const item = value as Record<string, unknown>;
  return item.type === NATIVE_APP_ACCESS_RESULT && typeof item.requestId === 'string' && uuid.test(item.requestId)
    && (item.decision === 'allow-once' || item.decision === 'allow-always' || item.decision === 'deny')
    && Object.keys(item).every(key => ['type', 'requestId', 'decision'].includes(key));
}
