import { EventEmitter } from 'node:events';
import type { BrowserWindow } from 'electron';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { PermissionPanel, PermissionPanelState } from '../src/main/computer-use-onboarding.js';

const mocks = vi.hoisted(() => ({ getFileIcon: vi.fn(), thumbnail: vi.fn(), stat: vi.fn(), windows: [] as any[] }));
vi.mock('node:fs/promises', () => ({ stat: mocks.stat }));
vi.mock('electron', async () => {
  const { EventEmitter } = await import('node:events');
  class Window extends EventEmitter {
    destroyed = false;
    webContents = Object.assign(new EventEmitter(), {
      mainFrame: {}, send: vi.fn(), startDrag: vi.fn(), setWindowOpenHandler: vi.fn(),
    });
    constructor() { super(); mocks.windows.push(this); }
    setMenu() {}
    setPosition = vi.fn();
    setAlwaysOnTop = vi.fn();
    isDestroyed() { return this.destroyed; }
    isVisible() { return true; }
    loadURL() { return Promise.resolve(); }
    destroy() { this.destroyed = true; this.emit('closed'); }
  }
  return {
    app: { getFileIcon: mocks.getFileIcon }, nativeImage: { createThumbnailFromPath: mocks.thumbnail }, BrowserWindow: Window,
    ipcMain: Object.assign(new EventEmitter(), { handle: vi.fn(), removeHandler: vi.fn() }),
  };
});
import { ipcMain } from 'electron';
import { showComputerUsePermissionPanel } from '../src/main/computer-use-permission-panel.js';

const channel = 'memmy:computer-use-permission-panel';
const helperApp = '/Users/test/Applications/Memmy Development/Open Computer Use.app';
const icon = { isEmpty: () => false, toDataURL: () => 'data:image/png;base64,aWNvbg==' };
const initial = (): PermissionPanelState => ({
  helperApp, busy: false, canContinue: true, message: '',
  permissions: { accessibility: 'granted', screenRecording: 'required' },
});
let panel: PermissionPanel;
const active = () => mocks.windows.at(-1);
const drag = (sender = active().webContents, senderFrame = active().webContents.mainFrame, ...payload: unknown[]) =>
  ipcMain.emit(`${channel}:drag-helper`, { sender, senderFrame }, ...payload);
const viewState = () => active().webContents.send.mock.calls.at(-1)?.[1];

beforeEach(() => {
  vi.clearAllMocks();
  mocks.windows.length = 0;
  mocks.stat.mockResolvedValue({ isDirectory: () => true });
  mocks.getFileIcon.mockResolvedValue(icon);
  mocks.thumbnail.mockResolvedValue(icon);
});
afterEach(() => panel?.close());
function show() {
  panel = showComputerUsePermissionPanel(new EventEmitter() as BrowserWindow, initial(), vi.fn());
}

describe('permission panel native file drag', () => {
  it('drags only the helper provided by the host, even if the renderer supplies another path', async () => {
    show();
    await vi.waitFor(() => expect(viewState()?.canDragHelper).toBe(true));
    panel.update({ ...initial(), helperApp: '/Applications/Other.app' });
    drag(undefined, undefined, '/Applications/Other.app');
    expect(active().webContents.startDrag).toHaveBeenCalledWith({ file: helperApp, icon });
    expect(viewState()).toMatchObject({ helperApp, helperIcon: icon.toDataURL() });
  });

  it('rejects messages from other windows and subframes, and blocks dragging during probes or failed suspension', async () => {
    show();
    await vi.waitFor(() => expect(viewState()?.canDragHelper).toBe(true));
    drag({});
    drag(undefined, {});
    panel.update({ ...initial(), busy: true });
    drag();
    expect(viewState().canDragHelper).toBe(false);
    panel.update({ ...initial(), permissions: { ...initial().permissions, failure: 'helperPauseFailed' } });
    drag();
    expect(active().webContents.startDrag).not.toHaveBeenCalled();
    panel.update(initial());
    drag();
    expect(active().webContents.startDrag).toHaveBeenCalledTimes(1);
  });

  it('keeps the path fallback available when the installed app is missing', async () => {
    mocks.stat.mockRejectedValue(new Error('ENOENT'));
    show();
    await vi.waitFor(() => expect(viewState()?.dragError).toContain('复制程序路径'));
    drag();
    expect(viewState()).toMatchObject({ helperApp, canDragHelper: false });
    expect(active().webContents.startDrag).not.toHaveBeenCalled();
    expect(mocks.getFileIcon).not.toHaveBeenCalled();
    expect(mocks.thumbnail).not.toHaveBeenCalled();
  });

  it.each(['accessibility', 'screenRecording'])('keeps the window in place when opening %s settings, then stops floating before a permission probe', permission => {
    show();
    const action = vi.mocked(ipcMain.handle).mock.calls.at(-1)![1];
    action({ sender: active().webContents, senderFrame: active().webContents.mainFrame } as any, permission);
    expect(active().setPosition).not.toHaveBeenCalled();
    expect(active().setAlwaysOnTop).toHaveBeenCalledWith(true, 'floating');
    panel.update({ ...initial(), busy: true });
    expect(active().setAlwaysOnTop).toHaveBeenLastCalledWith(false);
  });

  it('removes the drag listener when closed, including when icon loading finishes later', async () => {
    let finish!: (value: typeof icon) => void;
    mocks.thumbnail.mockImplementation(() => new Promise(resolve => { finish = resolve; }));
    show();
    await vi.waitFor(() => expect(mocks.thumbnail).toHaveBeenCalled());
    panel.close();
    finish(icon);
    await Promise.resolve();
    expect(ipcMain.listenerCount(`${channel}:drag-helper`)).toBe(0);
    drag();
    expect(active().webContents.send).not.toHaveBeenCalled();
    expect(active().webContents.startDrag).not.toHaveBeenCalled();
  });
});
