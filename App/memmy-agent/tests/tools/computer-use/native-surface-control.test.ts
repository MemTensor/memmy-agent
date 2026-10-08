import { afterEach, expect, it, vi } from 'vitest';
import { createNativeSurfaceActionHandler, nativeSurfaceKey } from '../../../src/tools/computer-use/native-surface-control.js';
import { revealNativeWindow } from '../../../src/tools/computer-use/mac-focus-guard.js';

vi.mock('../../../src/tools/computer-use/mac-focus-guard.js', () => ({ revealNativeWindow: vi.fn(async () => true) }));

const PNG_A = 'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+/p9sAAAAASUVORK5CYII=';
const PNG_B = 'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+/p9sAAAAASUVORK5CYIIA=';
const pngWithSize = (width: number, height: number) => {
  const bytes = Buffer.from(PNG_A, 'base64');
  bytes.writeUInt32BE(width, 16);
  bytes.writeUInt32BE(height, 20);
  return bytes.toString('base64');
};
const frame = (data: string) => ({ content: [{ type: 'image', mimeType: 'image/png', data }] });
const identity = { sessionKey: 's', channel: 'gui', chatId: 'c', targetId: 'Notes' };
const click = { ...identity, type: 'memmy:computer-use-surface:action', surface: 'computer', action: 'click', x: 0.5, y: 0.5 } as const;

afterEach(() => { vi.unstubAllEnvs(); vi.unstubAllGlobals(); });

it('converts DOM shortcut names to the native helper key format', () => {
  expect(nativeSurfaceKey('Meta+Shift+ArrowDown')).toBe('super+shift+Down');
  expect(nativeSurfaceKey('Control+c')).toBe('ctrl+c');
  expect(nativeSurfaceKey('Enter')).toBe('Return');
  expect(nativeSurfaceKey('F20')).toBeNull();
});

it('refreshes a changed app frame and refuses to click the stale coordinates', async () => {
  vi.stubEnv('MEMMY_DESKTOP_MANAGED_GATEWAY', '1');
  const send = vi.fn();
  vi.stubGlobal('process', Object.assign(Object.create(process), { send, connected: true }));
  const invoke = vi.fn(async (..._args: any[]) => frame(PNG_B));
  const handler = createNativeSurfaceActionHandler({
    managed: { invoke }, context: {} as any, timeout: 30, appName: 'Notes', identity, platform: 'darwin',
    initialFrame: { url: `data:image/png;base64,${PNG_A}`, width: 1, height: 1 },
  });
  await handler(click);
  expect(invoke.mock.calls.map(call => call[0])).toEqual(['get_app_state']);
  expect(send).toHaveBeenCalledWith(expect.objectContaining({ title: expect.stringContaining('画面已变化') }), expect.any(Function));
});

it('clicks only after verifying the current frame, then refreshes it', async () => {
  vi.stubEnv('MEMMY_DESKTOP_MANAGED_GATEWAY', '1');
  const send = vi.fn();
  vi.stubGlobal('process', Object.assign(Object.create(process), { send, connected: true }));
  const invoke = vi.fn(async (name: string, ..._args: any[]) => name === 'click' ? { content: [] } : frame(PNG_A));
  const handler = createNativeSurfaceActionHandler({
    managed: { invoke }, context: {} as any, timeout: 30, appName: 'Notes', identity, platform: 'darwin',
    initialFrame: { url: `data:image/png;base64,${PNG_A}`, width: 1, height: 1 },
  });
  await handler(click);
  expect(invoke.mock.calls.map(call => call[0])).toEqual(['get_app_state', 'click', 'get_app_state']);
  expect(invoke.mock.calls[1]?.[1]).toEqual({ app: 'Notes', x: 0, y: 0, click_method: 'sky_click' });
  expect(send).toHaveBeenCalledWith(expect.objectContaining({ title: 'Notes', imageDataUrl: `data:image/png;base64,${PNG_A}` }), expect.any(Function));
});

