import { EventEmitter } from 'node:events';
import { beforeEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({ windows: [] as any[], handles: new Map<string, (...args: any[]) => unknown>(), main: null as any,
  cursor: { x: 200, y: 200 },
  displays: [{ id: 1, workArea: { x: 0, y: 0, width: 1200, height: 900 } }] as Array<{ id: number; workArea: { x: number; y: number; width: number; height: number } }>,
  displayEvents: null as any }));
vi.mock('electron', async () => {
  const { EventEmitter } = await import('node:events');
  class Window extends EventEmitter {
    static fromWebContents(contents: unknown) {
      return mocks.main?.webContents === contents ? mocks.main : mocks.windows.find(window => window.webContents === contents) ?? null;
    }
    destroyed = false;
    visible = false;
    minimized = false;
    bounds: { x: number; y: number; width: number; height: number };
    webContents = Object.assign(new EventEmitter(), { mainFrame: {}, send: vi.fn(), setWindowOpenHandler: vi.fn(),
      isLoading: () => false, on: vi.fn() });
    constructor(options: any) { super(); this.bounds = options; mocks.windows.push(this); }
    setMenu() {}
    setAlwaysOnTop() {}
    setVisibleOnAllWorkspaces = vi.fn();
    getBounds() { return this.bounds; }
    setBounds = vi.fn((bounds: any) => { this.bounds = bounds; });
    isDestroyed() { return this.destroyed; }
    isMinimized() { return this.minimized; }
    restore = vi.fn(() => { this.minimized = false; this.visible = true; });
    isVisible() { return this.visible; }
    showInactive() { this.visible = true; }
    loadURL() { return Promise.resolve(); }
    destroy() { this.destroyed = true; this.emit('closed'); }
  }
  const ipcMain = Object.assign(new EventEmitter(), { handle: (name: string, handler: (...args: any[]) => unknown) => mocks.handles.set(name, handler) });
  const displayEvents = new EventEmitter();
  mocks.displayEvents = displayEvents;
  const inside = (display: { workArea: { x: number; y: number; width: number; height: number } }, point: { x: number; y: number }) =>
    point.x >= display.workArea.x && point.x < display.workArea.x + display.workArea.width
    && point.y >= display.workArea.y && point.y < display.workArea.y + display.workArea.height;
  return { BrowserWindow: Window, ipcMain, screen: {
    getCursorScreenPoint: () => mocks.cursor,
    getDisplayNearestPoint: (point: { x: number; y: number }) => mocks.displays.find(display => inside(display, point)) ?? mocks.displays[0],
    getDisplayMatching: (rect: { x: number; y: number; width: number; height: number }) =>
      mocks.displays.find(display => inside(display, rect)) ?? mocks.displays[0],
    on: (name: string, listener: (...args: any[]) => void) => displayEvents.on(name, listener),
    removeListener: (name: string, listener: (...args: any[]) => void) => displayEvents.removeListener(name, listener) } };
});
import { ipcMain } from 'electron';
import { recordingBarFocusable, registerTeachingRecordingControls, resolveFollowDecision } from '../src/main/teaching-recording-controls.js';

const channel = 'memmy:teaching-recording-controls';
const session = { id: 'ba1142db-f861-4dca-8bff-f602d492d8db', conversationId: 'chat-a',
  startedAt: '2026-11-24T06:00:00.000Z', state: 'recording' as const,
  labels: { stop: '完成录制', discard: '丢弃录制', drag: '拖动控制条' } };

beforeEach(() => {
  mocks.windows.length = 0; mocks.handles.clear();
  mocks.cursor = { x: 200, y: 200 };
  mocks.displays = [{ id: 1, workArea: { x: 0, y: 0, width: 1200, height: 900 } }];
  mocks.main = { webContents: Object.assign(new EventEmitter(), { mainFrame: {}, send: vi.fn() }), isDestroyed: () => false,
    minimized: true, visible: false, isMinimized() { return this.minimized; }, isVisible() { return this.visible; },
    restore: vi.fn(function (this: any) { this.minimized = false; this.visible = true; }),
    showInactive: vi.fn(function (this: any) { this.visible = true; }) };
});

