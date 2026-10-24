import { readFileSync } from 'node:fs';
import ts from 'typescript';
import { expect, it, vi } from 'vitest';

function preload() {
  let api!: { selectEmbeddedBrowserTab(tabId: number | null): void;
    onEmbeddedBrowserOpen(callback: (url: string, owner?: { scopeKey?: string; sourceGuestId?: number }) => void): () => void };
  const ipcRenderer = { on: vi.fn(), send: vi.fn(), sendSync: vi.fn(), invoke: vi.fn() };
  const source = readFileSync(new URL('../src/preload/preload.cts', import.meta.url), 'utf8');
  const compiled = ts.transpileModule(source, {
    compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 },
  }).outputText;
  const module = { exports: {} };
  Function('require', 'module', 'exports', 'process', compiled)((specifier: string) => {
    if (specifier !== 'electron') throw new Error(`Unexpected preload dependency: ${specifier}`);
    return { ipcRenderer, contextBridge: { exposeInMainWorld: (_name: string, value: typeof api) => { api = value; } } };
  }, module, module.exports, { platform: 'darwin' });
  return { api, send: ipcRenderer.send, on: ipcRenderer.on };
}

it('preload preserves safe tab owners and rejects malformed owner payloads', () => {
  const { api, on } = preload();
  const receive = vi.fn();
  api.onEmbeddedBrowserOpen(receive);
  const listener = on.mock.calls.find(call => call[0] === 'memmy:browser:open-url')![1];
  const url = 'https://example.com/';
  listener({}, url, { scopeKey: 'session-a' });
  listener({}, url, { sourceGuestId: 27 });
  listener({}, url);
  expect(receive.mock.calls).toEqual([[url, { scopeKey: 'session-a' }], [url, { sourceGuestId: 27 }], [url]]);
  receive.mockClear();
  for (const owner of [null, [], 'session-a', { scopeKey: '' }, { scopeKey: 'x'.repeat(513) },
    { scopeKey: 'scope\nother' }, { scopeKey: false }, { sourceGuestId: '27' },
    { sourceGuestId: 0 }, { sourceGuestId: 27.5 }, { sourceGuestId: NaN }, { untrusted: 'field' }]) {
    listener({}, url, owner);
  }
  expect(receive).not.toHaveBeenCalled();
});

it('preload sends an explicit null selection and rejects invalid tab identities', () => {
  const { api, send } = preload();
  api.selectEmbeddedBrowserTab(27);
  api.selectEmbeddedBrowserTab(null);
  expect(send.mock.calls).toEqual([
    ['memmy:browser:select-tab', 27], ['memmy:browser:select-tab', null],
  ]);
  send.mockClear();
  for (const invalid of [undefined, false, '27', 0, -1, 27.5, NaN, Infinity, {}]) {
    (api.selectEmbeddedBrowserTab as (value: unknown) => void)(invalid);
  }
  expect(send).not.toHaveBeenCalled();
});

function selectionHandler(mainWindow: unknown, selectTab = vi.fn()) {
  const source = readFileSync(new URL('../src/main/main.ts', import.meta.url), 'utf8');
  const ast = ts.createSourceFile('main.ts', source, ts.ScriptTarget.Latest, true);
  let statement: ts.ExpressionStatement | undefined;
  const find = (node: ts.Node) => {
    if (ts.isExpressionStatement(node) && ts.isCallExpression(node.expression)
      && node.expression.expression.getText(ast) === 'ipcMain.on'
      && node.expression.arguments[0]?.getText(ast) === "'memmy:browser:select-tab'") statement = node;
    ts.forEachChild(node, find);
  };
  find(ast);
  if (!statement) throw new Error('Missing embedded browser selection handler');
  let handler!: (event: unknown, value: unknown) => void;
  const compiled = ts.transpileModule(statement.getText(ast), {
    compilerOptions: { target: ts.ScriptTarget.ES2022 },
  }).outputText;
  Function('ipcMain', 'mainWindow', 'embeddedBrowserDriver', compiled)(
    { on: (_channel: string, callback: typeof handler) => { handler = callback; } }, mainWindow, { selectTab },
  );
  return { handler, selectTab };
}

it('main accepts a host null selection while rejecting foreign senders, invalid identities, and unavailable hosts', () => {
  const webContents = {};
  const host = { webContents, isDestroyed: () => false };
  const { handler, selectTab } = selectionHandler(host);
  handler({ sender: webContents }, 27);
  handler({ sender: webContents }, null);
  expect(selectTab.mock.calls).toEqual([[27, host], [null, host]]);
  selectTab.mockClear();
  handler({ sender: {} }, null);
  handler({ sender: {} }, 27);
  for (const invalid of [undefined, false, '27', 0, -1, 27.5, NaN, Infinity, {}]) {
    handler({ sender: webContents }, invalid);
  }
  selectionHandler(null, selectTab).handler({ sender: webContents }, null);
  selectionHandler({ ...host, isDestroyed: () => true }, selectTab).handler({ sender: webContents }, null);
  expect(selectTab).not.toHaveBeenCalled();
});

it('main forwards a popup with its actual source guest instead of selecting a current chat owner', () => {
  const source = readFileSync(new URL('../src/main/main.ts', import.meta.url), 'utf8');
  const ast = ts.createSourceFile('main.ts', source, ts.ScriptTarget.Latest, true);
  let statement: ts.ExpressionStatement | undefined;
  const find = (node: ts.Node) => {
    if (ts.isExpressionStatement(node) && ts.isCallExpression(node.expression)
      && node.expression.expression.getText(ast) === 'guest.setWindowOpenHandler') statement = node;
    ts.forEachChild(node, find);
  };
  find(ast);
  if (!statement) throw new Error('Missing embedded browser popup handler');
  let handler!: (request: { url: string }) => { action: string };
  const send = vi.fn();
  const compiled = ts.transpileModule(statement.getText(ast), {
    compilerOptions: { target: ts.ScriptTarget.ES2022 },
  }).outputText;
  Function('guest', 'targetMainWindow', 'isBrowserPageUrl', compiled)(
    { id: 27, setWindowOpenHandler: (callback: typeof handler) => { handler = callback; } },
    { webContents: { send } }, (url: string) => url.startsWith('https://'),
  );
  expect(handler({ url: 'https://example.com/next' })).toEqual({ action: 'deny' });
  expect(send).toHaveBeenCalledExactlyOnceWith('memmy:browser:open-url', 'https://example.com/next', { sourceGuestId: 27 });
  send.mockClear();
  expect(handler({ url: 'file:///private/test' })).toEqual({ action: 'deny' });
  expect(send).not.toHaveBeenCalled();
});