it('does not dispatch a queued native action or reopen the PiP after its turn is cancelled', async () => {
  vi.stubEnv('MEMMY_DESKTOP_MANAGED_GATEWAY', '1');
  const send = vi.fn();
  vi.stubGlobal('process', Object.assign(Object.create(process), { send, connected: true }));
  let releaseState!: () => void;
  const state = new Promise<void>(resolve => { releaseState = resolve; });
  const signal = new AbortController();
  const invoke = vi.fn(async (name: string, _args: Record<string, unknown>, _timeout: number,
    _context: unknown, _signal?: AbortSignal | null) => {
    if (name === 'get_app_state') await state;
    return frame(PNG_A);
  });
  const handler = createNativeSurfaceActionHandler({
    managed: { invoke }, context: {} as any, timeout: 30, appName: 'Notes', identity,
    platform: 'darwin', signal: signal.signal,
    initialFrame: { url: `data:image/png;base64,${PNG_A}`, width: 1, height: 1 },
  });
  const first = handler(click);
  await vi.waitFor(() => expect(invoke).toHaveBeenCalledTimes(1));
  const queued = handler({ ...click, action: 'scroll', deltaY: 120 });
  signal.abort();
  releaseState();
  await Promise.all([first, queued]);
  expect(invoke.mock.calls.map(call => call[0])).toEqual(['get_app_state']);
  expect(send).not.toHaveBeenCalled();
  expect(invoke.mock.calls[0]?.[4]).toBe(signal.signal);
});

it('accepts a changed live video frame when the window size is still the same', async () => {
  vi.stubEnv('MEMMY_DESKTOP_MANAGED_GATEWAY', '1');
  vi.stubGlobal('process', Object.assign(Object.create(process), { send: vi.fn(), connected: true }));
  const invoke = vi.fn(async (name: string) => name === 'click' ? { content: [] } : frame(PNG_B));
  const handler = createNativeSurfaceActionHandler({
    managed: { invoke }, context: {} as any, timeout: 30, appName: 'Notes', identity, platform: 'darwin',
    initialFrame: { url: `data:image/png;base64,${PNG_A}`, width: 1, height: 1 },
  });
  await handler({ ...click, frameMode: 'live', frameWidth: 1, frameHeight: 1 });
  expect(invoke.mock.calls.map(call => call[0])).toEqual(['get_app_state', 'click', 'get_app_state']);
});

it('maps a live video click through the current target screenshot dimensions', async () => {
  const current = pngWithSize(2, 1);
  const invoke = vi.fn(async (name: string, _args: Record<string, unknown>) => name === 'click' ? { content: [] } : frame(current));
  const handler = createNativeSurfaceActionHandler({
    managed: { invoke }, context: {} as any, timeout: 30, appName: 'Notes', identity, platform: 'darwin',
    initialFrame: { url: `data:image/png;base64,${current}`, width: 2, height: 1 },
  });
  await handler({ ...click, x: 0.75, frameMode: 'live', frameWidth: 4, frameHeight: 2 });
  expect(invoke.mock.calls.map(call => call[0])).toEqual(['get_app_state', 'click', 'get_app_state']);
  expect(invoke.mock.calls[1]?.[1]).toEqual({ app: 'Notes', x: 1, y: 0, click_method: 'sky_click' });
});

it('refuses a live click when the video belongs to a different window shape', async () => {
  const current = pngWithSize(2, 1);
  const invoke = vi.fn(async (name: string, _args: Record<string, unknown>) => name === 'click' ? { content: [] } : frame(current));
  const handler = createNativeSurfaceActionHandler({
    managed: { invoke }, context: {} as any, timeout: 30, appName: 'Notes', identity, platform: 'darwin',
    initialFrame: { url: `data:image/png;base64,${current}`, width: 2, height: 1 },
  });
  await handler({ ...click, frameMode: 'live', frameWidth: 1, frameHeight: 1 });
  expect(invoke.mock.calls.map(call => call[0])).toEqual(['get_app_state']);
});

it('refuses a live click when the active window ID changed despite identical pixels and size', async () => {
  vi.stubEnv('MEMMY_DESKTOP_MANAGED_GATEWAY', '1');
  const send = vi.fn();
  vi.stubGlobal('process', Object.assign(Object.create(process), { send, connected: true }));
  const result = { ...frame(PNG_A), _meta: { memmyComputerUse: { targetWindowID: 52, pid: 123 } } };
  const invoke = vi.fn(async (_name: string, _args?: unknown) => result);
  const handler = createNativeSurfaceActionHandler({
    managed: { invoke }, context: {} as any, timeout: 30, appName: 'TextEdit', identity, platform: 'darwin',
    initialFrame: { url: `data:image/png;base64,${PNG_A}`, width: 1, height: 1, targetWindowId: 51 },
  });
  await handler({ ...click, targetWindowId: 51, frameMode: 'live', frameWidth: 1, frameHeight: 1 });
  expect(invoke.mock.calls.map(call => call[0])).toEqual(['get_app_state']);
  expect(send).toHaveBeenCalledWith(expect.objectContaining({ targetWindowId: 52,
    title: expect.stringContaining('目标窗口已切换') }), expect.any(Function));
});

