import { expect, it, vi } from 'vitest';
import { EventEmitter } from 'node:events';
import { bindComputerUseWindowCaptureIpc, captureComputerUseWindow } from '../src/main/computer-use-window-capture.js';

vi.mock('electron', () => ({ desktopCapturer: { getSources: vi.fn() } }));

it('captures only a uniquely matched target window and resizes to native coordinates', async () => {
  const png = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+/p9sAAAAASUVORK5CYII=', 'base64');
  const image = { isEmpty: () => false, resize: vi.fn(() => ({ toPNG: () => png })) };
  const getSources = vi.fn(async () => [{ id: 'window:1:0', name: 'Untitled - Notepad', thumbnail: image }]);
  expect(await captureComputerUseWindow('Notepad', 1, 1, { getSources: getSources as any })).toBe(png.toString('base64'));
  expect(await captureComputerUseWindow('Notepad.exe', 1, 1, { getSources: getSources as any })).toBe(png.toString('base64'));
  expect(image.resize).toHaveBeenCalledWith({ width: 1, height: 1, quality: 'best' });
  expect(getSources).toHaveBeenCalledWith({ types: ['window'], thumbnailSize: { width: 1, height: 1 }, fetchWindowIcons: false });
  expect(await captureComputerUseWindow('Notepad', 0, 800, { getSources: getSources as any })).toBeNull();
  expect(getSources).toHaveBeenCalledTimes(2);
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
  expect(await captureComputerUseWindow('Notepad', 1, 1, { pid: 234, getSources: getSources as any, owners }))
    .toBe(png.toString('base64'));
  expect(owners).toHaveBeenCalledOnce();
});

it('returns a window frame only to the currently owned child', async () => {
  const child = Object.assign(new EventEmitter(), { connected: true, send: vi.fn() });
  let active = true;
  const capture = vi.fn(async () => 'frame');
  const dispose = bindComputerUseWindowCaptureIpc(child as any, () => active, capture);
  const request = { type: 'memmy:computer-use-window-capture:request',
    requestId: '00000000-0000-0000-0000-000000000001', target: 'Notepad', width: 100, height: 100, pid: 234 };
  child.emit('message', request);
  await vi.waitFor(() => expect(child.send).toHaveBeenCalledWith(expect.objectContaining({
    type: 'memmy:computer-use-window-capture:response', requestId: request.requestId, pngBase64: 'frame',
  }), expect.any(Function)));
  expect(capture).toHaveBeenCalledWith('Notepad', 100, 100, { pid: 234 });
  active = false;
  child.emit('message', request);
  expect(capture).toHaveBeenCalledTimes(1);
  dispose();
  expect(child.listenerCount('message')).toBe(0);
});
