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
    { type: 'image', mimeType: 'image/png', data: OCCLUDED_PNG }] }, 'Notepad', null, new WindowsWindowCaptureClient(parent as any));
  expect(result.isError).toBeUndefined();
  expect(result.content[1].data).toBe(PNG);
  expect(parent.send).toHaveBeenCalledWith(expect.objectContaining({ target: 'Notepad', width: 1, height: 1, pid: 234 }), expect.any(Function));
  expect(parent.listenerCount('message')).toBe(0);
});

it('withholds the native screen copy when the isolated window frame is unavailable', async () => {
  const result = await replaceOccludedWindowsFrame({ content: [{ type: 'image', mimeType: 'image/png', data: PNG }] },
    'Notepad', null, { capture: async () => null });
  expect(result.isError).toBe(true);
  expect(result.content).not.toEqual(expect.arrayContaining([expect.objectContaining({ type: 'image' })]));
});