it('refuses live action when a previously identified target loses its window ID', async () => {
  const invoke = vi.fn(async (_name: string, _args?: unknown) => frame(PNG_A));
  const handler = createNativeSurfaceActionHandler({
    managed: { invoke }, context: {} as any, timeout: 30, appName: 'TextEdit', identity, platform: 'darwin',
    initialFrame: { url: `data:image/png;base64,${PNG_A}`, width: 1, height: 1, targetWindowId: 51 },
  });
  await handler({ ...click, targetWindowId: 51, frameMode: 'live', frameWidth: 1, frameHeight: 1 });
  expect(invoke.mock.calls.map(call => call[0])).toEqual(['get_app_state']);
});

it('reveals only the exact Mac window after an explicit takeover action', async () => {
  const invoke = vi.fn(async (_name: string) => ({ ...frame(PNG_A),
    content: [{ type: 'text', text: 'App=Notes (pid 123)\nWindow=Notes' }, ...frame(PNG_A).content],
    _meta: { memmyComputerUse: { targetWindowID: 52 } } }));
  const handler = createNativeSurfaceActionHandler({
    managed: { invoke }, context: {} as any, timeout: 30, appName: 'Notes', identity, platform: 'darwin',
    initialFrame: { url: `data:image/png;base64,${PNG_A}`, width: 1, height: 1, targetWindowId: 52 },
  });
  await handler({ ...identity, type: 'memmy:computer-use-surface:action', surface: 'computer', action: 'open', targetWindowId: 52 });
  expect(revealNativeWindow).toHaveBeenCalledWith(123, 52);
  expect(invoke.mock.calls.map(call => call[0])).toEqual(['get_app_state']);
});

it('can reveal an existing exact Mac window when a hidden app has no fresh screenshot', async () => {
  vi.mocked(revealNativeWindow).mockClear();
  const invoke = vi.fn(async (_name: string) => ({ content: [{ type: 'text',
    text: 'App=Notes (pid 123)\nWindow=No on-screen window' }] }));
  const handler = createNativeSurfaceActionHandler({
    managed: { invoke }, context: {} as any, timeout: 30, appName: 'Notes', identity, platform: 'darwin',
    initialFrame: { url: `data:image/png;base64,${PNG_A}`, width: 1, height: 1, targetWindowId: 52 },
  });
  await handler({ ...identity, type: 'memmy:computer-use-surface:action', surface: 'computer', action: 'open', targetWindowId: 52 });
  expect(revealNativeWindow).toHaveBeenCalledWith(123, 52);
});

it('refuses takeover if the Mac target window changed since the PiP frame', async () => {
  vi.mocked(revealNativeWindow).mockClear();
  const send = vi.fn();
  vi.stubEnv('MEMMY_DESKTOP_MANAGED_GATEWAY', '1');
  vi.stubGlobal('process', Object.assign(Object.create(process), { send, connected: true }));
  const invoke = vi.fn(async (_name: string) => ({
    content: [{ type: 'text', text: 'App=Notes (pid 123)\nWindow=Notes' }, ...frame(PNG_A).content],
    _meta: { memmyComputerUse: { targetWindowID: 53 } },
  }));
  const handler = createNativeSurfaceActionHandler({
    managed: { invoke }, context: {} as any, timeout: 30, appName: 'Notes', identity, platform: 'darwin',
    initialFrame: { url: `data:image/png;base64,${PNG_A}`, width: 1, height: 1, targetWindowId: 52 },
  });
  await handler({ ...identity, type: 'memmy:computer-use-surface:action', surface: 'computer', action: 'open', targetWindowId: 52 });
  expect(revealNativeWindow).not.toHaveBeenCalled();
  expect(send).toHaveBeenCalledWith(expect.objectContaining({ targetWindowId: 53,
    title: expect.stringContaining('目标窗口已切换') }), expect.any(Function));
});

it('posts Windows preview clicks to the target HWND without using the macOS-only SkyLight path', async () => {
  const invoke = vi.fn(async (name: string, _args: Record<string, unknown>) => name === 'click' ? { content: [] } : frame(PNG_A));
  const handler = createNativeSurfaceActionHandler({
    managed: { invoke }, context: {} as any, timeout: 30, appName: 'Notepad', identity,
    platform: 'win32', initialFrame: { url: `data:image/png;base64,${PNG_A}`, width: 1, height: 1 },
  });
  await handler(click);
  expect(invoke.mock.calls[1]?.[0]).toBe('click');
  expect(invoke.mock.calls[1]?.[1]).toEqual({ app: 'Notepad', x: 0, y: 0, click_method: 'app_post' });
});

