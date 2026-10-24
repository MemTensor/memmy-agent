import { describe, expect, it, vi } from 'vitest';
import { runningExternalBrowsers, type BrowserProcessExecFile } from '../src/main/running-external-browsers.js';

function runner(stdout: string, error: Error | null = null) {
  return vi.fn<BrowserProcessExecFile>((_file, _args, _options, callback) => { callback(error, stdout, ''); });
}

describe('read-only browser process inventory', () => {
  it('restricts the actual running IPC handler to the main application window', async () => {
    const source = readFileSync(new URL('../src/main/main.ts', import.meta.url), 'utf8');
    const ast = ts.createSourceFile('main.ts', source, ts.ScriptTarget.Latest, true);
    let handler: ts.Expression | undefined;
    const visit = (node: ts.Node) => {
      if (ts.isCallExpression(node) && node.expression.getText(ast) === 'ipcMain.handle'
        && node.arguments[0]?.getText(ast) === "'memmy:browser-extension:running'") handler = node.arguments[1];
      ts.forEachChild(node, visit);
    };
    visit(ast);
    expect(handler).toBeDefined();
    const javascript = ts.transpileModule(`const invoke = (${handler!.getText(ast)});`,
      { compilerOptions: { target: ts.ScriptTarget.ES2022 } }).outputText;
    const mainWindow = {};
    const probe = vi.fn(async () => ['chrome']);
    const context = vm.createContext({ mainWindow, BrowserWindow: { fromWebContents: (sender: { window: unknown }) => sender.window },
      runningExternalBrowsers: probe });
    const invoke = vm.runInContext(`${javascript}\ninvoke`, context);
    expect(() => invoke({ sender: { window: {} } })).toThrow('Invalid browser extension request');
    expect(probe).not.toHaveBeenCalled();
    await expect(invoke({ sender: { window: mainWindow } })).resolves.toEqual(['chrome']);
    context.mainWindow = null as any;
    expect(() => invoke({ sender: { window: null } })).toThrow('Invalid browser extension request');
    expect(probe).toHaveBeenCalledOnce();
  });

  it('recognizes the macOS browser executables, including user Applications, without matching helpers', async () => {
    const run = runner([
      '101 /Applications/Google Chrome.app/Contents/MacOS/Google Chrome',
      '102 /Users/fixture/Applications/Microsoft Edge.app/Contents/MacOS/Microsoft Edge',
      '103 /Applications/Google Chrome.app/Contents/Frameworks/Google Chrome Framework.framework/Helpers/Google Chrome Helper',
      '104 /Applications/Microsoft Edge.app/Contents/Frameworks/Microsoft Edge Helper (Renderer)',
      '105 /usr/bin/python',
    ].join('\n'));
    expect(await runningExternalBrowsers({ platform: 'darwin', userId: 501, run })).toEqual(['chrome', 'edge']);
    expect(run).toHaveBeenCalledExactlyOnceWith('/bin/ps', ['-U', '501', '-o', 'pid=,comm=', '-ww'],
      { encoding: 'utf8', timeout: 3_000, maxBuffer: 1_048_576, windowsHide: true }, expect.any(Function));
  });

  it('accepts exact primary macOS executable names but rejects similar names and argument text', async () => {
    expect(await runningExternalBrowsers({ platform: 'darwin', run: runner('111 Google Chrome\n112 Microsoft Edge') }))
      .toEqual(['chrome', 'edge']);
    expect(await runningExternalBrowsers({ platform: 'darwin', run: runner([
      '111 Google Chrome Helper', '112 Microsoft Edge Helper', '113 Google Chrome Canary',
      '114 some-program /Applications/Google Chrome.app/Contents/MacOS/Google Chrome',
      '115 /tmp/google-chrome',
    ].join('\n')) })).toEqual([]);
  });

  it('returns a known empty result when a successful process inventory has no target browsers', async () => {
    expect(await runningExternalBrowsers({ platform: 'darwin', run: runner('1 /sbin/launchd\n2 /usr/bin/login') })).toEqual([]);
    expect(await runningExternalBrowsers({ platform: 'win32', run: runner('[]') })).toEqual([]);
  });

  it('recognizes Windows exact image names and excludes renderer/utility children', async () => {
    const run = runner(JSON.stringify([
      { Name: 'chrome.exe', ExecutablePath: 'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe', CommandLine: '"C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe" --profile-directory=Default' },
      { Name: 'MSEDGE.EXE', ExecutablePath: 'C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe', CommandLine: '"C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe"' },
      { Name: 'chrome.exe', ExecutablePath: null, CommandLine: 'chrome.exe --type=renderer' },
      { Name: 'msedge.exe', ExecutablePath: null, CommandLine: 'msedge.exe --type utility' },
    ]));
    expect(await runningExternalBrowsers({ platform: 'win32', run })).toEqual(['chrome', 'edge']);
    const [file, args, options] = run.mock.calls[0]!;
    expect(file).toBe('powershell.exe');
    expect(args.slice(0, 4)).toEqual(['-NoLogo', '-NoProfile', '-NonInteractive', '-Command']);
    expect(args[4]).toContain('Get-CimInstance Win32_Process');
    expect(args[4]).toContain('AND SessionId = ');
    expect(args[4]).toContain('[System.Diagnostics.Process]::GetCurrentProcess().SessionId');
    expect(options).toEqual({ encoding: 'utf8', timeout: 3_000, maxBuffer: 1_048_576, windowsHide: true });
  });

  it('does not match a browser name in arbitrary Windows command lines or mismatched images', async () => {
    expect(await runningExternalBrowsers({ platform: 'win32', run: runner(JSON.stringify([
      { Name: 'chrome-helper.exe', ExecutablePath: null, CommandLine: 'chrome.exe' },
      { Name: 'python.exe', ExecutablePath: null, CommandLine: 'open chrome.exe and msedge.exe' },
      { Name: 'chrome.exe', ExecutablePath: 'C:\\Tools\\other.exe', CommandLine: null },
      { Name: 'msedge.exe', ExecutablePath: 'C:\\Tools\\msedge.exe', CommandLine: 'msedge.exe --type=renderer' },
    ])) })).toEqual([]);
  });

  it('retains exact Windows OS image identity when optional process fields are unavailable', async () => {
    expect(await runningExternalBrowsers({ platform: 'win32', run: runner('\uFEFF' + JSON.stringify([
      { Name: 'chrome.exe', ExecutablePath: null, CommandLine: null },
    ])) })).toEqual(['chrome']);
  });

  it.each(['darwin', 'win32'] as const)('returns unknown instead of closed when the %s probe fails or times out', async platform => {
    expect(await runningExternalBrowsers({ platform, run: runner('', new Error('timeout or access denied')) })).toBeNull();
    expect(await runningExternalBrowsers({ platform, run: () => { throw new Error('cannot spawn'); } })).toBeNull();
  });

  it.each(['invalid json', '{}', 'null', '[{}]', '[null]', '[{"Name":"chrome.exe","ExecutablePath":1}]'])
    ('returns unknown for malformed Windows process output: %s', async stdout => {
      expect(await runningExternalBrowsers({ platform: 'win32', run: runner(stdout) })).toBeNull();
    });

  it('returns unknown for malformed macOS output and unsupported platforms', async () => {
    expect(await runningExternalBrowsers({ platform: 'darwin', run: runner('permission denied') })).toBeNull();
    const run = runner('[]');
    expect(await runningExternalBrowsers({ platform: 'linux', run })).toBeNull();
    expect(run).not.toHaveBeenCalled();
  });

  it('does not widen a macOS probe to every user when the current UID is unavailable', async () => {
    const run = runner('111 Google Chrome');
    expect(await runningExternalBrowsers({ platform: 'darwin', userId: Number.NaN, run })).toBeNull();
    expect(run).not.toHaveBeenCalled();
  });
});
import { readFileSync } from 'node:fs';
import vm from 'node:vm';
import ts from 'typescript';
