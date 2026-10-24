import { expect, it, vi } from 'vitest';
import { Script, runInNewContext } from 'node:vm';
import { readFileSync } from 'node:fs';
import { desktopCapturer } from 'electron';
import { createComputerUseSurfaceWindows, type NativePIP } from '../src/main/computer-use-surface-window.js';
import { createPIPTrayRecovery } from '../src/main/computer-use-pip-tray.js';

const html = readFileSync(new URL('../src/main/computer-use-surface.html', import.meta.url), 'utf8');

function rendererHarness() {
  const nodes = new Map<string, any>();
  for (const id of ['title', 'mode', 'open', 'hide', 'hide-menu', 'hide-task', 'hide-all', 'interrupt', 'frame', 'live', 'status']) {
    const events = new Map<string, Function>();
    nodes.set(id, { dataset: {}, style: {}, events, textContent: '',
      addEventListener: (name: string, handler: Function) => events.set(name, handler),
      removeEventListener: (name: string, handler: Function) => { if (events.get(name) === handler) events.delete(name); },
      removeAttribute: vi.fn() });
  }
  Object.assign(nodes.get('frame'), { naturalWidth: 1000, naturalHeight: 800 });
  const video = nodes.get('live');
  let nextFrame: Function | undefined;
  Object.assign(video, { srcObject: null, readyState: 0, videoWidth: 0, videoHeight: 0,
    requestVideoFrameCallback: vi.fn((callback: Function) => { nextFrame = callback; return 1; }),
    cancelVideoFrameCallback: vi.fn() });
  const makeStream = () => {
    const track = { stop: vi.fn(), readyState: 'live', muted: false,
      addEventListener: vi.fn(), removeEventListener: vi.fn() };
    return { track, getTracks: () => [track], getVideoTracks: () => [track] };
  };
  const stream = makeStream();
  const media = vi.fn(async () => stream);
  const captureReady = vi.fn(), captureEnded = vi.fn(), snapshotReady = vi.fn();
  const windowEvents = new Map<string, Function>();
  const window = { memmySurfaceControl: { send: vi.fn(), captureReady, captureEnded, snapshotReady },
    addEventListener: vi.fn((name: string, handler: Function) => windowEvents.set(name, handler)) } as any;
  const document = { body: { dataset: {} as Record<string, string> }, getElementById: (id: string) => nodes.get(id), addEventListener: vi.fn() };
  runInNewContext(html.match(/<script>([\s\S]*?)<\/script>/)![1]!, {
    window, document, navigator: { mediaDevices: { getDisplayMedia: media } }, setTimeout, clearTimeout,
  });
  const decodeFrame = () => { Object.assign(video, { readyState: 2, videoWidth: 1000, videoHeight: 800 }); nextFrame?.(); };
  return { nodes, video, stream, media, makeStream, window, windowEvents, document, captureReady, captureEnded, snapshotReady, decodeFrame };
}

function renderedEpoch(window: any, source: string): number {
  const script = window.webContents.executeJavaScript.mock.calls
    .map(([value]: [string]) => value).filter((value: string) => value.includes(JSON.stringify(source))).at(-1);
  const epoch = script?.match(/,(\d+),(?:true|false),(?:true|false),(?:true|false),\d+,(?:true|false)\)$/)?.[1];
  if (!epoch) throw new Error(`No rendered epoch for ${source}`);
  return Number(epoch);
}

const state = vi.hoisted(() => ({ windows: [] as any[], listener: null as any, listeners: new Map<string, any>(),
  sources: [] as Array<{ id: string; name: string }>, mediaHandler: null as any,
  ownerOverride: undefined as number | undefined, captureGate: null as Promise<void> | null,
  nextLoad: null as Promise<void> | null }));
vi.mock('../src/main/computer-use-window-capture.js', () => ({ windowsSourceOwners: vi.fn(async (sources: Array<{id:string}>) => new Map(sources.map(source => [source.id, state.ownerOverride ?? 321]))) }));
vi.mock('../src/main/computer-use-video-source.js', async importOriginal => ({
  ...await importOriginal<typeof import('../src/main/computer-use-video-source.js')>(),
  listComputerUseWindows: vi.fn(() => state.sources.map(source => ({
    id: Number(source.id.split(':')[1]), pid: state.ownerOverride ?? 321,
    owner: source.name, bundleId: `com.apple.${source.name}`, title: source.name,
  }))),
}));
vi.mock('electron', () => ({
  screen: { getPrimaryDisplay: () => ({ bounds: { x: 0, y: 0, width: 1200, height: 800 },
    workArea: { x: 0, y: 0, width: 1200, height: 800 } }),
    getDisplayMatching: () => ({ workArea: { x: 0, y: 0, width: 1200, height: 800 } }) },
  desktopCapturer: { getSources: vi.fn(async () => { await state.captureGate; return state.sources; }) },
  session: { fromPartition: vi.fn(() => ({ setDisplayMediaRequestHandler: vi.fn((handler: any) => { state.mediaHandler = handler; }) })) },
  ipcMain: { on: vi.fn((channel: string, listener: any) => {
    state.listeners.set(channel, listener);
    if (channel === 'memmy:computer-use-surface:interaction') state.listener = listener;
  }), removeListener: vi.fn((channel: string) => state.listeners.delete(channel)) },
  BrowserWindow: class {
    private closed = false;
    private bounds: { x: number; y: number; width: number; height: number };
    private windowListeners = new Map<string, Array<(...args: any[]) => void>>();
    private webContentsListeners = new Map<string, Array<{ callback: (...args: any[]) => void; once: boolean }>>();
    showInactive = vi.fn();
    hide = vi.fn();
    setAspectRatio = vi.fn();
    paint?: (...args: any[]) => void;
    webContents = {
      once: vi.fn((name: string, callback: (...args: any[]) => void) => {
        const listeners = this.webContentsListeners.get(name) ?? [];
        listeners.push({ callback, once: true });
        this.webContentsListeners.set(name, listeners);
      }),
      on: vi.fn((name: string, callback: (...args: any[]) => void) => {
        if (name === 'paint') this.paint = callback;
        const listeners = this.webContentsListeners.get(name) ?? [];
        listeners.push({ callback, once: false });
        this.webContentsListeners.set(name, listeners);
      }),
      emit: (name: string, ...args: any[]) => {
        const listeners = this.webContentsListeners.get(name) ?? [];
        this.webContentsListeners.set(name, listeners.filter(listener => !listener.once));
        for (const listener of listeners) listener.callback(...args);
      },
      setFrameRate: vi.fn(),
      executeJavaScript: vi.fn(async (_script: string, _gesture?: boolean) => undefined),
    };
    constructor(public options: any) {
      state.windows.push(this);
      this.bounds = { x: options.x, y: options.y, width: options.width, height: options.height };
    }
    getBounds = vi.fn(() => this.bounds);
    setBounds = vi.fn((bounds: any) => { this.bounds = bounds; });
    on(name: string, callback: (...args: any[]) => void) {
      const listeners = this.windowListeners.get(name) ?? [];
      listeners.push(callback);
      this.windowListeners.set(name, listeners);
    }
    isDestroyed() { return this.closed; }
    loadFile = vi.fn((_path: string) => {
      const pending = state.nextLoad;
      state.nextLoad = null;
      if (pending) return pending;
      this.webContents.emit('did-finish-load');
      return Promise.resolve();
    });
    private finishClose() {
      if (this.closed) return;
      this.closed = true;
      for (const callback of this.windowListeners.get('closed') ?? []) callback();
    }
    close = vi.fn(() => { this.finishClose(); });
    destroy = vi.fn(() => { this.finishClose(); });
  },
}));

it('keeps a failed preview hidden even when its Chromium error page finishes loading', async () => {
  state.windows.length = 0;
  state.sources = [];
  let rejectLoad!: (error: Error) => void;
  state.nextLoad = new Promise<void>((_resolve, reject) => { rejectLoad = reject; });
  const surfaces = createComputerUseSurfaceWindows('win32');
  const message = { type: 'memmy:computer-use-surface:update', surface: 'browser',
    sessionKey: 'failed-preview', channel: 'gui', chatId: 'c', targetId: 'tab', title: 'Page' } as const;
  try {
    surfaces.update(message);
    const window = state.windows[0];
    window.webContents.emit('did-fail-load', {}, -6, 'ERR_FILE_NOT_FOUND',
      'file:///missing/computer-use-surface.html', true);
    window.webContents.emit('did-finish-load');
    expect(window.isDestroyed()).toBe(true);
    expect(window.showInactive).not.toHaveBeenCalled();
    rejectLoad(new Error('ERR_FILE_NOT_FOUND'));
    await Promise.resolve();
    await Promise.resolve();
    expect(window.showInactive).not.toHaveBeenCalled();
    expect(window.webContents.executeJavaScript).not.toHaveBeenCalled();

    // A stale error window must not block the next update for this same surface.
    surfaces.update(message);
    expect(state.windows).toHaveLength(2);
    const replacement = state.windows[1];
    await vi.waitFor(() => expect(replacement.showInactive).toHaveBeenCalledOnce());
    expect(replacement.isDestroyed()).toBe(false);
  } finally { surfaces.dispose(); }
});

it('waits for the requested preview load to succeed before showing a floating window', async () => {
  state.windows.length = 0;
  state.sources = [];
  let resolveLoad!: () => void;
  state.nextLoad = new Promise<void>(resolve => { resolveLoad = resolve; });
  const surfaces = createComputerUseSurfaceWindows('win32');
  try {
    surfaces.update({ type: 'memmy:computer-use-surface:update', surface: 'browser',
      sessionKey: 'delayed-preview', channel: 'gui', chatId: 'c', targetId: 'tab', title: 'Page' });
    const window = state.windows[0];
    window.webContents.emit('did-finish-load');
    await Promise.resolve();
    expect(window.showInactive).not.toHaveBeenCalled();
    expect(window.webContents.executeJavaScript).not.toHaveBeenCalled();
    expect(window.isDestroyed()).toBe(false);
    resolveLoad();
    await vi.waitFor(() => expect(window.showInactive).toHaveBeenCalledOnce());
    expect(window.webContents.executeJavaScript).toHaveBeenCalledOnce();
  } finally { surfaces.dispose(); }
});

it('destroys a preview on load rejection even without a did-fail-load event', async () => {
  state.windows.length = 0;
  state.sources = [];
  state.nextLoad = Promise.reject(new Error('preview file is unavailable'));
  const surfaces = createComputerUseSurfaceWindows('win32');
  try {
    surfaces.update({ type: 'memmy:computer-use-surface:update', surface: 'browser',
      sessionKey: 'rejected-preview', channel: 'gui', chatId: 'c', targetId: 'tab', title: 'Page' });
    const window = state.windows[0];
    await vi.waitFor(() => expect(window.isDestroyed()).toBe(true));
    window.webContents.emit('did-finish-load');
    expect(window.showInactive).not.toHaveBeenCalled();
    expect(window.webContents.executeJavaScript).not.toHaveBeenCalled();
  } finally { surfaces.dispose(); }
});

