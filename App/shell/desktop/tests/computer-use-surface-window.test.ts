import { expect, it, vi } from 'vitest';
import { Script, runInNewContext } from 'node:vm';
import { readFileSync } from 'node:fs';
import { desktopCapturer } from 'electron';
import { createComputerUseSurfaceWindows } from '../src/main/computer-use-surface-window.js';

const html = readFileSync(new URL('../src/main/computer-use-surface.html', import.meta.url), 'utf8');

function renderedEpoch(window: any, source: string): number {
  const script = window.webContents.executeJavaScript.mock.calls
    .map(([value]: [string]) => value).filter((value: string) => value.includes(JSON.stringify(source))).at(-1);
  const epoch = script?.match(/,(\d+),(?:true|false)\)$/)?.[1];
  if (!epoch) throw new Error(`No rendered epoch for ${source}`);
  return Number(epoch);
}

const state = vi.hoisted(() => ({ windows: [] as any[], listener: null as any, listeners: new Map<string, any>(),
  sources: [] as Array<{ id: string; name: string }>, mediaHandler: null as any,
  captureGate: null as Promise<void> | null }));
vi.mock('electron', () => ({
  screen: { getPrimaryDisplay: () => ({ workArea: { x: 0, y: 0, width: 1200, height: 800 } }) },
  desktopCapturer: { getSources: vi.fn(async () => { await state.captureGate; return state.sources; }) },
  session: { fromPartition: vi.fn(() => ({ setDisplayMediaRequestHandler: vi.fn((handler: any) => { state.mediaHandler = handler; }) })) },
  ipcMain: { on: vi.fn((channel: string, listener: any) => {
    state.listeners.set(channel, listener);
    if (channel === 'memmy:computer-use-surface:interaction') state.listener = listener;
  }), removeListener: vi.fn((channel: string) => state.listeners.delete(channel)) },
  BrowserWindow: class {
    private closed = false;
    private bounds: { x: number; y: number; width: number; height: number };
    private onClosed?: () => void;
    private onReady?: () => void;
    showInactive = vi.fn();
    webContents = {
      once: vi.fn((_name: string, callback: () => void) => { this.onReady = callback; }),
      executeJavaScript: vi.fn(async (_script: string, _gesture?: boolean) => undefined),
    };
    constructor(public options: any) {
      state.windows.push(this);
      this.bounds = { x: options.x, y: options.y, width: options.width, height: options.height };
    }
    getBounds = vi.fn(() => this.bounds);
    setBounds = vi.fn((bounds: any) => { this.bounds = bounds; });
    on(_name: string, callback: () => void) { this.onClosed = callback; }
    isDestroyed() { return this.closed; }
    loadFile = vi.fn(async (_path: string) => { this.onReady?.(); });
    close = vi.fn(() => { this.closed = true; this.onClosed?.(); });
  },
}));

it('shows a resizable preview without taking focus, updates it, and closes with the session', async () => {
  state.sources = [];
  state.windows.length = 0;
  const surfaces = createComputerUseSurfaceWindows();
  const message = { type: 'memmy:computer-use-surface:update', surface: 'browser',
    sessionKey: 's', channel: 'gui', chatId: 'c', targetId: 'tab', title: 'Page',
    imageDataUrl: 'data:image/jpeg;base64,YWJj' } as const;
  const sendAction = vi.fn();
  surfaces.update(message, sendAction);
  await Promise.resolve();
  const window = state.windows[0];
  expect(window.loadFile.mock.calls[0][0]).toMatch(/computer-use-surface\.html$/);
  const rendererScript = html.match(/<script>([\s\S]*?)<\/script>/)?.[1];
  expect(rendererScript).toBeTruthy();
  expect(() => new Script(rendererScript!)).not.toThrow();
  expect(rendererScript).toContain("video.addEventListener('click',forwardClick)");
  expect(window.options.resizable).toBe(true);
  expect(window.showInactive).toHaveBeenCalledOnce();
  expect(window.webContents.executeJavaScript).toHaveBeenCalledOnce();
  surfaces.update({ ...message, title: 'Next' }, sendAction);
  expect(state.windows).toHaveLength(1);
  expect(window.webContents.executeJavaScript).toHaveBeenCalledTimes(2);
  state.listener({ sender: window.webContents }, { action: 'click', x: 0.25, y: 0.5, chatId: 'spoofed' });
  expect(sendAction).toHaveBeenCalledWith(expect.objectContaining({ action: 'open', chatId: 'c' }));
  expect(sendAction.mock.calls[0]?.[0]).not.toHaveProperty('x');
  surfaces.update({ ...message, type: 'memmy:computer-use-surface:close' });
  expect(window.close).toHaveBeenCalledOnce();
});

