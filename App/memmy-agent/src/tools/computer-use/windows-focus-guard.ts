import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { setTimeout as delay } from 'node:timers/promises';
import { resolveOpenComputerUseCommand } from './open-computer-use-binary.js';

const execFileAsync = promisify(execFile);
export const WINDOWS_USER_INPUT_DEBOUNCE_SECONDS = 5;
export type WindowsFocusSnapshot = { pid: number; windowID: number; inputIdle: number };
export type WindowsTarget = { pid: number; windowID: number };
export type WindowsIdleOptions = { signal?: AbortSignal | null; maxWaitMs?: number };

export function isWindowsWindowID(value: unknown): value is number {
  return typeof value === 'number' && Number.isSafeInteger(value) && value > 0;
}

function isSnapshot(value: any): value is WindowsFocusSnapshot {
  return value && Number.isSafeInteger(value.pid) && value.pid > 0
    && isWindowsWindowID(value.windowID)
    && typeof value.inputIdle === 'number' && Number.isFinite(value.inputIdle) && value.inputIdle >= 0;
}

/** Read foreground ownership and GetLastInputInfo through the bundled native helper. */
export async function windowsFocusSnapshot(signal?: AbortSignal | null): Promise<WindowsFocusSnapshot> {
  signal?.throwIfAborted();
  const executable = resolveOpenComputerUseCommand('open-computer-use', { platform: 'win32' });
  const { stdout } = await execFileAsync(executable, ['focus-snapshot'], {
    timeout: 3000, maxBuffer: 16_384, windowsHide: true, signal: signal ?? undefined,
  });
  const value: unknown = JSON.parse(stdout);
  if (!isSnapshot(value)) throw new Error('Invalid Windows Computer Use focus snapshot');
  return value;
}

/** Waiting never activates a window or replays input. Another HWND releases only this target. */
export async function waitForWindowsTargetIdle(target: WindowsTarget, options: WindowsIdleOptions = {},
  snapshot: (signal?: AbortSignal | null) => Promise<WindowsFocusSnapshot> = windowsFocusSnapshot): Promise<boolean> {
  if (!Number.isSafeInteger(target.pid) || target.pid <= 0 || !isWindowsWindowID(target.windowID)) return false;
  const deadline = Date.now() + (options.maxWaitMs ?? WINDOWS_USER_INPUT_DEBOUNCE_SECONDS * 1000);
  for (;;) {
    options.signal?.throwIfAborted();
    let current: WindowsFocusSnapshot;
    try { current = await snapshot(options.signal); }
    catch { options.signal?.throwIfAborted(); return false; }
    options.signal?.throwIfAborted();
    if (!isSnapshot(current)) return false;
    if (current.pid !== target.pid || current.windowID !== target.windowID
      || current.inputIdle >= WINDOWS_USER_INPUT_DEBOUNCE_SECONDS) return true;
    const remaining = deadline - Date.now();
    if (remaining <= 0) return false;
    await delay(Math.min(200, remaining), undefined, { signal: options.signal ?? undefined });
  }
}

/** The user explicitly opened this PiP: reveal precisely its HWND, with native PID validation. */
export async function revealWindowsWindow(pid: number, windowID: number,
  signal?: AbortSignal | null): Promise<boolean> {
  if (!Number.isSafeInteger(pid) || pid <= 0 || !isWindowsWindowID(windowID)) return false;
  signal?.throwIfAborted();
  try {
    const executable = resolveOpenComputerUseCommand('open-computer-use', { platform: 'win32' });
    const { stdout } = await execFileAsync(executable,
      ['reveal-window', '--pid', String(pid), '--window-id', String(windowID)], {
        timeout: 5000, maxBuffer: 16_384, windowsHide: true, signal: signal ?? undefined,
      });
    signal?.throwIfAborted();
    return JSON.parse(stdout)?.success === true;
  } catch { signal?.throwIfAborted(); return false; }
}
