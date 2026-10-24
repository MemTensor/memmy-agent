import { readFileSync } from 'node:fs';
import ts from 'typescript';
import { expect, it, vi } from 'vitest';

function handlers() {
  const source = readFileSync(new URL('../src/main/main.ts', import.meta.url), 'utf8');
  const ast = ts.createSourceFile('main.ts', source, ts.ScriptTarget.Latest, true);
  let callback: ts.ArrowFunction | undefined;
  const find = (node: ts.Node) => {
    if (ts.isPropertyAssignment(node) && node.name.getText(ast) === 'handleEmbeddedBrowserRequest'
      && ts.isArrowFunction(node.initializer)) callback = node.initializer;
    ts.forEachChild(node, find);
  };
  find(ast);
  if (!callback || !ts.isBlock(callback.body)) throw new Error('Missing browser child IPC callback');
  const statements = callback.body.statements.filter(statement => ts.isIfStatement(statement)
    && ["request.command === 'externalBrowserState'", "request.command === 'recoverExternalBrowser'"]
      .includes(statement.expression.getText(ast))).map(statement => statement.getText(ast));
  if (statements.length !== 2) throw new Error('Missing external browser IPC branches');
  const installation = { chrome: { installed: true, enabled: true }, edge: { installed: false, enabled: false } };
  const probe = vi.fn(() => installation);
  const running = vi.fn(async (): Promise<Array<'chrome' | 'edge'> | null> => ['chrome']);
  const wake = vi.fn(async () => 'woken');
  const compiled = ts.transpileModule(`return async (request, isCurrentChild) => { ${statements.join('\n')} };`, {
    compilerOptions: { target: ts.ScriptTarget.ES2022 },
  }).outputText;
  const handle = Function('probeExternalBrowserInstallation', 'runningExternalBrowsers', 'wakeExternalBrowser', compiled)(
    probe, running, wake,
  ) as (request: { command: string; args: Record<string, unknown> }, current: () => boolean) => Promise<unknown>;
  return { handle, probe, running, wake, installation };
}

it('returns only extension state and process browser names across the Agent IPC boundary', async () => {
  const f = handlers();
  expect(await f.handle({ command: 'externalBrowserState', args: {} }, () => true))
    .toEqual({ installation: f.installation, runningBrowsers: ['chrome'] });
  expect(f.probe).toHaveBeenCalledOnce();
  expect(f.running).toHaveBeenCalledOnce();
  expect(f.wake).not.toHaveBeenCalled();
});

it('recovers a confirmed enabled, installed, running target without a page URL or profile arguments', async () => {
  const f = handlers();
  expect(await f.handle({ command: 'recoverExternalBrowser', args: { browser: 'chrome' } }, () => true)).toBe('woken');
  expect(f.wake).toHaveBeenCalledExactlyOnceWith('chrome');
});

it.each([
  { installed: null, enabled: null },
  { installed: true, enabled: null },
])('recovers a running requested browser when protected configuration cannot establish enablement: %j', async state => {
  const f = handlers();
  f.probe.mockReturnValue({ ...f.installation, chrome: state } as typeof f.installation);
  expect(await f.handle({ command: 'recoverExternalBrowser', args: { browser: 'chrome' } }, () => true)).toBe('woken');
  expect(f.wake).toHaveBeenCalledExactlyOnceWith('chrome');
});

it.each([
  { installed: false, enabled: false, running: ['chrome'] as const },
  { installed: true, enabled: false, running: ['chrome'] as const },
  { installed: true, enabled: true, running: [] as const },
  { installed: true, enabled: true, running: null },
])('does not launch on missing, disabled, or unconfirmed running process: %j', async ({ installed, enabled, running }) => {
  const f = handlers();
  f.probe.mockReturnValue({ ...f.installation, chrome: { installed, enabled } } as typeof f.installation);
  f.running.mockResolvedValue(running ? [...running] : null);
  expect(await f.handle({ command: 'recoverExternalBrowser', args: { browser: 'chrome' } }, () => true)).toBe('unavailable');
  expect(f.wake).not.toHaveBeenCalled();
});

it.each(['externalBrowserState', 'recoverExternalBrowser'])('rejects stale IPC before or after probing for %s', async command => {
  const f = handlers();
  const request = { command, args: { browser: 'chrome' } };
  await expect(f.handle(request, () => false)).rejects.toThrow('finished turn');
  expect(f.probe).not.toHaveBeenCalled();
  let current = true;
  f.running.mockImplementation(async () => { current = false; return ['chrome']; });
  await expect(f.handle(request, () => current)).rejects.toThrow('finished turn');
  expect(f.wake).not.toHaveBeenCalled();
});

it('rejects a recovery reply whose owning request was canceled while waking', async () => {
  const f = handlers();
  let current = true;
  f.wake.mockImplementation(async () => { current = false; return 'woken'; });
  await expect(f.handle({ command: 'recoverExternalBrowser', args: { browser: 'chrome' } }, () => current))
    .rejects.toThrow('finished turn');
});
