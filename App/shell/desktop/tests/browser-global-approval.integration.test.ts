import { existsSync, mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { createContext, runInContext } from 'node:vm';
import ts from 'typescript';
import { afterEach, expect, it, vi } from 'vitest';
import { EMBEDDED_BROWSER_REQUEST, browserUsePatternMatches, parseBrowserTaskSitePermission,
  type BrowserUseSiteRule, type EmbeddedBrowserRequest } from '@memmy/local-api-contracts';
import { BrowserAllowAll } from '../src/main/browser-allow-all.js';
import { BrowserAccessStore } from '../src/main/browser-access-store.js';
import { rememberBrowserCdpGrant } from '../src/main/browser-cdp-remembered-grant.js';
import { runApprovedEmbeddedCdpRead, runApprovedEmbeddedCdpWrite } from '../src/main/browser-embedded-cdp-access.js';
import { queryInAppBrowserHistory } from '../src/main/browser-history-access.js';
import { BrowserHistoryStore } from '../src/main/browser-history-store.js';
import { BrowserUseSitePolicyStore } from '../src/main/browser-use-site-policy-store.js';
import { NativeAppAllowAll } from '../src/main/native-app-allow-all.js';
import { BrowserSitePermissions } from '../src/main/browser-site-permissions.js';
import { BrowserTaskSitePermissions } from '../src/main/browser-task-site-permissions.js';

// Run the actual desktop approval functions, runtime callbacks and settings IPC handlers.
// Only Electron windows/dialogs and the final page driver are replaced; permission stores
// and the embedded CDP/history approval gates run against temporary files.
const source = ts.createSourceFile('main.ts', readFileSync(new URL('../src/main/main.ts', import.meta.url), 'utf8'), ts.ScriptTarget.Latest, true);
const functionNames = new Set(['allowAllNativeApps', 'browserAllowAllStore', 'browserAllowAllState',
  'browserSiteDecision', 'publishBrowserAllowAll', 'showBrowserApproval', 'approveBrowserCapabilityOperation']);
const callbacks = new Set(['handleEmbeddedBrowserRequest', 'approveBrowserAccess', 'approveBrowserCapability']);
const ipcChannels = new Set(['memmy:computer-use:allow-all-apps:get', 'memmy:computer-use:allow-all-apps:set',
  'memmy:browser-allow-all:get', 'memmy:browser-allow-all:set']);
const callbackNodes: ts.PropertyAssignment[] = [];
const ipcNodes: ts.ExpressionStatement[] = [];
function visit(node: ts.Node) {
  if (ts.isPropertyAssignment(node) && callbacks.has(node.name.getText(source))) callbackNodes.push(node);
  if (ts.isExpressionStatement(node) && ts.isCallExpression(node.expression)
    && node.expression.expression.getText(source) === 'ipcMain.handle'
    && ts.isStringLiteral(node.expression.arguments[0]!)
    && ipcChannels.has(node.expression.arguments[0].text)) ipcNodes.push(node);
  ts.forEachChild(node, visit);
}
visit(source);
const selected = source.statements.filter(statement => ts.isFunctionDeclaration(statement)
  && functionNames.has(statement.name?.text ?? ''));
const code = ts.transpileModule([
  'let nativeAppAllowAll = null; const pendingBrowserApprovals = new Set();',
  ...selected.map(statement => statement.getText(source)),
  `globalThis.runtimeCallbacks = { ${callbackNodes.map(node => node.getText(source)).join(',\n')} };`,
  ...ipcNodes.map(node => node.getText(source)),
  'globalThis.approveCapability = approveBrowserCapabilityOperation;',
].join('\n'), { compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.CommonJS } }).outputText;