it('closes a visible preview when its renderer crashes and lets the same surface recover', async () => {
  state.windows.length = 0;
  state.sources = [];
  const surfaces = createComputerUseSurfaceWindows('win32');
  const message = { type: 'memmy:computer-use-surface:update', surface: 'browser',
    sessionKey: 'crashed-preview', channel: 'gui', chatId: 'c', targetId: 'tab', title: 'Page' } as const;
  try {
    surfaces.update(message);
    const window = state.windows[0];
    await vi.waitFor(() => expect(window.showInactive).toHaveBeenCalledOnce());
    window.webContents.emit('render-process-gone', {}, { reason: 'crashed', exitCode: 1 });
    expect(window.isDestroyed()).toBe(true);
    window.webContents.emit('did-finish-load');
    expect(window.showInactive).toHaveBeenCalledOnce();
    surfaces.update(message);
    expect(state.windows).toHaveLength(2);
    await vi.waitFor(() => expect(state.windows[1].showInactive).toHaveBeenCalledOnce());
    expect(state.windows[1].isDestroyed()).toBe(false);
  } finally { surfaces.dispose(); }
});

it('keeps the preview available when only a subframe fails to load', async () => {
  state.windows.length = 0;
  state.sources = [];
  const surfaces = createComputerUseSurfaceWindows('win32');
  try {
    surfaces.update({ type: 'memmy:computer-use-surface:update', surface: 'browser',
      sessionKey: 'subframe-preview', channel: 'gui', chatId: 'c', targetId: 'tab', title: 'Page' });
    const window = state.windows[0];
    await vi.waitFor(() => expect(window.showInactive).toHaveBeenCalledOnce());
    window.webContents.emit('did-fail-load', {}, -105, 'ERR_NAME_NOT_RESOLVED', 'https://unavailable.example/', false);
    expect(window.isDestroyed()).toBe(false);
    expect(window.showInactive).toHaveBeenCalledOnce();
  } finally { surfaces.dispose(); }
});

it('keeps verified Mac snapshots while native group capture connects and recovers without a single-window stream', async () => {
  state.windows.length = 0;
  state.sources = [{ id: 'window:123:0', name: 'Notes' }];
  const { native, actions } = fakeNative();
  const surfaces = createComputerUseSurfaceWindows('darwin', undefined, native);
  const image = 'data:image/png;base64,YWJj';
  const priorDiscoveries = vi.mocked(desktopCapturer.getSources).mock.calls.length;
  try {
    surfaces.update({ ...baseSurface, imageDataUrl: image });
    const window = state.windows[0];
    await vi.waitFor(() => expect(window.webContents.executeJavaScript).toHaveBeenCalled());
    expect(native.setImage).toHaveBeenCalledWith(1, Buffer.from('abc'));
    const initialSnapshots = vi.mocked(native.setImage).mock.calls.length;
    expect(window.showInactive).not.toHaveBeenCalled();
    expect(native.setTargetWindow).toHaveBeenCalledExactlyOnceWith(1, 123, 321, 1, []);
    expect(window.webContents.executeJavaScript).toHaveBeenLastCalledWith(
      expect.stringMatching(/,null,\d+,true,false,false,\d+,false\)$/), false);
    state.listeners.get('memmy:computer-use-surface:snapshot-ready')({ sender: window.webContents }, 1);
    expect(native.setVisible).toHaveBeenCalledWith(1, true);
    const grant = vi.fn(); state.mediaHandler({}, grant);
    expect(grant).toHaveBeenCalledWith(null);
    actions.get(1)!('capture-ready', 123, 0, 0, 1000, 800, 1);
    expect(window.webContents.executeJavaScript).toHaveBeenLastCalledWith(
      expect.stringMatching(/,null,\d+,true,false,true,\d+,false\)$/), false);
    actions.get(1)!('capture-ended', 999, 0, 0, 0, 0, 1);
    expect(native.setImage).toHaveBeenCalledTimes(initialSnapshots);
    actions.get(1)!('capture-ended', 123, 0, 0, 0, 0, 1);
    expect(native.setImage).toHaveBeenCalledTimes(initialSnapshots + 1);
    expect(native.setImage).toHaveBeenLastCalledWith(1, Buffer.from('abc'));
    expect(window.webContents.executeJavaScript).toHaveBeenLastCalledWith(
      expect.stringMatching(/,null,\d+,true,false,false,\d+,false\)$/), false);
    expect(vi.mocked(desktopCapturer.getSources).mock.calls).toHaveLength(priorDiscoveries);
  } finally { surfaces.dispose(); }
});

it('shows updated verified Mac popup snapshots when native capture is unavailable without requesting root-only video', async () => {
  state.windows.length = 0;
  state.sources = [{ id: 'window:123:0', name: 'Notes' }];
  const surfaces = createComputerUseSurfaceWindows('darwin', undefined, null);
  const priorDiscoveries = vi.mocked(desktopCapturer.getSources).mock.calls.length;
  try {
    surfaces.update({ ...baseSurface, imageDataUrl: 'data:image/png;base64,YQ==' });
    const window = state.windows[0];
    await vi.waitFor(() => expect(window.webContents.executeJavaScript).toHaveBeenCalled());
    state.listeners.get('memmy:computer-use-surface:snapshot-ready')({ sender: window.webContents }, 1);
    expect(window.showInactive).toHaveBeenCalledOnce();
    surfaces.update({ ...baseSurface, imageDataUrl: 'data:image/png;base64,Yg==', targetAssociatedWindowIds: [124] });
    expect(window.webContents.executeJavaScript).toHaveBeenLastCalledWith(
      expect.stringContaining('"data:image/png;base64,Yg==","computer",null,'), false);
    const grant = vi.fn(); state.mediaHandler({}, grant);
    expect(grant).toHaveBeenCalledWith(null);
    expect(vi.mocked(desktopCapturer.getSources).mock.calls).toHaveLength(priorDiscoveries);
  } finally { surfaces.dispose(); }
});

it('rejects same-window native events from a previous binding epoch and waits for a current native frame', async () => {
  state.windows.length = 0; state.sources = [{ id: 'window:123:0', name: 'Notes' }];
  const { native, actions } = fakeNative();
  const surfaces = createComputerUseSurfaceWindows('darwin', undefined, native);
  try {
    surfaces.update(baseSurface);
    const window = state.windows[0];
    await vi.waitFor(() => expect(window.webContents.executeJavaScript).toHaveBeenCalled());
    surfaces.update({ ...baseSurface, targetWindowId: 124 });
    surfaces.update(baseSurface);
    expect(vi.mocked(native.setTargetWindow).mock.calls).toEqual([[1, 123, 321, 1, []], [1, 124, 321, 2, []], [1, 123, 321, 3, []]]);
    actions.get(1)!('capture-ready', 123, 0, 0, 1000, 800, 1);
    expect(window.webContents.executeJavaScript).toHaveBeenLastCalledWith(
      expect.stringMatching(/,null,\d+,true,false,false,\d+,false\)$/), false);
    actions.get(1)!('capture-ready', 123, 0, 0, 1000, 800, 3);
    expect(window.webContents.executeJavaScript).toHaveBeenLastCalledWith(expect.stringMatching(/,null,\d+,true,false,true,\d+,false\)$/), false);
    const grant = vi.fn(); state.mediaHandler({}, grant);
    expect(grant).toHaveBeenCalledWith(null);
    actions.get(1)!('capture-ended', 123, 0, 0, 0, 0, 1);
    expect(window.webContents.executeJavaScript).toHaveBeenLastCalledWith(expect.stringMatching(/,null,\d+,true,false,true,\d+,false\)$/), false);
    actions.get(1)!('capture-ended', 123, 0, 0, 0, 0, 3);
    expect(window.webContents.executeJavaScript).toHaveBeenLastCalledWith(expect.stringMatching(/,null,\d+,true,false,false,\d+,false\)$/), false);
  } finally { surfaces.dispose(); }
});

it('revokes native live proof and advances its binding epoch when new observation changes the exact window owner', async () => {
  state.windows.length = 0; state.sources = [];
  const { native, actions } = fakeNative();
  const send = vi.fn();
  const surfaces = createComputerUseSurfaceWindows('darwin', undefined, native);
  try {
    surfaces.update(baseSurface, send);
    await Promise.resolve();
    actions.get(1)!('capture-ready', 123, 0, 0, 1000, 800, 1);
    surfaces.update({ ...baseSurface, targetPid: 999 }, send);
    expect(vi.mocked(native.setTargetWindow).mock.calls).toEqual([[1, 123, 321, 1, []], [1, 123, 999, 2, []]]);
    actions.get(1)!('capture-ready', 123, 0, 0, 1000, 800, 1);
    actions.get(1)!('scroll', 0.5, 0.5, 100, 1000, 800, 1);
    expect(send).not.toHaveBeenCalled();
    expect(state.windows[0].webContents.executeJavaScript).toHaveBeenLastCalledWith(
      expect.stringMatching(/,null,\d+,true,false,false,\d+,false\)$/), false);
  } finally { surfaces.dispose(); }
});

it.each([{ targetPid: undefined }, { targetWindowId: undefined }, { targetWindowId: 0x100000000 }, { targetPid: 0 }])(
  'clears an earlier native stream when its current target tuple becomes unavailable: %j', async invalid => {
    state.windows.length = 0; state.sources = [];
    const { native, actions } = fakeNative();
    const surfaces = createComputerUseSurfaceWindows('darwin', undefined, native);
    try {
      surfaces.update(baseSurface);
      actions.get(1)!('capture-ready', 123, 0, 0, 1000, 800, 1);
      const missing = { ...baseSurface, ...invalid, imageDataUrl: 'data:image/png;base64,Yg==' };
      expect(() => surfaces.update(missing)).not.toThrow();
      const window = state.windows[0]; await Promise.resolve();
      expect(native.clearTargetWindow).toHaveBeenCalledExactlyOnceWith(1, 2);
      state.listeners.get('memmy:computer-use-surface:snapshot-ready')({ sender: window.webContents }, 1);
      actions.get(1)!('capture-ready', 123, 0, 0, 1000, 800, 1);
      actions.get(1)!('capture-ready', 123, 0, 0, 1000, 800, 2);
      expect(window.webContents.executeJavaScript).toHaveBeenLastCalledWith(
        expect.stringMatching(/,null,\d+,true,false,false,1,false\)$/), false);
      surfaces.update(baseSurface);
      expect(native.setTargetWindow).toHaveBeenLastCalledWith(1, 123, 321, 3, []);
      actions.get(1)!('capture-ready', 123, 0, 0, 1000, 800, 3);
      expect(window.webContents.executeJavaScript).toHaveBeenLastCalledWith(
        expect.stringMatching(/,null,\d+,true,false,true,2,false\)$/), false);
    } finally { surfaces.dispose(); }
  },
);

