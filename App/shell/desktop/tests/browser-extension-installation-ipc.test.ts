import { readFileSync } from 'node:fs';
import ts from 'typescript';
import { describe, expect, it, vi } from 'vitest';
import { probeExternalBrowserInstallation } from '../src/main/installed-external-browsers.js';

const channel = 'memmy:browser-extension:installation';

// Exercise the actual main handler and exposed preload API without starting Electron.
function bridge(platform: 'darwin' | 'win32', probe: typeof probeExternalBrowserInstallation) {
  const source = readFileSync(new URL('../src/main/main.ts', import.meta.url), 'utf8');
  const ast = ts.createSourceFile('main.ts', source, ts.ScriptTarget.Latest, true);
  let handler: ts.Expression | undefined;
  const visit = (node: ts.Node) => {
    if (ts.isCallExpression(node) && node.expression.getText(ast) === 'ipcMain.handle'
      && ts.isStringLiteral(node.arguments[0]!) && node.arguments[0].text === channel) handler = node.arguments[1];
    ts.forEachChild(node, visit);
  };
  visit(ast);
  if (!handler) throw new Error('Missing installation state handler');
  const mainWindow = {};
  const compiledHandler = ts.transpileModule(`return (${handler.getText(ast)});`, {
    compilerOptions: { target: ts.ScriptTarget.ES2022 },
  }).outputText;
  const invoke = Function('mainWindow', 'BrowserWindow', 'probeExternalBrowserInstallation', compiledHandler)(
    mainWindow, { fromWebContents: (sender: { window: object }) => sender.window }, probe,
  );
  const ipcRenderer = { on: vi.fn(), send: vi.fn(), sendSync: vi.fn(), invoke: vi.fn(async (name: string) => {
    if (name !== channel) throw new Error('Unexpected IPC channel');
    return invoke({ sender: { window: mainWindow } });
  }) };
  let api!: { getBrowserExtensionInstallation(): Promise<ReturnType<typeof probe>> };
  const preload = readFileSync(new URL('../src/preload/preload.cts', import.meta.url), 'utf8');
  const compiled = ts.transpileModule(preload, {
    compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 },
  }).outputText;
  const module = { exports: {} };
  Function('require', 'module', 'exports', 'process', compiled)((specifier: string) => {
    if (specifier !== 'electron') throw new Error(`Unexpected preload dependency: ${specifier}`);
    return { ipcRenderer, contextBridge: { exposeInMainWorld: (_name: string, value: typeof api) => { api = value; } } };
  }, module, module.exports, { platform });
  return { api, invoke, ipcRenderer };
}

describe.each(['darwin', 'win32'] as const)('%s browser installation IPC', platform => {
  it.each(['EPERM', 'EACCES'])('preserves %s from browser metadata reads through the main and preload boundary', async code => {
    const probe = () => probeExternalBrowserInstallation({ platform, home: '/fixture', env: { LOCALAPPDATA: 'C:\\fixture' },
      fileExists: () => true,
      readFile: () => { throw Object.assign(new Error('Access denied'), { code }); },
    });
    const { api, ipcRenderer } = bridge(platform, probe);
    expect(await api.getBrowserExtensionInstallation()).toEqual({
      chrome: { installed: null, enabled: null }, edge: { installed: null, enabled: null },
    });
    expect(ipcRenderer.invoke).toHaveBeenCalledExactlyOnceWith(channel);
  });

  it('keeps disabled, absent and unknown browser facts distinct', async () => {
    const state = { chrome: { installed: true, enabled: false }, edge: { installed: null, enabled: null } };
    const probe = vi.fn(() => state);
    const { api, invoke } = bridge(platform, probe);
    expect(() => invoke({ sender: { window: {} } })).toThrow('Invalid browser extension request');
    expect(probe).not.toHaveBeenCalled();
    expect(await api.getBrowserExtensionInstallation()).toEqual(state);
    probe.mockReturnValue({ chrome: { installed: false, enabled: false }, edge: { installed: null, enabled: null } });
    expect((await api.getBrowserExtensionInstallation()).chrome).toEqual({ installed: false, enabled: false });
  });
});
