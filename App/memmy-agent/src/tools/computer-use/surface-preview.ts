import {
  COMPUTER_USE_SURFACE_MAX_IMAGE_CHARS,
  COMPUTER_USE_SURFACE_PREFIX,
  isComputerUseSurfaceAction,
  type ComputerUseSurfaceAction,
  type ComputerUseSurfaceMessage,
} from '@memmy/local-api-contracts';
import type { RequestContext } from '../../core/agent-runtime/tools/context.js';

type SurfaceIdentity = Pick<ComputerUseSurfaceAction, 'sessionKey' | 'channel' | 'chatId' | 'targetId' | 'turnId'>;
const computerHandlers = new Map<string, { identity: SurfaceIdentity;
  handle: (action: ComputerUseSurfaceAction) => Promise<void>; cancel?: AbortController }>();
const activeNativeSurfaces = new Map<string, ComputerUseSurfaceMessage>();
type TurnScope = { sessionKey: string; channel: string; chatId: string };
const activeTurns = new Map<string, Map<string, { stop: () => Promise<unknown> }>>();
const finishedTurns = new Map<string, Set<string>>();
const nativeTurnCleanups = new Map<string, { scope: TurnScope & { turnId: string };
  owners: Map<object, () => Promise<void>> }>();
let computerListenerProcess: NodeJS.Process | null = null;

function turnKey(input: TurnScope): string {
  return JSON.stringify([input.sessionKey, input.channel, input.chatId]);
}

function surfaceKey(input: Pick<ComputerUseSurfaceAction, 'sessionKey' | 'channel' | 'chatId' | 'targetId' | 'turnId'>): string {
  return JSON.stringify([input.sessionKey, input.channel, input.chatId, input.targetId, input.turnId]);
}

function turnFinished(scope: TurnScope & { turnId?: string }): boolean {
  return Boolean(scope.turnId && finishedTurns.get(turnKey(scope))?.has(scope.turnId));
}

function rememberFinishedTurn(scope: TurnScope & { turnId?: string }): void {
  if (!scope.turnId) return;
  const key = turnKey(scope);
  const turns = finishedTurns.get(key) ?? new Set<string>();
  turns.add(scope.turnId);
  while (turns.size > 32) turns.delete(turns.values().next().value!);
  finishedTurns.delete(key);
  finishedTurns.set(key, turns);
  while (finishedTurns.size > 64) finishedTurns.delete(finishedTurns.keys().next().value!);
}

/** The runtime owns this turn identity; a tool or renderer cannot choose a different one. */
export function registerComputerUseTurnInterrupt(scope: TurnScope & { turnId: string }, stop: () => Promise<unknown>): () => void {
  const key = turnKey(scope);
  const entries = activeTurns.get(key) ?? new Map<string, { stop: () => Promise<unknown> }>();
  const entry = { stop };
  entries.set(scope.turnId, entry);
  activeTurns.set(key, entries);
  return () => {
    if (entries.get(scope.turnId) !== entry) return;
    entries.delete(scope.turnId);
    if (entries.size === 0 && activeTurns.get(key) === entries) activeTurns.delete(key);
  };
}

export function activeComputerUseTurnId(scope: TurnScope & { turnId?: string }): string | undefined {
  const entries = activeTurns.get(turnKey(scope));
  if (scope.turnId) return entries?.has(scope.turnId) ? scope.turnId : undefined;
  // A missing execution identity can be recovered only while there is one
  // owner. Parallel subtasks must never adopt the last registered sibling.
  return entries?.size === 1 ? entries.keys().next().value : undefined;
}

function differentActiveTurn(scope: TurnScope & { turnId?: string }): boolean {
  const entries = activeTurns.get(turnKey(scope));
  return Boolean(scope.turnId && entries?.size && !entries.has(scope.turnId));
}

/** App aliases and documents share a name; only the native tuple identifies a window. */
export function nativeSurfaceTargetId(appName: string, targetPid?: number, targetWindowId?: number): string {
  if (Number.isSafeInteger(targetPid) && targetPid! > 0 && targetPid! <= 0xffffffff
      && Number.isSafeInteger(targetWindowId) && targetWindowId! > 0)
    return `native-window:${targetPid}:${targetWindowId}`;
  return appName.slice(0, 256);
}

/** Cleanup belongs to the host's turn, independently of whether it produced a preview. */
export function registerNativeTurnCleanup(scope: TurnScope & { turnId: string }, owner: object,
  cleanup: () => Promise<void>): void {
  if (turnFinished(scope)) return;
  const key = JSON.stringify([turnKey(scope), scope.turnId]);
  const entry = nativeTurnCleanups.get(key) ?? { scope, owners: new Map<object, () => Promise<void>>() };
  entry.owners.set(owner, cleanup);
  nativeTurnCleanups.set(key, entry);
}

