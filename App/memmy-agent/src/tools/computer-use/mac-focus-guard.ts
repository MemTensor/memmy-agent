import { execFile } from 'node:child_process';
import { createHash } from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';
import { setTimeout as delay } from 'node:timers/promises';

const execFileAsync = promisify(execFile);
const source = fileURLToPath(new URL('./mac/focus-guard.m', import.meta.url));
const READ_ONLY = new Set(['list_apps', 'get_app_state']);
// Codex's installed native manager uses a five-second interaction debounce.
// Keep the wait bounded; continuing requires a fresh window observation.
export const MAC_USER_INPUT_DEBOUNCE_SECONDS = 5;

export type FocusSnapshot = {
  pid: number; name: string; bundleId: string;
  inputIdle: number;
  /** The focused native window; omitted or zero when AX cannot resolve it safely. */
  windowId?: number;
};
export class OcuUserIntervened extends Error {}
/** A temporary physical takeover, distinct from permission or connection failure. */
export class OcuUserYielded extends Error {
  constructor(public readonly dispatched: boolean, public readonly timedOut = false) {
    super(timedOut ? 'Computer Use is waiting for you to finish using the target window.'
      : 'Computer Use yielded while you used the target window and is ready to observe it again.');
  }
}

export type MacFocusGuardOptions = {
  blockWhenTargetForeground?: boolean;
  /** Only pass an observed window that the native operation is bound to. */
  targetWindowId?: number;
  yieldOnUserInput?: boolean;
  signal?: AbortSignal | null;
  maxWaitMs?: number;
};

function isSnapshot(value: any): value is FocusSnapshot {
  return value && Number.isSafeInteger(value.pid) && value.pid >= 0
    && typeof value.name === 'string' && typeof value.bundleId === 'string'
    && (value.windowId === undefined || (Number.isSafeInteger(value.windowId)
      && value.windowId >= 0 && value.windowId <= 0xffffffff))
    && [value.inputIdle]
      .every((idle: unknown) => typeof idle === 'number' && Number.isFinite(idle) && idle >= 0);
}

async function binary(signal?: AbortSignal | null): Promise<string> {
  signal?.throwIfAborted();
  const directory = path.dirname(source).replace(/([/\\])app\.asar([/\\])/g, '$1app.asar.unpacked$2');
  const bundled = path.join(directory, 'native', process.arch, 'focus-guard');
  if (fs.existsSync(bundled)) return bundled;
  if (/[/\\]app\.asar(?:\.unpacked)?[/\\]/.test(source)) throw new Error('Packaged Computer Use focus guard is missing');
  const contents = fs.readFileSync(source);
  const hash = createHash('sha256').update(contents).update(process.arch).digest('hex').slice(0, 12);
  const cache = path.join(os.homedir(), '.memmy', 'tools', 'computer-use');
  const output = path.join(cache, `focus-guard-${hash}`);
  if (fs.existsSync(output)) return output;
  fs.mkdirSync(cache, { recursive: true });
  const temporary = `${output}.${process.pid}.tmp`;
  try {
    await execFileAsync('clang', ['-O2', '-fobjc-arc', '-framework', 'AppKit', '-framework', 'CoreGraphics', '-framework', 'IOKit', '-o', temporary, source], { timeout: 30_000, signal: signal ?? undefined });
    fs.renameSync(temporary, output);
  } finally { fs.rmSync(temporary, { force: true }); }
  return output;
}

export async function nativeFocusSnapshot(): Promise<FocusSnapshot> {
  const executable = await binary();
  const { stdout } = await execFileAsync(executable, ['snapshot'], { timeout: 3000, maxBuffer: 16_384 });
  const value: unknown = JSON.parse(stdout);
  if (!isSnapshot(value)) throw new Error('Invalid Computer Use focus snapshot');
  return value;
}