it('keeps the last native frame when a status-only update arrives', async () => {
  state.sources = [];
  state.windows.length = 0;
  const surfaces = createComputerUseSurfaceWindows('win32');
  const image = 'data:image/png;base64,YWJj';
  const message = { type: 'memmy:computer-use-surface:update', surface: 'computer',
    sessionKey: 's', channel: 'gui', chatId: 'c', targetId: 'Calculator', title: 'Calculator',
    imageDataUrl: image } as const;
  surfaces.update(message);
  await Promise.resolve();
  const window = state.windows[0];
  // An action failure/status transition must not replace the usable frame
  // with an empty image and a browser broken-image icon.
  surfaces.update({ ...message, title: 'Calculator · 操作未完成', imageDataUrl: undefined });
  const lastRender = window.webContents.executeJavaScript.mock.calls.at(-1)?.[0] as string;
  expect(lastRender).toContain(JSON.stringify(image));
  expect(lastRender).not.toContain('null,"computer"');
  surfaces.dispose();
});

it('does not render a broken image before the first frame arrives', async () => {
  state.sources = [];
  state.windows.length = 0;
  const surfaces = createComputerUseSurfaceWindows('win32');
  surfaces.update({ type: 'memmy:computer-use-surface:update', surface: 'computer',
    sessionKey: 's', channel: 'gui', chatId: 'c', targetId: 'Calculator', title: 'Calculator' });
  const rendererScript = html.match(/<script>([\s\S]*?)<\/script>/)?.[1];
  expect(rendererScript).toBeTruthy();
  expect(html).toContain('<img id="frame" alt="" hidden>');
  expect(html).toContain('#mode{display:none}');
  expect(() => new Script(rendererScript!)).not.toThrow();
  surfaces.dispose();
});

it('derives a stop action from the active native PiP turn rather than renderer identity', async () => {
  state.sources = [];
  state.windows.length = 0;
  const surfaces = createComputerUseSurfaceWindows('win32');
  const sendAction = vi.fn();
  const message = { type: 'memmy:computer-use-surface:update', surface: 'computer',
    sessionKey: 'session-one', channel: 'websocket', chatId: 'chat-one',
    targetId: 'Notes', turnId: 'active-turn', title: 'Notes' } as const;
  surfaces.update(message, sendAction);
  const window = state.windows[0];
  state.listener({ sender: window.webContents }, { action: 'interrupt',
    sessionKey: 'other-session', chatId: 'other-chat', turnId: 'old-turn' });
  expect(sendAction).toHaveBeenCalledWith({ type: 'memmy:computer-use-surface:action',
    surface: 'computer', sessionKey: 'session-one', channel: 'websocket',
    chatId: 'chat-one', targetId: 'Notes', turnId: 'active-turn', action: 'interrupt' });
  sendAction.mockClear();
  surfaces.update({ ...message, type: 'memmy:computer-use-surface:close' });
  expect(window.close).toHaveBeenCalledOnce();
  state.listener({ sender: window.webContents }, { action: 'interrupt' });
  expect(sendAction).not.toHaveBeenCalled();
  surfaces.dispose();
});