const directories: string[] = [];
afterEach(() => { for (const directory of directories.splice(0)) rmSync(directory, { recursive: true, force: true }); });
const origin = 'https://blocked.example';
type Capability = 'download' | 'upload' | 'debug' | 'debug-write';
type Prompt = { buttons: string[]; cancelId?: number; signal?: AbortSignal };
type Approval = { isAllowed?: () => boolean; mode?: string };
type Callbacks = {
  approveBrowserAccess(origin: string, url: string): Promise<string>;
  approveBrowserCapability(request: { capability: Capability; origin: string; names: string[] }): Promise<boolean>;
  handleEmbeddedBrowserRequest(request: EmbeddedBrowserRequest, isCurrentChild: () => boolean): Promise<unknown>;
};
function request(command: EmbeddedBrowserRequest['command'], args: Record<string, unknown> = {}): EmbeddedBrowserRequest {
  return { type: EMBEDDED_BROWSER_REQUEST, requestId: `test-${command}`, command,
    ...(command === 'queryHistory' ? {} : { tabId: 27 }), args };
}
function setup(platform: 'darwin' | 'win32' = 'darwin') {
  const directory = mkdtempSync(join(tmpdir(), 'memmy-browser-global-')); directories.push(directory);
  const userData = join(directory, 'desktop'), agentData = join(directory, 'agent');
  const native = new NativeAppAllowAll(userData);
  const websites = new BrowserAllowAll(agentData, () => native.isEnabled());
  const policies = new BrowserUseSitePolicyStore(agentData);
  const remembered = new BrowserAccessStore(agentData);
  const history = new BrowserHistoryStore(join(userData, 'history.json'));
  const mainWindow = { isDestroyed: () => false, webContents: { send: vi.fn() } };
  const otherWindow = { isDestroyed: () => false, webContents: { send: vi.fn() } };
  const presentApprovalWindow = vi.fn(() => mainWindow);
  const showMessageBox = vi.fn(async (...args: unknown[]) => ({ response: (args.at(-1) as Prompt).cancelId ?? 0, checkboxChecked: false }));
  const driver = {
    taskSitePermissions: new BrowserTaskSitePermissions(),
    uploadOrigin: vi.fn(() => origin),
    handle: vi.fn(async (_request: EmbeddedBrowserRequest, _upload?: unknown, approval?: Approval) => {
      if (approval?.isAllowed && !approval.isAllowed()) throw new Error('Page policy no longer allows this operation');
      return { allowed: true };
    }),
  };
  const ipcHandlers = new Map<string, (event: { sender: unknown }, enabled?: unknown) => unknown>();
  const context = createContext({
    app: { getPath: () => userData, getLocale: () => 'en-US' }, process: { platform },
    runtimeServices: { agentGateway: { configPath: join(agentData, 'agent.json'), workspace: join(agentData, 'workspace') } },
    BrowserAllowAll, NativeAppAllowAll, BrowserUseSitePolicyStore, BrowserAccessStore, BrowserSitePermissions,
    browserUsePatternMatches, parseBrowserTaskSitePermission, rememberBrowserCdpGrant, dirname, AbortController,
    BrowserWindow: { getAllWindows: () => [mainWindow, otherWindow],
      fromWebContents: (sender: unknown) => sender === mainWindow.webContents ? mainWindow : null },
    mainWindow, presentApprovalWindow, dialog: { showMessageBox },
    embeddedBrowserDriver: driver, embeddedBrowserHistoryStore: history,
    queryInAppBrowserHistory, runApprovedEmbeddedCdpRead, runApprovedEmbeddedCdpWrite,
    ipcMain: { handle: (channel: string, handler: (event: { sender: unknown }, enabled?: unknown) => unknown) => ipcHandlers.set(channel, handler) },
  });
  runInContext(code, context);
  const runtimeCallbacks = context.runtimeCallbacks as Callbacks;
  const approveCapability = context.approveCapability as (capability: Capability, origin: string, names: string[]) => Promise<boolean>;
  const setGlobal = (scope: 'computer' | 'websites', enabled: boolean) => ipcHandlers.get(scope === 'computer'
    ? 'memmy:computer-use:allow-all-apps:set' : 'memmy:browser-allow-all:set')!({ sender: mainWindow.webContents }, enabled);
  return { native, websites, policies, remembered, history, mainWindow, otherWindow, driver, agentData,
    presentApprovalWindow, showMessageBox, runtimeCallbacks, approveCapability, setGlobal, ipcHandlers };
}
function blockedRule(): BrowserUseSiteRule {
  return { pattern: origin, access: 'block', downloads: 'block', uploads: 'block', fullCdp: 'block' };
}
function historyRequest() {
  return request('queryHistory', { from: new Date(Date.now() - 86_400_000).toISOString(),
    to: new Date(Date.now() - 1000).toISOString(), keyword: 'example', limit: 10 });
}

it('keeps an Agent device grant to the task tab and current website and never saves it under allow-all', async () => {
  const test = setup();
  const permissions = new BrowserSitePermissions(test.agentData);
  const tasks = test.driver.taskSitePermissions;
  let agentCurrent = true;
  test.setGlobal('computer', true);
  const granted = await test.runtimeCallbacks.handleEmbeddedBrowserRequest(request('setSitePermission', {
    origin, permission: 'camera', allow: true,
  }), () => agentCurrent);
  expect(existsSync(permissions.filePath)).toBe(false);
  expect(tasks.decision(27, origin, 'camera')).toBe(true);
  expect(tasks.decision(28, origin, 'camera')).toBeUndefined();
  expect(granted).toEqual({ status: 'granted', origin, permission: 'camera', allowed: true, lasts: 'task' });
  await expect(test.runtimeCallbacks.handleEmbeddedBrowserRequest(request('setSitePermission', {
    origin: 'https://another.example', permission: 'microphone', allow: true,
  }), () => true)).rejects.toThrow('no longer current');
  expect(await test.runtimeCallbacks.handleEmbeddedBrowserRequest(request('endSitePermissions'), () => true))
    .toEqual({ ended: true });
  expect(tasks.decision(27, origin, 'camera')).toBeUndefined();
  await test.runtimeCallbacks.handleEmbeddedBrowserRequest(request('setSitePermission', {
    origin, permission: 'camera', allow: true,
  }), () => agentCurrent);
  agentCurrent = false;
  expect(tasks.decision(27, origin, 'camera')).toBeUndefined();
  test.setGlobal('computer', false);
  expect(permissions.list()).toEqual([]);
});

