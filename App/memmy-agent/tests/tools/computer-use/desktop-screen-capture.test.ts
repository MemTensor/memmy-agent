import { EventEmitter } from 'node:events';
import { expect, it, vi } from 'vitest';
import { DesktopScreenClient, DesktopScreenCaptureTool, screenCaptureEnabled } from '../../../src/tools/computer-use/desktop-screen-capture.js';
import { isManagedOcuConfig, managedOcuEnvironment } from '../../../src/tools/computer-use/open-computer-use-binary.js';

it('exposes passive capture only to supported, enabled desktop presets', () => {
  const cfg = { command: 'open-computer-use', args: ['mcp'] };
  const config = { mcpServers: { open_computer_use: cfg } };
  expect(screenCaptureEnabled(config, 'darwin', true)).toBe(true);
  expect(screenCaptureEnabled(config, 'darwin', false)).toBe(false);
  expect(screenCaptureEnabled(config, 'win32', true)).toBe(false);
  expect(screenCaptureEnabled(config, 'linux', true)).toBe(false);
  expect(screenCaptureEnabled({ mcpServers: {} }, 'darwin', true)).toBe(false);
  expect(screenCaptureEnabled({ mcpServers: { open_computer_use: { ...cfg, enabledTools: ['click'] } } }, 'darwin', true)).toBe(false);
  expect(screenCaptureEnabled({ mcpServers: { open_computer_use: { ...cfg, enabledTools: ['mcp_open_computer_use_get_screen_state'] } } }, 'darwin', true)).toBe(true);
  expect(isManagedOcuConfig('open_computer_use', { ...cfg, env: { OPEN_COMPUTER_USE_AGENT_SOCKET_NAMESPACE: 'custom' } }, 'darwin')).toBe(false);
  expect(isManagedOcuConfig('other', cfg, 'darwin')).toBe(false);
  expect(() => managedOcuEnvironment('open-computer-use', null)).toThrow(/missing/);
});
it('handshakes and correlates replies on the private parent channel', async () => {
  const ipc = Object.assign(new EventEmitter(), { connected: true, send: vi.fn((message: any, cb: any) => {
    cb?.(null);
    queueMicrotask(() => ipc.emit('message', message.type.endsWith('capabilities') ? { ...message, available: true } : { type: 'memmy:screen-capture:response', requestId: message.requestId, result: { ok: false, code: 'permission_required', message: 'enable Memmy screen permission' } }));
  }) });
  const client = new DesktopScreenClient(ipc as any); await client.initialize(); expect(client.available).toBe(true);
  const stop = vi.fn(); const tool = new DesktopScreenCaptureTool(() => true, client);
  expect(await tool.execute({}, { stopTurn: stop })).toContain('Memmy screen permission'); expect(stop).toHaveBeenCalledOnce();
  ipc.connected = false; ipc.emit('disconnect'); expect(client.available).toBe(false); expect(ipc.listenerCount('message')).toBe(0);
});
it('cancels pending IPC instead of accepting a late screenshot', async () => {
  const ipc = Object.assign(new EventEmitter(), { connected: true, send: vi.fn((message: any, cb: any) => {
    cb?.(null);
    if (message.type.endsWith('capabilities')) queueMicrotask(() => ipc.emit('message', { ...message, available: true }));
  }) });
  const client = new DesktopScreenClient(ipc as any); await client.initialize();
  const abort = new AbortController(); const request = client.capture(undefined, abort.signal); abort.abort();
  expect(await request).toMatchObject({ ok: false });
  expect(ipc.send).toHaveBeenCalledWith(expect.objectContaining({ type: 'memmy:screen-capture:cancel' }), expect.any(Function));
  ipc.emit('disconnect');
});
it('rechecks the enabled state when an already registered tool is invoked', async () => {
  const client = { capture: vi.fn() } as any; const stop = vi.fn();
  await new DesktopScreenCaptureTool(() => false, client).execute({}, { stopTurn: stop });
  expect(client.capture).not.toHaveBeenCalled(); expect(stop).toHaveBeenCalledOnce();
});

it('accepts a bounded PNG and rejects mismatched or malformed image replies', async () => {
  const pngBase64 = 'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+jRZkAAAAASUVORK5CYII=';
  let result = { ok: true, pngBase64, displayId: '7', bounds: { x: 0, y: 0, width: 1440, height: 900 }, width: 1, height: 1 };
  const ipc = Object.assign(new EventEmitter(), { connected: true, send: vi.fn((message: any, cb: any) => {
    cb?.(null);
    queueMicrotask(() => ipc.emit('message', message.type.endsWith('capabilities') ? { ...message, available: true } : { type: 'memmy:screen-capture:response', requestId: message.requestId, result }));
  }) });
  const client = new DesktopScreenClient(ipc as any); await client.initialize();
  expect(await client.capture()).toEqual(result);
  result = { ...result, width: 2 }; expect(await client.capture()).toMatchObject({ ok: false, code: 'capture_failed' });
  result = { ...result, width: 1, pngBase64: 'invalid' }; expect(await client.capture()).toMatchObject({ ok: false, code: 'capture_failed' });
  ipc.emit('disconnect');
});