it('sends a desktop preview wheel to the target window at the selected coordinate', async () => {
  const invoke = vi.fn(async (name: string, _args: Record<string, unknown>) => name === 'scroll' ? { content: [] } : frame(PNG_A));
  const handler = createNativeSurfaceActionHandler({
    managed: { invoke }, context: {} as any, timeout: 30, appName: 'Notepad', identity,
    platform: 'win32', initialFrame: { url: `data:image/png;base64,${PNG_A}`, width: 1, height: 1 },
  });
  await handler({ ...click, action: 'scroll', deltaY: 120, frameMode: 'live', frameWidth: 1, frameHeight: 1 });
  expect(invoke.mock.calls.map(call => call[0])).toEqual(['get_app_state', 'scroll', 'get_app_state']);
  expect(invoke.mock.calls[1]?.[1]).toEqual({ app: 'Notepad', x: 0, y: 0, direction: 'down', pages: 1 });
});

it('bounds a wheel burst while retaining its latest position and the following click order', async () => {
  const image = pngWithSize(4, 2);
  let releaseFirstState!: () => void;
  const firstState = new Promise<void>(resolve => { releaseFirstState = resolve; });
  let first = true;
  const invoke = vi.fn(async (name: string, _args: Record<string, unknown>) => {
    if (name === 'get_app_state') {
      if (first) { first = false; await firstState; }
      return frame(image);
    }
    return { content: [] };
  });
  const handler = createNativeSurfaceActionHandler({
    managed: { invoke }, context: {} as any, timeout: 30, appName: 'Notes', identity, platform: 'darwin',
    initialFrame: { url: `data:image/png;base64,${image}`, width: 4, height: 2 },
  });
  const wheel = (x: number) => handler({ ...click, action: 'scroll', deltaY: 202, x, y: 0.5 });
  const firstWheel = wheel(0.1);
  await vi.waitFor(() => expect(invoke.mock.calls.length).toBe(1));
  const burst = Array.from({ length: 10 }, (_, i) => wheel(i === 9 ? 0.75 : 0.25));
  const followingClick = handler(click);
  releaseFirstState();
  await Promise.all([firstWheel, ...burst, followingClick]);
  expect(invoke.mock.calls.map(call => call[0])).toEqual([
    'get_app_state', 'scroll', 'get_app_state',
    'get_app_state', 'scroll', 'get_app_state',
    'get_app_state', 'click', 'get_app_state',
  ]);
  expect(invoke.mock.calls[4]?.[1]).toEqual({ app: 'Notes', x: 3, y: 1, direction: 'down', pages: 3 });
});

it('replaces an unsent wheel direction and does not merge across a click', async () => {
  let releaseFirstState!: () => void;
  const firstState = new Promise<void>(resolve => { releaseFirstState = resolve; });
  let first = true;
  const invoke = vi.fn(async (name: string, _args: Record<string, unknown>) => {
    if (name === 'get_app_state') {
      if (first) { first = false; await firstState; }
      return frame(PNG_A);
    }
    return { content: [] };
  });
  const handler = createNativeSurfaceActionHandler({
    managed: { invoke }, context: {} as any, timeout: 30, appName: 'Notes', identity, platform: 'darwin',
    initialFrame: { url: `data:image/png;base64,${PNG_A}`, width: 1, height: 1 },
  });
  const wheel = (deltaY: number) => handler({ ...click, action: 'scroll', deltaY });
  const firstWheel = wheel(120);
  await vi.waitFor(() => expect(invoke.mock.calls.length).toBe(1));
  const pendingDown = wheel(202);
  const pendingReverse = wheel(-120);
  const between = handler(click);
  const afterClick = wheel(120);
  releaseFirstState();
  await Promise.all([firstWheel, pendingDown, pendingReverse, between, afterClick]);
  expect(invoke.mock.calls.filter(call => call[0] === 'scroll').map(call => call[1])).toEqual([
    { app: 'Notes', x: 0, y: 0, direction: 'down', pages: 1 },
    { app: 'Notes', x: 0, y: 0, direction: 'up', pages: 1 },
    { app: 'Notes', x: 0, y: 0, direction: 'down', pages: 1 },
  ]);
  expect(invoke.mock.calls.map(call => call[0])).toEqual([
    'get_app_state', 'scroll', 'get_app_state',
    'get_app_state', 'scroll', 'get_app_state',
    'get_app_state', 'click', 'get_app_state',
    'get_app_state', 'scroll', 'get_app_state',
  ]);
});
