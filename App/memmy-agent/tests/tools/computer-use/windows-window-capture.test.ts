import { EventEmitter } from 'node:events';
import { expect, it, vi } from 'vitest';
import { WindowsWindowCaptureClient, replaceOccludedWindowsFrame } from '../../../src/tools/computer-use/windows-window-capture.js';

const PNG = 'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+/p9sAAAAASUVORK5CYII=';
const OCCLUDED_PNG = 'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+/p9sAAAAASUVORK5CYIA=';

it('replaces an occlusion-prone native image with the target window frame', async () => {
  const parent = Object.assign(new EventEmitter(), { connected: true, send: vi.fn((message: any, callback: any) => {
    callback?.(null);
    queueMicrotask(() => parent.emit('message', { type: 'memmy:computer-use-window-capture:response',
      requestId: message.requestId, pngBase64: PNG }));
    return true;
  }) });
  const result = await replaceOccludedWindowsFrame({ content: [{ type: 'text', text: 'App=Notepad (pid 234)\nWindow=Untitled' },
    { type: 'image', mimeType: 'image/png', data: OCCLUDED_PNG }],
    _meta: { memmyComputerUse: { pid: 234, targetWindowID: 0x100000034, observationID: 'one' } } },
    'Notepad', null, new WindowsWindowCaptureClient(parent as any));
  expect(result.isError).toBeUndefined();
  expect(result.content[1].data).toBe(PNG);
  expect(parent.send).toHaveBeenCalledWith(expect.objectContaining({ target: 'Notepad', width: 1, height: 1,
    pid: 234, targetWindowId: 0x100000034 }), expect.any(Function));
  expect(result._meta.memmyComputerUse).toMatchObject({ screenshotIsolated: true,
    screenshotSource: 'desktop-capture', observationID: 'one', targetWindowID: 0x100000034 });
  expect(parent.listenerCount('message')).toBe(0);
});

it('never recaptures a trusted native isolated screenshot from a different source', async () => {
  const capture = vi.fn();
  const result = { content: [{ type: 'image', mimeType: 'image/png', data: PNG }],
    _meta: { memmyComputerUse: { targetWindowID: 52, pid: 20, screenshotIsolated: true } } };
  expect(await replaceOccludedWindowsFrame(result, 'Notepad', null, { capture })).toBe(result);
  expect(capture).not.toHaveBeenCalled();
});

it('preserves a trusted native popup composite without issuing a root-only thumbnail capture', async () => {
  const capture = vi.fn();
  const result = { content: [{ type: 'image', mimeType: 'image/png', data: PNG }],
    _meta: { memmyComputerUse: { targetWindowID: 52, pid: 20, relatedWindowIDs: [53], screenshotIsolated: true } } };
  expect(await replaceOccludedWindowsFrame(result, 'WPS', null, { capture })).toBe(result);
  expect(capture).not.toHaveBeenCalled();
});

it.each([{ images: [] }, { images: [{ type: 'image', mimeType: 'image/png', data: OCCLUDED_PNG }] }])(
  'withholds root-only replacement after a native popup composite fails, while forwarding its verified scope %j',
  async ({ images }) => {
    const capture = vi.fn().mockResolvedValue(PNG);
    const metadata = { targetWindowID: 52, pid: 20, relatedWindowIDs: [53],
      windowBounds: { x: 0, y: 0, width: 1, height: 1 }, screenshotIsolated: false };
    const result = await replaceOccludedWindowsFrame({ content: [{ type: 'text', text: 'Verified native tree' }, ...images],
      _meta: { memmyComputerUse: metadata } }, 'WPS', null, { capture });
    expect(capture).not.toHaveBeenCalled();
    expect(result.isError).toBeUndefined();
    expect(result._meta.memmyComputerUse).toBe(metadata);
    expect(result.content.some((item: any) => item.type === 'image')).toBe(false);
    expect(result.content.at(-1).text).toContain('owned popups could not be captured reliably');
  });