it('reconnects a continuous desktop capture after it ends without another surface update', async () => {
  state.sources = [{ id: 'window:123:0', name: 'Notes' }];
  state.windows.length = 0;
  const surfaces = createComputerUseSurfaceWindows();
  surfaces.update({ type: 'memmy:computer-use-surface:update', surface: 'computer',
    sessionKey: 's', channel: 'gui', chatId: 'c', targetId: 'Notes', title: 'Notes',
    imageDataUrl: 'data:image/png;base64,YWJj' });
  await vi.waitFor(() => expect(state.windows[0].webContents.executeJavaScript)
    .toHaveBeenCalledWith(expect.stringContaining('window:123:0'), true));
  const callback = vi.fn();
  state.mediaHandler({}, callback);
  expect(callback).toHaveBeenCalledWith({ video: state.sources[0] });
  const callsBefore = vi.mocked(desktopCapturer.getSources).mock.calls.length;
  const oldEpoch = renderedEpoch(state.windows[0], 'window:123:0');
  state.listeners.get('memmy:computer-use-surface:capture-ended')(
    { sender: state.windows[0].webContents }, 'window:123:0', oldEpoch);
  const unavailable = vi.fn();
  state.mediaHandler({}, unavailable);
  expect(unavailable).toHaveBeenCalledWith(null);
  await vi.waitFor(() => expect(vi.mocked(desktopCapturer.getSources).mock.calls.length)
    .toBeGreaterThan(callsBefore));
  await vi.waitFor(() => expect(state.windows[0].webContents.executeJavaScript)
    .toHaveBeenCalledWith(expect.stringContaining('"window:123:0",2,false)'), true));
  state.listeners.get('memmy:computer-use-surface:capture-ended')(
    { sender: state.windows[0].webContents }, 'window:123:0', oldEpoch);
  const current = vi.fn();
  state.mediaHandler({}, current);
  expect(current).toHaveBeenCalledWith({ video: state.sources[0] });
  surfaces.dispose();
});

it('bounds capture retries after repeated media permission rejections', async () => {
  state.sources = [{ id: 'window:123:0', name: 'Notes' }];
  state.windows.length = 0;
  const surfaces = createComputerUseSurfaceWindows();
  surfaces.update({ type: 'memmy:computer-use-surface:update', surface: 'computer',
    sessionKey: 's', channel: 'gui', chatId: 'c', targetId: 'Notes', title: 'Notes' });
  const window = state.windows[0];
  await vi.waitFor(() => expect(window.webContents.executeJavaScript)
    .toHaveBeenCalledWith(expect.stringContaining('"window:123:0"'), true));
  const initialCalls = vi.mocked(desktopCapturer.getSources).mock.calls.length;
  vi.useFakeTimers();
  try {
    for (const delay of [250, 1000, 3000]) {
      state.listeners.get('memmy:computer-use-surface:capture-ended')(
        { sender: window.webContents }, 'window:123:0', renderedEpoch(window, 'window:123:0'));
      await vi.advanceTimersByTimeAsync(delay);
    }
    expect(vi.mocked(desktopCapturer.getSources).mock.calls.length).toBe(initialCalls + 3);
    state.listeners.get('memmy:computer-use-surface:capture-ended')(
      { sender: window.webContents }, 'window:123:0', renderedEpoch(window, 'window:123:0'));
    await vi.advanceTimersByTimeAsync(20_000);
    surfaces.update({ type: 'memmy:computer-use-surface:update', surface: 'computer',
      sessionKey: 's', channel: 'gui', chatId: 'c', targetId: 'Notes', title: 'Notes' });
    expect(vi.mocked(desktopCapturer.getSources).mock.calls.length).toBe(initialCalls + 3);
  } finally { surfaces.dispose(); vi.useRealTimers(); }
});