it('rejects stale or blocked device grants and lets a task revocation override a saved grant without editing it', async () => {
  const test = setup();
  const permissions = new BrowserSitePermissions(test.agentData);
  const tasks = test.driver.taskSitePermissions;
  test.setGlobal('websites', true);
  await expect(test.runtimeCallbacks.handleEmbeddedBrowserRequest(request('setSitePermission', {
    origin, permission: 'microphone', allow: true,
  }), () => false)).rejects.toThrow('no longer current');
  permissions.set(origin, 'microphone', true);
  test.policies.upsert(blockedRule());
  for (const enabled of [true, false]) {
    test.setGlobal('websites', enabled);
    await expect(test.runtimeCallbacks.handleEmbeddedBrowserRequest(request('setSitePermission', {
      origin, permission: 'camera', allow: true,
    }), () => true)).rejects.toThrow('no longer current');
  }
  expect(tasks.decision(27, origin, 'camera')).toBeUndefined();
  const revoked = await test.runtimeCallbacks.handleEmbeddedBrowserRequest(request('setSitePermission', {
    origin, permission: 'microphone', allow: false,
  }), () => true);
  expect(permissions.list()).toEqual([{ origin, permissions: ['microphone'] }]);
  expect(tasks.decision(27, origin, 'microphone')).toBe(false);
  expect(revoked).toEqual({ status: 'revoked', origin, permission: 'microphone', allowed: false, lasts: 'task' });
});

it.each(['darwin', 'win32'] as const)('gives either global setting priority over remembered and site denials on %s', async platform => {
  for (const scope of ['computer', 'websites'] as const) {
    const test = setup(platform);
    const rule = blockedRule(); test.policies.upsert(rule); test.remembered.set(origin, 'deny');
    test.setGlobal(scope, true);
    expect(await test.runtimeCallbacks.approveBrowserAccess(origin, `${origin}/page`)).toBe('allow-always');
    for (const capability of ['download', 'upload', 'debug', 'debug-write'] as const) {
      expect(await test.runtimeCallbacks.approveBrowserCapability({ capability, origin, names: ['sample'] })).toBe(true);
    }
    expect(test.showMessageBox).not.toHaveBeenCalled();
    expect(test.presentApprovalWindow).not.toHaveBeenCalled();
    expect(test.policies.list()).toEqual([rule]);
    expect(test.remembered.list()).toEqual([{ origin, decision: 'deny' }]);
    test.setGlobal(scope, false);
    expect(await test.runtimeCallbacks.approveBrowserAccess(origin, `${origin}/page`)).toBe('deny');
    expect(await test.approveCapability('debug-write', origin, ['Runtime.evaluate'])).toBe(false);
    expect(test.showMessageBox).not.toHaveBeenCalled();
  }
});

it.each([false, true])('persists the all-websites dialog choice with an existing site rule = %s', async matched => {
  const test = setup();
  if (matched) test.policies.upsert({ pattern: origin, access: 'ask', downloads: 'block', uploads: 'ask', fullCdp: 'block' });
  const previous = test.policies.list();
  test.showMessageBox.mockImplementationOnce(async (...args: unknown[]) => {
    const options = args.at(-1) as Prompt;
    return { response: options.buttons.indexOf('Allow operations on all websites'), checkboxChecked: false };
  });
  expect(await test.runtimeCallbacks.approveBrowserAccess(origin, `${origin}/page`)).toBe('allow-always');
  expect(new BrowserAllowAll(test.agentData, () => false).read().enabled).toBe(true);
  expect(test.websites.read()).toEqual({ enabled: true, inherited: false, effective: true });
  expect(test.native.isEnabled()).toBe(false);
  expect(test.policies.list()).toEqual(previous);
  expect(await test.approveCapability('debug-write', origin, ['Runtime.evaluate'])).toBe(true);
  expect(test.showMessageBox).toHaveBeenCalledOnce();
  expect(test.mainWindow.webContents.send).toHaveBeenCalledWith('memmy:browser-allow-all:changed', { enabled: true, inherited: false, effective: true });
});