export function registerComputerUseSurfaceAction(
  identity: SurfaceIdentity,
  handler: (action: ComputerUseSurfaceAction) => Promise<void>,
  cancel?: AbortController,
): void {
  if (process.env.MEMMY_DESKTOP_MANAGED_GATEWAY !== '1' || !process.send || !process.connected) return;
  if (turnFinished(identity) || differentActiveTurn(identity)) { cancel?.abort(); return; }
  if (computerListenerProcess !== process) {
    process.on('message', raw => {
      if (!isComputerUseSurfaceAction(raw) || raw.surface !== 'computer') return;
      const key = surfaceKey(raw);
      const registered = computerHandlers.get(key);
      if (raw.action === 'interrupt') {
        const turn = raw.turnId ? activeTurns.get(turnKey(raw))?.get(raw.turnId) : undefined;
        if (registered && turn) void turn.stop().catch(() => undefined);
        return;
      }
      if (registered) void registered.handle(raw).catch(() => undefined);
    });
    computerListenerProcess = process;
  }
  const key = surfaceKey(identity);
  computerHandlers.get(key)?.cancel?.abort();
  computerHandlers.delete(key);
  // Active task queues are released by their owner. Creating another preview
  // must never evict and abort an unrelated task's handler.
  computerHandlers.set(key, { identity, handle: handler, cancel });
}

export function closeNativeSurfacesForTurn(scope: TurnScope & { turnId?: string }): Promise<void> {
  rememberFinishedTurn(scope);
  for (const [key, handler] of computerHandlers) {
    if (turnKey(handler.identity) !== turnKey(scope)
        || (scope.turnId !== undefined && handler.identity.turnId !== scope.turnId)) continue;
    handler.cancel?.abort();
    computerHandlers.delete(key);
  }
  for (const [key, identity] of activeNativeSurfaces) {
    if (identity.sessionKey !== scope.sessionKey || identity.channel !== scope.channel || identity.chatId !== scope.chatId) continue;
    if (scope.turnId !== undefined && identity.turnId !== scope.turnId) continue;
    computerHandlers.get(key)?.cancel?.abort();
    computerHandlers.delete(key);
    emitComputerUseSurface({ surface: 'computer', sessionKey: identity.sessionKey, channel: identity.channel,
      chatId: identity.chatId, targetId: identity.targetId, turnId: identity.turnId, title: identity.targetId, close: true });
  }
  const pending: Promise<void>[] = [];
  for (const [key, entry] of nativeTurnCleanups) {
    if (turnKey(entry.scope) !== turnKey(scope) || (scope.turnId !== undefined && entry.scope.turnId !== scope.turnId)) continue;
    nativeTurnCleanups.delete(key);
    for (const cleanup of entry.owners.values()) pending.push(Promise.resolve().then(cleanup));
  }
  if (!pending.length) return Promise.resolve();
  // Close the presentation synchronously. A broken notification transport must
  // not hold task completion open, and cleanup never repeats an app action.
  return new Promise(resolve => {
    const deadline = setTimeout(resolve, 1500);
    void Promise.allSettled(pending).then(() => { clearTimeout(deadline); resolve(); });
  });
}

/** A bound app request cannot silently expand a missing menu observation to the desktop. */
export function hasNativeSurfaceForRequest(request: RequestContext | null): boolean {
  if (!request?.sessionKey || !request.channel || !request.chatId) return false;
  const turnId = request.metadata.turnId ?? request.metadata.turn_id;
  if (typeof turnId !== 'string' || !turnId) return false;
  return [...activeNativeSurfaces.values()].some(surface => surface.sessionKey === request.sessionKey
    && surface.channel === request.channel && surface.chatId === request.chatId && surface.turnId === turnId
    && Number.isSafeInteger(surface.targetWindowId) && surface.targetWindowId! > 0);
}

export function emitComputerUseSurface(message: Omit<ComputerUseSurfaceMessage, 'type'> & { close?: boolean }): void {
  if (process.env.MEMMY_DESKTOP_MANAGED_GATEWAY !== '1' || !process.send || !process.connected) return;
  const { close, ...details } = message;
  if (details.imageDataUrl && details.imageDataUrl.length > COMPUTER_USE_SURFACE_MAX_IMAGE_CHARS) {
    // Keep the session visible: live capture or the real browser tab may still work.
    details.imageDataUrl = undefined;
  }
  const event: ComputerUseSurfaceMessage = {
    ...details,
    type: close ? `${COMPUTER_USE_SURFACE_PREFIX}close` : `${COMPUTER_USE_SURFACE_PREFIX}update`,
  };
  if (event.surface === 'computer') {
    const key = surfaceKey(event);
    if (close) activeNativeSurfaces.delete(key);
    else {
      if (turnFinished(event) || differentActiveTurn(event)) return;
      // Aliases within a task share one exact native window action owner.
      // Parallel tasks retain independent handlers and presentation lifetimes.
      if (Number.isSafeInteger(event.targetPid) && event.targetPid! > 0
        && Number.isSafeInteger(event.targetWindowId) && event.targetWindowId! > 0) {
        for (const [oldKey, prior] of activeNativeSurfaces) {
          if (oldKey === key || turnKey(prior) !== turnKey(event) || prior.turnId !== event.turnId
            || prior.targetPid !== event.targetPid || prior.targetWindowId !== event.targetWindowId) continue;
          computerHandlers.get(oldKey)?.cancel?.abort();
          computerHandlers.delete(oldKey);
          activeNativeSurfaces.delete(oldKey);
        }
      }
      activeNativeSurfaces.set(key, event);
    }
  }
  try { process.send(event, () => undefined); } catch { /* Desktop child is exiting. */ }
}

