export const LOCKED_MAC_USE_REQUEST = 'memmy:locked-mac-use:request';
export const LOCKED_MAC_USE_RESULT = 'memmy:locked-mac-use:result';

export type LockedMacUseRequest = {
  type: typeof LOCKED_MAC_USE_REQUEST;
  requestId: string;
  action: 'begin' | 'release';
  turnId: string;
  leaseId?: string;
};
export type LockedMacUseResult = {
  type: typeof LOCKED_MAC_USE_RESULT;
  requestId: string;
  status: 'ready' | 'not-needed' | 'relocked' | 'user-intervened' | 'denied';
  leaseId?: string;
};

const uuid = /^[0-9a-f-]{36}$/i;
export function isLockedMacUseRequest(value: unknown): value is LockedMacUseRequest {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return false;
  const item = value as Record<string, unknown>;
  return item.type === LOCKED_MAC_USE_REQUEST
    && typeof item.requestId === 'string' && uuid.test(item.requestId)
    && (item.action === 'begin' || item.action === 'release')
    && typeof item.turnId === 'string' && item.turnId.length > 0 && new TextEncoder().encode(item.turnId).length <= 512
    && (item.action === 'begin' ? item.leaseId === undefined
      : typeof item.leaseId === 'string' && uuid.test(item.leaseId))
    && Object.keys(item).every(key => ['type', 'requestId', 'action', 'turnId', 'leaseId'].includes(key));
}

export function isLockedMacUseResult(value: unknown): value is LockedMacUseResult {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return false;
  const item = value as Record<string, unknown>;
  return item.type === LOCKED_MAC_USE_RESULT
    && typeof item.requestId === 'string' && uuid.test(item.requestId)
    && ['ready', 'not-needed', 'relocked', 'user-intervened', 'denied'].includes(String(item.status))
    && (item.leaseId === undefined || (typeof item.leaseId === 'string' && uuid.test(item.leaseId)))
    && Object.keys(item).every(key => ['type', 'requestId', 'status', 'leaseId'].includes(key));
}
