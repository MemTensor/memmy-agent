import { EventEmitter } from 'node:events';
import { readFileSync } from 'node:fs';
import type { BrowserWindow } from 'electron';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { PermissionPanel, PermissionPanelState } from '../src/main/computer-use-onboarding.js';

const mocks = vi.hoisted(() => ({ getFileIcon: vi.fn(), thumbnail: vi.fn(), stat: vi.fn(), follow: vi.fn(), windows: [] as any[] }));
vi.mock('node:fs/promises', () => ({ stat: mocks.stat }));
vi.mock('../src/main/computer-use-settings-window.js', async importOriginal => ({
  ...await importOriginal<typeof import('../src/main/computer-use-settings-window.js')>(),
  watchSystemSettingsWindow: mocks.follow,
}));
vi.mock('electron', async () => {
  const { EventEmitter } = await import('node:events');
  class Window extends EventEmitter {
    destroyed = false;
    bounds: any;
    webContents = Object.assign(new EventEmitter(), {
      mainFrame: {}, send: vi.fn(), startDrag: vi.fn(), setWindowOpenHandler: vi.fn(),
    });
    constructor(readonly options: any) { super(); this.bounds = { x: options.x, y: options.y, width: options.width, height: options.height }; mocks.windows.push(this); }
    setMenu() {}
    getBounds() { return this.bounds; }
    setBounds = vi.fn((next: any) => { this.bounds = next; });
    setPosition = vi.fn();
    setAlwaysOnTop = vi.fn();
    showInactive = vi.fn();
    show = vi.fn();
    focus = vi.fn();
    isDestroyed() { return this.destroyed; }
    isVisible() { return true; }
    loadURL() { return Promise.resolve(); }
    destroy() { this.destroyed = true; this.emit('closed'); }
  }
  return {
    app: { getFileIcon: mocks.getFileIcon }, nativeImage: { createThumbnailFromPath: mocks.thumbnail }, BrowserWindow: Window,
    screen: { getDisplayMatching: () => ({ workArea: { x: 0, y: 0, width: 1200, height: 900 } }) },
    ipcMain: Object.assign(new EventEmitter(), { handle: vi.fn(), removeHandler: vi.fn() }),
  };
});
import { ipcMain } from 'electron';
import { permissionDragTarget, showComputerUsePermissionPanel } from '../src/main/computer-use-permission-panel.js';
import { computerUsePermissionHtml } from '../src/main/computer-use-permission-view.js';

const channel = 'memmy:computer-use-permission-panel';
const helperApp = '/Users/test/Applications/Memmy Development/Memmy Computer Use.app';
const icon = { isEmpty: () => false, toDataURL: () => 'data:image/png;base64,aWNvbg==' };
const initial = (): PermissionPanelState => ({
  helperApp, busy: false, canContinue: true, showActions: false, requiredPermission: 'screenRecording', message: '',
  permissions: { accessibility: 'granted', screenRecording: 'required' },
});
let panel: PermissionPanel;
const active = () => mocks.windows.at(-1);
const drag = (sender = active().webContents, senderFrame = active().webContents.mainFrame, ...payload: unknown[]) => {
  const event = { sender, senderFrame, returnValue: undefined };
  ipcMain.emit(`${channel}:drag-helper`, event, ...payload);
  return event;
};
const viewState = () => active().webContents.send.mock.calls.at(-1)?.[1];

beforeEach(() => {
  vi.clearAllMocks();
  mocks.windows.length = 0;
  mocks.stat.mockResolvedValue({ isDirectory: () => true });
  mocks.getFileIcon.mockResolvedValue(icon);
  mocks.thumbnail.mockResolvedValue(icon);
  mocks.follow.mockReturnValue(vi.fn());
});
afterEach(() => panel?.close());
function show() {
  panel = showComputerUsePermissionPanel(Object.assign(new EventEmitter(), { getBounds: () => ({ x: 0, y: 0, width: 1200, height: 900 }) }) as BrowserWindow, initial(), vi.fn());
}