it('captures the exact HWND from native bounds when PrintWindow produced no reliable PNG', async () => {
  const capture = vi.fn().mockResolvedValue(PNG);
  const result = await replaceOccludedWindowsFrame({ content: [{ type: 'text', text: 'Window state without a reliable native frame' }],
    _meta: { memmyComputerUse: { targetWindowID: 0x100000034, pid: 20, observationID: 'native-observation',
      windowBounds: { x: -200, y: 100, width: 1, height: 1 }, screenshotIsolated: false } } },
    'WPS', null, { capture });
  expect(capture).toHaveBeenCalledWith('WPS', 1, 1, null, 20, 0x100000034);
  expect(result.content[1]).toEqual({ type: 'image', mimeType: 'image/png', data: PNG });
  expect(result._meta.memmyComputerUse).toMatchObject({ observationID: 'native-observation',
    screenshotIsolated: true, screenshotSource: 'desktop-capture' });
});

it('requests a maximized window wider than a 4096 px display, and nothing beyond the decoder limit', async () => {
  const capture = vi.fn().mockResolvedValue(null);
  const observe = (width: number) => replaceOccludedWindowsFrame({ content: [{ type: 'text', text: 'Word' }],
    _meta: { memmyComputerUse: { targetWindowID: 52, pid: 20, observationID: 'maximized',
      windowBounds: { x: -13, y: -13, width, height: 2158 }, screenshotIsolated: false } } }, 'Word', null, { capture });
  await observe(4122);
  expect(capture).toHaveBeenCalledWith('Word', 4122, 2158, null, 20, 52);
  capture.mockClear();
  expect((await observe(8193)).isError).toBe(true);
  expect(capture).not.toHaveBeenCalled();
});

it.each([
  { pid: 20 }, { targetWindowID: 52 }, { pid: 20, targetWindowID: Number.MAX_SAFE_INTEGER + 1 },
])('refuses image replacement without exact trusted PID/HWND metadata %j', async metadata => {
  const capture = vi.fn();
  const result = await replaceOccludedWindowsFrame({ content: [{ type: 'image', mimeType: 'image/png', data: PNG }],
    _meta: { memmyComputerUse: metadata } }, 'Notepad', null, { capture });
  expect(result.isError).toBe(true);
  expect(capture).not.toHaveBeenCalled();
  expect(result._meta.memmyComputerUse).toEqual(metadata);
});

it('rejects malformed IPC images and removes its listeners', async () => {
  const parent = Object.assign(new EventEmitter(), { connected: true, send: vi.fn((message: any, callback: any) => {
    callback?.(null);
    queueMicrotask(() => parent.emit('message', { type: 'memmy:computer-use-window-capture:response',
      requestId: message.requestId, pngBase64: PNG }));
    return true;
  }) });
  const client = new WindowsWindowCaptureClient(parent as any);
  expect(await client.capture('Notepad', 2, 1, null, 20, 52)).toBeNull();
  expect(parent.listenerCount('message')).toBe(0);
  expect(parent.listenerCount('disconnect')).toBe(0);
});

it('does not issue a process/title-only IPC capture request', async () => {
  const parent = Object.assign(new EventEmitter(), { connected: true, send: vi.fn() });
  expect(await new WindowsWindowCaptureClient(parent as any).capture('Notepad', 1, 1, null, 20)).toBeNull();
  expect(parent.send).not.toHaveBeenCalled();
});

it('withholds the native screen copy when the isolated window frame is unavailable', async () => {
  const result = await replaceOccludedWindowsFrame({ content: [{ type: 'image', mimeType: 'image/png', data: PNG }] },
    'Notepad', null, { capture: async () => null });
  expect(result.isError).toBe(true);
  expect(result.content).not.toEqual(expect.arrayContaining([expect.objectContaining({ type: 'image' })]));
});