it.each(['computer', 'websites'] as const)('settles every pending browser approval after %s allows all', async scope => {
  const test = setup();
  const prompts: Prompt[] = [];
  test.showMessageBox.mockImplementation((...args: unknown[]) => {
    const options = args.at(-1) as Prompt; prompts.push(options);
    return new Promise(resolve => options.signal!.addEventListener('abort', () => resolve({ response: options.cancelId ?? 0, checkboxChecked: false }), { once: true }));
  });
  const pending = [
    test.runtimeCallbacks.approveBrowserAccess(origin, `${origin}/page`),
    test.approveCapability('debug-write', origin, ['Runtime.evaluate']),
    test.runtimeCallbacks.handleEmbeddedBrowserRequest(historyRequest(), () => true),
  ];
  expect(prompts).toHaveLength(3);
  test.setGlobal(scope, true);
  expect(await Promise.all(pending)).toEqual(['allow-always', true, { entries: [] }]);
  expect(prompts.every(prompt => prompt.signal?.aborted)).toBe(true);
  expect(test.otherWindow.webContents.send).toHaveBeenCalledWith('memmy:browser-allow-all:changed', test.websites.read());
});

it.each(['debug', 'debug-write'] as const)('saves the %s always-allow choice for the site without enabling every website', async capability => {
  const test = setup();
  const saved: BrowserUseSiteRule = { pattern: origin, access: 'allow', downloads: 'block', uploads: 'ask', fullCdp: 'ask' };
  test.policies.upsert(saved);
  test.showMessageBox.mockImplementationOnce(async (...args: unknown[]) => ({
    response: (args.at(-1) as Prompt).buttons.indexOf('Always allow this site'), checkboxChecked: false,
  }));
  expect(await test.approveCapability(capability, origin, ['Runtime.evaluate'])).toBe(true);
  expect(test.policies.list()).toEqual([{ ...saved, fullCdp: 'allow' }]);
  expect(test.websites.read().effective).toBe(false);
  expect(await test.approveCapability('debug-write', origin, ['Runtime.evaluate'])).toBe(true);
  expect(await test.approveCapability('download', origin, ['file.txt'])).toBe(false);
  expect(test.showMessageBox).toHaveBeenCalledOnce();
});

it.each(['computer', 'websites'] as const)('uses the %s grant for embedded CDP, history and Playwright and rechecks after revocation', async scope => {
  const test = setup(); test.policies.upsert(blockedRule());
  test.history.recordVisit('test-session', `${origin}/page`, 'Example page', Date.now() - 10_000);
  test.setGlobal(scope, true);
  const read = request('cdpCall', { method: 'Page.getLayoutMetrics', params: {} });
  const write = request('cdpWrite', { method: 'Runtime.evaluate', params: { expression: 'document.title = "changed"' } });
  const playwright = request('playwrightStart', { approvedOrigin: origin });
  for (const operation of [read, write, playwright]) {
    expect(await test.runtimeCallbacks.handleEmbeddedBrowserRequest(operation, () => true)).toEqual({ allowed: true });
  }
  expect(await test.runtimeCallbacks.handleEmbeddedBrowserRequest(historyRequest(), () => true)).toEqual({ entries: [expect.objectContaining({ title: 'Example page' })] });
  expect(test.showMessageBox).not.toHaveBeenCalled();
  const grants = test.driver.handle.mock.calls.map(call => call[2]);
  expect(grants.map(grant => grant?.isAllowed?.())).toEqual([true, true, true]);
  test.setGlobal(scope, false);
  expect(grants.map(grant => grant?.isAllowed?.())).toEqual([false, false, false]);
  for (const operation of [read, write, playwright]) {
    await expect(test.runtimeCallbacks.handleEmbeddedBrowserRequest(operation, () => true)).rejects.toThrow(/policy/);
  }
  await expect(test.runtimeCallbacks.handleEmbeddedBrowserRequest(historyRequest(), () => true)).rejects.toThrow(/denied/);
  expect(test.showMessageBox).toHaveBeenCalledOnce();
});

it('preserves independent website consent across computer allow-all changes through the real IPC handlers', () => {
  const test = setup();
  test.setGlobal('websites', true);
  test.setGlobal('computer', true);
  expect(test.websites.read()).toEqual({ enabled: true, inherited: true, effective: true });
  test.setGlobal('computer', false);
  expect(test.websites.read()).toEqual({ enabled: true, inherited: false, effective: true });
  expect(() => test.ipcHandlers.get('memmy:browser-allow-all:set')!({ sender: {} }, false)).toThrow(/Invalid/);
  expect(test.websites.read().enabled).toBe(true);
});