describe('independent Teach Mode panel', () => {
  it('lets the clicked bar take key status only on macOS', () => {
    expect(recordingBarFocusable('darwin')).toBe(true);
    expect(recordingBarFocusable('win32')).toBe(false);
    expect(recordingBarFocusable('linux')).toBe(false);
  });
  it('stays open after the main window closes and finishes through the Host', async () => {
    const fetcher = vi.fn(async (_url: unknown, init: RequestInit) => {
      const action = (JSON.parse(String(init.body)) as { input: { action: string } }).input.action;
      return { ok: true, json: async () => ({ event: { type: 'result', output: action === 'status'
        ? { sessions: [session] } : { ...session, state: 'ready' } } }) };
    });
    vi.stubGlobal('fetch', fetcher);
    registerTeachingRecordingControls(() => mocks.main, () => ({ baseUrl: 'http://127.0.0.1:19000', localToken: 'test' }));
    const update = mocks.handles.get(`${channel}:update`)!;
    update({ sender: mocks.main.webContents, senderFrame: mocks.main.webContents.mainFrame }, session);
    expect(mocks.main.restore).toHaveBeenCalledOnce();
    expect(mocks.main.visible).toBe(true);
    const panel = mocks.windows.at(-1)!;
    panel.emit('ready-to-show');
    expect(panel.visible).toBe(true);

    // A renderer teardown may report null while the Host still records.
    update({ sender: mocks.main.webContents, senderFrame: mocks.main.webContents.mainFrame }, null);
    await vi.waitFor(() => expect(fetcher).toHaveBeenCalled());
    expect(panel.destroyed).toBe(false);

    mocks.main = null;
    ipcMain.emit(`${channel}:action`, { sender: panel.webContents, senderFrame: panel.webContents.mainFrame },
      { id: session.id, action: 'stop' });
    await vi.waitFor(() => expect(panel.destroyed).toBe(true));
    expect(fetcher.mock.calls.some(([, init]) => JSON.parse(String(init.body)).input.action === 'stop')).toBe(true);
    vi.unstubAllGlobals();
  });
  it('asks before discarding and restores the bar when the user keeps recording', async () => {
    const fetcher = vi.fn(async (_url: unknown, init: RequestInit) => {
      const action = (JSON.parse(String(init.body)) as { input: { action: string } }).input.action;
      return { ok: true, json: async () => ({ event: { type: 'result', output: action === 'status'
        ? { sessions: [session] } : { ...session, state: 'cancelled' } } }) };
    });
    vi.stubGlobal('fetch', fetcher);
    registerTeachingRecordingControls(() => mocks.main, () => ({ baseUrl: 'http://127.0.0.1:19000', localToken: 'test' }));
    mocks.handles.get(`${channel}:update`)!({ sender: mocks.main.webContents, senderFrame: mocks.main.webContents.mainFrame }, session);
    const panel = mocks.windows.at(-1)!, from = { sender: panel.webContents, senderFrame: panel.webContents.mainFrame };
    const bar = { ...panel.getBounds() };
    ipcMain.emit(`${channel}:confirm`, from, true);
    expect(panel.getBounds().height).toBeGreaterThan(bar.height);
    expect(panel.getBounds().y + panel.getBounds().height).toBe(bar.y + bar.height);
    ipcMain.emit(`${channel}:confirm`, from, false);
    expect(panel.getBounds()).toEqual(bar);
    expect(fetcher.mock.calls.some(([, init]) => JSON.parse(String(init.body)).input.action === 'cancel')).toBe(false);
    ipcMain.emit(`${channel}:confirm`, from, true);
    ipcMain.emit(`${channel}:action`, from, { id: session.id, action: 'cancel' });
    expect(panel.getBounds().height).toBeGreaterThan(bar.height);
    await vi.waitFor(() => expect(panel.destroyed).toBe(true));
    vi.unstubAllGlobals();
  });
  it('starts at the same screen anchor after dragging and closes without moving back', async () => {
    const fetcher = vi.fn(async () => ({ ok: true, json: async () => ({ event: { type: 'result', output: { state: 'ready' } } }) }));
    vi.stubGlobal('fetch', fetcher);
    registerTeachingRecordingControls(() => mocks.main, () => ({ baseUrl: 'http://127.0.0.1:19000', localToken: 'test' }));
    const update = mocks.handles.get(`${channel}:update`)!;
    const fromMain = { sender: mocks.main.webContents, senderFrame: mocks.main.webContents.mainFrame };
    update(fromMain, session);
    const first = mocks.windows.at(-1)!, anchor = { ...first.getBounds() };
    first.setBounds({ ...anchor, x: 85, y: 120 });
    ipcMain.emit(`${channel}:action`, { sender: first.webContents, senderFrame: first.webContents.mainFrame },
      { id: session.id, action: 'stop' });
    expect(first.getBounds()).toMatchObject({ x: 85, y: 120 });
    expect(first.setBounds).toHaveBeenCalledTimes(1);
    await vi.waitFor(() => expect(first.destroyed).toBe(true));

    update(fromMain, { ...session, id: 'bfb1a112-5b96-4916-a6f8-2b3a3833f7a1' });
    const second = mocks.windows.at(-1)!;
    expect(second.getBounds()).toMatchObject(anchor);
    ipcMain.emit(`${channel}:action`, { sender: second.webContents, senderFrame: second.webContents.mainFrame },
      { id: 'bfb1a112-5b96-4916-a6f8-2b3a3833f7a1', action: 'stop' });
    await vi.waitFor(() => expect(second.destroyed).toBe(true));
    vi.unstubAllGlobals();
  });
});