export async function restoreNativeFocus(priorPid: number, expectedCurrentPid: number,
  priorWindowId?: number, expectedWindowId?: number): Promise<boolean> {
  const executable = await binary();
  const args = priorWindowId && expectedWindowId
    ? ['restore-window', String(priorPid), String(priorWindowId), String(expectedCurrentPid), String(expectedWindowId)]
    : ['restore', String(priorPid), String(expectedCurrentPid)];
  const { stdout } = await execFileAsync(executable, args,
    { timeout: 3000, maxBuffer: 16_384 });
  return JSON.parse(stdout)?.restored === true;
}

/** Reveal a previously resolved app only after the user explicitly asks to take it over. */
export async function revealNativeApp(pid: number): Promise<boolean> {
  if (!Number.isSafeInteger(pid) || pid <= 0) return false;
  const executable = await binary();
  const { stdout } = await execFileAsync(executable, ['reveal', String(pid)],
    { timeout: 3000, maxBuffer: 16_384 });
  const result = JSON.parse(stdout);
  return result?.success === true;
}

/** Take over the same native window shown in the PiP, never another document of that app. */
export async function revealNativeWindow(pid: number, windowId: number, signal?: AbortSignal | null): Promise<boolean> {
  signal?.throwIfAborted();
  if (!Number.isSafeInteger(pid) || pid <= 0
      || !Number.isSafeInteger(windowId) || windowId <= 0 || windowId > 0xffffffff) return false;
  const executable = await binary(signal);
  signal?.throwIfAborted();
  const { stdout } = await execFileAsync(executable, ['reveal-window', String(pid), String(windowId)],
    { timeout: 3000, maxBuffer: 16_384, signal: signal ?? undefined });
  signal?.throwIfAborted();
  return JSON.parse(stdout)?.success === true;
}

/** Reveal the Agent-owned Chromium tab only after the user asks to open it. */
export const revealNativeBrowser = revealNativeApp;

function matchesTarget(snapshot: FocusSnapshot, target: string): boolean {
  const app = target.trim().toLocaleLowerCase();
  return Boolean(app) && (snapshot.bundleId.toLocaleLowerCase() === app || snapshot.name.toLocaleLowerCase() === app);
}

function matchesTargetWindow(snapshot: FocusSnapshot, target: string, targetWindowId?: number): boolean {
  return matchesTarget(snapshot, target)
    && (!targetWindowId || !snapshot.windowId || snapshot.windowId === targetWindowId);
}

function hasNewInput(before: FocusSnapshot, after: FocusSnapshot, durationSeconds: number): boolean {
  return after.inputIdle < durationSeconds + 0.1
    && after.inputIdle + 0.15 < before.inputIdle + durationSeconds;
}

/** HID idle measures physical input, including input that starts while the target is already front. */
export function tookOverTargetDuringAction(
  before: FocusSnapshot, after: FocusSnapshot, target: string, durationSeconds: number,
  targetWindowId?: number,
): boolean {
  return matchesTargetWindow(after, target, targetWindowId) && hasNewInput(before, after, durationSeconds);
}

export async function waitForMacTargetIdle(target: string, options: MacFocusGuardOptions,
  snapshot: () => Promise<FocusSnapshot> = nativeFocusSnapshot, initial?: FocusSnapshot): Promise<boolean> {
  const deadline = Date.now() + (options.maxWaitMs ?? MAC_USER_INPUT_DEBOUNCE_SECONDS * 1000);
  let current = initial ?? await snapshot();
  // HID idle is physical input. There is no foreground activation or synthetic
  // input here. Leaving the target window also releases the temporary yield.
  while (matchesTargetWindow(current, target, options.targetWindowId)
      && current.inputIdle < MAC_USER_INPUT_DEBOUNCE_SECONDS) {
    options.signal?.throwIfAborted();
    const remaining = deadline - Date.now();
    if (remaining <= 0) return false;
    await delay(Math.min(200, remaining), undefined, { signal: options.signal ?? undefined });
    current = await snapshot();
  }
  options.signal?.throwIfAborted();
  return true;
}