it('does not paint an Electron page over the verified Mac snapshot after native capture pauses', async () => {
  state.windows.length = 0; state.sources = [{ id: 'window:123:0', name: 'Notes' }];
  const { native, actions } = fakeNative();
  const surfaces = createComputerUseSurfaceWindows('darwin', undefined, native);
  try {
    surfaces.update({ ...baseSurface, imageDataUrl: 'data:image/png;base64,YQ==' });
    const window = state.windows[0], ready = state.listeners.get('memmy:computer-use-surface:capture-ready');
    await vi.waitFor(() => expect(window.webContents.executeJavaScript).toHaveBeenCalled());
    expect(native.setImage).toHaveBeenCalledWith(1, Buffer.from('a'));
    const initialSnapshots = vi.mocked(native.setImage).mock.calls.length;
    actions.get(1)!('capture-ready', 123, 0, 0, 1000, 800, 1);
    actions.get(1)!('capture-ended', 123, 0, 0, 0, 0, 1);
    expect(native.setImage).toHaveBeenCalledTimes(initialSnapshots + 1);
    const black = { isEmpty: () => false, toPNG: () => Buffer.from('black-unavailable-page') };
    window.paint({}, {}, black);
    ready({ sender: window.webContents }, 'window:123:0', 1, 1000, 800);
    window.paint({}, {}, black);
    expect(native.setImage).toHaveBeenCalledTimes(initialSnapshots + 1);
    surfaces.update({ ...baseSurface, imageDataUrl: 'data:image/png;base64,Yg==' });
    expect(native.setImage).toHaveBeenCalledTimes(initialSnapshots + 2);
    expect(native.setImage).toHaveBeenLastCalledWith(1, Buffer.from('b'));
  } finally { surfaces.dispose(); }
});

it('canonicalizes native associated windows and preserves their binding on same-target status updates', async () => {
  state.windows.length = 0; state.sources = [];
  const { native } = fakeNative();
  const surfaces = createComputerUseSurfaceWindows('darwin', undefined, native);
  const first = { ...baseSurface, imageDataUrl: 'data:image/png;base64,YQ==', targetAssociatedWindowIds: [125, 124, 125, 123] };
  try {
    surfaces.update(first);
    expect(native.setTargetWindow).toHaveBeenCalledExactlyOnceWith(1, 123, 321, 1, [124, 125]);
    surfaces.update({ ...first, targetAssociatedWindowIds: [124, 125] });
    // This is the trusted helper's status-only update: retain the last image
    // and its complete native target tuple, including proven associations.
    surfaces.update({ ...baseSurface, targetWindowId: undefined, targetPid: undefined, title: 'Waiting for the next frame' });
    expect(native.setTargetWindow).toHaveBeenCalledOnce();
    surfaces.update({ ...baseSurface, imageDataUrl: first.imageDataUrl });
    expect(native.setTargetWindow).toHaveBeenLastCalledWith(1, 123, 321, 2, []);
    expect(native.setTargetWindow).toHaveBeenCalledTimes(2);
  } finally { surfaces.dispose(); }
});

it('revokes native live proof and rejects old callbacks when associated windows change on the same root', async () => {
  state.windows.length = 0; state.sources = [];
  const { native, actions } = fakeNative();
  const surfaces = createComputerUseSurfaceWindows('darwin', undefined, native);
  const send = vi.fn();
  const first = { ...baseSurface, imageDataUrl: 'data:image/png;base64,YQ==', targetAssociatedWindowIds: [124] };
  try {
    surfaces.update(first, send); await Promise.resolve();
    const window = state.windows[0];
    actions.get(1)!('capture-ready', 123, 0, 0, 1000, 800, 1);
    expect(window.webContents.executeJavaScript).toHaveBeenLastCalledWith(expect.stringMatching(/,true,false,true,1,false\)$/), false);
    surfaces.update({ ...first, targetAssociatedWindowIds: [125] }, send);
    expect(native.setTargetWindow).toHaveBeenLastCalledWith(1, 123, 321, 2, [125]);
    expect(window.webContents.executeJavaScript).toHaveBeenLastCalledWith(expect.stringMatching(/,true,false,false,1,false\)$/), false);
    const rendered = window.webContents.executeJavaScript.mock.calls.length;
    actions.get(1)!('capture-ready', 123, 0, 0, 1000, 800, 1);
    actions.get(1)!('capture-ended', 123, 0, 0, 0, 0, 1);
    actions.get(1)!('scroll', 0.5, 0.5, 100, 1000, 800, 1);
    expect(window.webContents.executeJavaScript).toHaveBeenCalledTimes(rendered);
    expect(send).not.toHaveBeenCalled();
    actions.get(1)!('capture-ready', 123, 0, 0, 1000, 800, 2);
    expect(window.webContents.executeJavaScript).toHaveBeenLastCalledWith(expect.stringMatching(/,true,false,true,1,false\)$/), false);
  } finally { surfaces.dispose(); }
});

it('clears old associations on an explicit empty status or a changed target with no new association proof', () => {
  state.windows.length = 0; state.sources = [];
  const { native } = fakeNative();
  const surfaces = createComputerUseSurfaceWindows('darwin', undefined, native);
  const first = { ...baseSurface, imageDataUrl: 'data:image/png;base64,YQ==', targetAssociatedWindowIds: [125] };
  try {
    surfaces.update(first);
    surfaces.update({ ...baseSurface, targetAssociatedWindowIds: [] });
    surfaces.update(first);
    surfaces.update({ ...baseSurface, targetWindowId: 124 });
    expect(vi.mocked(native.setTargetWindow).mock.calls).toEqual([
      [1, 123, 321, 1, [125]], [1, 123, 321, 2, []],
      [1, 123, 321, 3, [125]], [1, 124, 321, 4, []],
    ]);
  } finally { surfaces.dispose(); }
});

it('filters invalid associated IDs without coercion and bounds the native list to 64 unique uint32 windows', () => {
  state.windows.length = 0; state.sources = [];
  const { native } = fakeNative();
  const surfaces = createComputerUseSurfaceWindows('darwin', undefined, native);
  try {
    surfaces.update({ ...baseSurface, targetAssociatedWindowIds: [123, 124, 125, 125, 0xffffffff,
      '126', null, undefined, 0, -1, 0.5, NaN, Infinity, 0x100000000] as any });
    expect(native.setTargetWindow).toHaveBeenLastCalledWith(1, 123, 321, 1, [124, 125, 0xffffffff]);
    surfaces.update({ ...baseSurface, targetAssociatedWindowIds: Array.from({ length: 70 }, (_, index) => 70 - index) });
    expect(native.setTargetWindow).toHaveBeenLastCalledWith(1, 123, 321, 2, Array.from({ length: 64 }, (_, index) => index + 1));
    surfaces.update({ ...baseSurface, targetAssociatedWindowIds: '125' as any });
    expect(native.setTargetWindow).toHaveBeenLastCalledWith(1, 123, 321, 3, []);
  } finally { surfaces.dispose(); }
});

it('deduplicates pending capture, keeps its snapshot until decoding, and stops late or deliberately replaced streams', async () => {
  vi.useFakeTimers();
  const f = rendererHarness();
  const image = 'data:image/png;base64,YWJj';
  let deliverOld!: (stream: ReturnType<typeof f.makeStream>) => void;
  f.media.mockImplementationOnce(() => new Promise(resolve => { deliverOld = resolve; }));
  try {
    const pending = f.window.__memmySetSurface('Notes', image, 'computer', 'window:123:0', 1, false, false, false, 1);
    await vi.advanceTimersByTimeAsync(0);
    await f.window.__memmySetSurface('Status only', image, 'computer', 'window:123:0', 1, false, false, false, 1);
    expect(f.media).toHaveBeenCalledOnce();
    expect(f.nodes.get('frame').style.display).toBe('block');
    await vi.advanceTimersByTimeAsync(9000);
    expect(f.captureEnded).not.toHaveBeenCalled();
    await vi.advanceTimersByTimeAsync(1000);
    await pending;
    expect(f.captureEnded).toHaveBeenCalledExactlyOnceWith('window:123:0', 1);
    const current = f.window.__memmySetSurface('Notes', image, 'computer', 'window:124:0', 2, false, false, false, 1);
    await vi.advanceTimersByTimeAsync(0);
    expect(f.nodes.get('frame').style.display).toBe('block');
    expect(f.video.style.display).toBe('none');
    f.decodeFrame(); await current;
    expect(f.captureReady).toHaveBeenCalledExactlyOnceWith('window:124:0', 2, 1000, 800);
    const stale = f.makeStream(); deliverOld(stale);
    await vi.advanceTimersByTimeAsync(0);
    expect(stale.track.stop).toHaveBeenCalledOnce();
    await f.window.__memmySetSurface('Notes', image, 'computer', null, 2, false, false, true, 1);
    expect(f.stream.track.stop).toHaveBeenCalledOnce();
    expect(f.video.srcObject).toBeNull();
    expect(f.captureEnded).toHaveBeenCalledTimes(1);
    const next = f.makeStream(); f.media.mockResolvedValueOnce(next);
    const recovered = f.window.__memmySetSurface('Notes', image, 'computer', 'window:124:0', 2, false, false, false, 1);
    await vi.advanceTimersByTimeAsync(0); f.decodeFrame(); await recovered;
    expect(f.media).toHaveBeenCalledTimes(3);
    expect(f.captureReady).toHaveBeenCalledTimes(2);
    await f.window.__memmySetSurface('Notes', null, 'computer', null, 3, false, false, false, 2);
  } finally { vi.useRealTimers(); }
});

it('binds snapshot readiness to the decoded image rather than the live video epoch', async () => {
  const f = rendererHarness();
  await f.window.__memmySetSurface('Notes', 'data:image/png;base64,YQ==', 'computer', null, 0, false, false, false, 1);
  const staleLoaded = f.nodes.get('frame').onload;
  await f.window.__memmySetSurface('Notes', 'data:image/png;base64,Yg==', 'computer', null, 0, false, false, false, 2);
  staleLoaded();
  expect(f.snapshotReady).not.toHaveBeenCalled();
  f.nodes.get('frame').onload();
  expect(f.snapshotReady).toHaveBeenCalledExactlyOnceWith(2);
});