describe('permission panel native file drag', () => {
  it('keeps a close control on the drag guide', () => {
    const html = computerUsePermissionHtml('nonce');
    expect(html).toContain('aria-label="关闭"');
    expect(html).toContain("el('close').addEventListener('click',()=>bridge.close())");
    expect(html).toContain("if(event.key==='Escape')bridge.act('later')");
    const preload = readFileSync(new URL('../src/preload/computer-use-permission-preload.cts', import.meta.url), 'utf8');
    expect(preload).toContain('sendSync(`${channel}:close`)');
  });

  it('routes the native close action to the host before disposing the panel', () => {
    const act = vi.fn();
    panel = showComputerUsePermissionPanel(
      Object.assign(new EventEmitter(), { getBounds: () => ({ x: 0, y: 0, width: 1200, height: 900 }) }) as BrowserWindow,
      initial(), act,
    );
    const event = { sender: active().webContents, senderFrame: {}, returnValue: undefined };
    ipcMain.emit(`${channel}:close`, event);
    expect(act).toHaveBeenCalledExactlyOnceWith('later');
    expect(event.returnValue).toBe(true);
  });

  it('replies to a rejected synchronous close without closing another window', () => {
    const act = vi.fn();
    panel = showComputerUsePermissionPanel(
      Object.assign(new EventEmitter(), { getBounds: () => ({ x: 0, y: 0, width: 1200, height: 900 }) }) as BrowserWindow,
      initial(), act,
    );
    const event = { sender: {}, returnValue: undefined };
    ipcMain.emit(`${channel}:close`, event);
    expect(act).not.toHaveBeenCalled();
    expect(event.returnValue).toBe(false);
  });

  it('starts the file drag synchronously so System Settings accepts the drop', () => {
    const preload = readFileSync(new URL('../src/preload/computer-use-permission-preload.cts', import.meta.url), 'utf8');
    expect(preload).toContain('ipcRenderer.sendSync(`${channel}:drag-helper`)');
    expect(preload).not.toContain('ipcRenderer.send(');
  });

  it('replies after starting a drag so subsequent close clicks remain responsive', async () => {
    show();
    await vi.waitFor(() => expect(viewState()?.canDragHelper).toBe(true));
    const event = { sender: active().webContents, senderFrame: active().webContents.mainFrame, returnValue: undefined };
    active().webContents.startDrag.mockImplementation(() => expect(event.returnValue).toBeUndefined());
    ipcMain.emit(`${channel}:drag-helper`, event);
    expect(active().webContents.startDrag).toHaveBeenCalledExactlyOnceWith({ file: helperApp, icon });
    expect(event.returnValue).toBe(true);
  });

  it('replies to rejected synchronous drags without starting them', async () => {
    show();
    expect(drag().returnValue).toBe(false);
    await vi.waitFor(() => expect(viewState()?.canDragHelper).toBe(true));
    expect(drag({}).returnValue).toBe(false);
    expect(drag(undefined, {}).returnValue).toBe(false);
    panel.update({ ...initial(), busy: true });
    expect(drag().returnValue).toBe(false);
    panel.update({ ...initial(), permissions: { ...initial().permissions, failure: 'helperPauseFailed' } });
    expect(drag().returnValue).toBe(false);
    expect(active().webContents.startDrag).not.toHaveBeenCalled();
  });

  it('replies when native dragging fails and exposes the fallback', async () => {
    show();
    await vi.waitFor(() => expect(viewState()?.canDragHelper).toBe(true));
    active().webContents.startDrag.mockImplementation(() => { throw new Error('Native dragging failed'); });
    expect(drag().returnValue).toBe(false);
    expect(viewState()?.dragError).toContain('复制程序路径');
  });
  it('uses the measured native guide dimensions and lower-right placement', () => {
    show();
    expect(active().options).toMatchObject({ type: 'panel', width: 545, height: 114, x: 649, y: 779, acceptFirstMouse: true });
    // The accessory must remain visible while macOS System Settings is the
    // active app.  A BrowserWindow parent would make AppKit treat it as a
    // Memmy child and hide it behind the Settings window.
    expect(active().options.parent).toBeUndefined();
  });

  it('shows over System Settings without pulling Memmy to the foreground', () => {
    show(); active().emit('ready-to-show');
    expect(active().showInactive).toHaveBeenCalledOnce();
    expect(active().show).not.toHaveBeenCalled();
    expect(active().focus).not.toHaveBeenCalled();
  });

  it('follows the actual Settings window and stops tracking when closed', () => {
    const previous = process.env.MEMMY_DEV_COMPUTER_USE_BINARY;
    process.env.MEMMY_DEV_COMPUTER_USE_BINARY = `${helperApp}/Contents/MacOS/MemmyComputerUse`;
    try {
      show();
      const onFrame = mocks.follow.mock.calls.at(-1)![1];
      onFrame({ x: 200, y: 100, width: 850, height: 650 });
      expect(active().setBounds).toHaveBeenCalledExactlyOnceWith({ x: 499, y: 629, width: 545, height: 114 }, false);
      onFrame({ x: 200, y: 100, width: 850, height: 650 });
      expect(active().setBounds).toHaveBeenCalledTimes(1);
      onFrame({ x: 250, y: 130, width: 850, height: 650 });
      expect(active().setBounds).toHaveBeenLastCalledWith({ x: 549, y: 659, width: 545, height: 114 }, false);
      onFrame(null);
      expect(active().setBounds).toHaveBeenCalledTimes(2);
      panel.close();
      expect(mocks.follow.mock.results.at(-1)!.value).toHaveBeenCalledOnce();
    } finally {
      if (previous === undefined) delete process.env.MEMMY_DEV_COMPUTER_USE_BINARY;
      else process.env.MEMMY_DEV_COMPUTER_USE_BINARY = previous;
    }
  });

  it('drags the signed Memmy app when the helper lives inside it', () => {
    const helper = '/Applications/Memmy.app/Contents/Resources/app.asar.unpacked/dist/native-computer-use/Memmy Computer Use.app';
    expect(permissionDragTarget(helper)).toBe('/Applications/Memmy.app');
    expect(permissionDragTarget(helperApp)).toBe(helperApp);
  });

  it('uses the production Memmy app for Input Monitoring grants too', () => {
    const helper = '/Applications/Memmy.app/Contents/Resources/app.asar.unpacked/dist/native-computer-use/Memmy Computer Use.app';
    expect(permissionDragTarget(helper)).toBe('/Applications/Memmy.app');
  });

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
    expect(active().setAlwaysOnTop).toHaveBeenCalledWith(true, 'floating');
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
