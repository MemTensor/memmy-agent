import { expect, it, vi } from 'vitest';
import { EventEmitter } from 'node:events';
import { spawn } from 'node:child_process';
import { bindComputerUseWindowCaptureIpc, captureComputerUseWindow, windowsSourceOwners } from '../src/main/computer-use-window-capture.js';

vi.mock('electron', () => ({ desktopCapturer: { getSources: vi.fn() } }));
const spawned = vi.hoisted(() => [] as any[]);
vi.mock('node:child_process', async () => {
  const { EventEmitter } = await import('node:events');
  return { spawn: vi.fn(() => {
    const child: any = new EventEmitter();
    child.stdin = Object.assign(new EventEmitter(), { write: vi.fn() });
    child.stdout = Object.assign(new EventEmitter(), { setEncoding: vi.fn() });
    child.kill = vi.fn(() => child.emit('exit', null, 'SIGTERM'));
    spawned.push(child);
    return child;
  }) };
});

function asWindows(): () => void {
  const platform = Object.getOwnPropertyDescriptor(process, 'platform')!;
  Object.defineProperty(process, 'platform', { value: 'win32' });
  return () => Object.defineProperty(process, 'platform', platform);
}

it('answers window owner queries in request order from one long-lived hidden PowerShell', async () => {
  const restore = asWindows();
  const before = spawned.length;
  try {
    const first = windowsSourceOwners([{ id: 'window:345:0' }, { id: 'screen:1:0' }]);
    const second = windowsSourceOwners([{ id: 'window:346:0' }, { id: 'window:347:0' }]);
    await vi.waitFor(() => expect(spawned).toHaveLength(before + 1));
    const child = spawned[before];
    expect(spawn).toHaveBeenLastCalledWith('powershell.exe', ['-NoLogo', '-NoProfile', '-NonInteractive', '-EncodedCommand', expect.any(String)],
      { stdio: ['pipe', 'pipe', 'ignore'], windowsHide: true });
    await vi.waitFor(() => expect(child.stdin.write).toHaveBeenCalledWith('345\n'));
    expect(child.stdin.write).toHaveBeenCalledOnce();
    child.stdout.emit('data', '[{"handle":"345","processId":234}]\r\n');
    expect(await first).toEqual(new Map([['window:345:0', 234]]));
    await vi.waitFor(() => expect(child.stdin.write).toHaveBeenLastCalledWith('346,347\n'));
    child.stdout.emit('data', '[{"handle":"346","processId":0},');
    child.stdout.emit('data', '{"handle":"347","processId":235}]\r\n');
    expect(await second).toEqual(new Map([['window:347:0', 235]]));
    expect(spawned).toHaveLength(before + 1);
  } finally { spawned.at(-1)?.kill(); restore(); }
});

it('replaces an unresponsive or exited owner helper and stops an idle one', async () => {
  const restore = asWindows();
  const before = spawned.length;
  vi.useFakeTimers();
  try {
    const stalled = windowsSourceOwners([{ id: 'window:345:0' }]);
    await vi.advanceTimersByTimeAsync(15_000);
    expect(await stalled).toEqual(new Map());
    expect(spawned[before].kill).toHaveBeenCalledOnce();
    const interrupted = windowsSourceOwners([{ id: 'window:345:0' }]);
    await vi.advanceTimersByTimeAsync(0);
    spawned[before + 1].emit('exit', 1, null);
    expect(await interrupted).toEqual(new Map());
    const answered = windowsSourceOwners([{ id: 'window:345:0' }]);
    await vi.advanceTimersByTimeAsync(0);
    const helper = spawned[before + 2];
    helper.stdout.emit('data', '[{"handle":"345","processId":234}]\n');
    expect(await answered).toEqual(new Map([['window:345:0', 234]]));
    await vi.advanceTimersByTimeAsync(29_999);
    expect(helper.kill).not.toHaveBeenCalled();
    await vi.advanceTimersByTimeAsync(1);
    expect(helper.kill).toHaveBeenCalledOnce();
    expect(spawned).toHaveLength(before + 3);
  } finally { vi.useRealTimers(); restore(); }
});

it('captures only a uniquely matched target window and resizes to native coordinates', async () => {
  const png = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+/p9sAAAAASUVORK5CYII=', 'base64');
  const image = { isEmpty: () => false, resize: vi.fn(() => ({ toPNG: () => png })) };
  const getSources = vi.fn(async () => [{ id: 'window:1:0', name: 'Untitled - Notepad', thumbnail: image }]);
  const bound = { pid: 234, targetWindowId: 1, getSources: getSources as any, owners: async () => new Map([['window:1:0', 234]]) };
  expect(await captureComputerUseWindow('Notepad', 1, 1, bound)).toBe(png.toString('base64'));
  expect(await captureComputerUseWindow('Notepad.exe', 1, 1, bound)).toBe(png.toString('base64'));
  expect(image.resize).toHaveBeenCalledWith({ width: 1, height: 1, quality: 'best' });
  expect(getSources).toHaveBeenCalledWith({ types: ['window'], thumbnailSize: { width: 1, height: 1 }, fetchWindowIcons: false });
  expect(await captureComputerUseWindow('Notepad', 0, 800, bound)).toBeNull();
  expect(getSources).toHaveBeenCalledTimes(2);
});

