import { afterEach, expect, it, vi } from 'vitest';
import { execFile } from 'node:child_process';
import { resolveOpenComputerUseCommand } from '../../../src/tools/computer-use/open-computer-use-binary.js';
import { InstalledAppIdentityLookupError, resolveInstalledAppIdentity,
  resolveNativeAppIdentity } from '../../../src/tools/computer-use/native-app-approvals.js';

vi.mock('node:child_process', () => {
  const run = vi.fn();
  Object.assign(run, { [Symbol.for('nodejs.util.promisify.custom')]: (...args: any[]) =>
    new Promise((resolve, reject) => run(...args, (error: unknown, stdout: string, stderr: string) => {
      if (error) reject(error); else resolve({ stdout, stderr });
    })) });
  return { execFile: run };
});
vi.mock('../../../src/tools/computer-use/open-computer-use-binary.js', () => ({
  resolveOpenComputerUseCommand: vi.fn((_command: string, options: { platform: string }) => options.platform === 'win32'
    ? 'C:\\Memmy\\native-computer-use\\windows\\amd64\\memmy-computer-use.exe'
    : '/Memmy.app/Contents/Resources/Memmy Computer Use.app/Contents/MacOS/MemmyComputerUse'),
  openComputerUseEnvironment: vi.fn(() => ({ PATH: 'C:\\Windows\\System32\\WindowsPowerShell\\v1.0' })),
}));
const identity = { platform: 'darwin', appId: 'com.apple.calculator', displayName: '计算器' };
const reply = (raw: unknown, error: Error | null = null) => vi.mocked(execFile).mockImplementation(((_file: string,
  _args: string[], _options: unknown, callback: (error: Error | null, stdout: string, stderr: string) => void) => {
  callback(error, typeof raw === 'string' ? raw : JSON.stringify(raw), '');
}) as any);
afterEach(() => { vi.clearAllMocks(); });

it.each(['Calculator', '计算器', 'com.apple.calculator'])
  ('looks up an installed %s omitted from the recent list without launching it', async target => {
    expect(resolveNativeAppIdentity({ content: [{ type: 'text', text: 'TextEdit — com.apple.TextEdit [running]' }] },
      target, 'darwin')).toBeNull();
    reply({ platform: 'darwin', status: 'resolved', app: { appId: identity.appId, displayName: identity.displayName } });
    const controller = new AbortController();
    await expect(resolveInstalledAppIdentity(target, 'darwin', controller.signal)).resolves.toEqual(identity);
    expect(resolveOpenComputerUseCommand).toHaveBeenCalledWith('open-computer-use', { platform: 'darwin' });
    expect(execFile).toHaveBeenCalledWith(expect.stringContaining('MemmyComputerUse'),
      ['resolve-app', '--query', target], expect.objectContaining({ timeout: 5000, maxBuffer: 16_384,
        signal: controller.signal }), expect.any(Function));
    expect(execFile).toHaveBeenCalledOnce();
  });

it('resolves a Windows app that is installed or has no window, binding a PID only when the helper found one window', async () => {
  reply({ platform: 'win32', status: 'resolved', app: { appId: 'Weixin', displayName: '微信' } });
  await expect(resolveInstalledAppIdentity('微信', 'win32')).resolves.toEqual({ platform: 'win32', appId: 'Weixin', displayName: '微信' });
  expect(execFile).toHaveBeenCalledWith(expect.stringContaining('memmy-computer-use.exe'), ['resolve-app', '--query', '微信'],
    expect.objectContaining({ timeout: 25_000, env: expect.objectContaining({ PATH: expect.stringContaining('WindowsPowerShell') }) }),
    expect.any(Function));
  reply({ platform: 'win32', status: 'resolved', app: { appId: 'notepad', displayName: 'Notepad' }, pid: 4812 });
  await expect(resolveInstalledAppIdentity('记事本', 'win32')).resolves.toEqual({ platform: 'win32', appId: 'notepad',
    displayName: 'Notepad', runtimeSelector: '4812' });
});

it.each(['not-found', 'ambiguous', 'blocked', 'unavailable'])
  ('preserves the native %s status without inventing an app identity', async status => {
    reply({ platform: 'darwin', status });
    await expect(resolveInstalledAppIdentity('Same', 'darwin')).rejects.toMatchObject({ code: status });
  });

it.each([{}, [], null, { platform: 'win32', status: 'resolved', app: identity },
  { platform: 'darwin', status: 'resolved', app: { appId: '../Calculator.app', displayName: 'Calculator' } },
  { platform: 'darwin', status: 'resolved', app: { appId: identity.appId, displayName: '' } },
  { platform: 'darwin', status: 'resolved', app: identity, pid: 42 },
  { platform: 'darwin', status: 'ambiguous', app: identity }, { platform: 'darwin', status: 'guess' }, 'not JSON'])
  ('rejects malformed lookup output %j', async raw => {
    reply(raw);
    await expect(resolveInstalledAppIdentity('Calculator', 'darwin')).rejects.toMatchObject({ code: 'invalid-response' });
  });

it.each([0, -1, 1.5, '42', 0x80000000])('rejects a malformed Windows PID %j', async pid => {
  reply({ platform: 'win32', status: 'resolved', app: { appId: 'notepad', displayName: 'Notepad' }, pid });
  await expect(resolveInstalledAppIdentity('Notepad', 'win32')).rejects.toMatchObject({ code: 'invalid-response' });
});

it('retains Memmy app safety on a native resolved identity', async () => {
  reply({ platform: 'darwin', status: 'resolved', app: { appId: 'com.apple.Terminal', displayName: 'Terminal' } });
  await expect(resolveInstalledAppIdentity('Terminal', 'darwin')).rejects.toMatchObject({ code: 'blocked' });
  reply({ platform: 'win32', status: 'resolved', app: { appId: 'Microsoft.WindowsTerminal_8wekyb3d8bbwe!App', displayName: 'Terminal' } });
  await expect(resolveInstalledAppIdentity('Terminal', 'win32')).rejects.toMatchObject({ code: 'blocked' });
});

it('bounds transport failure and does not retry or launch', async () => {
  reply('', new Error('timeout'));
  await expect(resolveInstalledAppIdentity('Calculator', 'darwin')).rejects.toBeInstanceOf(InstalledAppIdentityLookupError);
  await expect(resolveInstalledAppIdentity('Calculator', 'darwin')).rejects.toMatchObject({ code: 'lookup-failed' });
  expect(execFile).toHaveBeenCalledTimes(2);
});

it('cancels before or during lookup without converting abort into an app denial', async () => {
  const controller = new AbortController();
  controller.abort();
  await expect(resolveInstalledAppIdentity('Calculator', 'darwin', controller.signal)).rejects.toMatchObject({ name: 'AbortError' });
  expect(execFile).not.toHaveBeenCalled();
  const active = new AbortController();
  vi.mocked(execFile).mockImplementation(((_file: string, _args: string[], _options: unknown,
    callback: (error: unknown, stdout: string, stderr: string) => void) => {
    active.abort(); callback(new Error('cancelled'), '', '');
  }) as any);
  await expect(resolveInstalledAppIdentity('Calculator', 'darwin', active.signal)).rejects.toMatchObject({ name: 'AbortError' });
});
