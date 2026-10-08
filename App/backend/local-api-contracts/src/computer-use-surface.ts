/** Private Agent child -> Desktop main process preview protocol. */
export const COMPUTER_USE_SURFACE_PREFIX = 'memmy:computer-use-surface:';
export const COMPUTER_USE_SURFACE_MAX_IMAGE_CHARS = 3_000_000;

export type ComputerUseSurfaceMessage = {
  type: 'memmy:computer-use-surface:update' | 'memmy:computer-use-surface:close';
  surface: 'browser' | 'computer';
  sessionKey: string;
  channel: string;
  chatId: string;
  targetId: string;
  /** Active Agent turn that owns a native surface; never supplied by the renderer. */
  turnId?: string;
  title: string;
  /** Exact native target window for the displayed computer frame, when known. */
  targetWindowId?: number;
  imageDataUrl?: string;
  url?: string;
  canGoBack?: boolean;
  canGoForward?: boolean;
  /** Close the turn's PiP while retaining the underlying browser session. */
  presentationOnly?: boolean;
  error?: string;
};

export type ComputerUseSurfaceAction = {
  type: 'memmy:computer-use-surface:action';
  surface: 'browser' | 'computer';
  sessionKey: string;
  channel: string;
  chatId: string;
  targetId: string;
  turnId?: string;
  targetWindowId?: number;
  action: 'click' | 'scroll' | 'key' | 'open' | 'interrupt' | 'navigate' | 'back' | 'forward' | 'reload' | 'fill-credential' | 'fill-contact';
  x?: number;
  y?: number;
  deltaY?: number;
  /** Intrinsic video dimensions, required for live coordinate actions. */
  frameWidth?: number;
  frameHeight?: number;
  key?: string;
  url?: string;
  frameMode?: 'live';
  autofill?: { origin: string; username: string; password: string } | { origin: string; name: string; email: string; phone: string; address: string };
};

export function isComputerUseSurfaceAction(value: unknown): value is ComputerUseSurfaceAction {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return false;
  const action = value as Record<string, unknown>;
  if (action.type !== `${COMPUTER_USE_SURFACE_PREFIX}action`
      || (action.surface !== 'browser' && action.surface !== 'computer')) return false;
  if (![action.sessionKey, action.channel, action.chatId, action.targetId]
    .every(item => typeof item === 'string' && item.length > 0 && item.length <= 256)) return false;
  if (action.turnId !== undefined && (action.surface !== 'computer'
      || typeof action.turnId !== 'string' || action.turnId.length === 0 || action.turnId.length > 128)) return false;
  const validFrame = action.frameMode === undefined
    ? action.frameWidth === undefined && action.frameHeight === undefined
    : action.surface === 'computer' && action.frameMode === 'live'
      && dimension(action.frameWidth) && dimension(action.frameHeight);
  if (action.targetWindowId !== undefined && (action.surface !== 'computer'
      || !windowIdentifier(action.targetWindowId))) return false;
  if (action.action === 'interrupt') return action.surface === 'computer' && action.turnId !== undefined
    && keysOnly(action, ['type', 'surface', 'sessionKey', 'channel', 'chatId', 'targetId', 'turnId', 'targetWindowId', 'action']);
  if (action.action === 'click') return normalized(action.x) && normalized(action.y) && validFrame
    && keysOnly(action, ['type', 'surface', 'sessionKey', 'channel', 'chatId', 'targetId', 'turnId', 'targetWindowId', 'action', 'x', 'y', 'frameMode', 'frameWidth', 'frameHeight']);
  if (action.action === 'scroll') return typeof action.deltaY === 'number' && Number.isFinite(action.deltaY)
    && Math.abs(action.deltaY) <= 1000
    && (action.surface === 'browser'
      ? (action.x === undefined && action.y === undefined) || (normalized(action.x) && normalized(action.y))
      : normalized(action.x) && normalized(action.y))
    && validFrame
    && keysOnly(action, ['type', 'surface', 'sessionKey', 'channel', 'chatId', 'targetId', 'turnId', 'targetWindowId', 'action', 'deltaY', 'x', 'y', 'frameMode', 'frameWidth', 'frameHeight']);
  if (action.action === 'key') return typeof action.key === 'string' && action.key.length > 0 && action.key.length <= 64
    && (action.surface === 'computer' ? action.frameMode === 'live' : action.frameMode === undefined)
    && keysOnly(action, ['type', 'surface', 'sessionKey', 'channel', 'chatId', 'targetId', 'turnId', 'targetWindowId', 'action', 'key', 'frameMode']);
  if (action.action === 'open') return keysOnly(action,
    ['type', 'surface', 'sessionKey', 'channel', 'chatId', 'targetId', 'turnId', 'targetWindowId', 'action']);
  if (['back', 'forward', 'reload'].includes(String(action.action))) return action.surface === 'browser'
    && keysOnly(action, ['type', 'surface', 'sessionKey', 'channel', 'chatId', 'targetId', 'action']);
  if (action.action === 'navigate') return action.surface === 'browser'
    && typeof action.url === 'string' && action.url.length > 0 && action.url.length <= 4096
    && /^https?:\/\//i.test(action.url)
    && keysOnly(action, ['type', 'surface', 'sessionKey', 'channel', 'chatId', 'targetId', 'action', 'url']);
  if (action.action === 'fill-credential' || action.action === 'fill-contact') {
    if (action.surface !== 'browser' || !keysOnly(action,
      ['type', 'surface', 'sessionKey', 'channel', 'chatId', 'targetId', 'action', 'autofill'])) return false;
    const autofill = action.autofill;
    if (!autofill || typeof autofill !== 'object' || Array.isArray(autofill)) return false;
    const fields = autofill as Record<string, unknown>;
    try {
      const origin = new URL(String(fields.origin));
      if (!['http:', 'https:'].includes(origin.protocol) || origin.origin !== fields.origin
        || origin.origin.length > 320) return false;
    } catch { return false; }
    if (action.action === 'fill-credential') return typeof fields.username === 'string'
      && fields.username.length <= 256 && typeof fields.password === 'string'
      && fields.password.length > 0 && fields.password.length <= 4096
      && keysOnly(fields, ['origin', 'username', 'password']);
    return ['name', 'email', 'phone', 'address'].every(key =>
      typeof fields[key] === 'string' && (fields[key] as string).length <= 1024)
      && keysOnly(fields, ['origin', 'name', 'email', 'phone', 'address']);
  }
  return false;
}

