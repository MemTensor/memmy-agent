import { execFile } from 'node:child_process';
import { createHash } from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';

const execFileAsync = promisify(execFile);
const source = fileURLToPath(new URL('./mac/focus-guard.m', import.meta.url));
const READ_ONLY = new Set(['list_apps', 'get_app_state']);

export type FocusSnapshot = {
  pid: number; name: string; bundleId: string;
  inputIdle: number;
};
export class OcuUserIntervened extends Error {}

function isSnapshot(value: any): value is FocusSnapshot {
  return value && Number.isSafeInteger(value.pid) && value.pid >= 0
    && typeof value.name === 'string' && typeof value.bundleId === 'string'
    && [value.inputIdle]
      .every((idle: unknown) => typeof idle === 'number' && Number.isFinite(idle) && idle >= 0);
}

async function binary(): Promise<string> {
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
    await execFileAsync('clang', ['-O2', '-fobjc-arc', '-framework', 'AppKit', '-framework', 'CoreGraphics', '-framework', 'IOKit', '-o', temporary, source], { timeout: 30_000 });
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

export async function restoreNativeFocus(priorPid: number, expectedCurrentPid: number): Promise<boolean> {
  const executable = await binary();
  const { stdout } = await execFileAsync(executable, ['restore', String(priorPid), String(expectedCurrentPid)],
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
export async function revealNativeWindow(pid: number, windowId: number): Promise<boolean> {
  if (!Number.isSafeInteger(pid) || pid <= 0
      || !Number.isSafeInteger(windowId) || windowId <= 0 || windowId > 0xffffffff) return false;
  const executable = await binary();
  const { stdout } = await execFileAsync(executable, ['reveal-window', String(pid), String(windowId)],
    { timeout: 3000, maxBuffer: 16_384 });
  return JSON.parse(stdout)?.success === true;
}

/** Reveal the Agent-owned Chromium tab only after the user asks to open it. */
export const revealNativeBrowser = revealNativeApp;

function matchesTarget(snapshot: FocusSnapshot, target: string): boolean {
  const app = target.trim().toLocaleLowerCase();
  return Boolean(app) && (snapshot.bundleId.toLocaleLowerCase() === app || snapshot.name.toLocaleLowerCase() === app);
}

function hasNewInput(before: FocusSnapshot, after: FocusSnapshot, durationSeconds: number): boolean {
  return after.inputIdle < durationSeconds + 0.1
    && after.inputIdle + 0.15 < before.inputIdle + durationSeconds;
}

/** The user brought the target forward during the action. Input while it was already front is not a takeover: that clock also moves for the Agent's own clicks. */
export function tookOverTargetDuringAction(
  before: FocusSnapshot, after: FocusSnapshot, target: string, durationSeconds: number,
): boolean {
  if (matchesTarget(before, target)) return false;
  return matchesTarget(after, target) && hasNewInput(before, after, durationSeconds);
}

/** Preserve the user's foreground app and stop when they interact with the Agent's target. */
export async function withMacFocusGuard<T>(
  target: string, tool: string, invoke: () => Promise<T>,
  deps: { snapshot: () => Promise<FocusSnapshot>; restore: (priorPid: number, expectedPid: number) => Promise<boolean> }
    = { snapshot: nativeFocusSnapshot, restore: restoreNativeFocus },
  options: { blockWhenTargetForeground?: boolean } = {},
): Promise<T> {
  if (READ_ONLY.has(tool)) return invoke();
  let before: FocusSnapshot;
  try { before = await deps.snapshot(); }
  catch { throw new OcuUserIntervened('Computer Use could not verify foreground focus. The action was not sent.'); }
  if (before.pid <= 0) throw new OcuUserIntervened('Computer Use could not identify the foreground app. The action was not sent.');
  if (matchesTarget(before, target) && (options.blockWhenTargetForeground || before.inputIdle < 0.5)) {
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
  if (tookOverTargetDuringAction(before, after, target, (Date.now() - started) / 1000)) {
    throw new OcuUserIntervened('You took over the target app while Computer Use was acting. Check the result before continuing.');
  }
  if (before.pid > 0 && before.pid !== after.pid && matchesTarget(after, target)) {
    let restored = false;
    try { restored = await deps.restore(before.pid, after.pid); } catch { /* fail closed below */ }
    if (!restored) throw new OcuUserIntervened('Computer Use changed the foreground app and could not restore your previous app. Check the desktop before continuing.');
  }
  if (actionFailed) throw actionError;
  return result as T;
}
