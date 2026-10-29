import { EventEmitter } from 'node:events';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, expect, it, vi } from 'vitest';
import { DesktopScreenClient, DesktopScreenCaptureTool, desktopScreenClient, screenCaptureEnabled } from '../../../src/tools/computer-use/desktop-screen-capture.js';
import { isManagedOcuConfig, managedOcuEnvironment, resolveOpenComputerUseCommand } from '../../../src/tools/computer-use/open-computer-use-binary.js';
import { ToolLoader } from '../../../src/core/agent-runtime/tools/loader.js';
import { Config } from '../../../src/config/schema.js';
import { MCPToolWrapper } from '../../../src/core/agent-runtime/tools/mcp.js';
import { RequestContext } from '../../../src/core/agent-runtime/tools/context.js';
import type { ManagedOcuSession } from '../../../src/tools/computer-use/managed-ocu-session.js';
import { closeNativeSurfacesForTurn, registerComputerUseTurnInterrupt } from '../../../src/tools/computer-use/surface-preview.js';

const nativeScope = { sessionKey: 'desktop-native-fallback', channel: 'websocket', chatId: 'native-chat' };
afterEach(() => {
  closeNativeSurfacesForTurn(nativeScope);
  vi.unstubAllGlobals();
  vi.unstubAllEnvs();
});

async function observeNativeApplication() {
  vi.stubEnv('MEMMY_DESKTOP_MANAGED_GATEWAY', '1');
  const events = new EventEmitter();
  vi.stubGlobal('process', Object.assign(Object.create(process), {
    on: events.on.bind(events), send: vi.fn(), connected: true,
  }));
  const release = registerComputerUseTurnInterrupt({ ...nativeScope, turnId: 'native-request' }, vi.fn(async () => undefined));
  try {
    const result = { _meta: { memmyComputerUse: { targetWindowID: 52, pid: 20, relatedWindowIDs: [53] } },
      content: [{ type: 'text', text: 'Native window observed' }] };
    const owner = { invoke: vi.fn().mockResolvedValue(result),
      presentModelResult: vi.fn((_name, _args, _result, output) => output) } as unknown as ManagedOcuSession;
    const native = new MCPToolWrapper({}, 'memmy_computer_use', { name: 'get_app_state' }, 30, undefined, owner);
    native.setContext(new RequestContext({ ...nativeScope, metadata: { turnId: 'native-request' } }));
    await native.execute({ app: 'WPS' });
  } finally { release(); }
}

async function screenToolWithIpc() {
  const pngBase64 = 'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+jRZkAAAAASUVORK5CYII=';
  const result = { ok: true, pngBase64, displayId: '7', bounds: { x: 0, y: 0, width: 1440, height: 900 }, width: 1, height: 1 };
  const ipc = Object.assign(new EventEmitter(), { connected: true, send: vi.fn((message: any, cb: any) => {
    cb?.(null);
    queueMicrotask(() => ipc.emit('message', message.type.endsWith('capabilities') ? { ...message, available: true }
      : { type: 'memmy:screen-capture:response', requestId: message.requestId, result }));
  }) });
  const client = new DesktopScreenClient(ipc as any);
  await client.initialize();
  ipc.send.mockClear();
  return { tool: new DesktopScreenCaptureTool(() => true, client), ipc };
}

it('blocks whole-screen menu fallback for the same observed native request before sending capture IPC', async () => {
  await observeNativeApplication();
  const { tool, ipc } = await screenToolWithIpc();
  const stop = vi.fn();
  tool.setContext(new RequestContext({ ...nativeScope, metadata: { turnId: 'native-request' } }));
  expect(await tool.execute({ display_id: 7 }, { stopTurn: stop })).toContain('get_app_state');
  expect(ipc.send).not.toHaveBeenCalled();
  expect(stop).not.toHaveBeenCalled();
  ipc.emit('disconnect');
});

it.each([
  { ...nativeScope, chatId: 'another-chat', metadata: { turnId: 'native-request' } },
  { ...nativeScope, metadata: { turnId: 'new-screen-request' } },
])('does not let a native surface block screen observation in another chat or a new request: %j', async context => {
  await observeNativeApplication();
  const { tool, ipc } = await screenToolWithIpc();
  const stop = vi.fn();
  tool.setContext(new RequestContext(context));
  const result = await tool.execute({}, { stopTurn: stop });
  expect(ipc.send).toHaveBeenCalledWith(expect.objectContaining({ type: 'memmy:screen-capture:request' }), expect.any(Function));
  expect(result).toEqual(expect.arrayContaining([expect.objectContaining({ type: 'image_url' })]));
  expect(stop).not.toHaveBeenCalled();
  ipc.emit('disconnect');
});

