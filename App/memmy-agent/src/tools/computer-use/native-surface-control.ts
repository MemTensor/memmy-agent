import type { ComputerUseSurfaceAction } from '@memmy/local-api-contracts';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import type { RequestContext } from '../../core/agent-runtime/tools/context.js';
import { revealNativeWindow } from './mac-focus-guard.js';
import { emitComputerUseSurface, mcpPreviewImage } from './surface-preview.js';

const execFileAsync = promisify(execFile);
const MAX_QUEUED_SCROLL_DELTA = 360;

function boundedScrollDelta(deltaY: number): number {
  return Math.max(-MAX_QUEUED_SCROLL_DELTA, Math.min(MAX_QUEUED_SCROLL_DELTA, deltaY));
}

type NativeConnection = {
  invoke(name: string, args: Record<string, unknown>, timeout: number,
    context: RequestContext | null, signal?: AbortSignal | null): Promise<any>;
};

const KEY_NAMES: Record<string, string> = {
  Enter: 'Return', Escape: 'Escape', Backspace: 'BackSpace', Delete: 'Delete',
  Tab: 'Tab', Space: 'space', ArrowUp: 'Up', ArrowDown: 'Down',
  ArrowLeft: 'Left', ArrowRight: 'Right', Home: 'Home', End: 'End',
  PageUp: 'Prior', PageDown: 'Next', Insert: 'Insert',
  '+': 'plus', '-': 'minus', '=': 'equal', '.': 'period', ',': 'comma',
  '/': 'slash', '\\': 'backslash', ';': 'semicolon', "'": 'apostrophe',
  '[': 'bracketleft', ']': 'bracketright', '`': 'grave',
};
const MODIFIERS: Record<string, string> = { Meta: 'super', Control: 'ctrl', Alt: 'alt', Shift: 'shift' };

/** Convert the preview window's DOM key names to the helper's xdotool syntax. */
export function nativeSurfaceKey(domKey: string): string | null {
  const parts = domKey.split('+');
  const key = parts.pop();
  if (!key) return null;
  const modifiers = parts.map(part => MODIFIERS[part]);
  if (modifiers.some(part => !part)) return null;
  const name = KEY_NAMES[key] ?? (/^[A-Za-z0-9]$/.test(key) ? key.toLowerCase() : null);
  return name ? [...modifiers, name].join('+') : null;
}

function appPid(result: any): number | null {
  const text = result?.content?.find((item: any) => item?.type === 'text' && typeof item.text === 'string')?.text;
  const match = typeof text === 'string' ? /^App=.+ \(pid ([1-9]\d*)\)/m.exec(text) : null;
  const pid = match ? Number(match[1]) : NaN;
  return Number.isSafeInteger(pid) && pid > 0 ? pid : null;
}

async function revealWindowsApp(pid: number): Promise<boolean> {
  const script = `Add-Type -TypeDefinition 'using System; using System.Runtime.InteropServices; public static class MemmyForeground { [DllImport("user32.dll")] public static extern IntPtr GetForegroundWindow(); [DllImport("user32.dll")] public static extern uint GetWindowThreadProcessId(IntPtr window, out uint processId); }'
$shell = New-Object -ComObject WScript.Shell
if (-not $shell.AppActivate(${pid})) { Write-Output 0; exit }
$active = [MemmyForeground]::GetForegroundWindow()
$activePid = [uint32]0
[void][MemmyForeground]::GetWindowThreadProcessId($active, [ref]$activePid)
if ($activePid -eq ${pid}) { Write-Output 1 } else { Write-Output 0 }`;
  try {
    const { stdout } = await execFileAsync('powershell.exe', ['-NoProfile', '-NonInteractive', '-EncodedCommand',
      Buffer.from(script, 'utf16le').toString('base64')], { timeout: 5000, windowsHide: true });
    return stdout.trim() === '1';
  } catch { return false; }
}

function liveFrameMatches(action: ComputerUseSurfaceAction, current: { width: number; height: number }): boolean {
  if (action.frameMode !== 'live') return true;
  const sourceWidth = action.frameWidth ?? 0;
  const sourceHeight = action.frameHeight ?? 0;
  if (sourceWidth <= 0 || sourceHeight <= 0) return false;
  const sourceRatio = sourceWidth / sourceHeight;
  const currentRatio = current.width / current.height;
  return Math.abs(sourceRatio / currentRatio - 1) <= 0.03;
}

