export const EMBEDDED_BROWSER_REQUEST = 'memmy:embedded-browser:request';
export const EMBEDDED_BROWSER_RESULT = 'memmy:embedded-browser:result';
export const EMBEDDED_BROWSER_CANCEL = 'memmy:embedded-browser:cancel';
export type EmbeddedBrowserCancel = { type: typeof EMBEDDED_BROWSER_CANCEL; requestId: string };
export function isEmbeddedBrowserCancel(value: unknown): value is EmbeddedBrowserCancel {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return false;
  const input = value as Record<string, unknown>;
  return input.type === EMBEDDED_BROWSER_CANCEL && typeof input.requestId === 'string'
    && /^[a-zA-Z0-9:-]{1,100}$/.test(input.requestId)
    && Object.keys(input).every(key => key === 'type' || key === 'requestId');
}

export const EMBEDDED_BROWSER_COMMANDS = [
  'probe', 'listTabs', 'queryHistory', 'openTab', 'closeTab', 'allowOrigin', 'snapshot', 'find', 'navigate', 'back', 'forward', 'reload',
  'click', 'type', 'selectOption', 'pressKey', 'scroll', 'waitFor', 'screenshot',
  'consoleMessages', 'networkRequests', 'viewport', 'historyState', 'resize', 'open',
  'fillCredential', 'fillContact',
  'authRequest',
  'upload',
  'cdpCall', 'cdpEvents', 'cdpWrite',
] as const;

export type EmbeddedBrowserTabMention = {
  browserId: string;
  tabId: number;
  title: string;
  url: string;
};

export function formatEmbeddedBrowserTabMention(tab: EmbeddedBrowserTabMention): string {
  const query = new URLSearchParams({ mention: 'tab-v1', browserId: tab.browserId,
    tabId: String(tab.tabId), title: tab.title, url: tab.url });
  return `plugin://browser@memmy?${query}`;
}

export function parseEmbeddedBrowserTabMention(value: unknown): EmbeddedBrowserTabMention | null {
  if (typeof value !== 'string' || value.length > 20_000) return null;
  let parsed: URL;
  try { parsed = new URL(value); } catch { return null; }
  if (parsed.protocol !== 'plugin:' || parsed.username !== 'browser' || parsed.password
    || parsed.host !== 'memmy'
    || parsed.pathname || parsed.hash || parsed.searchParams.size !== 5
    || [...parsed.searchParams.keys()].some(key => parsed.searchParams.getAll(key).length !== 1)
    || parsed.searchParams.get('mention') !== 'tab-v1') return null;
  const browserId = parsed.searchParams.get('browserId') ?? '';
  const tabIdText = parsed.searchParams.get('tabId') ?? '';
  const title = parsed.searchParams.get('title');
  const url = parsed.searchParams.get('url') ?? '';
  const tabId = Number(tabIdText);
  if (!/^[a-f0-9-]{36}$/i.test(browserId) || !/^[1-9]\d*$/.test(tabIdText)
    || !Number.isSafeInteger(tabId) || title === null || title.length > 4096 || url.length > 4096) return null;
  try { if (!['http:', 'https:'].includes(new URL(url).protocol)) return null; }
  catch { return null; }
  return { browserId, tabId, title, url };
}

export type EmbeddedBrowserCommand = typeof EMBEDDED_BROWSER_COMMANDS[number];
export type EmbeddedBrowserRequest = {
  type: typeof EMBEDDED_BROWSER_REQUEST;
  requestId: string;
  tabId?: number;
  command: EmbeddedBrowserCommand;
  args: Record<string, unknown>;
};
export type EmbeddedBrowserResult = {
  type: typeof EMBEDDED_BROWSER_RESULT;
  requestId: string;
  ok: boolean;
  result?: unknown;
  error?: string;
};

export function isEmbeddedBrowserRequest(value: unknown): value is EmbeddedBrowserRequest {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return false;
  const input = value as Partial<EmbeddedBrowserRequest>;
  return input.type === EMBEDDED_BROWSER_REQUEST
    && typeof input.requestId === 'string' && /^[a-zA-Z0-9:-]{1,100}$/.test(input.requestId)
    && EMBEDDED_BROWSER_COMMANDS.includes(input.command as EmbeddedBrowserCommand)
    && (input.tabId === undefined || (Number.isSafeInteger(input.tabId) && input.tabId! > 0))
    && (input.command !== 'closeTab' || input.tabId !== undefined)
    && Boolean(input.args && typeof input.args === 'object' && !Array.isArray(input.args));
}

export function isEmbeddedBrowserResult(value: unknown): value is EmbeddedBrowserResult {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return false;
  const input = value as Partial<EmbeddedBrowserResult>;
  return input.type === EMBEDDED_BROWSER_RESULT
    && typeof input.requestId === 'string' && /^[a-zA-Z0-9:-]{1,100}$/.test(input.requestId)
    && typeof input.ok === 'boolean';
}