it('ignores stale snapshot readiness and keeps a user-hidden preview hidden during automatic recovery', async () => {
  state.windows.length = 0; state.sources = [];
  const surfaces = createComputerUseSurfaceWindows('win32');
  const first = { ...baseSurface, imageDataUrl: 'data:image/png;base64,YQ==' };
  try {
    surfaces.update(first);
    const window = state.windows[0]; await Promise.resolve();
    surfaces.update({ ...first, imageDataUrl: 'data:image/png;base64,Yg==' });
    state.listeners.get('memmy:computer-use-surface:snapshot-ready')({ sender: window.webContents }, 1);
    expect(window.showInactive).not.toHaveBeenCalled();
    state.listeners.get('memmy:computer-use-surface:snapshot-ready')({ sender: window.webContents }, 2);
    expect(window.showInactive).toHaveBeenCalledOnce();
    state.listeners.get('memmy:computer-use-surface:hide')({ sender: window.webContents }, 'task');
    surfaces.update({ ...first, imageDataUrl: 'data:image/png;base64,Yw==' });
    state.listeners.get('memmy:computer-use-surface:snapshot-ready')({ sender: window.webContents }, 3);
    expect(window.showInactive).toHaveBeenCalledOnce();
    expect(surfaces.hasHiddenActive()).toBe(true);
    surfaces.restoreAll();
    expect(window.showInactive).toHaveBeenCalledTimes(2);
  } finally { surfaces.dispose(); }
});