/** A user action is bound to the last frame; stale frames are refreshed without clicking. */
export function createNativeSurfaceActionHandler(options: {
  managed: NativeConnection;
  context: RequestContext;
  timeout: number;
  appName: string;
  platform?: NodeJS.Platform;
  signal?: AbortSignal | null;
  identity: Pick<ComputerUseSurfaceAction, 'sessionKey' | 'channel' | 'chatId' | 'targetId' | 'turnId'>;
  initialFrame: { url: string; width: number; height: number; targetWindowId?: number };
}): (action: ComputerUseSurfaceAction) => Promise<void> {
  const { managed, context, timeout, appName, identity } = options;
  const signal = options.signal;
  const platform = options.platform ?? process.platform;
  let frame = options.initialFrame;
  let tail: Promise<void> = Promise.resolve();
  let pendingScroll: { action: ComputerUseSurfaceAction; run: Promise<void> } | null = null;
  const show = (title: string, imageDataUrl?: string, targetWindowId = frame.targetWindowId) => {
    if (!signal?.aborted) emitComputerUseSurface({
      surface: 'computer', ...identity, title: title.slice(0, 256), imageDataUrl, targetWindowId,
    });
  };
  const invoke = (name: string, args: Record<string, unknown>) => managed.invoke(name, args, timeout, context, signal);
  const handle = async (action: ComputerUseSurfaceAction): Promise<void> => {
    if (signal?.aborted) return;
    if (action.action === 'scroll' && action.deltaY === 0) return;
    const key = action.action === 'key' ? nativeSurfaceKey(action.key ?? '') : null;
    if (action.action === 'key' && !key) { show(`${appName} · 不支持该按键`); return; }
    try {
      const currentResult = await invoke('get_app_state', { app: appName });
      if (signal?.aborted) return;
      if (action.action === 'open') {
        const pid = currentResult?.isError === true ? null : appPid(currentResult);
        const current = mcpPreviewImage(currentResult);
        const expectedWindowId = action.targetWindowId ?? frame.targetWindowId;
        if (platform === 'darwin' && expectedWindowId === undefined) {
          show(`${appName} · 无法确认目标窗口`); return;
        }
        if (expectedWindowId !== undefined && current?.targetWindowId !== undefined
            && current.targetWindowId !== expectedWindowId) {
          if (current?.width && current.height)
            frame = { url: current.url, width: current.width, height: current.height,
              targetWindowId: current.targetWindowId };
          show(`${appName} · 目标窗口已切换，请重新操作`, current?.url, current?.targetWindowId);
          return;
        }
        const revealed = pid && (platform === 'darwin' ? await revealNativeWindow(pid, expectedWindowId!)
          : platform === 'win32' ? await revealWindowsApp(pid) : false);
        show(revealed ? `${appName} · 已接管应用窗口` : `${appName} · 无法接管应用窗口`);
        return;
      }
      const current = mcpPreviewImage(currentResult);
      if (currentResult?.isError === true || !current?.width || !current.height) {
        show(`${appName} · 无法确认当前画面`); return;
      }
      const expectedWindowId = action.targetWindowId ?? frame.targetWindowId;
      if (expectedWindowId !== undefined && current.targetWindowId !== expectedWindowId) {
        frame = { url: current.url, width: current.width, height: current.height,
          targetWindowId: current.targetWindowId };
        show(`${appName} · 目标窗口已切换，请重新操作`, current.url, current.targetWindowId);
        return;
      }
      if (!liveFrameMatches(action, { width: current.width, height: current.height })) {
        show(`${appName} · 实时画面与目标窗口尺寸不一致，请重新操作`, current.url); return;
      }
      const changedSize = current.width !== frame.width || current.height !== frame.height;
      const changedImage = current.url !== frame.url;
      if (changedSize || (changedImage && action.frameMode !== 'live')) {
        frame = { url: current.url, width: current.width, height: current.height,
          targetWindowId: current.targetWindowId };
        show(`${appName} · 画面已变化，请重新操作`, frame.url, frame.targetWindowId);
        return;
      }
      const x = Math.min(current.width - 1, Math.round((action.x ?? 0) * current.width));
      const y = Math.min(current.height - 1, Math.round((action.y ?? 0) * current.height));
      const args = action.action === 'click'
        ? { app: appName, x, y,
          click_method: platform === 'darwin' ? 'sky_click' : platform === 'win32' ? 'app_post' : 'auto' }
        : action.action === 'scroll'
          ? { app: appName, x, y, direction: (action.deltaY ?? 0) > 0 ? 'down' : 'up',
            pages: Math.min(3, Math.max(1 / 12, Math.abs(action.deltaY ?? 0) / 120)) }
          : { app: appName, key: key! };
      const tool = action.action === 'click' ? 'click' : action.action === 'scroll' ? 'scroll' : 'press_key';
      if (signal?.aborted) return;
      const outcome = await invoke(tool, args);
      if (signal?.aborted) return;
      if (outcome?.isError === true) { show(`${appName} · 操作未完成`); return; }
      const refreshed = await invoke('get_app_state', { app: appName });
      if (signal?.aborted) return;
      const next = mcpPreviewImage(refreshed);
      if (refreshed?.isError === true || !next?.width || !next.height) {
        show(`${appName} · 操作后画面不可用`); return;
      }
      frame = { url: next.url, width: next.width, height: next.height,
        targetWindowId: next.targetWindowId };
      show(appName, frame.url, frame.targetWindowId);
    } catch {
      show(`${appName} · 操作未完成`);
    }
  };
  return action => {
    if (action.action === 'scroll') {
      const deltaY = action.deltaY ?? 0;
      if (deltaY === 0) return Promise.resolve();
      if (pendingScroll) {
        const prior = pendingScroll.action.deltaY ?? 0;
        // A reversal replaces unsent motion; otherwise cap the queued gesture to three pages.
        const combined = Math.sign(prior) === Math.sign(deltaY) ? prior + deltaY : deltaY;
        pendingScroll.action = { ...action, deltaY: boundedScrollDelta(combined) };
        return pendingScroll.run;
      }
      const slot = { action: { ...action, deltaY: boundedScrollDelta(deltaY) }, run: Promise.resolve() };
      const run = tail.then(() => {
        if (pendingScroll === slot) pendingScroll = null;
        return handle(slot.action);
      });
      slot.run = run;
      pendingScroll = slot;
      tail = run.catch(() => undefined);
      return run;
    }
    // A click, key, or explicit takeover separates wheel gestures in the action queue.
    pendingScroll = null;
    const run = tail.then(() => handle(action));
    tail = run.catch(() => undefined);
    return run;
  };
}
