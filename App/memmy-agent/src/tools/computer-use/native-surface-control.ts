import type { ComputerUseSurfaceAction } from '@memmy/local-api-contracts';
import type { RequestContext } from '../../core/agent-runtime/tools/context.js';
import { revealNativeWindow } from './mac-focus-guard.js';
import { emitComputerUseSurface, mcpPreviewImage, mcpTargetPid, mcpTargetAssociatedWindowIds, mcpTargetWindowId } from './surface-preview.js';
import { revealWindowsWindow } from './windows-focus-guard.js';

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
  const metadataPid = result?._meta?.memmyComputerUse?.pid;
  if (Number.isSafeInteger(metadataPid) && metadataPid > 0) return metadataPid;
  const text = result?.content?.find((item: any) => item?.type === 'text' && typeof item.text === 'string')?.text;
  const match = typeof text === 'string' ? /^App=.+ \(pid ([1-9]\d*)\)/m.exec(text) : null;
  const pid = match ? Number(match[1]) : NaN;
  return Number.isSafeInteger(pid) && pid > 0 ? pid : null;
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
  appKey?: string;
  platform?: NodeJS.Platform;
  signal?: AbortSignal | null;
  identity: Pick<ComputerUseSurfaceAction, 'sessionKey' | 'channel' | 'chatId' | 'targetId' | 'turnId'>;
  initialFrame: { url: string; width: number; height: number; targetWindowId?: number; targetPid?: number; targetAssociatedWindowIds?: number[] };
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
      ...(options.appKey ? { appKey: options.appKey } : {}),
      ...(['darwin', 'win32'].includes(platform) && frame.targetPid ? { targetPid: frame.targetPid } : {}),
      ...(['darwin', 'win32'].includes(platform) && frame.targetPid && targetWindowId
        ? { targetAssociatedWindowIds: frame.targetAssociatedWindowIds ?? [] } : {}),
    });
  };
  const invoke = (name: string, args: Record<string, unknown>) => managed.invoke(name,
    { ...args, ...((platform === 'darwin' || platform === 'win32') && frame.targetWindowId !== undefined
      ? { window_id: frame.targetWindowId } : {}) }, timeout, context, signal);
  const handle = async (action: ComputerUseSurfaceAction): Promise<void> => {
    if (signal?.aborted) return;
    if (action.action === 'scroll' && action.deltaY === 0) return;
    const key = action.action === 'key' ? nativeSurfaceKey(action.key ?? '') : null;
    if (action.action === 'key' && !key) { show(`${appName} · 不支持该按键`); return; }
    if (action.targetWindowId !== undefined && frame.targetWindowId !== undefined
        && action.targetWindowId !== frame.targetWindowId) {
      show(`${appName} · 小窗目标已变化，请重新操作`); return;
    }
    try {
      if (action.action === 'open' && (platform === 'darwin' || platform === 'win32')
        && frame.targetPid !== undefined && frame.targetWindowId !== undefined) {
        // Taking over is an explicit user action. The native reveal validates
        // the exact PID/window again; it needs neither an MCP connection nor a
        // fresh screenshot queued behind the model's application operations.
        const revealed = platform === 'darwin'
          ? await revealNativeWindow(frame.targetPid, frame.targetWindowId, signal)
          : await revealWindowsWindow(frame.targetPid, frame.targetWindowId, signal);
        show(revealed ? `${appName} · 已接管应用窗口` : `${appName} · 无法接管应用窗口`);
        return;
      }
      const currentResult = await invoke('get_app_state', { app: appName });
      if (signal?.aborted) return;
      const targetPid = ['darwin', 'win32'].includes(platform) ? mcpTargetPid(currentResult) : undefined;
      if (['darwin', 'win32'].includes(platform) && frame.targetPid !== undefined && targetPid !== frame.targetPid) {
        show(`${appName} · 原目标窗口所属应用已变化，请重新观察`); return;
      }
      if (action.action === 'open') {
        const currentWindowId = mcpTargetWindowId(currentResult, platform);
        const expectedWindowId = action.targetWindowId ?? frame.targetWindowId;
        const unavailable = currentResult?._meta?.memmyComputerUse;
        // A minimized/hidden target may not be capturable. The native reveal
        // still verifies that this exact window belongs to the current PID;
        // closed windows fail there without substituting another document.
        const canVerifyHidden = unavailable?.targetWindowUnavailable === true
          && unavailable.requestedWindowID === expectedWindowId;
        const pid = currentResult?.isError === true && !canVerifyHidden ? null : appPid(currentResult);
        if ((platform === 'darwin' || platform === 'win32') && expectedWindowId === undefined) {
          show(`${appName} · 无法确认目标窗口`); return;
        }
        if (expectedWindowId !== undefined && currentWindowId !== undefined
            && currentWindowId !== expectedWindowId) {
          show(`${appName} · 无法确认原目标窗口，请重新观察`);
          return;
        }
        if (platform === 'win32' && currentWindowId !== expectedWindowId && !canVerifyHidden) {
          show(`${appName} · 无法确认原目标窗口，请重新观察`); return;
        }
        const revealed = pid && (platform === 'darwin' ? await revealNativeWindow(pid, expectedWindowId!, signal)
          : platform === 'win32' ? await revealWindowsWindow(pid, expectedWindowId!, signal) : false);
        show(revealed ? `${appName} · 已接管应用窗口` : `${appName} · 无法接管应用窗口`);
        return;
      }
      const current = mcpPreviewImage(currentResult, platform);
      if (currentResult?.isError === true || !current?.width || !current.height) {
        show(`${appName} · 无法确认当前画面`); return;
      }
      const expectedWindowId = action.targetWindowId ?? frame.targetWindowId;
      if (expectedWindowId !== undefined && current.targetWindowId !== expectedWindowId) {
        show(`${appName} · 无法确认原目标窗口，请重新观察`);
        return;
      }
      if (!liveFrameMatches(action, { width: current.width, height: current.height })) {
        show(`${appName} · 实时画面与目标窗口尺寸不一致，请重新操作`, current.url); return;
      }
      const changedSize = current.width !== frame.width || current.height !== frame.height;
      const changedImage = current.url !== frame.url;
      if (changedSize || (changedImage && action.frameMode !== 'live')) {
        frame = { url: current.url, width: current.width, height: current.height,
          targetWindowId: current.targetWindowId, targetPid,
          targetAssociatedWindowIds: mcpTargetAssociatedWindowIds(currentResult, platform) };
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
      const observationID = currentResult?._meta?.memmyComputerUse?.observationID;
      if ((platform === 'darwin' || platform === 'win32') && typeof observationID === 'string')
        Object.assign(args, { observation_id: observationID });
      const tool = action.action === 'click' ? 'click' : action.action === 'scroll' ? 'scroll' : 'press_key';
      if (signal?.aborted) return;
      const outcome = await invoke(tool, args);
      if (signal?.aborted) return;
      if (outcome?.isError === true) { show(`${appName} · 操作未完成`); return; }
      const refreshed = await invoke('get_app_state', { app: appName });
      if (signal?.aborted) return;
      const next = mcpPreviewImage(refreshed, platform);
      if (refreshed?.isError === true || !next?.width || !next.height) {
        show(`${appName} · 操作后画面不可用`); return;
      }
      const nextPid = ['darwin', 'win32'].includes(platform) ? mcpTargetPid(refreshed) : undefined;
      if (expectedWindowId !== undefined && next.targetWindowId !== expectedWindowId) {
        show(`${appName} · 无法确认原目标窗口，请重新观察`); return;
      }
      if (['darwin', 'win32'].includes(platform) && frame.targetPid !== undefined && nextPid !== frame.targetPid) {
        show(`${appName} · 原目标窗口所属应用已变化，请重新观察`); return;
      }
      frame = { url: next.url, width: next.width, height: next.height,
        targetWindowId: next.targetWindowId, targetPid: nextPid,
        targetAssociatedWindowIds: mcpTargetAssociatedWindowIds(refreshed, platform) };
      show(appName, frame.url, frame.targetWindowId);
    } catch {
      show(`${appName} · 操作未完成`);
    }
  };
  return action => {
    if (action.sessionKey !== identity.sessionKey || action.channel !== identity.channel
        || action.chatId !== identity.chatId || action.turnId !== identity.turnId || action.targetId !== identity.targetId)
      return Promise.resolve();
    // User takeover must not wait behind queued scrolling or typing. Its exact
    // window reveal is independent of the helper's serialized action queue.
    if (action.action === 'open') return handle(action);
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