it('cancels an old retry on target switch and close, and ignores its stale ended event', async () => {
  state.sources = [{ id: 'window:123:0', name: 'One - Notepad' }];
  state.windows.length = 0;
  const surfaces = createComputerUseSurfaceWindows('win32');
  const message = { type: 'memmy:computer-use-surface:update', surface: 'computer',
    sessionKey: 's', channel: 'gui', chatId: 'c', targetId: 'Notepad', title: 'Notepad',
    targetWindowId: 123 } as const;
  surfaces.update(message);
  const window = state.windows[0];
  await vi.waitFor(() => expect(window.webContents.executeJavaScript)
    .toHaveBeenCalledWith(expect.stringContaining('"window:123:0"'), true));
  const oldEpoch = renderedEpoch(window, 'window:123:0');
  state.listeners.get('memmy:computer-use-surface:capture-ended')(
    { sender: window.webContents }, 'window:123:0', oldEpoch);
  state.sources = [{ id: 'window:124:0', name: 'Two - Notepad' }];
  surfaces.update({ ...message, targetWindowId: 124 });
  await vi.waitFor(() => expect(window.webContents.executeJavaScript)
    .toHaveBeenCalledWith(expect.stringContaining('"window:124:0"'), true));
  const newEpoch = renderedEpoch(window, 'window:124:0');
  const callsBefore = vi.mocked(desktopCapturer.getSources).mock.calls.length;
  vi.useFakeTimers();
  try {
    state.listeners.get('memmy:computer-use-surface:capture-ended')(
      { sender: window.webContents }, 'window:123:0', oldEpoch);
    await vi.advanceTimersByTimeAsync(5000);
    expect(vi.mocked(desktopCapturer.getSources).mock.calls.length).toBe(callsBefore);
    const callback = vi.fn();
    state.mediaHandler({}, callback);
    expect(callback).toHaveBeenCalledWith({ video: state.sources[0] });
    state.listeners.get('memmy:computer-use-surface:capture-ended')(
      { sender: window.webContents }, 'window:124:0', newEpoch);
    surfaces.update({ ...message, type: 'memmy:computer-use-surface:close', targetWindowId: undefined });
    await vi.advanceTimersByTimeAsync(5000);
    expect(vi.mocked(desktopCapturer.getSources).mock.calls.length).toBe(callsBefore);
  } finally { surfaces.dispose(); vi.useRealTimers(); }
});

