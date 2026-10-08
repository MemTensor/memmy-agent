import { EventEmitter } from 'node:events';
import { describe, expect, it, vi } from 'vitest';
import { bindScreenCaptureIpc, createDesktopScreenCapture, memmyPermissionMessage, type HelperScreenShot } from '../src/main/desktop-screen-capture.js';
import { captureMemmyScreen, computerUseAgentEnvironment, computerUseApp, memmyPermissionSnapshot, parseHelperScreenCapture, permissionsFromDoctor } from '../src/main/memmy-screen-permission.js';

const displays = () => [{ id: 7, bounds: { x: 0, y: 0, width: 100, height: 80 } }];
function fixture(shot: HelperScreenShot = { ok: true, png: Buffer.from('png'), width: 100, height: 80, displayId: '7' }) {
  const capture = vi.fn(async () => shot);
  const guide = vi.fn(async () => undefined);
  return { capture, guide, screen: createDesktopScreenCapture({ capture, guide, getDisplays: displays, getPrimaryDisplay: () => displays()[0] }) };
}

describe('one Memmy screen permission', () => {
  it('returns the helper image without opening a second permission', async () => {
    const { screen, guide } = fixture();
    await expect(screen()).resolves.toMatchObject({ ok: true, displayId: '7', width: 100, height: 80, pngBase64: Buffer.from('png').toString('base64') });
    expect(guide).not.toHaveBeenCalled();
  });

  it('opens the same Memmy guide once when that permission is missing', async () => {
    const { screen, guide, capture } = fixture({ ok: false, code: 'permission_required' });
    const first = await screen();
    const second = await screen();
    expect(first).toMatchObject({ ok: false, code: 'permission_required', message: memmyPermissionMessage });
    expect(second).toMatchObject({ ok: false, code: 'permission_required' });
    expect(guide).toHaveBeenCalledOnce();
    expect(capture).toHaveBeenCalledTimes(2);
    expect(memmyPermissionMessage).toContain('同一套权限');
    expect(memmyPermissionMessage).toContain('不需要再单独授权另一个程序');
    expect(memmyPermissionMessage).not.toContain('Electron');
  });

  it('asks again after a successful capture if permission is removed', async () => {
    const capture = vi.fn<(...args: unknown[]) => Promise<HelperScreenShot>>()
      .mockResolvedValueOnce({ ok: true, png: Buffer.from('png'), width: 20, height: 20, displayId: '7' })
      .mockResolvedValue({ ok: false, code: 'permission_required' });
    const guide = vi.fn(async () => undefined);
    const screen = createDesktopScreenCapture({ capture, guide, getDisplays: displays, getPrimaryDisplay: () => displays()[0] });
    await screen();
    await screen();
    await screen();
    expect(guide).toHaveBeenCalledOnce();
  });

  it('does not substitute another display or accept an oversized image', async () => {
    const missing = fixture({ ok: true, png: Buffer.from('png'), width: 10, height: 10, displayId: '999' });
    await expect(missing.screen('999')).resolves.toMatchObject({ ok: false, code: 'capture_failed' });
    const huge = fixture({ ok: true, png: Buffer.alloc(901 * 1024), width: 100, height: 80, displayId: '7' });
    await expect(huge.screen()).resolves.toMatchObject({ ok: false, code: 'capture_failed' });
  });
});

describe('helper screen capture', () => {
  it('reads the helper result and retries once after stopping a stale helper', async () => {
    const run = vi.fn()
      .mockResolvedValueOnce({ stdout: '{"ok":false,"code":"permission_required"}\n', stderr: '' })
      .mockResolvedValueOnce({ stdout: JSON.stringify({ ok: true, pngBase64: Buffer.from('png').toString('base64'), width: 8, height: 4, displayId: '7' }), stderr: '' });
    const stopAgent = vi.fn(async () => undefined);
    await expect(captureMemmyScreen('/Apps/Memmy Computer Use.app/Contents/MacOS/MemmyComputerUse', undefined, undefined, { run, stopAgent }))
      .resolves.toMatchObject({ ok: true, width: 8, height: 4, displayId: '7' });
    expect(stopAgent).toHaveBeenCalledOnce();
    expect(run).toHaveBeenLastCalledWith('/Apps/Memmy Computer Use.app/Contents/MacOS/MemmyComputerUse', ['capture-screen'], undefined);
  });

  it('parses doctor output into the one permission record', () => {
    expect(permissionsFromDoctor('Permissions: accessibility=granted, screenRecording=missing\n')).toEqual({
      accessibility: 'granted', screenRecording: 'required',
    });
    expect(memmyPermissionSnapshot('{"accessibility":true,"inputMonitoring":false,"screenRecording":true}\n')).toEqual({
      accessibility: 'granted', inputMonitoring: 'required', screenRecording: 'granted',
    });
    expect(parseHelperScreenCapture('not json')).toBeNull();
    expect(computerUseApp('/Apps/Memmy Computer Use.app/Contents/MacOS/MemmyComputerUse')).toBe('/Apps/Memmy Computer Use.app');
    expect(computerUseAgentEnvironment('/Apps/Memmy Computer Use.app/Contents/MacOS/MemmyComputerUse')
      .OPEN_COMPUTER_USE_AGENT_SOCKET_NAMESPACE).toBe('memmy:/Apps/Memmy Computer Use.app');
  });
});

function child() { return Object.assign(new EventEmitter(), { connected: true, send: vi.fn((_message: any, cb: any) => cb?.(null)) }); }
it('private IPC only handles its protocol and discards responses from an old generation', async () => {
  const process = child(); let live = true; let finish!: (value: any) => void;
  const handler = vi.fn(() => new Promise<any>(resolve => { finish = resolve; }));
  const dispose = bindScreenCaptureIpc(process as any, () => live, handler);
  process.emit('message', { type: 'memmy-agent:restart' }); expect(handler).not.toHaveBeenCalled();
  process.emit('message', { type: 'memmy:screen-capture:capabilities', requestId: 'hello', version: 1 });
  expect(process.send).toHaveBeenLastCalledWith(expect.objectContaining({ available: true }), expect.any(Function));
  process.emit('message', { type: 'memmy:screen-capture:request', requestId: 'one', displayId: '7' });
  await vi.waitFor(() => expect(handler).toHaveBeenCalledOnce());
  live = false; finish({ ok: false, code: 'cancelled', message: 'stale' });
  await Promise.resolve(); await Promise.resolve(); expect(process.send).toHaveBeenCalledTimes(1);
  dispose(); expect(process.listenerCount('message')).toBe(0);
});
it('cancellation and child disconnect release pending jobs without sending images', async () => {
  const process = child(); const signals: AbortSignal[] = [];
  const handler = vi.fn((_id, signal) => { signals.push(signal); return new Promise<any>(() => {}); });
  const dispose = bindScreenCaptureIpc(process as any, () => true, handler);
  process.emit('message', { type: 'memmy:screen-capture:request', requestId: 'one' });
  await vi.waitFor(() => expect(handler).toHaveBeenCalledOnce());
  process.emit('message', { type: 'memmy:screen-capture:cancel', requestId: 'one' }); expect(signals[0].aborted).toBe(true);
  process.emit('message', { type: 'memmy:screen-capture:request', requestId: 'two' });
  await vi.waitFor(() => expect(handler).toHaveBeenCalledTimes(2));
  process.emit('disconnect'); expect(signals[1].aborted).toBe(true); expect(process.send).not.toHaveBeenCalled(); dispose();
});