it('captures a maximized window wider than a 4096 px display, but not beyond the decoder limit', async () => {
  const getSources = vi.fn(async () => []);
  const bound = { pid: 234, targetWindowId: 1, getSources: getSources as any, owners: async () => new Map() };
  expect(await captureComputerUseWindow('Word', 4122, 2158, bound)).toBeNull();
  expect(getSources).toHaveBeenCalledWith({ types: ['window'], thumbnailSize: { width: 4122, height: 2158 }, fetchWindowIcons: false });
  getSources.mockClear();
  expect(await captureComputerUseWindow('Word', 8193, 2158, bound)).toBeNull();
  expect(getSources).not.toHaveBeenCalled();
});

it('rejects ambiguous app titles rather than showing a different user window', async () => {
  const image = { isEmpty: () => false, resize: vi.fn() };
  const getSources = vi.fn(async () => [
    { id: 'window:1:0', name: 'Untitled - Notepad', thumbnail: image },
    { id: 'window:2:0', name: 'Notes - Notepad', thumbnail: image },
  ]);
  expect(await captureComputerUseWindow('Notepad', 100, 100, { getSources: getSources as any })).toBeNull();
  expect(image.resize).not.toHaveBeenCalled();
});

it('selects by owning PID even when the window title contains no app name', async () => {
  const png = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+/p9sAAAAASUVORK5CYII=', 'base64');
  const image = { isEmpty: () => false, resize: () => ({ toPNG: () => png }) };
  const getSources = vi.fn(async () => [
    { id: 'window:1:0', name: 'Untitled', thumbnail: image },
    { id: 'window:2:0', name: 'Other', thumbnail: image },
  ]);
  const owners = vi.fn(async () => new Map([['window:1:0', 234], ['window:2:0', 999]]));
  expect(await captureComputerUseWindow('Notepad', 1, 1, { pid: 234, targetWindowId: 1, getSources: getSources as any, owners }))
    .toBe(png.toString('base64'));
  expect(owners).toHaveBeenCalledOnce();
});

it('returns a window frame only to the currently owned child', async () => {
  const child = Object.assign(new EventEmitter(), { connected: true, send: vi.fn() });
  let active = true;
  const capture = vi.fn(async () => 'frame');
  const dispose = bindComputerUseWindowCaptureIpc(child as any, () => active, capture);
  const request = { type: 'memmy:computer-use-window-capture:request',
    requestId: '00000000-0000-0000-0000-000000000001', target: 'Notepad', width: 100, height: 100, pid: 234, targetWindowId: 345 };
  child.emit('message', request);
  await vi.waitFor(() => expect(child.send).toHaveBeenCalledWith(expect.objectContaining({
    type: 'memmy:computer-use-window-capture:response', requestId: request.requestId, pngBase64: 'frame',
  }), expect.any(Function)));
  expect(capture).toHaveBeenCalledWith('Notepad', 100, 100, { pid: 234, targetWindowId: 345 });
  active = false;
  child.emit('message', request);
  expect(capture).toHaveBeenCalledTimes(1);
  dispose();
  expect(child.listenerCount('message')).toBe(0);
});

it('keeps the exact HWND within the same process despite duplicate or renamed document titles', async () => {
  const png = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+/p9sAAAAASUVORK5CYII=', 'base64');
  const chosen = { isEmpty: () => false, resize: vi.fn(() => ({ toPNG: () => png })) };
  const other = { isEmpty: () => false, resize: vi.fn() };
  const getSources = vi.fn(async () => [
    { id: 'window:1:0', name: 'Untitled - WPS', thumbnail: other },
    { id: 'window:4294967297:0', name: '杭州西湖', thumbnail: chosen },
  ]);
  const options = { pid: 234, targetWindowId: 4294967297, getSources: getSources as any,
    owners: async () => new Map([['window:1:0', 234], ['window:4294967297:0', 234]]) };
  expect(await captureComputerUseWindow('WPS', 1, 1, options)).toBe(png.toString('base64'));
  expect(other.resize).not.toHaveBeenCalled();
  expect(await captureComputerUseWindow('WPS', 1, 1, { ...options, targetWindowId: 2 })).toBeNull();
  expect(await captureComputerUseWindow('WPS', 1, 1, { ...options, pid: 999 })).toBeNull();
  expect(await captureComputerUseWindow('WPS', 1, 1, { ...options, owners: async () => new Map() })).toBeNull();
});

it('rejects unbound or unsafe capture IPC before capture or response', async () => {
  const child = Object.assign(new EventEmitter(), { connected: true, send: vi.fn() });
  const capture = vi.fn(async () => 'frame');
  const dispose = bindComputerUseWindowCaptureIpc(child as any, () => true, capture);
  const request = { type: 'memmy:computer-use-window-capture:request', requestId: '00000000-0000-0000-0000-000000000001', target: 'WPS', width: 100, height: 100, pid: 234 };
  for (const targetWindowId of [undefined, 0, -1, 1.5, Number.MAX_SAFE_INTEGER + 1]) child.emit('message', { ...request, targetWindowId });
  await Promise.resolve();
  expect(capture).not.toHaveBeenCalled();
  expect(child.send).not.toHaveBeenCalled();
  dispose();
});