async function yieldUntilIdle(target: string, initial: FocusSnapshot, dispatched: boolean,
  snapshot: () => Promise<FocusSnapshot>, options: MacFocusGuardOptions): Promise<never> {
  const idle = await waitForMacTargetIdle(target, options, snapshot, initial);
  // User input can invalidate the old element indices and coordinates. Never
  // send the pending action after waiting; the owner obtains a fresh snapshot.
  throw new OcuUserYielded(dispatched, !idle);
}

/** Preserve the user's foreground app and stop when they interact with the Agent's target. */
export async function withMacFocusGuard<T>(
  target: string, tool: string, invoke: () => Promise<T>,
  deps: { snapshot: () => Promise<FocusSnapshot>; restore: (priorPid: number, expectedPid: number,
    priorWindowId?: number, expectedWindowId?: number) => Promise<boolean> }
    = { snapshot: nativeFocusSnapshot, restore: restoreNativeFocus },
  options: MacFocusGuardOptions = {},
): Promise<T> {
  if (READ_ONLY.has(tool)) return invoke();
  let before: FocusSnapshot;
  try { before = await deps.snapshot(); }
  catch { throw new OcuUserIntervened('Computer Use could not verify foreground focus. The action was not sent.'); }
  if (before.pid <= 0) throw new OcuUserIntervened('Computer Use could not identify the foreground app. The action was not sent.');
  options.signal?.throwIfAborted();
  if (matchesTargetWindow(before, target, options.targetWindowId)
      && (options.blockWhenTargetForeground || before.inputIdle < MAC_USER_INPUT_DEBOUNCE_SECONDS)) {
    if (options.yieldOnUserInput && !options.blockWhenTargetForeground)
      return yieldUntilIdle(target, before, false, deps.snapshot, options);
    throw new OcuUserIntervened('You are using the target app. Computer Use paused before sending the action.');
  }
  const started = Date.now();
  let result: T | undefined;
  let actionError: unknown;
  let actionFailed = false;
  try { result = await invoke(); }
  catch (error) { actionError = error; actionFailed = true; }
  let after: FocusSnapshot;
  try { after = await deps.snapshot(); }
  catch { throw new OcuUserIntervened('Computer Use sent an action but could not verify foreground focus. Check the app before continuing.'); }
  if (tookOverTargetDuringAction(before, after, target, (Date.now() - started) / 1000, options.targetWindowId)) {
    if (options.yieldOnUserInput) return yieldUntilIdle(target, after, true, deps.snapshot, options);
    throw new OcuUserIntervened('You took over the target app while Computer Use was acting. Check the result before continuing.');
  }
  if (before.pid > 0 && matchesTargetWindow(after, target, options.targetWindowId)
      && (before.pid !== after.pid || (before.windowId && after.windowId && before.windowId !== after.windowId))) {
    const restoreStarted = Date.now();
    let restored = false;
    try { restored = before.windowId && after.windowId
      ? await deps.restore(before.pid, after.pid, before.windowId, after.windowId)
      : await deps.restore(before.pid, after.pid); } catch { /* fail closed below */ }
    if (!restored) {
      // The native restore refuses to overwrite new physical input. A user
      // click racing this cleanup is a recoverable intervention, not a failed
      // permission or a reason to terminate the task.
      if (options.yieldOnUserInput) {
        let latest: FocusSnapshot | undefined;
        try { latest = await deps.snapshot(); } catch { /* retain the verified failure below */ }
        if (latest && hasNewInput(after, latest, (Date.now() - restoreStarted) / 1000))
          return yieldUntilIdle(target, latest, true, deps.snapshot, options);
      }
      throw new OcuUserIntervened('Computer Use changed the foreground app and could not restore your previous app. Check the desktop before continuing.');
    }
  }
  if (actionFailed) throw actionError;
  return result as T;
}