function normalized(value: unknown): boolean {
  return typeof value === 'number' && Number.isFinite(value) && value >= 0 && value <= 1;
}

function dimension(value: unknown): boolean {
  return typeof value === 'number' && Number.isSafeInteger(value) && value > 0 && value <= 16384;
}

function windowIdentifier(value: unknown): boolean {
  return typeof value === 'number' && Number.isSafeInteger(value) && value > 0 && value <= 0xffffffff;
}

function keysOnly(value: Record<string, unknown>, allowed: string[]): boolean {
  return Object.keys(value).every(key => allowed.includes(key));
}

export function isComputerUseSurfaceMessage(value: unknown): value is ComputerUseSurfaceMessage {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return false;
  const message = value as Record<string, unknown>;
  if (message.type !== `${COMPUTER_USE_SURFACE_PREFIX}update`
      && message.type !== `${COMPUTER_USE_SURFACE_PREFIX}close`) return false;
  if (message.surface !== 'browser' && message.surface !== 'computer') return false;
  if (message.targetWindowId !== undefined && (message.surface !== 'computer'
      || message.type !== `${COMPUTER_USE_SURFACE_PREFIX}update`
      || !windowIdentifier(message.targetWindowId))) return false;
  if (![message.sessionKey, message.channel, message.chatId, message.targetId, message.title]
    .every(item => typeof item === 'string' && item.length > 0 && item.length <= 256)) return false;
  if (message.turnId !== undefined && (message.surface !== 'computer'
      || typeof message.turnId !== 'string' || message.turnId.length === 0 || message.turnId.length > 128)) return false;
  if (message.imageDataUrl !== undefined && (typeof message.imageDataUrl !== 'string'
      || message.imageDataUrl.length > COMPUTER_USE_SURFACE_MAX_IMAGE_CHARS
      || !/^data:image\/(?:png|jpeg|webp);base64,[A-Za-z0-9+/=]+$/.test(message.imageDataUrl))) return false;
  if (message.url !== undefined && (message.surface !== 'browser' || typeof message.url !== 'string'
      || message.url.length > 4096)) return false;
  if (message.canGoBack !== undefined && (message.surface !== 'browser' || typeof message.canGoBack !== 'boolean')) return false;
  if (message.canGoForward !== undefined && (message.surface !== 'browser' || typeof message.canGoForward !== 'boolean')) return false;
  if (message.presentationOnly !== undefined && (message.type !== `${COMPUTER_USE_SURFACE_PREFIX}close`
      || message.surface !== 'browser' || message.presentationOnly !== true)) return false;
  if (message.error !== undefined && (message.surface !== 'browser' || typeof message.error !== 'string'
      || message.error.length > 256)) return false;
  return Object.keys(message).every(key =>
    ['type', 'surface', 'sessionKey', 'channel', 'chatId', 'targetId', 'turnId', 'targetWindowId', 'title', 'imageDataUrl', 'url', 'canGoBack', 'canGoForward', 'presentationOnly', 'error'].includes(key));
}
