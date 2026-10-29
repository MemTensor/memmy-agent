import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { BrowserWindow, IpcMainEvent, NativeImage } from 'electron';
import ts from 'typescript';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { createExternalBrowserExtensionDragHandler, EXTERNAL_BROWSER_EXTENSION_DRAG_CHANNEL } from '../src/main/external-browser-extension-drag.js';

const temporaryDirectories: string[] = [];
afterEach(() => {
  for (const directory of temporaryDirectories.splice(0)) rmSync(directory, { recursive: true, force: true });
});

function fixture() {
  const directory = mkdtempSync(join(tmpdir(), 'memmy-extension-drag-'));
  temporaryDirectories.push(directory);
  writeFileSync(join(directory, 'manifest.json'), JSON.stringify({ manifest_version: 3 }));
  writeFileSync(join(directory, 'background.js'), '');
  const startDrag = vi.fn();
  const mainFrame = {};
  const webContents = { mainFrame, startDrag };
  const window = { isDestroyed: () => false, webContents } as unknown as BrowserWindow;
  const icon = { isEmpty: () => false } as NativeImage;
  const event = { sender: webContents, senderFrame: mainFrame } as unknown as IpcMainEvent;
  const resolveDirectory = vi.fn(() => directory);
  const loadIcon = vi.fn(() => icon);
  return { directory, startDrag, window, icon, event, resolveDirectory, loadIcon };
}

describe('bundled browser extension native drag', () => {
  it('drags the real extension folder and replies synchronously after startDrag', () => {
    const value = fixture();
    value.startDrag.mockImplementation(() => expect(value.event.returnValue).toBeUndefined());
    createExternalBrowserExtensionDragHandler(() => value.window, value.resolveDirectory, value.loadIcon)(value.event);
    expect(value.startDrag).toHaveBeenCalledExactlyOnceWith({ file: value.directory, icon: value.icon });
    expect(value.event.returnValue).toBe(true);
  });

  it.each(['no-window', 'destroyed-window', 'other-renderer', 'subframe'])(
    'rejects %s before resolving any local asset and still releases the renderer', source => {
      const value = fixture();
      let window: BrowserWindow | null = value.window;
      if (source === 'no-window') window = null;
      if (source === 'destroyed-window') value.window.isDestroyed = () => true;
      if (source === 'other-renderer') value.event.sender = {} as IpcMainEvent['sender'];
      if (source === 'subframe') value.event.senderFrame = {} as IpcMainEvent['senderFrame'];
      createExternalBrowserExtensionDragHandler(() => window, value.resolveDirectory, value.loadIcon)(value.event);
      expect(value.resolveDirectory).not.toHaveBeenCalled();
      expect(value.loadIcon).not.toHaveBeenCalled();
      expect(value.startDrag).not.toHaveBeenCalled();
      expect(value.event.returnValue).toBe(false);
    },
  );

  it.each(['missing-directory', 'missing-manifest', 'invalid-manifest', 'missing-background'])(
    'refuses a %s instead of dragging an invalid extension', condition => {
      const value = fixture();
      if (condition === 'missing-directory') rmSync(value.directory, { recursive: true });
      if (condition === 'missing-manifest') rmSync(join(value.directory, 'manifest.json'));
      if (condition === 'invalid-manifest') writeFileSync(join(value.directory, 'manifest.json'), '{');
      if (condition === 'missing-background') rmSync(join(value.directory, 'background.js'));
      createExternalBrowserExtensionDragHandler(() => value.window, value.resolveDirectory, value.loadIcon)(value.event);
      expect(value.loadIcon).not.toHaveBeenCalled();
      expect(value.startDrag).not.toHaveBeenCalled();
      expect(value.event.returnValue).toBe(false);
    },
  );

  it('replies false for empty icons and native drag errors', () => {
    const value = fixture();
    value.icon.isEmpty = () => true;
    const handler = createExternalBrowserExtensionDragHandler(() => value.window, value.resolveDirectory, value.loadIcon);
    handler(value.event);
    expect(value.startDrag).not.toHaveBeenCalled();
    expect(value.event.returnValue).toBe(false);
    value.icon.isEmpty = () => false;
    value.startDrag.mockImplementation(() => { throw new Error('Native drag failed'); });
    handler(value.event);
    expect(value.event.returnValue).toBe(false);
  });
});