it('does not borrow another native request when desktop observation has no request context', async () => {
  await observeNativeApplication();
  const { tool, ipc } = await screenToolWithIpc();
  const result = await tool.execute();
  expect(ipc.send).toHaveBeenCalledWith(expect.objectContaining({ type: 'memmy:screen-capture:request' }), expect.any(Function));
  expect(result).toEqual(expect.arrayContaining([expect.objectContaining({ type: 'image_url' })]));
  ipc.emit('disconnect');
});

it('returns a normal desktop observation when this request has no native surface', async () => {
  const { tool, ipc } = await screenToolWithIpc();
  tool.setContext(new RequestContext({ ...nativeScope, metadata: { turnId: 'screen-only-request' } }));
  const result = await tool.execute({ display_id: 7 });
  expect(ipc.send).toHaveBeenCalledWith(expect.objectContaining({ type: 'memmy:screen-capture:request', displayId: '7' }), expect.any(Function));
  expect(result).toEqual(expect.arrayContaining([expect.objectContaining({ type: 'image_url' })]));
  ipc.emit('disconnect');
});

it.skipIf(process.platform !== 'darwin')('registers passive capture through the real builtin loader after desktop handshake', () => {
  const available = desktopScreenClient.available;
  const ctx = { config: new Config().tools, runtimeState: { mcpServers: { memmy_computer_use: { command: 'open-computer-use', args: ['mcp'] } } } };
  try {
    desktopScreenClient.available = true;
    const registry = new ToolLoader({ ctx: ctx as any }).loadRegistry();
    expect(registry.get('get_screen_state')).toBeInstanceOf(DesktopScreenCaptureTool);
    expect(registry.getDefinitions().some(tool => tool.function.name === 'get_screen_state')).toBe(true);
    desktopScreenClient.available = false;
    expect(new ToolLoader({ ctx: ctx as any }).loadRegistry().get('get_screen_state')).toBeUndefined();
  } finally { desktopScreenClient.available = available; }
});

it('exposes passive capture only to supported, enabled desktop presets', () => {
  const cfg = { command: 'open-computer-use', args: ['mcp'] };
  const config = { mcpServers: { memmy_computer_use: cfg } };
  expect(screenCaptureEnabled(config, 'darwin', true)).toBe(true);
  expect(screenCaptureEnabled(config, 'darwin', false)).toBe(false);
  expect(screenCaptureEnabled(config, 'win32', true)).toBe(false);
  expect(screenCaptureEnabled(config, 'linux', true)).toBe(false);
  expect(screenCaptureEnabled({ mcpServers: {} }, 'darwin', true)).toBe(false);
  expect(screenCaptureEnabled({ mcpServers: { memmy_computer_use: { ...cfg, enabledTools: ['click'] } } }, 'darwin', true)).toBe(false);
  expect(screenCaptureEnabled({ mcpServers: { memmy_computer_use: { ...cfg, enabledTools: ['mcp_memmy_computer_use_get_screen_state'] } } }, 'darwin', true)).toBe(true);
  expect(screenCaptureEnabled({ mcpServers: { open_computer_use: cfg } }, 'darwin', true)).toBe(true);
  expect(screenCaptureEnabled({ mcpServers: { open_computer_use: { ...cfg, enabledTools: ['mcp_open_computer_use_get_screen_state'] } } }, 'darwin', true)).toBe(true);
  expect(isManagedOcuConfig('memmy_computer_use', { ...cfg, env: { OPEN_COMPUTER_USE_AGENT_SOCKET_NAMESPACE: 'custom' } }, 'darwin')).toBe(false);
  expect(isManagedOcuConfig('other', cfg, 'darwin')).toBe(false);
  expect(() => managedOcuEnvironment('open-computer-use', null)).toThrow(/missing/);
});
it.skipIf(process.platform !== 'darwin')('keeps the physical pointer fallback disabled by default', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'memmy-ocu-runtime-'));
  const app = path.join(root, 'Memmy Computer Use.app', 'Contents', 'MacOS');
  const binary = path.join(app, 'MemmyComputerUse');
  fs.mkdirSync(app, { recursive: true });
  fs.writeFileSync(binary, '#!/bin/sh\nexit 0\n');
  fs.chmodSync(binary, 0o755);
  vi.stubEnv('MEMMY_DEV_COMPUTER_USE_BINARY', binary);
  try {
    const resolved = resolveOpenComputerUseCommand('open-computer-use');
    expect(resolved).toBe(binary);
    expect(managedOcuEnvironment(resolved, null).OPEN_COMPUTER_USE_ALLOW_GLOBAL_POINTER_FALLBACKS).toBe('0');
    expect(managedOcuEnvironment(resolved, { OPEN_COMPUTER_USE_ALLOW_GLOBAL_POINTER_FALLBACKS: '1' })
      .OPEN_COMPUTER_USE_ALLOW_GLOBAL_POINTER_FALLBACKS).toBe('1');
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
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