it('uses a live video click to take over the app and keeps coordinates for scrolling', async () => {
  state.windows.length = 0;
  const surfaces = createComputerUseSurfaceWindows();
  surfaces.update({ type: 'memmy:computer-use-surface:update', surface: 'computer',
    sessionKey: 's', channel: 'gui', chatId: 'c', targetId: 'Notes', title: 'Notes' });
  const script = html.match(/<script>([\s\S]*?)<\/script>/)?.[1]!;
  const handlers = new Map<string, Function>();
  const frame = { naturalWidth: 1000, naturalHeight: 500, style: {},
    addEventListener: (name: string, handler: Function) => handlers.set(`frame:${name}`, handler) };
  const video = { videoWidth: 1000, videoHeight: 500, style: {}, srcObject: null,
    getBoundingClientRect: () => ({ left: 0, top: 0, width: 400, height: 200 }),
    addEventListener: (name: string, handler: Function) => handlers.set(`video:${name}`, handler) };
  const title = { textContent: '' };
  const mode = { textContent: '' };
  const open = { addEventListener: vi.fn(), textContent: '' };
  const hide = { addEventListener: vi.fn() };
  const expand = { addEventListener: vi.fn() };
  const interrupt = { addEventListener: vi.fn() };
  const status = { textContent: '' };
  const sent = vi.fn();
  const captureReady = vi.fn();
  const captureEnded = vi.fn();
  const window = { memmySurfaceControl: { send: sent, captureReady, captureEnded }, addEventListener: vi.fn() } as any;
  const nodes: Record<string, any> = { title, mode, frame, live: video, open, hide, expand, interrupt, status };
  const document = { body: { dataset: {} }, getElementById: (id: string) => nodes[id] };
  let endVideo: (() => void) | undefined;
  const stopVideo = vi.fn();
  const stream = { getTracks: () => [{ stop: stopVideo }],
    getVideoTracks: () => [{ addEventListener: (_name: string, callback: () => void) => { endVideo = callback; } }] };
  const navigator = { mediaDevices: { getDisplayMedia: vi.fn(async () => stream) } };
  runInNewContext(script, { window, document, navigator });
  await window.__memmySetSurface('Notes', null, 'computer', 'window:123:0', 7, true);
  expect(mode.textContent).toBe('正在使用电脑 · 实时');
  expect(document.body.dataset.interruptible).toBe('true');
  interrupt.addEventListener.mock.calls[0]?.[1]();
  expect(sent).toHaveBeenCalledWith({ action: 'interrupt' });
  const onKeyDown = window.addEventListener.mock.calls.find(([name]: [string]) => name === 'keydown')?.[1];
  const escape = { key: 'Escape', preventDefault: vi.fn() };
  onKeyDown(escape);
  expect(escape.preventDefault).toHaveBeenCalledOnce();
  expect(sent).toHaveBeenLastCalledWith({ action: 'interrupt' });
  expect(captureReady).toHaveBeenCalledWith('window:123:0', 7);
  await window.__memmySetSurface('Notes', null, 'computer', 'window:123:0', 8);
  expect(navigator.mediaDevices.getDisplayMedia).toHaveBeenCalledTimes(2);
  expect(captureReady).toHaveBeenLastCalledWith('window:123:0', 8);
  expect(stopVideo).toHaveBeenCalledOnce();
  expect(window.__memmyResolvePipPoint(0.5, 0.5)).toMatchObject({ x: 0.5, y: 0.5,
    frameMode: 'live', frameWidth: 1000, frameHeight: 500 });
  video.getBoundingClientRect = () => ({ left: 0, top: 0, width: 400, height: 300 });
  expect(window.__memmyResolvePipPoint(0.5, 0.05)).toBeNull();
  video.getBoundingClientRect = () => ({ left: 0, top: 0, width: 400, height: 200 });
  handlers.get('video:click')?.({ currentTarget: video, clientX: 200, clientY: 100 });
  expect(sent).toHaveBeenCalledWith({ action: 'open' });
  handlers.get('video:wheel')?.({ currentTarget: video, deltaY: 120, preventDefault: vi.fn() });
  expect(sent).toHaveBeenCalledWith({ action: 'scroll', deltaY: 120, x: 0.5, y: 0.5,
    frameMode: 'live', frameWidth: 1000, frameHeight: 500 });
  endVideo?.();
  expect(captureEnded).toHaveBeenCalledWith('window:123:0', 8);
  expect(video.srcObject).toBeNull();
  await window.__memmySetSurface('Notes', null, 'computer', null, 9);
  expect(video.srcObject).toBeNull();
  expect(stopVideo).toHaveBeenCalledOnce();
  navigator.mediaDevices.getDisplayMedia.mockRejectedValueOnce(new Error('capture denied'));
  await window.__memmySetSurface('Notes', null, 'computer', 'window:456:0');
  expect(stopVideo).toHaveBeenCalledOnce();
  expect(mode.textContent).toBe('正在使用电脑 · 快照');
  expect(frame.style).toMatchObject({ display: 'block' });
  let releaseOld!: (value: typeof stream) => void;
  const staleTrack = { stop: vi.fn() };
  const staleStream = { getTracks: () => [staleTrack],
    getVideoTracks: () => [{ addEventListener: vi.fn() }] };
  const currentStream = { getTracks: () => [{ stop: vi.fn() }],
    getVideoTracks: () => [{ addEventListener: vi.fn() }] };
  navigator.mediaDevices.getDisplayMedia.mockImplementationOnce(() => new Promise(resolve => { releaseOld = resolve; }));
  navigator.mediaDevices.getDisplayMedia.mockResolvedValueOnce(currentStream);
  const staleLookup = window.__memmySetSurface('Notes', null, 'computer', 'window:456:0');
  await window.__memmySetSurface('Notes', null, 'computer', 'window:789:0');
  releaseOld(staleStream);
  await staleLookup;
  expect(staleTrack.stop).toHaveBeenCalledOnce();
  expect(video.srcObject).toBe(currentStream);
  expect(mode.textContent).toBe('正在使用电脑 · 实时');
  surfaces.dispose();
});

