import { describe, expect, it } from 'vitest';
import { LOCKED_MAC_USE_REQUEST, LOCKED_MAC_USE_RESULT,
  isLockedMacUseRequest, isLockedMacUseResult } from './locked-mac-use.js';

const requestId = '12345678-1234-1234-1234-123456789abc';

describe('locked Mac host IPC contract', () => {
  it('accepts a bounded interactive turn and rejects extra fields', () => {
    const request = { type: LOCKED_MAC_USE_REQUEST, requestId, action: 'begin', turnId: '["session","chat","1"]' };
    expect(isLockedMacUseRequest(request)).toBe(true);
    expect(isLockedMacUseRequest({ ...request, turnId: 'x'.repeat(513) })).toBe(false);
    expect(isLockedMacUseRequest({ ...request, userApproved: true })).toBe(false);
    expect(isLockedMacUseRequest({ ...request, action: 'release' })).toBe(false);
  });

  it('requires a lease identifier to release and validates host responses', () => {
    const release = { type: LOCKED_MAC_USE_REQUEST, requestId, action: 'release', turnId: 'turn', leaseId: requestId };
    expect(isLockedMacUseRequest(release)).toBe(true);
    expect(isLockedMacUseRequest({ ...release, leaseId: '../fake' })).toBe(false);
    expect(isLockedMacUseResult({ type: LOCKED_MAC_USE_RESULT, requestId,
      status: 'ready', leaseId: requestId })).toBe(true);
    expect(isLockedMacUseResult({ type: LOCKED_MAC_USE_RESULT, requestId, status: 'approved' })).toBe(false);
  });
});