describe('recording bar display following', () => {
  const fromMain = () => ({ sender: mocks.main.webContents, senderFrame: mocks.main.webContents.mainFrame });
  const secondDisplay = { id: 2, workArea: { x: 1200, y: 0, width: 1600, height: 900 } };

  /** Registers the controls with a live session and returns the created panel plus a cleanup. */
  function startRecording() {
    let live = true;
    const fetcher = vi.fn(async () => ({ ok: true, json: async () => ({ event: { type: 'result',
      output: live ? { sessions: [session] } : { sessions: [] } } }) }));
    vi.stubGlobal('fetch', fetcher);
    registerTeachingRecordingControls(() => mocks.main, () => ({ baseUrl: 'http://127.0.0.1:19000', localToken: 'test' }));
    const update = mocks.handles.get(`${channel}:update`)!;
    update(fromMain(), session);
    const panel = mocks.windows.at(-1)!;
    return { panel, update, stopServing: () => { live = false; } };
  }

  it('starts on the display under the pointer', async () => {
    vi.useFakeTimers();
    try {
      mocks.displays.push(secondDisplay);
      mocks.cursor = { x: 1800, y: 400 };
      const { panel, update, stopServing } = startRecording();
      expect(panel.getBounds()).toMatchObject({ x: 1200 + 723, y: 838, width: 154, height: 46 });
      // The panel joins every Space without switching Memmy itself to an accessory app.
      expect(panel.setVisibleOnAllWorkspaces).toHaveBeenCalledWith(true,
        { visibleOnFullScreen: true, skipTransformProcessType: true });
      stopServing();
      update(fromMain(), null);
      await vi.advanceTimersByTimeAsync(0);
      expect(panel.destroyed).toBe(true);
    } finally {
      vi.useRealTimers();
      vi.unstubAllGlobals();
    }
  });

  it('moves to the other display only after the pointer settles there', async () => {
    vi.useFakeTimers();
    try {
      const { panel, update, stopServing } = startRecording();
      expect(panel.getBounds()).toMatchObject({ x: 523, y: 838 });
      mocks.displays.push(secondDisplay);
      mocks.cursor = { x: 1800, y: 400 };
      // One tick on the second display is not enough: passing over a monitor must not drag the bar.
      await vi.advanceTimersByTimeAsync(1_500);
      expect(panel.getBounds()).toMatchObject({ x: 523 });
      await vi.advanceTimersByTimeAsync(1_500);
      expect(panel.getBounds()).toMatchObject({ x: 1200 + 723, y: 838, width: 154, height: 46 });
      // And it stays put while the pointer does not move away.
      await vi.advanceTimersByTimeAsync(3_000);
      expect(panel.getBounds()).toMatchObject({ x: 1200 + 723 });
      stopServing();
      update(fromMain(), null);
      await vi.advanceTimersByTimeAsync(0);
      expect(panel.destroyed).toBe(true);
    } finally {
      vi.useRealTimers();
      vi.unstubAllGlobals();
    }
  });

  it('keeps a bar the person dragged where they left it', async () => {
    vi.useFakeTimers();
    try {
      const { panel, update, stopServing } = startRecording();
      panel.setBounds({ x: 85, y: 120, width: 154, height: 46 });
      panel.emit('moved');
      mocks.displays.push(secondDisplay);
      mocks.cursor = { x: 1800, y: 400 };
      await vi.advanceTimersByTimeAsync(4_500);
      expect(panel.getBounds()).toMatchObject({ x: 85, y: 120 });
      stopServing();
      update(fromMain(), null);
      await vi.advanceTimersByTimeAsync(0);
      expect(panel.destroyed).toBe(true);
    } finally {
      vi.useRealTimers();
      vi.unstubAllGlobals();
    }
  });

  it('comes back to an existing display when the one it sat on disappears', async () => {
    vi.useFakeTimers();
    try {
      const { panel, update, stopServing } = startRecording();
      mocks.displays.push(secondDisplay);
      mocks.cursor = { x: 1800, y: 400 };
      await vi.advanceTimersByTimeAsync(3_000);
      expect(panel.getBounds()).toMatchObject({ x: 1200 + 723 });
      mocks.displays = [mocks.displays[0]!];
      mocks.cursor = { x: 200, y: 200 };
      mocks.displayEvents.emit('display-removed', {}, secondDisplay);
      expect(panel.getBounds()).toMatchObject({ x: 523, y: 838 });
      stopServing();
      update(fromMain(), null);
      await vi.advanceTimersByTimeAsync(0);
      expect(panel.destroyed).toBe(true);
    } finally {
      vi.useRealTimers();
      vi.unstubAllGlobals();
    }
  });
});

describe('resolveFollowDecision', () => {
  it('requires the pointer to stay on the new display before moving', () => {
    expect(resolveFollowDecision(1, 1, null, 0)).toEqual({ move: false, pendingDisplayId: null, pendingSamples: 0 });
    expect(resolveFollowDecision(1, 2, null, 0)).toEqual({ move: false, pendingDisplayId: 2, pendingSamples: 1 });
    expect(resolveFollowDecision(1, 2, 2, 1)).toEqual({ move: true, pendingDisplayId: null, pendingSamples: 0 });
    // Coming back to the anchored display forgets the pending one.
    expect(resolveFollowDecision(1, 1, 2, 1)).toEqual({ move: false, pendingDisplayId: null, pendingSamples: 0 });
  });
});
