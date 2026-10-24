import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { expect, it, vi } from 'vitest';
import { EMBEDDED_BROWSER_REQUEST, type EmbeddedBrowserRequest } from '@memmy/local-api-contracts';
import { runApprovedEmbeddedUpload } from '../src/main/browser-embedded-upload-access.js';

it('does not call the webview driver after a denied upload and rechecks files after approval', async () => {
  const workspace = fs.mkdtempSync(path.join(os.tmpdir(), 'memmy-webview-upload-'));
  const file = path.join(workspace, 'report.txt');
  fs.writeFileSync(file, 'sample');
  const request: EmbeddedBrowserRequest = { type: EMBEDDED_BROWSER_REQUEST, requestId: 'test',
    tabId: 27, command: 'upload', args: { paths: [file], target: 'ax-7' } };
  const driver = { uploadOrigin: vi.fn(() => 'https://example.com'), handle: vi.fn(async () => ({ uploaded: 1 })) };
  try {
    const deny = vi.fn(async () => false);
    await expect(runApprovedEmbeddedUpload(request, workspace, driver as any, deny))
      .rejects.toThrow('not approved');
    expect(deny).toHaveBeenCalledWith('https://example.com', ['report.txt']);
    expect(driver.handle).not.toHaveBeenCalled();

    await expect(runApprovedEmbeddedUpload(request, workspace, driver as any, async () => {
      fs.rmSync(file);
      fs.writeFileSync(file, 'replacement');
      return true;
    })).rejects.toThrow('file changed');
    expect(driver.handle).not.toHaveBeenCalled();

    expect(await runApprovedEmbeddedUpload(request, workspace, driver as any, async () => true))
      .toEqual({ uploaded: 1 });
    expect(driver.handle).toHaveBeenCalledWith(request, expect.objectContaining({
      origin: 'https://example.com', stamps: [expect.objectContaining({ path: file })],
    }));
  } finally { fs.rmSync(workspace, { recursive: true, force: true }); }
});

it('ignores an approval after the upload deadline or child disconnects', async () => {
  const workspace = fs.mkdtempSync(path.join(os.tmpdir(), 'memmy-webview-upload-'));
  const file = path.join(workspace, 'report.txt');
  fs.writeFileSync(file, 'sample');
  const request: EmbeddedBrowserRequest = { type: EMBEDDED_BROWSER_REQUEST, requestId: 'late',
    tabId: 27, command: 'upload', args: { paths: [file], target: 'ax-7' } };
  const driver = { uploadOrigin: vi.fn(() => 'https://example.com'), handle: vi.fn(async () => ({})) };
  try {
    vi.useFakeTimers();
    let release!: (approved: boolean) => void;
    const approve = vi.fn(() => new Promise<boolean>(resolve => { release = resolve; }));
    const operation = runApprovedEmbeddedUpload(request, workspace, driver as any, approve,
      () => true, 10);
    const denied = expect(operation).rejects.toThrow('not approved');
    await vi.waitFor(() => expect(approve).toHaveBeenCalledOnce());
    await vi.advanceTimersByTimeAsync(11);
    await denied;
    release(true);
    await Promise.resolve();
    expect(driver.handle).not.toHaveBeenCalled();
    let connected = true;
    await expect(runApprovedEmbeddedUpload(request, workspace, driver as any,
      async () => { connected = false; return true; }, () => connected, 100))
      .rejects.toThrow('not approved');
    expect(driver.handle).not.toHaveBeenCalled();
  } finally {
    vi.useRealTimers();
    fs.rmSync(workspace, { recursive: true, force: true });
  }
});