it('selects a Windows app capture source by title without a Mac native helper', async () => {
  state.sources = [{ id: 'window:321:0', name: 'Untitled - Notepad' }];
  state.windows.length = 0;
  const surfaces = createComputerUseSurfaceWindows('win32');
  surfaces.update({ type: 'memmy:computer-use-surface:update', surface: 'computer',
    sessionKey: 's', channel: 'gui', chatId: 'c', targetId: 'Notepad', title: 'Notepad' });
  await vi.waitFor(() => expect(state.windows[0].webContents.executeJavaScript)
    .toHaveBeenCalledWith(expect.stringContaining('window:321:0'), true));
  const window = state.windows[0];
  expect(window.options).toMatchObject({ frame: false, transparent: true, resizable: true });
  expect(window.loadFile.mock.calls[0][1]).toEqual({ query: { windowPip: '1' } });
  state.listeners.get('memmy:computer-use-surface:expand')({ sender: window.webContents });
  expect(window.setBounds).toHaveBeenCalledWith(expect.objectContaining({ width: 424, height: 324 }));
  state.listeners.get('memmy:computer-use-surface:hide')({ sender: window.webContents });
  expect(window.close).toHaveBeenCalledOnce();
  surfaces.dispose();
});

it('sends takeover through the exact window ID even before video connects', async () => {
  state.sources = [
    { id: 'window:321:0', name: 'One - Notepad' },
    { id: 'window:322:0', name: 'Two - Notepad' },
  ];
  state.windows.length = 0;
  let releaseCapture!: () => void;
  state.captureGate = new Promise<void>(resolve => { releaseCapture = resolve; });
  const surfaces = createComputerUseSurfaceWindows('win32');
  const sendAction = vi.fn();
  const message = { type: 'memmy:computer-use-surface:update', surface: 'computer',
    sessionKey: 's', channel: 'gui', chatId: 'c', targetId: 'Notepad', title: 'Notepad' } as const;
  const priorCaptures = vi.mocked(desktopCapturer.getSources).mock.calls.length;
  surfaces.update(message, sendAction);
  await vi.waitFor(() => expect(vi.mocked(desktopCapturer.getSources).mock.calls.length).toBeGreaterThan(priorCaptures));
  const window = state.windows[0];
  const click = { action: 'click', x: 0.5, y: 0.5, frameMode: 'live', frameWidth: 1000, frameHeight: 800 };
  state.listener({ sender: window.webContents }, click);
  expect(sendAction).toHaveBeenCalledWith(expect.objectContaining({ action: 'open' }));
  expect(sendAction.mock.calls[0]?.[0]).not.toHaveProperty('x');
  sendAction.mockClear();

  surfaces.update({ ...message, targetWindowId: 322 }, sendAction);
  releaseCapture();
  state.captureGate = null;
  await vi.waitFor(() => expect(window.webContents.executeJavaScript)
    .toHaveBeenCalledWith(expect.stringContaining('window:322:0'), true));
  state.listener({ sender: window.webContents }, { ...click, targetWindowId: 321 });
  expect(sendAction).toHaveBeenCalledWith(expect.objectContaining({ action: 'open', targetWindowId: 322 }));
  state.listener({ sender: window.webContents }, { action: 'key', key: 'Enter' });
  expect(sendAction).toHaveBeenCalledTimes(1);
  state.listener({ sender: window.webContents }, { action: 'key', key: 'Enter', frameMode: 'live' });
  expect(sendAction).toHaveBeenCalledWith(expect.objectContaining({ action: 'key', key: 'Enter',
    targetWindowId: 322, frameMode: 'live' }));
  surfaces.dispose();
});
