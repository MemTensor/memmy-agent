import { expect, it, vi } from 'vitest';
import { EMBEDDED_BROWSER_REQUEST, type EmbeddedBrowserRequest } from '@memmy/local-api-contracts';
import { runApprovedEmbeddedCdpRead, runApprovedEmbeddedCdpWrite } from '../src/main/browser-embedded-cdp-access.js';

const request: EmbeddedBrowserRequest = { type: EMBEDDED_BROWSER_REQUEST, requestId: 'test',
  tabId: 27, command: 'cdpCall', args: { method: 'Page.getLayoutMetrics', params: {} } };

it('requires visible approval for the exact selected tab and current origin', async () => {
  let origin = 'https://example.test';
  const driver = { uploadOrigin: vi.fn(() => origin), handle: vi.fn(async () => ({ metrics: true })) };
  const approve = vi.fn(async () => false);
  await expect(runApprovedEmbeddedCdpRead(request, driver as any, approve,
    () => true, () => true)).rejects.toThrow(/not approved/);
  expect(driver.handle).not.toHaveBeenCalled();
  approve.mockImplementation(async () => { origin = 'https://other.test'; return true; });
  await expect(runApprovedEmbeddedCdpRead(request, driver as any, approve,
    () => true, () => true)).rejects.toThrow(/not approved/);
  expect(driver.handle).not.toHaveBeenCalled();
  origin = 'https://example.test';
  let policyAllowed = true;
  await expect(runApprovedEmbeddedCdpRead(request, driver as any,
    async () => { policyAllowed = false; return true; }, () => true, () => policyAllowed))
    .rejects.toThrow(/not approved/);
  expect(driver.handle).not.toHaveBeenCalled();
  expect(await runApprovedEmbeddedCdpRead(request, driver as any, async () => true,
    () => true, () => true)).toEqual({ metrics: true });
  expect(driver.handle).toHaveBeenCalledWith(request, undefined, expect.objectContaining({
    origin: 'https://example.test', isCurrentChild: expect.any(Function), isAllowed: expect.any(Function),
  }));
});

it('denies unsupported mutating methods and late approvals before invoking CDP', async () => {
  const driver = { uploadOrigin: vi.fn(() => 'https://example.test'), handle: vi.fn(async () => ({})) };
  await expect(runApprovedEmbeddedCdpRead({ ...request, args: { method: 'DOM.setFileInputFiles', params: {} } },
    driver as any, async () => true, () => true, () => true)).rejects.toThrow(/unavailable/);
  expect(driver.handle).not.toHaveBeenCalled();
  vi.useFakeTimers();
  try {
    let release!: (approved: boolean) => void;
    const approve = vi.fn(() => new Promise<boolean>(resolve => { release = resolve; }));
    const operation = runApprovedEmbeddedCdpRead(request, driver as any, approve,
      () => true, () => true, 10);
    const denied = expect(operation).rejects.toThrow(/not approved/);
    await vi.waitFor(() => expect(approve).toHaveBeenCalledOnce());
    await vi.advanceTimersByTimeAsync(11);
    await denied;
    release(true);
    expect(driver.handle).not.toHaveBeenCalled();
  } finally { vi.useRealTimers(); }
});

it('requires a separate current write approval and rechecks policy before a CDP mutation', async () => {
  const write = { ...request, command: 'cdpWrite' as const,
    args: { method: 'Runtime.evaluate', params: { expression: 'document.title = "changed"' } } };
  let origin = 'https://example.test';
  let allowed = true;
  let currentChild = true;
  const driver = { uploadOrigin: vi.fn(() => origin), handle: vi.fn(async () => ({ ok: true })) };
  const approve = vi.fn(async () => false);
  await expect(runApprovedEmbeddedCdpWrite(write, driver as any, approve,
    () => currentChild, () => allowed)).rejects.toThrow(/not approved/);
  expect(driver.handle).not.toHaveBeenCalled();
  approve.mockImplementation(async () => { allowed = false; return true; });
  await expect(runApprovedEmbeddedCdpWrite(write, driver as any, approve,
    () => currentChild, () => allowed)).rejects.toThrow(/not approved/);
  expect(driver.handle).not.toHaveBeenCalled();
  allowed = true;
  approve.mockImplementation(async () => { origin = 'https://other.test'; return true; });
  await expect(runApprovedEmbeddedCdpWrite(write, driver as any, approve,
    () => currentChild, () => allowed)).rejects.toThrow(/not approved/);
  origin = 'https://example.test';
  approve.mockImplementation(async () => { currentChild = false; return true; });
  await expect(runApprovedEmbeddedCdpWrite(write, driver as any, approve,
    () => currentChild, () => allowed)).rejects.toThrow(/not approved/);
  currentChild = true;
  expect(await runApprovedEmbeddedCdpWrite(write, driver as any, async () => true,
    () => currentChild, () => allowed)).toEqual({ ok: true });
  expect(driver.handle).toHaveBeenCalledWith(write, undefined, expect.objectContaining({ mode: 'write' }));
});

it('approves every explicit CDP destination before touching the selected webview', async () => {
  const write = { ...request, command: 'cdpWrite' as const,
    args: { method: 'Network.setCookie', params: {
      name: 'sample', value: '1', url: 'https://destination.test/path',
    } } };
  const driver = { uploadOrigin: vi.fn(() => 'https://example.test'), handle: vi.fn(async () => ({ success: true })) };
  const approve = vi.fn(async (origin: string) => origin !== 'https://destination.test');
  await expect(runApprovedEmbeddedCdpWrite(write, driver as any, approve,
    () => true, () => true)).rejects.toThrow(/destination site/);
  expect(approve.mock.calls.map(call => call[0])).toEqual(['https://example.test', 'https://destination.test']);
  expect(driver.handle).not.toHaveBeenCalled();
  approve.mockResolvedValue(true);
  expect(await runApprovedEmbeddedCdpWrite(write, driver as any, approve,
    () => true, () => true)).toEqual({ success: true });
  expect(driver.handle).toHaveBeenCalledOnce();
});