function loadPreload() {
  let api: { dragBrowserExtension(): boolean; prepareBrowserExtension(browser: string, revealFolder?: boolean): Promise<unknown> } | undefined;
  const ipcRenderer = { on: vi.fn(), sendSync: vi.fn().mockReturnValue(true), invoke: vi.fn().mockResolvedValue({}) };
  const source = readFileSync(new URL('../src/preload/preload.cts', import.meta.url), 'utf8');
  const compiled = ts.transpileModule(source, {
    compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 },
  }).outputText;
  const module = { exports: {} };
  Function('require', 'module', 'exports', 'process', compiled)((specifier: string) => {
    if (specifier !== 'electron') throw new Error(`Unexpected preload dependency: ${specifier}`);
    return { ipcRenderer, contextBridge: { exposeInMainWorld: (_name: string, value: typeof api) => { api = value; } } };
  }, module, module.exports, { platform: 'darwin' });
  if (!api) throw new Error('Preload did not expose the Memmy API');
  return { api, ipcRenderer };
}

it('preload sends no renderer file path and preserves the synchronous drag result', () => {
  const { api, ipcRenderer } = loadPreload();
  expect((api.dragBrowserExtension as (...args: unknown[]) => boolean)('/private/renderer-selected-file')).toBe(true);
  expect(ipcRenderer.sendSync).toHaveBeenCalledExactlyOnceWith(EXTERNAL_BROWSER_EXTENSION_DRAG_CHANNEL);
  ipcRenderer.sendSync.mockReturnValue(false);
  expect(api.dragBrowserExtension()).toBe(false);
});

it('preload can prepare the browser page without revealing Finder', async () => {
  const { api, ipcRenderer } = loadPreload();
  await api.prepareBrowserExtension('chrome', false);
  expect(ipcRenderer.invoke).toHaveBeenCalledExactlyOnceWith('memmy:browser-extension:prepare', 'chrome', false);
});

it('main preparation keeps folder reveal optional and validates its flag', async () => {
  const source = readFileSync(new URL('../src/main/main.ts', import.meta.url), 'utf8');
  const ast = ts.createSourceFile('main.ts', source, ts.ScriptTarget.Latest, true);
  let statement: ts.ExpressionStatement | undefined;
  const find = (node: ts.Node) => {
    if (ts.isExpressionStatement(node) && ts.isCallExpression(node.expression)
      && node.expression.expression.getText(ast) === 'ipcMain.handle'
      && node.expression.arguments[0]?.getText(ast) === "'memmy:browser-extension:prepare'") statement = node;
    ts.forEachChild(node, find);
  };
  find(ast);
  if (!statement) throw new Error('Missing extension preparation handler');
  let prepare!: (event: unknown, browser: string, revealFolder?: unknown) => Promise<unknown>;
  const window = {};
  const showItemInFolder = vi.fn();
  const launch = vi.fn().mockResolvedValue('opened');
  const compiled = ts.transpileModule(statement.getText(ast), { compilerOptions: { target: ts.ScriptTarget.ES2022 } }).outputText;
  Function('ipcMain', 'BrowserWindow', 'mainWindow', 'resolveExternalBrowserExtensionDirectory', 'process', 'launchExternalBrowserExtensionManager', 'shell', compiled)(
    { handle: (_channel: string, handler: typeof prepare) => { prepare = handler; } },
    { fromWebContents: () => window }, window, () => '/bundled/browser-extension',
    { resourcesPath: '/bundled' }, launch, { showItemInFolder },
  );
  await expect(prepare({ sender: {} }, 'chrome', false)).resolves.toEqual({ status: 'browser-opened', directory: '/bundled/browser-extension' });
  expect(launch).toHaveBeenCalledWith('chrome');
  expect(showItemInFolder).not.toHaveBeenCalled();
  await prepare({ sender: {} }, 'edge');
  expect(showItemInFolder).toHaveBeenCalledExactlyOnceWith('/bundled/browser-extension');
  await expect(prepare({ sender: {} }, 'chrome', '/private/arbitrary-file')).rejects.toThrow('Invalid browser extension request');
  expect(launch).toHaveBeenCalledTimes(2);
});