it('shows a resizable preview without taking focus, updates it, and closes with the session', async () => {
  state.sources = [];
  state.windows.length = 0;
  const surfaces = createComputerUseSurfaceWindows('win32');
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
  const message = { type: 'memmy:computer-use-surface:update', surface: 'computer', targetPid: 321,
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
  surfaces.update({ type: 'memmy:computer-use-surface:update', surface: 'computer', targetPid: 321,
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
  const message = { type: 'memmy:computer-use-surface:update', surface: 'computer', targetPid: 321,
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
  const surfaces = createComputerUseSurfaceWindows('win32');
  surfaces.update({ type: 'memmy:computer-use-surface:update', surface: 'computer', targetPid: 321,
    sessionKey: 's', channel: 'gui', chatId: 'c', targetId: 'Notes', title: 'Notes', targetWindowId: 123,
    imageDataUrl: 'data:image/png;base64,YWJj' });
  await vi.waitFor(() => expect(state.windows[0].webContents.executeJavaScript)
    .toHaveBeenCalledWith(expect.stringContaining('window:123:0'), true));
  const callback = vi.fn();
  state.mediaHandler({}, callback);
  await vi.waitFor(() => expect(callback).toHaveBeenCalledWith({ video: state.sources[0] }));
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
    .toHaveBeenCalledWith(expect.stringContaining('"window:123:0",2,false,false,false,1,false)'), true));
  state.listeners.get('memmy:computer-use-surface:capture-ended')(
    { sender: state.windows[0].webContents }, 'window:123:0', oldEpoch);
  const current = vi.fn();
  state.mediaHandler({}, current);
  await vi.waitFor(() => expect(current).toHaveBeenCalledWith({ video: state.sources[0] }));
  surfaces.dispose();
});

it('bounds fast capture retries, hides empty previews, and recovers at a slower cadence', async () => {
  state.sources = [{ id: 'window:123:0', name: 'Notes' }];
  state.windows.length = 0;
  const surfaces = createComputerUseSurfaceWindows('win32');
  surfaces.update({ type: 'memmy:computer-use-surface:update', surface: 'computer', targetPid: 321,
    sessionKey: 's', channel: 'gui', chatId: 'c', targetId: 'Notes', title: 'Notes', targetWindowId: 123 });
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
    expect(window.hide).toHaveBeenCalled();
    expect(window.showInactive).not.toHaveBeenCalled();
    await vi.advanceTimersByTimeAsync(14_999);
    expect(vi.mocked(desktopCapturer.getSources).mock.calls.length).toBe(initialCalls + 3);
    await vi.advanceTimersByTimeAsync(1);
    expect(vi.mocked(desktopCapturer.getSources).mock.calls.length).toBe(initialCalls + 4);
    // Source discovery alone cannot reveal the empty card; a decoded first frame can.
    expect(window.showInactive).not.toHaveBeenCalled();
    state.listeners.get('memmy:computer-use-surface:capture-ready')(
      { sender: window.webContents }, 'window:123:0', renderedEpoch(window, 'window:123:0'), 1000, 800);
    await vi.advanceTimersByTimeAsync(0);
    expect(window.showInactive).toHaveBeenCalledOnce();
  } finally { surfaces.dispose(); vi.useRealTimers(); }
});

it('cancels an old retry on target switch and close, and ignores its stale ended event', async () => {
  state.sources = [{ id: 'window:123:0', name: 'One - Notepad' }];
  state.windows.length = 0;
  const surfaces = createComputerUseSurfaceWindows('win32');
  const message = { type: 'memmy:computer-use-surface:update', surface: 'computer', targetPid: 321,
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
    await vi.waitFor(() => expect(callback).toHaveBeenCalledWith({ video: state.sources[0] }));
    state.listeners.get('memmy:computer-use-surface:capture-ended')(
      { sender: window.webContents }, 'window:124:0', newEpoch);
    surfaces.update({ ...message, type: 'memmy:computer-use-surface:close', targetWindowId: undefined });
    await vi.advanceTimersByTimeAsync(5000);
    expect(vi.mocked(desktopCapturer.getSources).mock.calls.length).toBe(callsBefore);
  } finally { surfaces.dispose(); vi.useRealTimers(); }
});

it('recovers source discovery from a hung request without applying its late result to a new target', async () => {
  state.windows.length = 0;
  state.sources = [{ id: 'window:123:0', name: 'Notes' }];
  let releaseOld!: () => void;
  state.captureGate = new Promise<void>(resolve => { releaseOld = resolve; });
  vi.useFakeTimers();
  const surfaces = createComputerUseSurfaceWindows('win32');
  try {
    surfaces.update(baseSurface);
    await vi.advanceTimersByTimeAsync(0);
    const window = state.windows[0];
    state.sources = [{ id: 'window:124:0', name: 'Notes' }];
    state.captureGate = null;
    surfaces.update({ ...baseSurface, targetWindowId: 124 });
    await vi.advanceTimersByTimeAsync(3500);
    expect(window.webContents.executeJavaScript).toHaveBeenLastCalledWith(expect.stringContaining('"window:124:0"'), true);
    const before = window.webContents.executeJavaScript.mock.calls.length;
    releaseOld(); await vi.advanceTimersByTimeAsync(0);
    expect(window.webContents.executeJavaScript.mock.calls).toHaveLength(before);
    expect(window.showInactive).not.toHaveBeenCalled();
  } finally { state.captureGate = null; releaseOld(); surfaces.dispose(); vi.useRealTimers(); }
});

it('uses a live video click to take over the app and keeps coordinates for scrolling', async () => {
  state.windows.length = 0;
  const surfaces = createComputerUseSurfaceWindows('win32');
  surfaces.update({ type: 'memmy:computer-use-surface:update', surface: 'computer', targetPid: 321,
    sessionKey: 's', channel: 'gui', chatId: 'c', targetId: 'Notes', title: 'Notes', targetWindowId: 123 });
  const script = html.match(/<script>([\s\S]*?)<\/script>/)?.[1]!;
  const handlers = new Map<string, Function>();
  const frame = { naturalWidth: 1000, naturalHeight: 500, style: {},
    addEventListener: (name: string, handler: Function) => handlers.set(`frame:${name}`, handler) };
  const video = { videoWidth: 1000, videoHeight: 500, readyState: 2, style: {}, srcObject: null,
    requestVideoFrameCallback: (callback: () => void) => { void Promise.resolve().then(callback); return 1; },
    cancelVideoFrameCallback: vi.fn(),
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
  for (const id of ['hide-menu', 'hide-task', 'hide-all']) nodes[id] = { dataset: {}, addEventListener: vi.fn() };
  const document = { body: { dataset: {} }, getElementById: (id: string) => nodes[id], addEventListener: vi.fn() };
  let endVideo: (() => void) | undefined;
  const stopVideo = vi.fn();
  const stream = { getTracks: () => [{ stop: stopVideo }],
    getVideoTracks: () => [{ addEventListener: (_name: string, callback: () => void) => { endVideo = callback; } }] };
  const navigator = { mediaDevices: { getDisplayMedia: vi.fn(async () => stream) } };
  runInNewContext(script, { window, document, navigator, setTimeout, clearTimeout });
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
  expect(captureReady).toHaveBeenCalledWith('window:123:0', 7, 1000, 500);
  await window.__memmySetSurface('Notes', null, 'computer', 'window:123:0', 8);
  expect(navigator.mediaDevices.getDisplayMedia).toHaveBeenCalledTimes(2);
  expect(captureReady).toHaveBeenLastCalledWith('window:123:0', 8, 1000, 500);
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
  expect(stopVideo).toHaveBeenCalledTimes(2);
  navigator.mediaDevices.getDisplayMedia.mockRejectedValueOnce(new Error('capture denied'));
  await window.__memmySetSurface('Notes', null, 'computer', 'window:456:0');
  expect(stopVideo).toHaveBeenCalledTimes(2);
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

it('marks fallback video live only after a decoded frame, and retries a stream that never provides one', async () => {
  vi.useFakeTimers();
  try {
    const nodes = new Map<string, any>();
    let firstFrame: (() => void) | undefined;
    for (const id of ['title', 'mode', 'open', 'hide', 'hide-menu', 'hide-task', 'hide-all', 'interrupt', 'frame', 'live', 'status'])
      nodes.set(id, { dataset: {}, style: {}, textContent: '', addEventListener: vi.fn(), removeEventListener: vi.fn(), removeAttribute: vi.fn() });
    const video = nodes.get('live');
    Object.assign(video, { videoWidth: 0, videoHeight: 0, readyState: 0, srcObject: null,
      requestVideoFrameCallback: vi.fn((callback: () => void) => { firstFrame = callback; return 1; }),
      cancelVideoFrameCallback: vi.fn() });
    const track = { stop: vi.fn(), addEventListener: vi.fn(), removeEventListener: vi.fn() };
    const stream = { getTracks: () => [track], getVideoTracks: () => [track] };
    const navigator = { mediaDevices: { getDisplayMedia: vi.fn(async () => stream) } };
    const captureReady = vi.fn(), captureEnded = vi.fn();
    const window = { memmySurfaceControl: { send: vi.fn(), captureReady, captureEnded }, addEventListener: vi.fn() } as any;
    const document = { body: { dataset: {} as Record<string, string> }, getElementById: (id: string) => nodes.get(id), addEventListener: vi.fn() };
    const script = html.match(/<script>([\s\S]*?)<\/script>/)?.[1]!;
    runInNewContext(script, { window, document, navigator, setTimeout, clearTimeout });
    const connecting = window.__memmySetSurface('Notes', null, 'computer', 'window:123:0', 1, true);
    await vi.waitFor(() => expect(video.requestVideoFrameCallback).toHaveBeenCalledOnce());
    expect(document.body.dataset.live).toBe('false');
    expect(captureReady).not.toHaveBeenCalled();
    Object.assign(video, { videoWidth: 1000, videoHeight: 800, readyState: 2 });
    firstFrame?.();
    await connecting;
    expect(document.body.dataset.live).toBe('true');
    expect(captureReady).toHaveBeenCalledWith('window:123:0', 1, 1000, 800);

    const unavailable = window.__memmySetSurface('Notes', null, 'computer', 'window:124:0', 2, true);
    await vi.waitFor(() => expect(video.requestVideoFrameCallback).toHaveBeenCalledTimes(2));
    // A resolved getDisplayMedia with old metadata still needs a new frame callback.
    expect(document.body.dataset.live).toBe('false');
    await vi.advanceTimersByTimeAsync(4000);
    expect(captureEnded).not.toHaveBeenCalled();
    await vi.advanceTimersByTimeAsync(1000);
    await unavailable;
    expect(captureEnded).toHaveBeenCalledWith('window:124:0', 2);
    expect(captureReady).toHaveBeenCalledTimes(1);
    expect(document.body.dataset.live).toBe('false');
    expect(nodes.get('status').textContent).toBe('实时画面不可用');
    expect(video.srcObject).toBeNull();
  } finally { vi.useRealTimers(); }
});

it('selects a Windows app capture source by exact HWND and PID without a Mac native helper', async () => {
  state.sources = [{ id: 'window:321:0', name: 'Untitled - Notepad' }];
  state.windows.length = 0;
  const surfaces = createComputerUseSurfaceWindows('win32');
  surfaces.update({ type: 'memmy:computer-use-surface:update', surface: 'computer', targetPid: 321,
    sessionKey: 's', channel: 'gui', chatId: 'c', targetId: 'Notepad', title: 'Notepad', targetWindowId:321 });
  await vi.waitFor(() => expect(state.windows[0].webContents.executeJavaScript)
    .toHaveBeenCalledWith(expect.stringContaining('window:321:0'), true));
  const window = state.windows[0];
  expect(desktopCapturer.getSources).toHaveBeenLastCalledWith({ types: ['window'], thumbnailSize: { width: 0, height: 0 } });
  expect(window.options).toMatchObject({ frame: false, transparent: true, resizable: true });
  expect(window.loadFile.mock.calls[0][1]).toEqual({ query: { windowPip: '1' } });
  state.listeners.get('memmy:computer-use-surface:capture-ready')(
    { sender: window.webContents }, 'window:321:0', renderedEpoch(window, 'window:321:0'), 1000, 800);
  await vi.waitFor(() => expect(window.showInactive).toHaveBeenCalledOnce());
  state.listeners.get('memmy:computer-use-surface:expand')({ sender: window.webContents });
  expect(window.setBounds).toHaveBeenCalledWith(expect.objectContaining({ width: 424, height: 324 }));
  state.listeners.get('memmy:computer-use-surface:hide')({ sender: window.webContents });
  expect(window.close).not.toHaveBeenCalled();
  expect(window.hide).toHaveBeenCalledTimes(2);
  expect(surfaces.hasHiddenActive()).toBe(true);
  surfaces.restoreAll();
  expect(window.showInactive).toHaveBeenCalledTimes(2);
  expect(surfaces.hasHiddenActive()).toBe(false);
  surfaces.dispose();
});

it('stops root-only Windows video for owned popups and restores it after they close, rejecting stale callbacks', async () => {
  state.windows.length = 0;
  state.sources = [{ id: 'window:123:0', name: 'Notes' }];
  const surfaces = createComputerUseSurfaceWindows('win32');
  const image = 'data:image/png;base64,YQ==', composed = 'data:image/png;base64,Yg==';
  const f = rendererHarness();
  try {
    surfaces.update({ ...baseSurface, imageDataUrl: image, targetAssociatedWindowIds: [] });
    const window = state.windows[0];
    await vi.waitFor(() => expect(window.webContents.executeJavaScript).toHaveBeenLastCalledWith(
      expect.stringContaining('"window:123:0"'), true));
    const initialEpoch = renderedEpoch(window, 'window:123:0');
    const firstVideo = runInNewContext(window.webContents.executeJavaScript.mock.calls.at(-1)[0], { window: f.window });
    await vi.waitFor(() => expect(f.video.requestVideoFrameCallback).toHaveBeenCalled());
    f.decodeFrame(); await firstVideo;
    expect(f.document.body.dataset.live).toBe('true');
    const initialDiscoveries = vi.mocked(desktopCapturer.getSources).mock.calls.length;

    surfaces.update({ ...baseSurface, imageDataUrl: composed, targetAssociatedWindowIds: [0x100000035] });
    expect(window.webContents.executeJavaScript).toHaveBeenLastCalledWith(
      expect.stringContaining(`"${composed}","computer",null,`), false);
    await runInNewContext(window.webContents.executeJavaScript.mock.calls.at(-1)[0], { window: f.window });
    expect(f.stream.track.stop).toHaveBeenCalledOnce();
    expect(f.video.srcObject).toBeNull();
    expect(f.nodes.get('frame').style.display).toBe('block');
    expect(f.nodes.get('frame').src).toBe(composed);
    expect(f.document.body.dataset.live).toBe('false');
    expect(f.nodes.get('status').textContent).toBe('弹窗打开时显示快照');
    // A status-only update of the same group can preserve its verified snapshot.
    surfaces.update({ ...baseSurface, imageDataUrl: undefined, targetAssociatedWindowIds: [0x100000035] });
    expect(window.webContents.executeJavaScript).toHaveBeenLastCalledWith(
      expect.stringContaining(`"${composed}","computer",null,`), false);
    // A new topology without PrintWindow pixels cannot display the old group's image.
    surfaces.update({ ...baseSurface, imageDataUrl: undefined, targetAssociatedWindowIds: [0x100000036] });
    expect(window.webContents.executeJavaScript).toHaveBeenLastCalledWith(
      expect.stringContaining('null,"computer",null,'), false);
    expect(window.hide).toHaveBeenCalled();
    state.listeners.get('memmy:computer-use-surface:capture-ready')(
      { sender: window.webContents }, 'window:123:0', initialEpoch, 1000, 800);
    state.listeners.get('memmy:computer-use-surface:capture-ended')(
      { sender: window.webContents }, 'window:123:0', initialEpoch);
    const denied = vi.fn(); state.mediaHandler({}, denied);
    expect(denied).toHaveBeenCalledWith(null);
    expect(vi.mocked(desktopCapturer.getSources).mock.calls).toHaveLength(initialDiscoveries);

    surfaces.update({ ...baseSurface, imageDataUrl: image, targetAssociatedWindowIds: [] });
    await vi.waitFor(() => expect(window.webContents.executeJavaScript).toHaveBeenLastCalledWith(
      expect.stringContaining('"window:123:0"'), true));
    const restoredEpoch = renderedEpoch(window, 'window:123:0');
    expect(restoredEpoch).toBeGreaterThan(initialEpoch);
    state.listeners.get('memmy:computer-use-surface:capture-ended')(
      { sender: window.webContents }, 'window:123:0', initialEpoch);
    const restored = vi.fn(); state.mediaHandler({}, restored);
    await vi.waitFor(() => expect(restored).toHaveBeenCalledWith({ video: state.sources[0] }));
  } finally { f.windowEvents.get('beforeunload')?.(); surfaces.dispose(); }
});

it('discards Windows source discovery that completes after an owned popup appears', async () => {
  state.windows.length = 0; state.sources = [{ id: 'window:123:0', name: 'Notes' }];
  let releaseDiscovery!: () => void;
  state.captureGate = new Promise<void>(resolve => { releaseDiscovery = resolve; });
  const surfaces = createComputerUseSurfaceWindows('win32');
  try {
    const initialDiscoveries = vi.mocked(desktopCapturer.getSources).mock.calls.length;
    surfaces.update({ ...baseSurface, imageDataUrl: 'data:image/png;base64,YQ==' });
    await vi.waitFor(() => expect(vi.mocked(desktopCapturer.getSources).mock.calls).toHaveLength(initialDiscoveries + 1));
    surfaces.update({ ...baseSurface, imageDataUrl: 'data:image/png;base64,Yg==', targetAssociatedWindowIds: [124] });
    releaseDiscovery(); state.captureGate = null;
    await Promise.resolve(); await Promise.resolve();
    const window = state.windows[0];
    expect(window.webContents.executeJavaScript).toHaveBeenLastCalledWith(
      expect.stringContaining('"computer",null,'), false);
    const denied = vi.fn(); state.mediaHandler({}, denied);
    expect(denied).toHaveBeenCalledWith(null);
    expect(vi.mocked(desktopCapturer.getSources).mock.calls).toHaveLength(initialDiscoveries + 1);
  } finally { releaseDiscovery(); state.captureGate = null; surfaces.dispose(); }
});

it('revokes Windows live capture when the same window ID changes owner', async () => {
  state.sources = [{ id:'window:123:0',name:'Notes' }]; state.windows.length=0;
  const surfaces = createComputerUseSurfaceWindows('win32');
  surfaces.update(baseSurface);
  const window = state.windows[0];
  await vi.waitFor(() => expect(window.webContents.executeJavaScript).toHaveBeenCalledWith(expect.stringContaining('"window:123:0"'),true));
  // Read ownership again when opening the stream, even if source selection succeeded earlier.
  state.ownerOverride=999;
  try {
    const callback=vi.fn();state.mediaHandler({},callback);
    await vi.waitFor(() => expect(callback).toHaveBeenCalledWith(null));
    await vi.waitFor(() => expect(window.webContents.executeJavaScript).toHaveBeenLastCalledWith(expect.stringContaining(',null,'),false),{timeout:3500});
  } finally { state.ownerOverride=undefined;surfaces.dispose(); }
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
  const message = { type: 'memmy:computer-use-surface:update', surface: 'computer', targetPid: 321,
    sessionKey: 's', channel: 'gui', chatId: 'c', targetId: 'Notepad', title: 'Notepad', targetWindowId: 321 } as const;
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

function fakeNative() {
  const actions = new Map<number, Parameters<NativePIP['create']>[5]>();
  let nextID = 1;
  const native: NativePIP = { create: vi.fn((_title, _width, _height, _x, _y, callback) => {
    const id = nextID++; actions.set(id, callback); return id;
  }), setImage: vi.fn(), setTargetWindow: vi.fn(), clearTargetWindow: vi.fn(), setVisible: vi.fn(), setPosition: vi.fn(),
  close: vi.fn(), screenRecordingGranted: vi.fn().mockReturnValue(false) };
  return { native, actions };
}
const baseSurface = { type: 'memmy:computer-use-surface:update', surface: 'computer', targetPid: 321,
  sessionKey: 's', channel: 'gui', chatId: 'c', targetId: 'Notes', title: 'Notes',
  targetWindowId: 123, turnId: 'turn' } as const;

it('routes only the current native screen permission miss and retries after the host grant', () => {
  state.windows.length = 0; state.sources = [];
  const { native, actions } = fakeNative();
  const permissionRequired = vi.fn();
  const surfaces = createComputerUseSurfaceWindows('darwin', {
    onScreenRecordingPermissionRequired: permissionRequired,
  }, native);
  try {
    surfaces.update(baseSurface);
    actions.get(1)!('screen-permission-required', 999, 0, 0, 0, 0, 1);
    actions.get(1)!('screen-permission-required', 123, 0, 0, 0, 0, 0);
    expect(permissionRequired).not.toHaveBeenCalled();
    actions.get(1)!('screen-permission-required', 123, 0, 0, 0, 0, 1);
    expect(permissionRequired).toHaveBeenCalledOnce();
    const request = permissionRequired.mock.calls[0]![0];
    expect(request.isCurrent()).toBe(true);
    expect(request.readGranted()).toBe(false);
    request.retryCapture();
    expect(native.setTargetWindow).toHaveBeenCalledOnce();
    vi.mocked(native.screenRecordingGranted).mockReturnValue(true);
    request.retryCapture();
    expect(native.setTargetWindow).toHaveBeenLastCalledWith(1, 123, 321, 2, []);
    expect(request.isCurrent()).toBe(false);
    surfaces.update({ ...baseSurface, type: 'memmy:computer-use-surface:close' });
    actions.get(1)!('screen-permission-required', 123, 0, 0, 0, 0, 2);
    expect(permissionRequired).toHaveBeenCalledOnce();
  } finally { surfaces.dispose(); }
});

it.each([
  { platform: 'darwin' as const, windowId: 123, alias: 'com.apple.calculator', withNative: true },
  { platform: 'win32' as const, windowId: 0x100000001, alias: 'Calculator.exe', withNative: false },
])('keeps parallel owners of the same native window separate and ignores a stopped owner on $platform', async ({ platform, windowId, alias, withNative }) => {
  state.windows.length = 0; state.sources = [];
  const { native } = fakeNative();
  const surfaces = createComputerUseSurfaceWindows(platform, undefined, withNative ? native : null);
  const firstSend = vi.fn(), nextSend = vi.fn();
  const first = { ...baseSurface, targetId: '计算器', title: '计算器', targetWindowId: windowId,
    turnId: 'calculator-turn-1', imageDataUrl: 'data:image/png;base64,YQ==' };
  const next = { ...first, targetId: alias, title: 'Calculator', turnId: 'calculator-turn-2', imageDataUrl: 'data:image/png;base64,Yg==' };
  try {
    surfaces.update(first, firstSend); await Promise.resolve();
    const firstWindow = state.windows[0];
    surfaces.update(next, nextSend);
    const window = state.windows[1];
    expect(state.windows).toHaveLength(2);
    expect(native.create).toHaveBeenCalledTimes(withNative ? 2 : 0);
    state.listener({ sender: firstWindow.webContents }, { action: 'interrupt' });
    expect(firstSend).toHaveBeenCalledExactlyOnceWith(expect.objectContaining({ turnId: first.turnId, action: 'interrupt' }));
    expect(nextSend).not.toHaveBeenCalled();
    firstSend.mockClear();
    surfaces.update({ ...first, type: 'memmy:computer-use-surface:close', targetPid: undefined, targetWindowId: undefined });
    expect(firstWindow.isDestroyed()).toBe(true);
    expect(window.isDestroyed()).toBe(false);
    const rendered = window.webContents.executeJavaScript.mock.calls.length;
    surfaces.update({ ...first, targetId: alias, imageDataUrl: 'data:image/png;base64,Yw==' }, firstSend);
    expect(window.webContents.executeJavaScript).toHaveBeenCalledTimes(rendered);
    expect(state.windows).toHaveLength(2);
    state.listener({ sender: window.webContents }, { action: 'open' });
    expect(nextSend).toHaveBeenCalledExactlyOnceWith(expect.objectContaining({ targetId: alias,
      turnId: 'calculator-turn-2', targetWindowId: windowId, action: 'open' }));
    expect(firstSend).not.toHaveBeenCalled();
    surfaces.update({ ...next, type: 'memmy:computer-use-surface:close', targetPid: undefined, targetWindowId: undefined });
    expect(window.isDestroyed()).toBe(true);
    expect(native.close).toHaveBeenCalledTimes(withNative ? 2 : 0);
  } finally { surfaces.dispose(); }
});

it('keeps exact presentations separate for different windows, owners, apps, and chats', () => {
  state.windows.length = 0; state.sources = [];
  const { native } = fakeNative();
  const surfaces = createComputerUseSurfaceWindows('darwin', undefined, native);
  try {
    surfaces.update(baseSurface);
    surfaces.update({ ...baseSurface, targetWindowId: 124, turnId: 'new-turn' });
    surfaces.update({ ...baseSurface, targetId: 'Different owner', targetPid: 322, turnId: 'new-turn' });
    surfaces.update({ ...baseSurface, targetId: 'Calculator', targetWindowId: 125, turnId: 'new-turn' });
    surfaces.update({ ...baseSurface, chatId: 'different-chat', turnId: 'new-turn' });
    expect(state.windows).toHaveLength(5);
    expect(native.create).toHaveBeenCalledTimes(5);
    surfaces.update({ ...baseSurface, type: 'memmy:computer-use-surface:close' });
    expect(state.windows[0].isDestroyed()).toBe(true);
    expect(state.windows.slice(1).every(window => !window.isDestroyed())).toBe(true);
  } finally { surfaces.dispose(); }
});

const chromeTab = { type: 'memmy:computer-use-surface:update', surface: 'browser', sessionKey: 's', channel: 'gui',
  chatId: 'c', targetId: 'external:conn:7', title: '百度', imageDataUrl: 'data:image/png;base64,YQ==',
  appKey: 'browser:chrome' } as const;
const chromeWindow = { ...baseSurface, targetId: 'native-window:321:123', title: 'Google Chrome', appKey: 'browser:chrome' };

it('keeps one card per app in a chat while the extension tab and native window of one browser take turns', () => {
  state.windows.length = 0; state.sources = [];
  const { native } = fakeNative();
  const surfaces = createComputerUseSurfaceWindows('darwin', undefined, native);
  try {
    surfaces.update(chromeTab);
    surfaces.update(chromeWindow);
    expect(state.windows).toHaveLength(2);
    expect(state.windows[0].isDestroyed()).toBe(true);
    expect(native.close).toHaveBeenCalledWith(1);
    surfaces.update({ ...chromeTab, type: 'memmy:computer-use-surface:close' });
    expect(state.windows[1].isDestroyed()).toBe(false);
    surfaces.update({ ...chromeTab, title: '上海博物馆官网_百度搜索' });
    expect(state.windows).toHaveLength(3);
    expect(state.windows[1].isDestroyed()).toBe(true);
    expect(state.windows[2].isDestroyed()).toBe(false);
  } finally { surfaces.dispose(); }
});

it('keeps cards separate for different apps and chats that report app keys', () => {
  state.windows.length = 0; state.sources = [];
  const surfaces = createComputerUseSurfaceWindows('win32', undefined, null);
  try {
    surfaces.update({ ...baseSurface, appKey: 'app:win32:microsoft.office.powerpnt.exe.15' });
    surfaces.update({ ...baseSurface, targetId: 'native-window:400:7', targetPid: 400, targetWindowId: 7,
      appKey: 'app:win32:microsoft.windows.notepad' });
    surfaces.update({ ...baseSurface, chatId: 'other-chat', appKey: 'app:win32:microsoft.office.powerpnt.exe.15' });
    expect(state.windows).toHaveLength(3);
    expect(state.windows.every(window => !window.isDestroyed())).toBe(true);
  } finally { surfaces.dispose(); }
});

it('keeps the app key through status-only updates so the next channel still replaces the card', () => {
  state.windows.length = 0; state.sources = [];
  const surfaces = createComputerUseSurfaceWindows('win32', undefined, null);
  try {
    surfaces.update({ ...chromeWindow, appKey: 'browser:edge', imageDataUrl: 'data:image/png;base64,YQ==' });
    surfaces.update({ ...baseSurface, targetId: 'native-window:321:123', title: 'Microsoft Edge · 小窗目标已变化' });
    expect(state.windows).toHaveLength(1);
    surfaces.update({ ...chromeTab, targetId: 'external:edge-conn:3', appKey: 'browser:edge' });
    expect(state.windows).toHaveLength(2);
    expect(state.windows[0].isDestroyed()).toBe(true);
  } finally { surfaces.dispose(); }
});

it('keeps a replacement card hidden when the user hid that app', () => {
  state.windows.length = 0; state.sources = [];
  const { native, actions } = fakeNative();
  const surfaces = createComputerUseSurfaceWindows('darwin', undefined, native);
  try {
    surfaces.update(chromeWindow);
    actions.get(1)!('hide-task', 0, 0, 0, 0, 0);
    vi.mocked(native.setVisible).mockClear();
    surfaces.update(chromeTab);
    expect(native.close).toHaveBeenCalledWith(1);
    expect(native.setVisible).toHaveBeenCalledWith(2, false);
    expect(surfaces.hasHiddenActive()).toBe(true);
  } finally { surfaces.dispose(); }
});

it.each(['darwin', 'win32'] as const)('isolates a %s preview crash and task stop from a sibling using the same app', async platform => {
  state.windows.length = 0; state.sources = [];
  const { native } = fakeNative();
  const surfaces = createComputerUseSurfaceWindows(platform, undefined, platform === 'darwin' ? native : null);
  const first = { ...baseSurface, targetId: 'native-window:321:123', turnId: 'task-a' };
  const second = { ...baseSurface, targetId: 'native-window:321:124', targetWindowId: 124, turnId: 'task-b' };
  const third = { ...baseSurface, targetId: 'native-window:321:125', targetWindowId: 125, turnId: 'task-c' };
  const firstSend = vi.fn(), secondSend = vi.fn(), thirdSend = vi.fn();
  try {
    surfaces.update(first, firstSend);
    surfaces.update(second, secondSend);
    surfaces.update(third, thirdSend);
    await Promise.resolve();
    state.windows[0].webContents.emit('render-process-gone', {}, { reason: 'crashed' });
    expect(state.windows[0].isDestroyed()).toBe(true);
    expect(state.windows.slice(1).every(window => !window.isDestroyed())).toBe(true);
    state.listener({ sender: state.windows[1].webContents }, { action: 'interrupt' });
    expect(secondSend).toHaveBeenCalledExactlyOnceWith(expect.objectContaining({ turnId: 'task-b', action: 'interrupt' }));
    expect(firstSend).not.toHaveBeenCalled();
    expect(thirdSend).not.toHaveBeenCalled();
    surfaces.update({ ...second, type: 'memmy:computer-use-surface:close' });
    surfaces.update({ ...third, title: 'Notes still working' }, thirdSend);
    state.listener({ sender: state.windows[2].webContents }, { action: 'open' });
    expect(thirdSend).toHaveBeenCalledExactlyOnceWith(expect.objectContaining({ turnId: 'task-c', targetWindowId: 125 }));
    expect(state.windows[2].isDestroyed()).toBe(false);
  } finally { surfaces.dispose(); }
});

it('opens only an explicitly requested current native binding and rejects stale or cleared handoffs', () => {
  state.windows.length = 0; state.sources = [];
  const { native, actions } = fakeNative();
  const surfaces = createComputerUseSurfaceWindows('darwin', undefined, native);
  const send = vi.fn();
  try {
    surfaces.update(baseSurface, send);
    actions.get(1)!('open', 0, 0, 0, 0, 0, 1);
    expect(send).toHaveBeenCalledExactlyOnceWith(expect.objectContaining({ action: 'open', targetWindowId: 123 }));
    send.mockClear();
    surfaces.update({ ...baseSurface, targetWindowId: 124 }, send);
    actions.get(1)!('open', 0, 0, 0, 0, 0, 1);
    actions.get(1)!('click', 0, 0, 0, 0, 0, 1);
    actions.get(1)!('unexpected' as any, 0, 0, 0, 0, 0, 2);
    expect(send).not.toHaveBeenCalled();
    actions.get(1)!('click', 0, 0, 0, 0, 0, 2);
    expect(send).toHaveBeenCalledExactlyOnceWith(expect.objectContaining({ action: 'open', targetWindowId: 124 }));
    send.mockClear();
    surfaces.update({ ...baseSurface, targetWindowId: 124, targetPid: undefined, imageDataUrl: 'data:image/png;base64,YQ==' }, send);
    expect(native.clearTargetWindow).toHaveBeenCalledWith(1, 3);
    actions.get(1)!('open', 0, 0, 0, 0, 0, 2);
    actions.get(1)!('open', 0, 0, 0, 0, 0, 3);
    expect(send).not.toHaveBeenCalled();
  } finally { surfaces.dispose(); }
});

it('does not merge aliases or new turns without a complete trusted native tuple', () => {
  state.windows.length = 0; state.sources = [];
  const surfaces = createComputerUseSurfaceWindows('darwin', undefined, null);
  try {
    surfaces.update({ ...baseSurface, targetPid: undefined });
    surfaces.update({ ...baseSurface, targetPid: undefined, turnId: 'new-turn' });
    surfaces.update({ ...baseSurface, targetPid: undefined, targetId: 'Notes alias' });
    expect(state.windows).toHaveLength(3);
  } finally { surfaces.dispose(); }
});

it('does not recreate a finished computer turn from late frames but permits the next turn and another chat', () => {
  state.windows.length = 0; state.sources = [];
  const { native } = fakeNative();
  const surfaces = createComputerUseSurfaceWindows('darwin', undefined, native);
  try {
    surfaces.update(baseSurface);
    surfaces.update({ ...baseSurface, type: 'memmy:computer-use-surface:close' });
    expect(state.windows[0].isDestroyed()).toBe(true);
    surfaces.update({ ...baseSurface, targetId: 'Notes alias', targetWindowId: 124 });
    expect(state.windows).toHaveLength(1);
    surfaces.update({ ...baseSurface, turnId: 'next-turn' });
    surfaces.update({ ...baseSurface, type: 'memmy:computer-use-surface:close' });
    expect(state.windows[1].isDestroyed()).toBe(false);
    surfaces.update({ ...baseSurface, chatId: 'other-chat' });
    expect(state.windows).toHaveLength(3);
    expect(native.create).toHaveBeenCalledTimes(3);
  } finally { surfaces.dispose(); }
});

it('keeps legacy close messages without a turn scoped to their exact handler identity', () => {
  state.windows.length = 0; state.sources = [];
  const surfaces = createComputerUseSurfaceWindows('win32', undefined, null);
  const legacy = { ...baseSurface, turnId: undefined };
  try {
    surfaces.update(legacy);
    surfaces.update({ ...baseSurface, targetWindowId: 124 });
    surfaces.update({ ...legacy, type: 'memmy:computer-use-surface:close' });
    expect(state.windows[0].isDestroyed()).toBe(true);
    expect(state.windows[1].isDestroyed()).toBe(false);
    surfaces.update(legacy);
    expect(state.windows).toHaveLength(3);
  } finally { surfaces.dispose(); }
});

it('isolates addon cleanup failures while closing other presentations and cancelling every discovery timer', async () => {
  state.windows.length = 0; state.sources = [];
  vi.useFakeTimers();
  const { native } = fakeNative();
  vi.mocked(native.clearTargetWindow).mockImplementationOnce(() => { throw new Error('clear failed'); });
  vi.mocked(native.close).mockImplementationOnce(() => { throw new Error('close failed'); });
  let release!: () => void;
  state.captureGate = new Promise<void>(resolve => { release = resolve; });
  const surfaces = createComputerUseSurfaceWindows('darwin', undefined, native);
  try {
    surfaces.update(baseSurface);
    surfaces.update({ ...baseSurface, targetId: 'Calculator', targetWindowId: 124 });
    const captures = vi.mocked(desktopCapturer.getSources).mock.calls.length;
    expect(() => surfaces.closeAll()).not.toThrow();
    expect(vi.mocked(native.clearTargetWindow).mock.calls).toEqual([[1, 2], [2, 2]]);
    expect(vi.mocked(native.close).mock.calls).toEqual([[1], [2]]);
    expect(state.windows.every(window => window.isDestroyed())).toBe(true);
    await vi.advanceTimersByTimeAsync(0);
    expect(vi.getTimerCount()).toBe(0);
    release(); state.captureGate = null;
    await vi.advanceTimersByTimeAsync(60_000);
    expect(vi.mocked(desktopCapturer.getSources).mock.calls).toHaveLength(captures);
    expect(state.windows.every(window => window.webContents.executeJavaScript.mock.calls.length === 0)).toBe(true);
    expect(surfaces.hasHiddenActive()).toBe(false);
    surfaces.closeAll();
    expect(native.close).toHaveBeenCalledTimes(2);
  } finally { release(); state.captureGate = null; surfaces.dispose(); vi.useRealTimers(); }
});

it.each(['missing-close-event', 'already-destroyed'] as const)('releases native capture even when its fallback has %s', mode => {
  state.windows.length = 0; state.sources = [];
  const { native } = fakeNative();
  const surfaces = createComputerUseSurfaceWindows('darwin', undefined, native);
  try {
    surfaces.update(baseSurface);
    const window = state.windows[0];
    if (mode === 'missing-close-event') window.close.mockImplementationOnce(() => undefined);
    else vi.spyOn(window, 'isDestroyed').mockReturnValue(true);
    surfaces.update({ ...baseSurface, type: 'memmy:computer-use-surface:close' });
    expect(native.clearTargetWindow).toHaveBeenCalledExactlyOnceWith(1, 2);
    expect(native.close).toHaveBeenCalledExactlyOnceWith(1);
    expect(window.isDestroyed()).toBe(true);
    if (mode === 'missing-close-event') expect(window.destroy).toHaveBeenCalledOnce();
    surfaces.closeAll();
    expect(native.close).toHaveBeenCalledOnce();
  } finally { surfaces.dispose(); }
});

it('stops late media and rejects decoded snapshots after fallback page teardown cancels a pending capture', async () => {
  vi.useFakeTimers();
  const f = rendererHarness();
  let deliver!: (stream: ReturnType<typeof f.makeStream>) => void;
  f.media.mockImplementationOnce(() => new Promise(resolve => { deliver = resolve; }));
  try {
    const pending = f.window.__memmySetSurface('Notes', 'data:image/png;base64,YQ==', 'computer', 'window:123:0', 1, false, false, false, 1);
    await vi.advanceTimersByTimeAsync(0);
    const decodedSnapshot = f.nodes.get('frame').onload;
    f.windowEvents.get('beforeunload')!();
    await pending;
    const late = f.makeStream(); deliver(late);
    await vi.advanceTimersByTimeAsync(0);
    decodedSnapshot();
    f.windowEvents.get('pagehide')!();
    expect(late.track.stop).toHaveBeenCalledOnce();
    expect(f.video.srcObject).toBeNull();
    expect(f.captureReady).not.toHaveBeenCalled();
    expect(f.captureEnded).not.toHaveBeenCalled();
    expect(f.snapshotReady).not.toHaveBeenCalled();
    expect(vi.getTimerCount()).toBe(0);
    await f.window.__memmySetSurface('Late update', null, 'computer', 'window:123:0', 2, false, false, false, 2);
    expect(f.media).toHaveBeenCalledOnce();
  } finally { vi.useRealTimers(); }
});

it('stops a decoded fallback stream exactly once on page teardown without requesting reconnection', async () => {
  vi.useFakeTimers();
  const f = rendererHarness();
  try {
    const pending = f.window.__memmySetSurface('Notes', null, 'computer', 'window:123:0', 1, false, false, false, 0);
    await vi.advanceTimersByTimeAsync(0); f.decodeFrame(); await pending;
    expect(f.captureReady).toHaveBeenCalledOnce();
    f.windowEvents.get('pagehide')!();
    f.windowEvents.get('beforeunload')!();
    expect(f.stream.track.stop).toHaveBeenCalledOnce();
    expect(f.video.srcObject).toBeNull();
    expect(f.captureEnded).not.toHaveBeenCalled();
    expect(vi.getTimerCount()).toBe(0);
  } finally { vi.useRealTimers(); }
});

it('hides only one task in a shared chat while siblings continue, and restores without opening or stopping a target', async () => {
  state.windows.length = 0; state.sources = [];
  const { native, actions } = fakeNative();
  const send = vi.fn(), visibilityChanged = vi.fn();
  const surfaces = createComputerUseSurfaceWindows('darwin', {
    onVisibilityChanged: visibilityChanged,
  }, native);
  surfaces.update(baseSurface, send);
  surfaces.update({ ...baseSurface, targetId: 'Other window', targetWindowId: 124 }, send);
  surfaces.update({ ...baseSurface, turnId: 'sibling-task', targetWindowId: 125 }, send);
  for (let id = 1; id <= 3; id++) actions.get(id)!('capture-ready', 122 + id, 0, 0, 1000, 800, 1);
  await vi.waitFor(() => expect(state.windows[0].webContents.executeJavaScript).toHaveBeenCalled());
  vi.mocked(native.setVisible).mockClear();
  actions.get(1)!('hide-task', 0, 0, 0, 0, 0);
  expect(native.setVisible).toHaveBeenCalledWith(1, false);
  expect(native.setVisible).toHaveBeenCalledWith(2, false);
  expect(native.setVisible).not.toHaveBeenCalledWith(3, false);
  expect(surfaces.hasHiddenActive()).toBe(true);
  expect(native.close).not.toHaveBeenCalled();
  state.windows.forEach(window => expect(window.close).not.toHaveBeenCalled());
  const before = state.windows[0].webContents.executeJavaScript.mock.calls.length;
  surfaces.update({ ...baseSurface, title: 'Still progressing while hidden' }, send);
  expect(state.windows[0].webContents.executeJavaScript.mock.calls.length).toBeGreaterThan(before);
  surfaces.update({ ...baseSurface, targetId: 'New presentation in hidden task', targetWindowId: 126 }, send);
  expect(native.setVisible).toHaveBeenCalledWith(4, false);
  actions.get(4)!('capture-ready', 126, 0, 0, 1000, 800, 1);
  actions.get(3)!('hide-all', 0, 0, 0, 0, 0);
  expect(native.setVisible).toHaveBeenCalledWith(3, false);
  surfaces.restoreAll();
  for (let id = 1; id <= 4; id++) expect(native.setVisible).toHaveBeenCalledWith(id, true);
  expect(send).not.toHaveBeenCalled();
  expect(native.close).not.toHaveBeenCalled();
  expect(surfaces.hasHiddenActive()).toBe(false);
  expect(visibilityChanged).toHaveBeenCalled();
  surfaces.dispose();
  expect(native.close).toHaveBeenCalledTimes(4);
});

it('cleans up temporary recovery after the last hidden entry closes and lets the next task show normally', async () => {
  state.windows.length = 0; state.sources = [];
  let trayPresent = false;
  const removeTray = vi.fn(() => { trayPresent = false; });
  const recovery = createPIPTrayRecovery({ hasTray: () => trayPresent,
    showTray: () => { trayPresent = true; }, removeTray, updateMenu: vi.fn() });
  const surfaces = createComputerUseSurfaceWindows('win32', {
    onVisibilityChanged: () => recovery.visibilityChanged(surfaces.hasHiddenActive()) });
  surfaces.update(baseSurface);
  state.listeners.get('memmy:computer-use-surface:hide')({ sender: state.windows[0].webContents }, 'task');
  expect(trayPresent).toBe(true);
  surfaces.update({ ...baseSurface, type: 'memmy:computer-use-surface:close' });
  expect(removeTray).toHaveBeenCalledOnce();
  expect(surfaces.hasHiddenActive()).toBe(false);
  surfaces.update({ ...baseSurface, turnId: 'next-turn', imageDataUrl: 'data:image/png;base64,YWJj' });
  await Promise.resolve();
  state.listeners.get('memmy:computer-use-surface:snapshot-ready')({ sender: state.windows[1].webContents }, 1);
  expect(state.windows[1].showInactive).toHaveBeenCalledOnce();
  surfaces.dispose();
});

it('falls back per presentation when a loaded native addon cannot create a panel', async () => {
  state.windows.length = 0; state.sources = [];
  const { native } = fakeNative();
  vi.mocked(native.create).mockImplementationOnce(() => { throw new Error('native panel creation failed'); });
  const surfaces = createComputerUseSurfaceWindows('darwin', undefined, native);
  surfaces.update({ ...baseSurface, imageDataUrl: 'data:image/png;base64,YWJj' });
  const fallback = state.windows[0];
  expect(fallback.options).toMatchObject({ frame: false, transparent: true, focusable: false });
  expect(fallback.options.webPreferences).not.toHaveProperty('offscreen');
  expect(fallback.loadFile.mock.calls[0][1]).toEqual({ query: { windowPip: '1' } });
  await Promise.resolve();
  state.listeners.get('memmy:computer-use-surface:snapshot-ready')({ sender: fallback.webContents }, 1);
  expect(fallback.showInactive).toHaveBeenCalledOnce();
  surfaces.update({ ...baseSurface, targetId: 'second', targetWindowId: 124 });
  expect(state.windows[1].options.webPreferences).toHaveProperty('offscreen');
  expect(state.windows[1].showInactive).not.toHaveBeenCalled();
  surfaces.dispose();
  expect(native.close).toHaveBeenCalledOnce();
});

it('keeps native presentations distinct after default layout, preserving a dragged window', async () => {
  state.windows.length = 0; state.sources = [];
  const { native, actions } = fakeNative();
  const surfaces = createComputerUseSurfaceWindows('darwin', undefined, native);
  const send = vi.fn();
  for (let id = 1; id <= 5; id++) surfaces.update({ ...baseSurface, targetId: `target-${id}`, targetWindowId: 120 + id }, send);
  for (let id = 1; id <= 5; id++) actions.get(id)!('capture-ready', 120 + id, 0, 0, 1000, 800, 1);
  const latestPositions = () => new Map(vi.mocked(native.setPosition).mock.calls.map(([id, x, y]) => [id, `${x},${y}`]));
  expect(new Set(latestPositions().values()).size).toBe(5);
  const allPositions = new Map(vi.mocked(native.setPosition).mock.calls.map(([id, x, y]) => [id, { x, y, width: 200, height: 150 }]));
  for (const [id, a] of allPositions) for (const [other, b] of allPositions) if (other > id)
    expect(a.x < b.x + b.width && a.x + a.width > b.x && a.y < b.y + b.height && a.y + a.height > b.y).toBe(false);
  surfaces.update({ ...baseSurface, targetId: 'new-presentation', targetWindowId: 126 }, send);
  actions.get(6)!('capture-ready', 126, 0, 0, 1000, 800, 1);
  expect(new Set(latestPositions().values()).size).toBe(6);
  actions.get(1)!('dragged', 0, 0, 0, 0, 0);
  vi.mocked(native.setPosition).mockClear();
  actions.get(2)!('source-size', 150, 200, 0, 0, 0);
  expect(vi.mocked(native.setPosition).mock.calls.some(([id]) => id === 1)).toBe(false);
  actions.get(2)!('open', 0, 0, 0, 0, 0, 1);
  expect(send).toHaveBeenLastCalledWith(expect.objectContaining({ action: 'open', targetId: 'target-2', targetWindowId: 122 }));
  expect(native.close).not.toHaveBeenCalled();
  surfaces.update({ ...baseSurface, targetId: 'target-2', targetWindowId: 122, title: 'Updated after opening' }, send);
  await vi.waitFor(() => expect(state.windows[1].webContents.executeJavaScript)
    .toHaveBeenLastCalledWith(expect.stringContaining('Updated after opening'), false));
  surfaces.dispose();
});

it('fits a tall live source without turning the lost width into extra window padding', async () => {
  state.windows.length = 0; state.sources = [{ id: 'window:123:0', name: 'Notes' }];
  const surfaces = createComputerUseSurfaceWindows('win32');
  surfaces.update(baseSurface);
  const window = state.windows[0];
  await vi.waitFor(() => expect(window.webContents.executeJavaScript)
    .toHaveBeenCalledWith(expect.stringContaining('window:123:0'), true));
  const epoch = renderedEpoch(window, 'window:123:0');
  state.listeners.get('memmy:computer-use-surface:capture-ready')({ sender: window.webContents }, 'window:123:0', epoch, 400, 2400);
  await vi.waitFor(() => expect(window.getBounds()).toMatchObject({ width: 74, height: 324 }));
  expect(window.setAspectRatio).toHaveBeenLastCalledWith(1 / 6, { width: 24, height: 24 });
  surfaces.dispose();
});

it('keeps an unchanged Windows window live while Chromium mutes its capture track', async () => {
  const f = rendererHarness();
  const trackEvents = new Map<string, Function>();
  Object.assign(f.stream.track, { muted: true, addEventListener: (name: string, fn: Function) => trackEvents.set(name, fn) });
  const connecting = f.window.__memmySetSurface('Notes', null, 'computer', 'window:123:0', 1, true);
  await vi.waitFor(() => expect(f.video.requestVideoFrameCallback).toHaveBeenCalled());
  f.decodeFrame(); await connecting;
  trackEvents.get('mute')?.();
  expect(f.document.body.dataset.live).toBe('true');
  expect(f.video.srcObject).toBe(f.stream);
  expect(f.stream.track.stop).not.toHaveBeenCalled();
  expect(f.captureEnded).not.toHaveBeenCalled();
  expect(f.captureReady).toHaveBeenCalledWith('window:123:0', 1, 1000, 800);
});

it.each(['ended', 'error'])('revokes a decoded live video on runtime %s and ignores late events from the old stream', async kind => {
  const nodes = new Map<string, any>();
  for (const id of ['title', 'mode', 'open', 'hide', 'hide-menu', 'hide-task', 'hide-all', 'interrupt', 'frame', 'live', 'status']) {
    const events = new Map<string, Function>();
    nodes.set(id, { dataset: {}, style: {}, events, textContent: '', removeAttribute: vi.fn(),
      addEventListener: (name: string, fn: Function) => events.set(name, fn),
      removeEventListener: (name: string, fn: Function) => { if (events.get(name) === fn) events.delete(name); } });
  }
  const video = nodes.get('live');
  Object.assign(video, { videoWidth: 1000, videoHeight: 800, readyState: 2, srcObject: null,
    requestVideoFrameCallback: (callback: () => void) => { void Promise.resolve().then(callback); return 1; },
    cancelVideoFrameCallback: vi.fn() });
  const trackEvents = new Map<string, Function>();
  const track = { stop: vi.fn(), readyState: 'live', muted: false,
    addEventListener: (name: string, fn: Function) => trackEvents.set(name, fn),
    removeEventListener: (name: string, fn: Function) => { if (trackEvents.get(name) === fn) trackEvents.delete(name); } };
  const stream = { getTracks: () => [track], getVideoTracks: () => [track] };
  const navigator = { mediaDevices: { getDisplayMedia: vi.fn(async () => stream) } };
  const captureReady = vi.fn(), captureEnded = vi.fn();
  const window = { memmySurfaceControl: { send: vi.fn(), captureReady, captureEnded }, addEventListener: vi.fn() } as any;
  const document = { body: { dataset: {} as Record<string, string> }, getElementById: (id: string) => nodes.get(id), addEventListener: vi.fn() };
  runInNewContext(html.match(/<script>([\s\S]*?)<\/script>/)![1]!, { window, document, navigator, setTimeout, clearTimeout });
  await window.__memmySetSurface('Notes', null, 'computer', 'window:123:0', 1, true);
  const late = kind === 'ended' ? trackEvents.get('ended')! : video.events.get('error')!;
  late();
  expect(document.body.dataset.live).toBe('false');
  expect(video.srcObject).toBeNull();
  expect(track.stop).toHaveBeenCalledOnce();
  expect(captureEnded).toHaveBeenCalledOnce();
  await window.__memmySetSurface('Notes', null, 'computer', 'window:124:0', 2, true);
  late();
  expect(document.body.dataset.live).toBe('true');
  expect(captureReady).toHaveBeenLastCalledWith('window:124:0', 2, 1000, 800);
  expect(captureEnded).toHaveBeenCalledOnce();
});
