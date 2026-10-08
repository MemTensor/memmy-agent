import {
  COMPUTER_USE_SURFACE_MAX_IMAGE_CHARS,
  COMPUTER_USE_SURFACE_PREFIX,
  isComputerUseSurfaceAction,
  type ComputerUseSurfaceAction,
  type ComputerUseSurfaceMessage,
} from '@memmy/local-api-contracts';

const computerHandlers = new Map<string, { handle: (action: ComputerUseSurfaceAction) => Promise<void>; cancel?: AbortController }>();
const activeNativeSurfaces = new Map<string, Pick<ComputerUseSurfaceAction, 'sessionKey' | 'channel' | 'chatId' | 'targetId' | 'turnId'>>();
type TurnScope = { sessionKey: string; channel: string; chatId: string };
const activeTurns = new Map<string, { turnId: string; stop: () => Promise<unknown> }>();
let computerListenerProcess: NodeJS.Process | null = null;

function turnKey(input: TurnScope): string {
  return JSON.stringify([input.sessionKey, input.channel, input.chatId]);
}

function surfaceKey(input: Pick<ComputerUseSurfaceAction, 'sessionKey' | 'channel' | 'chatId' | 'targetId' | 'turnId'>): string {
  return JSON.stringify([input.sessionKey, input.channel, input.chatId, input.targetId, input.turnId]);
}

/** The runtime owns this turn identity; a tool or renderer cannot choose a different one. */
export function registerComputerUseTurnInterrupt(scope: TurnScope & { turnId: string }, stop: () => Promise<unknown>): () => void {
  const key = turnKey(scope);
  const entry = { turnId: scope.turnId, stop };
  activeTurns.set(key, entry);
  return () => { if (activeTurns.get(key) === entry) activeTurns.delete(key); };
}

export function activeComputerUseTurnId(scope: TurnScope): string | undefined {
  return activeTurns.get(turnKey(scope))?.turnId;
}

export function registerComputerUseSurfaceAction(
  identity: Pick<ComputerUseSurfaceAction, 'sessionKey' | 'channel' | 'chatId' | 'targetId' | 'turnId'>,
  handler: (action: ComputerUseSurfaceAction) => Promise<void>,
  cancel?: AbortController,
): void {
  if (process.env.MEMMY_DESKTOP_MANAGED_GATEWAY !== '1' || !process.send || !process.connected) return;
  if (computerListenerProcess !== process) {
    process.on('message', raw => {
      if (!isComputerUseSurfaceAction(raw) || raw.surface !== 'computer') return;
      const key = surfaceKey(raw);
      const registered = computerHandlers.get(key);
      if (raw.action === 'interrupt') {
        const turn = activeTurns.get(turnKey(raw));
        if (registered && turn && turn.turnId === raw.turnId) void turn.stop().catch(() => undefined);
        return;
      }
      if (registered) void registered.handle(raw).catch(() => undefined);
    });
    computerListenerProcess = process;
  }
  const key = surfaceKey(identity);
  computerHandlers.get(key)?.cancel?.abort();
  computerHandlers.delete(key);
  computerHandlers.set(key, { handle: handler, cancel });
  while (computerHandlers.size > 16) {
    const oldest = computerHandlers.keys().next().value!;
    computerHandlers.get(oldest)?.cancel?.abort();
    computerHandlers.delete(oldest);
  }
}

export function closeNativeSurfacesForTurn(scope: { sessionKey: string; channel: string; chatId: string }): void {
  for (const [key, identity] of activeNativeSurfaces) {
    if (identity.sessionKey !== scope.sessionKey || identity.channel !== scope.channel || identity.chatId !== scope.chatId) continue;
    computerHandlers.get(key)?.cancel?.abort();
    computerHandlers.delete(key);
    emitComputerUseSurface({ surface: 'computer', ...identity, title: identity.targetId, close: true });
  }
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
    else activeNativeSurfaces.set(key, event);
  }
  try { process.send(event, () => undefined); } catch { /* Desktop child is exiting. */ }
}

export function mcpTargetWindowId(result: any): number | undefined {
  const id = result?._meta?.memmyComputerUse?.targetWindowID;
  return typeof id === 'number' && Number.isSafeInteger(id) && id > 0 && id <= 0xffffffff ? id : undefined;
}

export function mcpPreviewImage(result: any): { url: string; width?: number; height?: number; targetWindowId?: number } | undefined {
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
  const targetWindowId = mcpTargetWindowId(result);
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
