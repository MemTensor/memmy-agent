import { afterEach, expect, it, vi } from 'vitest';
import { execFile } from 'node:child_process';
import { resolveOpenComputerUseCommand } from '../../../src/tools/computer-use/open-computer-use-binary.js';
import { revealWindowsWindow, waitForWindowsTargetIdle, windowsFocusSnapshot } from '../../../src/tools/computer-use/windows-focus-guard.js';

vi.mock('node:child_process', () => {
  const run = vi.fn();
  Object.assign(run, { [Symbol.for('nodejs.util.promisify.custom')]: (...args: any[]) =>
    new Promise((resolve, reject) => run(...args, (error: unknown, stdout: string, stderr: string) => {
      if (error) reject(error); else resolve({ stdout, stderr });
    })) });
  return { execFile: run };
});
vi.mock('../../../src/tools/computer-use/open-computer-use-binary.js', () => ({
  resolveOpenComputerUseCommand: vi.fn(() => 'C:\\Memmy\\memmy-computer-use.exe'),
}));
const target = { pid: 20, windowID: 0x100000034 };
const state = (inputIdle: number, windowID = target.windowID, pid = target.pid) => ({ pid, windowID, inputIdle });
const reply = (value: unknown) => vi.mocked(execFile).mockImplementation(((_file: string, _args: string[],
  _options: unknown, callback: (error: unknown, stdout: string, stderr: string) => void) => {
  callback(null, JSON.stringify(value), '');
}) as any);

afterEach(() => { vi.clearAllMocks(); });

it('uses the bundled read-only CLI and preserves a safe 64-bit HWND', async () => {
  reply(state(0.2));
  await expect(windowsFocusSnapshot()).resolves.toEqual(state(0.2));
  expect(resolveOpenComputerUseCommand).toHaveBeenCalledWith('open-computer-use', { platform: 'win32' });
  expect(execFile).toHaveBeenCalledWith('C:\\Memmy\\memmy-computer-use.exe', ['focus-snapshot'],
    expect.objectContaining({ windowsHide: true, timeout: 3000 }), expect.any(Function));
});

it.each([state(-1), state(NaN), state(0, 0), state(0, Number.MAX_SAFE_INTEGER + 1), state(0, 52, 0)])
  ('rejects an unverified focus snapshot %j', async invalid => {
    reply(invalid);
    await expect(windowsFocusSnapshot()).rejects.toThrow('Invalid Windows Computer Use focus snapshot');
  });

it('waits for five seconds of idle while the exact target remains foreground', async () => {
  const snapshot = vi.fn().mockResolvedValueOnce(state(4.9)).mockResolvedValueOnce(state(5));
  await expect(waitForWindowsTargetIdle(target, { maxWaitMs: 1000 }, snapshot)).resolves.toBe(true);
  expect(snapshot).toHaveBeenCalledTimes(2);
});

it.each([state(0, 53), state(0, target.windowID, 21)])
  ('releases another foreground HWND/PID without treating its input as target input', async unrelated => {
    const snapshot = vi.fn().mockResolvedValue(unrelated);
    await expect(waitForWindowsTargetIdle(target, {}, snapshot)).resolves.toBe(true);
    expect(snapshot).toHaveBeenCalledOnce();
    expect(execFile).not.toHaveBeenCalled();
  });

it('bounds continued target input and treats missing focus state as unverified', async () => {
  await expect(waitForWindowsTargetIdle(target, { maxWaitMs: 0 }, async () => state(0))).resolves.toBe(false);
  await expect(waitForWindowsTargetIdle(target, {}, async () => { throw new Error('locked desktop'); }))
    .resolves.toBe(false);
  await expect(waitForWindowsTargetIdle(target, {}, async () => state(10, 0))).resolves.toBe(false);
});

it('cancels a waiting yield without revealing a window or dispatching input', async () => {
  const controller = new AbortController();
  const snapshot = vi.fn().mockResolvedValue(state(0));
  const pending = waitForWindowsTargetIdle(target, { signal: controller.signal }, snapshot);
  const rejected = expect(pending).rejects.toMatchObject({ name: 'AbortError' });
  await vi.waitFor(() => expect(snapshot).toHaveBeenCalledOnce());
  controller.abort();
  await rejected;
  expect(execFile).not.toHaveBeenCalled();
});

it('reveals only the explicitly requested exact HWND through the native CLI', async () => {
  reply({ success: true });
  await expect(revealWindowsWindow(target.pid, target.windowID)).resolves.toBe(true);
  expect(execFile).toHaveBeenCalledWith('C:\\Memmy\\memmy-computer-use.exe',
    ['reveal-window', '--pid', '20', '--window-id', String(target.windowID)],
    expect.objectContaining({ windowsHide: true, timeout: 5000 }), expect.any(Function));
});

it('does not substitute process-level activation when native reveal cannot verify the window', async () => {
  reply({ success: false });
  await expect(revealWindowsWindow(target.pid, target.windowID)).resolves.toBe(false);
  await expect(revealWindowsWindow(target.pid, Number.MAX_SAFE_INTEGER + 1)).resolves.toBe(false);
  expect(execFile).toHaveBeenCalledOnce();
});