export function mcpTargetWindowId(result: any, platform: NodeJS.Platform = process.platform): number | undefined {
  const id = result?._meta?.memmyComputerUse?.targetWindowID;
  return typeof id === 'number' && Number.isSafeInteger(id) && id > 0
    && (platform === 'win32' || id <= 0xffffffff) ? id : undefined;
}

/** Native metadata, never a user action, establishes window ownership. */
export function mcpTargetPid(result: any): number | undefined {
  const pid = result?._meta?.memmyComputerUse?.pid;
  return typeof pid === 'number' && Number.isSafeInteger(pid) && pid > 0 && pid <= 0xffffffff ? pid : undefined;
}

/** An exact native root observation supplies these associations, independently of app names. */
export function mcpTargetAssociatedWindowIds(result: any, platform: NodeJS.Platform = process.platform): number[] {
  if (!['darwin', 'win32'].includes(platform) || mcpTargetWindowId(result, platform) === undefined || mcpTargetPid(result) === undefined) return [];
  const ids = result?._meta?.memmyComputerUse?.relatedWindowIDs;
  if (!Array.isArray(ids) || ids.length > 64 || !ids.every(id => typeof id === 'number'
    && Number.isSafeInteger(id) && id > 0 && (platform === 'win32' || id <= 0xffffffff))) return [];
  const root = mcpTargetWindowId(result, platform);
  return [...new Set<number>(ids)].filter(id => id !== root).sort((a, b) => a - b);
}

export function mcpPreviewImage(result: any, platform: NodeJS.Platform = process.platform): { url: string; width?: number; height?: number; targetWindowId?: number } | undefined {
  const block = Array.isArray(result?.content)
    ? result.content.find((item: any) => {
      if (item?.type === 'image' && typeof item.data === 'string'
        && ['image/png', 'image/jpeg', 'image/webp'].includes(item.mimeType)) return true;
      // Managed MCP responses may already be normalized to the OpenAI image_url
      // shape. Keep accepting only inline data URLs: remote URLs cannot provide
      // a deterministic native surface frame and would make the UI fail open.
      const imageUrl = typeof item?.image_url === 'string' ? item.image_url : item?.image_url?.url;
      return item?.type === 'image_url' && typeof imageUrl === 'string'
        && /^data:image\/(?:png|jpeg|webp);base64,[A-Za-z0-9+/]+={0,2}$/.test(imageUrl);
    })
    : null;
  if (!block) return undefined;
  let mimeType: 'image/png' | 'image/jpeg' | 'image/webp';
  let data: string;
  let url: string;
  if (block.type === 'image') {
    mimeType = block.mimeType;
    data = block.data;
    if (!/^[A-Za-z0-9+/]+={0,2}$/.test(data)) return undefined;
    url = `data:${mimeType};base64,${data}`;
  } else {
    const imageUrl = typeof block.image_url === 'string' ? block.image_url : block.image_url.url;
    const match = /^data:(image\/(?:png|jpeg|webp));base64,([A-Za-z0-9+/]+={0,2})$/.exec(imageUrl);
    if (!match) return undefined;
    mimeType = match[1] as typeof mimeType;
    data = match[2];
    url = imageUrl;
  }
  if (url.length > COMPUTER_USE_SURFACE_MAX_IMAGE_CHARS) return undefined;
  const header = Buffer.from(data.slice(0, 48), 'base64');
  const targetWindowId = mcpTargetWindowId(result, platform);
  const identity = targetWindowId === undefined ? {} : { targetWindowId };
  if (mimeType === 'image/jpeg') return header[0] === 0xff && header[1] === 0xd8 ? { url, ...identity } : undefined;
  if (mimeType === 'image/webp') return header.toString('ascii', 0, 4) === 'RIFF'
    && header.toString('ascii', 8, 12) === 'WEBP' ? { url, ...identity } : undefined;
  if (header.length < 24 || header.toString('hex', 0, 8) !== '89504e470d0a1a0a'
      || header.toString('ascii', 12, 16) !== 'IHDR') return undefined;
  const width = header.readUInt32BE(16);
  const height = header.readUInt32BE(20);
  if (!width || !height || width > 16000 || height > 16000) return { url, ...identity };
  return { url, width, height, ...identity };
}
