import { randomUUID } from 'node:crypto';
import { lstatSync, realpathSync } from 'node:fs';
import path from 'node:path';
import type { BrowserWindow, Session, WebContents } from 'electron';
import { formatEmbeddedBrowserTabMention, normalizeBrowserCdpReadCall, normalizeBrowserCdpWriteCall,
  normalizeBrowserCdpCommandOptions, type BrowserCdpTarget, type BrowserCdpTargetApproval,
  BROWSER_PLAYWRIGHT_CDP_METHODS,
  type EmbeddedBrowserCommand, type EmbeddedBrowserRequest } from '@memmy/local-api-contracts';
import type { BrowserHistoryStore, BrowserVisitSource } from './browser-history-store.js';
import { BrowserCdpEventBuffer } from './browser-cdp-event-buffer.js';
import { BrowserTaskSitePermissions } from './browser-task-site-permissions.js';
import { collectMissingBrowserAuth, parseBrowserAuthRequest, type BrowserAuthRequest, type BrowserAuthResult } from './browser-auth-request.js';
import type { BrowserAuthFormResult } from './browser-auth-form.js';
import { assertEmbeddedBrowserInputReceiver, focusEmbeddedBrowserInput,
  keepEmbeddedBrowserAnimating } from './embedded-browser-input.js';

type Node = { ref: string; role: string; name: string; value: string };
type Point = { x: number; y: number };
type ClickGeometry = { width: number; height: number; quads: number[][] };
type ClickAction = Point & { objectId?: string; backendNodeId?: number; geometry?: ClickGeometry; checkCurrent: () => void };
type CdpSession = { targetId: string; url: string; revision: number; parentSessionId?: string };
type ResolvedCdpTarget = { sessionId: string; info: CdpSession; revision: number; origin: string };
/** Delivers an executor CDP event on the same ordered channel as command results. */
export type EmbeddedExecutorEventSink = (event: { leaseId: string; method: string;
  params: Record<string, unknown>; sessionId?: string }) => void;
type PlaywrightLease = { id: string; origin: string; input: boolean; expiresAt: number;
  documentEpoch: number; cdpEpoch: number; targetId: string; emit?: EmbeddedExecutorEventSink;
  restoreAnimation?: () => void; expiryTimer?: ReturnType<typeof setTimeout>;
  uploadStamps?: ApprovedBrowserUpload['stamps']; uploadPaths?: string[] };
type BrowserNavigation = { startUrl: string; url: string; state: 'loading' | 'complete' | 'failed';
  error?: Error; abortError?: Error };
type Entry = { guest: WebContents; host: BrowserWindow; allowedOrigins: Set<string>;
  console: Array<{ type: string; text: string }>; requests: Array<{ method: string; url: string }>;
  cdpEvents: BrowserCdpEventBuffer;
  cdpSessions: Map<string, CdpSession>;
  cdpOrigin: string | null;
  cdpEpoch: number;
  playwrightLease: PlaywrightLease | null; playwrightLastLeaseId: string | null;
  protectedActivity: number; cdpReadDepth: number; cdpWriteDepth: number;
  credentialProtected: boolean; credentialRecoveryOrigin: string | null;
  recoveryNavigationPending: boolean; documentEpoch: number; frameEpoch: number;
  attached: boolean; debuggerListenersInstalled: boolean; lastUserInputAt: number; agentInputDepth: number; lastStartedUrl: string;
  visitSource: BrowserVisitSource; visitSourceUntil: number; visitSourceMarkedAt: number;
  lastRecordedUrl: string; lastRecordedAt: number; lastRecordedSource: BrowserVisitSource;
  pendingNavigation: boolean; everSelected: boolean; initialNavigationUrl: string;
  navigation: BrowserNavigation | null };

export type ApprovedBrowserUpload = { origin: string; stamps: Array<{
  path: string; realPath: string; dev: number; ino: number; size: number; mtimeMs: number;
}>; isCurrentChild: () => boolean };

export type ApprovedBrowserCdpRead = { origin: string; isCurrentChild: () => boolean;
  isAllowed: () => boolean; mode?: 'read' | 'write'; target?: BrowserCdpTargetApproval };

export type BrowserAutofillPayload =
  | { kind: 'credential'; origin: string; username: string; password: string }
  | { kind: 'contact'; origin: string; name: string; email: string; phone: string; address: string };

const WRITES = new Set<EmbeddedBrowserCommand>([
  'navigate', 'back', 'forward', 'reload', 'click', 'type', 'selectOption',
  'pressKey', 'scroll', 'resize',
  'fillCredential', 'fillContact',
  'upload',
  'cdpWrite',
]);
const OBSERVES_PAGE = new Set<EmbeddedBrowserCommand>([
  'snapshot', 'find', 'consoleMessages', 'networkRequests',
  'cdpCall', 'cdpEvents', 'cdpWrite',
]);
const NAVIGATION_ACTIONS = new Set<EmbeddedBrowserCommand>([
  'navigate', 'back', 'forward', 'reload', 'click', 'type', 'selectOption', 'pressKey', 'fillCredential', 'fillContact',
]);
// Switching apps (Cmd+Tab) delivers bare modifier and key-up events to the
// focused page; those do not mean the user is operating it.
const MODIFIER_KEYS = new Set(['Meta', 'Control', 'Alt', 'AltGraph', 'Shift', 'CapsLock', 'Fn', 'FnLock', 'OS']);
const USER_ACTIVE_WINDOW_MS = 2_000;
const USER_IDLE_WAIT_MS = 8_000;
const PLAYWRIGHT_METHODS = new Set<string>(BROWSER_PLAYWRIGHT_CDP_METHODS);

function origin(value: string): string {
  const url = new URL(value);
  if (url.protocol !== 'http:' && url.protocol !== 'https:') throw new Error('Only HTTP(S) pages can be controlled');
  return url.origin;
}

function runtimeResult(response: any, operation: string): any {
  if (response?.exceptionDetails) {
    const details = response.exceptionDetails;
    const reason = (String(details.exception?.description ?? details.text ?? 'JavaScript exception')
      .split('\n')[0] ?? 'JavaScript exception').slice(0, 300);
    throw new Error(`${operation}: ${reason}. Take a new snapshot before acting again.`);
  }
  return response?.result;
}

function clippedQuad(quad: number[], width: number, height: number): Point[] {
  let points: Point[] = Array.from({ length: 4 }, (_, index) => ({ x: quad[index * 2]!, y: quad[index * 2 + 1]! }));
  for (const [axis, edge, lower] of [['x', 0, true], ['x', width, false], ['y', 0, true], ['y', height, false]] as const) {
    const clipped: Point[] = [];
    for (let index = 0; index < points.length; index++) {
      const first = points[index]!, second = points[(index + 1) % points.length]!;
      const inside = (point: Point) => lower ? point[axis] >= edge : point[axis] <= edge;
      if (inside(first)) clipped.push(first);
      if (inside(first) !== inside(second)) {
        const ratio = (edge - first[axis]) / (second[axis] - first[axis]);
        clipped.push({ x: first.x + ratio * (second.x - first.x), y: first.y + ratio * (second.y - first.y) });
      }
    }
    points = clipped;
  }
  return points;
}

function visibleClickPoint(geometry: ClickGeometry): Point {
  const candidates = geometry.quads.map(quad => clippedQuad(quad, geometry.width, geometry.height))
    .map(points => ({ points, area: Math.abs(points.reduce((sum, point, index) => {
      const next = points[(index + 1) % points.length]!;
      return sum + point.x * next.y - next.x * point.y;
    }, 0)) / 2 })).filter(candidate => candidate.area >= 1).sort((a, b) => b.area - a.area);
  const points = candidates[0]?.points;
  if (!points?.length) throw new Error('Element has no visible non-zero layout inside the viewport. Take a new snapshot.');
  return { x: points.reduce((sum, point) => sum + point.x, 0) / points.length,
    y: points.reduce((sum, point) => sum + point.y, 0) / points.length };
}

function sameClickGeometry(before: ClickGeometry, after: ClickGeometry): boolean {
  return before.width === after.width && before.height === after.height && before.quads.length === after.quads.length
    && before.quads.every((quad, index) => quad.every((value, coordinate) => Math.abs(value - after.quads[index]![coordinate]!) <= 0.5));
}

function keyEvent(key: string, modifiers: number): Record<string, unknown> {
  const aliases: Record<string, string> = { Return: 'Enter', Esc: 'Escape', Del: 'Delete',
    Left: 'ArrowLeft', Right: 'ArrowRight', Up: 'ArrowUp', Down: 'ArrowDown', ' ': 'Space' };
  const named: Record<string, [string, number, string]> = {
    Enter: ['Enter', 13, '\r'], Tab: ['Tab', 9, ''], Escape: ['Escape', 27, ''],
    Backspace: ['Backspace', 8, ''], Delete: ['Delete', 46, ''],
    ArrowLeft: ['ArrowLeft', 37, ''], ArrowUp: ['ArrowUp', 38, ''],
    ArrowRight: ['ArrowRight', 39, ''], ArrowDown: ['ArrowDown', 40, ''],
    Home: ['Home', 36, ''], End: ['End', 35, ''], PageUp: ['PageUp', 33, ''],
    PageDown: ['PageDown', 34, ''], Space: ['Space', 32, ' '],
  };
  const normalized = aliases[key] ?? key;
  let code: string, virtualKeyCode: number, text = '';
  if (named[normalized]) [code, virtualKeyCode, text] = named[normalized];
  else if (/^[a-z]$/i.test(normalized)) {
    code = `Key${normalized.toUpperCase()}`;
    virtualKeyCode = normalized.toUpperCase().charCodeAt(0);
    text = modifiers & 8 ? normalized.toUpperCase() : normalized.toLowerCase();
  } else if (/^[0-9]$/.test(normalized)) {
    code = `Digit${normalized}`;
    virtualKeyCode = normalized.charCodeAt(0);
    text = normalized;
  } else if (/^F([1-9]|1[0-2])$/.test(normalized)) {
    code = normalized;
    virtualKeyCode = 111 + Number(normalized.slice(1));
  } else if (normalized.length === 1) {
    code = normalized;
    virtualKeyCode = normalized.toUpperCase().charCodeAt(0);
    text = normalized;
  } else throw new Error('Unsupported key');
  if (modifiers & 7) text = '';
  return { key: normalized === 'Space' ? ' ' : normalized, code,
    windowsVirtualKeyCode: virtualKeyCode, nativeVirtualKeyCode: virtualKeyCode,
    modifiers, text, unmodifiedText: text };
}

/** Drives the actual Electron webview shown in the right browser panel. */
export class EmbeddedBrowserDriver {
  private readonly browserId = randomUUID();
  private readonly entries = new Map<number, Entry>();
  private readonly hostInput = new Map<BrowserWindow, { lastInputAt: number; dispose: () => void }>();
  private selectedTabId: number | null = null;
  private historyStore: BrowserHistoryStore | null = null;
  readonly taskSitePermissions = new BrowserTaskSitePermissions();

  constructor(private readonly getHost: () => BrowserWindow | null = () => null) {}

  private observeHostInput(host: BrowserWindow): void {
    if (this.hostInput.has(host)) return;
    const contents = host.webContents;
    const state = { lastInputAt: 0, dispose: () => {
      contents.removeListener('before-input-event', onKey);
      contents.removeListener('input-event', onPointer);
      contents.removeListener('destroyed', onDestroyed);
    } };
    const record = () => {
      // Electron may surface injected input on the embedding WebContents too.
      if (![...this.entries.values()].some(entry => entry.host === host && entry.agentInputDepth > 0)) {
        state.lastInputAt = Date.now();
      }
    };
    const onKey = (_event: unknown, input: { type?: string; key?: string }) => {
      if (input?.type === 'keyDown' && !MODIFIER_KEYS.has(input.key ?? '')) record();
    };
    const onPointer = (_event: unknown, input: { type?: string }) => {
      if (['mouseDown', 'mouseWheel', 'pointerDown', 'touchStart'].includes(input?.type ?? '')) record();
    };
    const onDestroyed = () => { state.dispose(); this.hostInput.delete(host); };
    contents.on('before-input-event', onKey);
    contents.on('input-event', onPointer);
    contents.once('destroyed', onDestroyed);
    this.hostInput.set(host, state);
  }

  setHistoryStore(store: BrowserHistoryStore): void { this.historyStore = store; }

  /** A task destination belongs only to this live tab and one browser action. */
  setDownloadDestination(tabId: number, raw: Record<string, unknown>,
    set: (tabId: number, filePath: string | null, destinationId: string, isCurrent: () => boolean) => void,
    isCurrentChild: () => boolean): { configured: boolean } {
    if (typeof raw.destinationId !== 'string' || !/^[a-f\d-]{36}$/i.test(raw.destinationId)
      || (raw.filePath !== null && (typeof raw.filePath !== 'string' || raw.filePath.length > 4096
        || !path.isAbsolute(raw.filePath) || raw.filePath.includes('\0')))
      || Object.keys(raw).some(key => !['filePath', 'destinationId'].includes(key)))
      throw new Error('Invalid browser download destination');
    if (raw.filePath === null) {
      set(tabId, null, raw.destinationId, () => false);
      return { configured: false };
    }
    const entry = this.active(tabId);
    if (!isCurrentChild() || entry.credentialProtected || entry.protectedActivity
      || !entry.allowedOrigins.has(origin(entry.guest.getURL()))) throw new Error('Browser download target is unavailable');
    const initialUrl = entry.guest.getURL();
    set(tabId, raw.filePath, raw.destinationId, () => isCurrentChild()
      && this.entries.get(tabId) === entry && !entry.guest.isDestroyed()
      && !entry.credentialProtected && !entry.protectedActivity && entry.guest.getURL() === initialUrl);
    return { configured: true };
  }

  attach(guest: WebContents, host: BrowserWindow): void {
    this.observeHostInput(host);
    const entry: Entry = { guest, host, allowedOrigins: new Set(), console: [], requests: [],
      cdpEvents: new BrowserCdpEventBuffer(), cdpSessions: new Map(), cdpOrigin: null, cdpEpoch: 0,
      playwrightLease: null, playwrightLastLeaseId: null,
      protectedActivity: 0, cdpReadDepth: 0, cdpWriteDepth: 0, credentialProtected: false,
      credentialRecoveryOrigin: null, recoveryNavigationPending: false,
      documentEpoch: 0, frameEpoch: 0,
      attached: false, debuggerListenersInstalled: false, lastUserInputAt: 0, agentInputDepth: 0, lastStartedUrl: '',
      visitSource: 'other', visitSourceUntil: 0, visitSourceMarkedAt: 0,
      lastRecordedUrl: '', lastRecordedAt: 0, lastRecordedSource: 'other', pendingNavigation: false,
      everSelected: false, initialNavigationUrl: '', navigation: null };
    this.entries.set(guest.id, entry);
    guest.on('did-start-navigation', details => {
      if (details.isMainFrame) {
        this.revokePlaywright(entry, details.isSameDocument ? undefined : 'navigation');
        this.taskSitePermissions.end(guest.id, details.url);
        try { this.ensureCdpOrigin(entry, origin(details.url)); }
        catch { entry.cdpEvents.clear(); entry.cdpOrigin = null; entry.cdpEpoch++; }
        entry.lastStartedUrl = details.url;
        entry.pendingNavigation = true;
        if (!entry.initialNavigationUrl && /^https?:\/\//.test(details.url)) entry.initialNavigationUrl = details.url;
        if (!details.isSameDocument) {
          entry.navigation = { startUrl: details.url, url: details.url, state: 'loading' };
        } else if (entry.navigation) entry.navigation.url = details.url;
      }
    });
    guest.on('did-redirect-navigation', details => {
      if (details.isMainFrame && entry.navigation?.state === 'loading') entry.navigation.url = details.url;
    });
    guest.on('did-finish-load', () => {
      // A Chromium error page can also finish loading. Its failure stays a
      // failure until another main-frame navigation starts.
      const navigation = entry.navigation;
      if (navigation?.state === 'loading' && guest.getURL() === navigation.url) navigation.state = 'complete';
    });
    const failedNavigation = (_event: unknown, code: number, description: string, url: string, isMainFrame: boolean) => {
      const navigation = entry.navigation;
      if (!isMainFrame || !navigation || navigation.url !== url) return;
      const error = new Error(`${description || 'Navigation failed'} (${code}) loading '${url}'`);
      if (code === -3) {
        // An older same-URL load can abort after its replacement has started.
        // Wait for loading to stop; a replacement that finishes wins instead.
        navigation.abortError = error;
        return;
      }
      navigation.state = 'failed';
      navigation.error = error;
    };
    guest.on('did-fail-load', failedNavigation);
    guest.on('did-fail-provisional-load', failedNavigation);
    guest.on('before-input-event', (_event, input) => {
      if (!entry.agentInputDepth && input?.type === 'keyDown' && !MODIFIER_KEYS.has(input.key)) {
        entry.lastUserInputAt = Date.now();
        this.markVisitSource(entry, 'other');
      }
    });
    guest.on('input-event', (_event, input) => {
      if (!entry.agentInputDepth && ['mouseDown', 'mouseWheel', 'pointerDown', 'touchStart'].includes(input.type)) {
        entry.lastUserInputAt = Date.now();
        this.markVisitSource(entry, 'other');
      }
    });
    const recordNavigation = () => {
      if (!entry.pendingNavigation && entry.lastRecordedUrl) return;
      try {
        const url = guest.getURL();
        const now = Date.now();
        const source = entry.visitSourceMarkedAt >= entry.lastRecordedAt && now <= entry.visitSourceUntil
          ? entry.visitSource : url === entry.lastRecordedUrl ? entry.lastRecordedSource : 'other';
        this.historyStore?.recordVisit(String(guest.id), url, guest.getTitle(), now, source);
        entry.lastRecordedUrl = url;
        entry.lastRecordedAt = now;
        entry.lastRecordedSource = source;
        entry.pendingNavigation = false;
      }
      catch { /* History disk errors cannot interrupt the browser. */ }
    };
    guest.on('did-stop-loading', () => {
      const navigation = entry.navigation;
      if (navigation?.state === 'loading' && navigation.abortError && !guest.isLoading()) {
        navigation.state = 'failed';
        navigation.error = navigation.abortError;
      }
      recordNavigation();
    });
    guest.on('did-navigate', () => {
      if (entry.navigation) entry.navigation.url = guest.getURL();
      this.revokePlaywright(entry, 'navigation');
      // A redirect can commit another origin after the navigation started on this one.
      this.taskSitePermissions.end(guest.id, guest.getURL());
      entry.documentEpoch++;
      let recovered = false;
      try { recovered = entry.recoveryNavigationPending
        && origin(entry.guest.getURL()) === entry.credentialRecoveryOrigin; }
      catch { /* Site redirected to an unsupported page. */ }
      entry.recoveryNavigationPending = false;
      if (entry.credentialProtected && recovered) {
        entry.credentialProtected = false;
        entry.credentialRecoveryOrigin = null;
        entry.cdpEvents.clear(); entry.console.length = 0; entry.requests.length = 0;
      }
    });
    guest.on('did-navigate-in-page', () => {
      if (entry.navigation) entry.navigation.url = guest.getURL();
      entry.pendingNavigation = true;
      recordNavigation();
    });
    guest.on('page-title-updated', () => {
      try { this.historyStore?.reviseLatestVisit(String(guest.id), guest.getURL(), guest.getTitle()); }
      catch { /* A history title update must not interrupt the browser. */ }
    });
    guest.once('destroyed', () => {
      this.taskSitePermissions.end(guest.id);
      this.revokePlaywright(entry);
      this.historyStore?.finishSession(String(guest.id));
      if (this.entries.get(guest.id) !== entry) return;
      this.entries.delete(guest.id);
      if (this.selectedTabId === guest.id) this.selectedTabId = null;
    });
  }

  private markVisitSource(entry: Entry, source: BrowserVisitSource): void {
    entry.visitSource = source;
    entry.visitSourceMarkedAt = Date.now();
    entry.visitSourceUntil = Date.now() + 10_000;
  }

  private ensureCdpOrigin(entry: Entry, current: string = origin(entry.guest.getURL())): void {
    if (entry.cdpOrigin !== current) {
      this.revokePlaywright(entry);
      entry.cdpEvents.clear();
      entry.cdpSessions.clear();
      entry.cdpOrigin = current;
      entry.cdpEpoch++;
    }
  }

  /** Renderer address-bar navigation overrides any earlier Agent gesture on this tab. */
  markUserNavigation(tabId: number, host: BrowserWindow): void {
    const entry = this.entries.get(tabId);
    if (!entry || entry.host !== host || entry.guest.isDestroyed()) throw new Error('Browser tab is unavailable');
    this.markVisitSource(entry, 'other');
  }

  selectTab(tabId: number | null, host: BrowserWindow): void {
    if (tabId === null) {
      const selected = this.entries.get(this.selectedTabId ?? -1);
      if (selected && selected.host !== host) throw new Error('Browser tab is unavailable');
      this.selectedTabId = null;
      return;
    }
    const entry = this.entries.get(tabId);
    if (!entry || entry.host !== host || entry.guest.isDestroyed()) throw new Error('Browser tab is unavailable');
    this.selectedTabId = tabId;
    entry.everSelected = true;
  }

  tabMention(tabId: number, host: BrowserWindow): string {
    const entry = this.entries.get(tabId);
    if (!entry || entry.host !== host || entry.guest.isDestroyed()) throw new Error('Browser tab is unavailable');
    const url = entry.guest.getURL();
    origin(url);
    if (url.length > 4096 || entry.guest.getTitle().length > 4096) {
      throw new Error('Browser tab reference is too long');
    }
    return formatEmbeddedBrowserTabMention({ browserId: this.browserId, tabId,
      title: entry.guest.getTitle(), url });
  }

  private userAutofillTab(tabId: number, host: BrowserWindow, browserSession: Session): Entry {
    const entry = this.entries.get(tabId);
    if (!Number.isSafeInteger(tabId) || tabId <= 0 || !entry || this.selectedTabId !== tabId
      || entry.host !== host || host.isDestroyed() || entry.guest.isDestroyed()
      || entry.guest.session !== browserSession) throw new Error('Browser tab is unavailable');
    return entry;
  }

  selectedTabOrigin(tabId: number, host: BrowserWindow, browserSession: Session): string {
    return origin(this.userAutofillTab(tabId, host, browserSession).guest.getURL());
  }

  /** A user click may fill only the selected webview owned by this window and browser partition. */
  async fillFromVault(tabId: number, host: BrowserWindow, browserSession: Session,
    input: BrowserAutofillPayload): Promise<number> {
    const entry = this.userAutofillTab(tabId, host, browserSession);
    if (origin(input.origin) !== input.origin || origin(entry.guest.getURL()) !== input.origin)
      throw new Error('Autofill site changed');
    return this.fillFields(entry, input, () => {
      this.userAutofillTab(tabId, host, browserSession);
      if (origin(entry.guest.getURL()) !== input.origin) throw new Error('Autofill site changed');
    });
  }

  private async authFrame(entry: Entry, selectors: readonly string[]): Promise<{
    key: string; documentExpression: string; url: string; timeOrigin?: number; sessionId?: string;
    children: Array<{ sessionId: string; info: CdpSession; revision: number; url: string }>;
  }> {
    let documentExpression = 'document';
    let sessionId: string | undefined;
    let url = entry.guest.getURL();
    let timeOrigin: number | undefined;
    const keys: string[] = [];
    const children: Array<{ sessionId: string; info: CdpSession; revision: number; url: string }> = [];
    for (const selector of selectors) {
      const expression = `(() => { const doc=${documentExpression};
        const found=doc?.querySelectorAll(${JSON.stringify(selector)});
        return found?.length===1 && found[0].tagName==='IFRAME' ? found[0] : null; })()`;
      const object = await this.command(entry, 'Runtime.evaluate', { expression }, undefined, sessionId);
      if (!object.result?.objectId) throw new Error('Auth frame is unavailable');
      const described = await this.command(entry, 'DOM.describeNode',
        { objectId: object.result.objectId }, undefined, sessionId);
      const frameId = String(described.node?.frameId ?? '');
      if (described.node?.nodeName?.toLowerCase() !== 'iframe' || !frameId)
        throw new Error('Auth target is not a frame');
      const child = [...entry.cdpSessions.entries()].find(([, info]) =>
        info.targetId === frameId && info.parentSessionId === sessionId);
      if (child) {
        const [childSessionId, info] = child;
        const live = await this.attachedChildMetadata(entry, childSessionId, info);
        url = String(live.targetInfo?.url ?? '');
        if (live.targetInfo?.targetId !== info.targetId || origin(url) !== origin(info.url))
          throw new Error('Auth frame site changed');
        children.push({ sessionId: childSessionId, info, revision: info.revision, url });
        sessionId = childSessionId;
        documentExpression = 'document';
      } else {
        documentExpression = `${documentExpression}.querySelector(${JSON.stringify(selector)}).contentDocument`;
      }
      const fingerprint = await this.command(entry, 'Runtime.evaluate', {
        expression: `(() => { const doc=${documentExpression}; return doc ?
          {url:doc.URL,timeOrigin:doc.defaultView.performance.timeOrigin} : null; })()`,
        returnByValue: true,
      }, undefined, sessionId);
      const value = fingerprint.result?.value;
      if (!value || typeof value.url !== 'string' || !Number.isFinite(value.timeOrigin)
        || (child && value.url !== url)) throw new Error('Auth frame changed');
      url = value.url; timeOrigin = value.timeOrigin;
      keys.push(`${frameId}:${sessionId ?? 'top'}:${url}:${timeOrigin}:${child?.[1].revision ?? ''}`);
    }
    return { key: keys.join('|') || 'top', documentExpression, url, timeOrigin, sessionId, children };
  }

  /** Secure auth values are collected and used entirely in desktop main, never sent to Agent. */
  async requestAuth(tabId: number, raw: unknown,
    collect: (request: BrowserAuthRequest) => Promise<BrowserAuthFormResult>,
    isCurrent: () => boolean): Promise<BrowserAuthResult> {
    const request = parseBrowserAuthRequest(raw);
    if (!isCurrent()) return { status: 'cancelled' };
    const entry = this.active(tabId);
    if (entry.credentialProtected) return { status: 'unavailable' };
    if (this.selectedTabId !== tabId) return { status: 'page_changed' };
    if (origin(entry.guest.getURL()) !== request.origin) return { status: 'origin_changed' };
    if (!entry.allowedOrigins.has(request.origin)) return { status: 'unavailable' };
    const initialUrl = entry.guest.getURL();
    const initialEpoch = entry.documentEpoch;
    return this.withProtectedActivity(entry, async () => {
      const frames = request.frame ? [request.frame] : request.frames ?? [];
      let initialFrame: Awaited<ReturnType<typeof this.authFrame>>;
      try { initialFrame = await this.authFrame(entry, frames); }
      catch { return { status: 'locator_invalid' }; }
      const stillCurrent = () => isCurrent() && !entry.guest.isDestroyed()
        && this.selectedTabId === tabId && entry.documentEpoch === initialEpoch
        && entry.guest.getURL() === initialUrl;
      const validate = async (): Promise<BrowserAuthResult | null> => {
        if (!stillCurrent()) return { status: 'page_changed' };
        if (origin(entry.guest.getURL()) !== request.origin) return { status: 'origin_changed' };
        const controls = [
          ...request.fields.map(field => ({ key: field.id, selector: field.selector,
            type: field.type, autocomplete: field.autocomplete ?? null, kind: 'field' })),
          ...(request.options ?? []).filter(option => option.selector).map(option =>
            ({ key: option.id, selector: option.selector!, type: null, autocomplete: null, kind: 'option' })),
          ...(request.submit ? [{ key: 'submit', selector: request.submit.selector,
            type: null, autocomplete: null, kind: request.submit.action === 'press_enter' ? 'field' : 'submit' }] : []),
        ];
        let frame: Awaited<ReturnType<typeof this.authFrame>>;
        try { frame = await this.authFrame(entry, frames); }
        catch { return { status: 'locator_invalid' }; }
        if (frame.key !== initialFrame.key) return { status: 'page_changed' };
        const expression = `(() => { const doc=${frame.documentExpression}; const view=doc?.defaultView;
          if(!doc||!view||doc.URL!==${JSON.stringify(frame.url)}
            || ${frame.timeOrigin !== undefined ? `view.performance.timeOrigin!==${JSON.stringify(frame.timeOrigin)}` : 'false'})
            throw Error('stale'); const controls=${JSON.stringify(controls)};
          const visible=el => !!el.getClientRects().length && view.getComputedStyle(el).visibility!=='hidden';
          return controls.map(c => { try { const matches=doc.querySelectorAll(c.selector);
            if(matches.length!==1) return c.key;
            const el=matches[0]; if(!el.isConnected || el.disabled || !visible(el)) return c.key;
            if(c.kind==='field' && (!(el instanceof view.HTMLInputElement)
              || (c.type && el.type!==c.type) || (c.autocomplete && el.autocomplete!==c.autocomplete))) return c.key;
            return null; } catch { return c.key; } }).filter(Boolean); })()`;
        try {
          const result = await this.command(entry, 'Runtime.evaluate', { expression, returnByValue: true }, () => {
            if (!stillCurrent()) throw new Error('Browser auth page changed');
            if (frame.children.some(child => entry.cdpSessions.get(child.sessionId) !== child.info
              || child.info.revision !== child.revision || child.info.url !== child.url))
              throw new Error('Browser auth frame changed');
          }, frame.sessionId);
          if (result.exceptionDetails || !Array.isArray(result.result?.value)) return { status: 'locator_invalid' };
          const invalid = result.result.value[0];
          return invalid ? { status: 'locator_invalid', locator_error:
            { field_id: String(invalid), reason: 'not_user_visible' } } : null;
        } catch { return { status: 'page_changed' }; }
      };
      const invalid = await validate();
      if (invalid) return invalid;
      const answer = await collectMissingBrowserAuth(request, collect);
      if (!answer) return { status: 'declined' };
      if ('status' in answer) return answer;
      if (!stillCurrent()) return { status: 'page_changed' };
      const selected = request.options?.find(option => option.id === answer.selected_option);
      if (request.options && !selected) return { status: 'cancelled' };
      const selectedFields = selected?.field_ids
        ? request.fields.filter(field => selected.field_ids!.includes(field.id))
        : selected?.selector ? [] : request.fields;
      const values = selectedFields.flatMap(field => {
        const value = answer.values[field.id];
        if (value === undefined && !field.required) return [];
        if (typeof value !== 'string' || value.length > 4096 || (field.required && !value))
          throw new Error('Invalid secure browser auth input');
        return [{ selector: field.selector, value }];
      });
      const revalidated = await validate();
      if (revalidated) return revalidated;
      if (!stillCurrent()) return { status: 'page_changed' };
      entry.credentialProtected = true;
      entry.credentialRecoveryOrigin = request.origin;
      entry.cdpEvents.clear(); entry.console.length = 0; entry.requests.length = 0;
      let frame: Awaited<ReturnType<typeof this.authFrame>>;
      try { frame = await this.authFrame(entry, frames); }
      catch { return { status: 'page_changed' }; }
      if (frame.key !== initialFrame.key) return { status: 'page_changed' };
      const expression = `(() => { const doc=${frame.documentExpression}; const view=doc?.defaultView;
        if(!doc||!view||doc.URL!==${JSON.stringify(frame.url)}
          || ${frame.timeOrigin !== undefined ? `view.performance.timeOrigin!==${JSON.stringify(frame.timeOrigin)}` : 'false'})
          throw Error('stale'); const values=${JSON.stringify(values)};
        const option=${JSON.stringify(selected?.selector ?? null)};
        const submit=${JSON.stringify(selected?.selector ? null : request.submit ?? null)};
        const get=s => { const matches=doc.querySelectorAll(s); if(matches.length!==1) throw Error('stale');
          const el=matches[0]; if(!el.isConnected || el.disabled || !el.getClientRects().length) throw Error('stale'); return el; };
        if(option){ get(option).click(); return true; }
        for(const field of values){ const el=get(field.selector); if(!(el instanceof view.HTMLInputElement)) throw Error('stale');
          const setter=Object.getOwnPropertyDescriptor(view.HTMLInputElement.prototype,'value').set;
          setter.call(el,field.value); el.dispatchEvent(new view.Event('input',{bubbles:true}));
          el.dispatchEvent(new view.Event('change',{bubbles:true})); }
        if(submit){ const el=get(submit.selector); if(submit.action==='click') el.click();
          else { el.focus(); el.dispatchEvent(new view.KeyboardEvent('keydown',{key:'Enter',code:'Enter',bubbles:true}));
            if(el.form) el.form.requestSubmit(); } }
        return true; })()`;
      try {
        const result = await this.command(entry, 'Runtime.evaluate', { expression, returnByValue: true }, () => {
          if (!stillCurrent()) throw new Error('Browser auth page changed');
          if (frame.children.some(child => entry.cdpSessions.get(child.sessionId) !== child.info
            || child.info.revision !== child.revision || child.info.url !== child.url))
            throw new Error('Browser auth frame changed');
        }, frame.sessionId);
        if (result.exceptionDetails || result.result?.value !== true) return { status: 'submission_failed' };
        return { status: 'submitted', ...(selected ? { selected_option: selected.id } : {}) };
      } catch { return { status: 'submission_failed' }; }
    });
  }

  private active(tabId?: number): Entry {
    const entry = this.entries.get(tabId ?? this.selectedTabId ?? -1);
    if (!entry || entry.guest.isDestroyed() || entry.host.isDestroyed()
      || (tabId !== undefined && entry.guest.id !== tabId)) throw new Error('Embedded browser tab is no longer open');
    origin(entry.guest.getURL());
    return entry;
  }

  /** Resolve the selected in-app tab before any main-process upload approval is shown. */
  uploadOrigin(tabId: number): string {
    const entry = this.active(tabId);
    if (this.selectedTabId !== tabId) {
      throw new Error('Selected in-app browser tab changed');
    }
    return origin(entry.guest.getURL());
  }

  /** Resolve only an attached iframe's identity before main-process site approval. */
  async cdpTarget(tabId: number, target: BrowserCdpTarget): Promise<BrowserCdpTargetApproval> {
    const entry = this.active(tabId);
    const pageOrigin = this.uploadOrigin(tabId);
    if (entry.credentialProtected || entry.protectedActivity || entry.playwrightLease) {
      throw new Error('CDP child target probe is unavailable during a protected browser operation');
    }
    this.ensureCdpOrigin(entry);
    const epoch = entry.cdpEpoch;
    const child = await this.resolveCdpTarget(entry, target);
    if (!child || this.uploadOrigin(tabId) !== pageOrigin || entry.cdpEpoch !== epoch
      || entry.cdpSessions.get(child.sessionId) !== child.info || child.info.revision !== child.revision) {
      throw new Error('CDP child target changed before approval');
    }
    return { sessionId: child.sessionId, targetId: child.info.targetId, url: child.info.url,
      origin: child.origin, revision: child.revision };
  }

  private assertCdpTargetApproval(entry: Entry,
    child: ResolvedCdpTarget,
    approved: BrowserCdpTargetApproval | undefined): void {
    if (!approved || approved.sessionId !== child.sessionId || approved.targetId !== child.info.targetId
      || approved.url !== child.info.url || approved.origin !== child.origin || approved.revision !== child.revision
      || entry.cdpSessions.get(child.sessionId) !== child.info || child.info.revision !== child.revision) {
      throw new Error('CDP child target changed after approval');
    }
  }

  private async command(entry: Entry, method: string, params: Record<string, unknown> = {},
    beforeSend?: () => void, sessionId?: string): Promise<any> {
    if (!entry.attached) {
      entry.guest.debugger.attach('1.3');
      entry.attached = true;
      if (!entry.debuggerListenersInstalled) {
        entry.debuggerListenersInstalled = true;
        entry.guest.debugger.on('detach', () => {
          this.revokePlaywright(entry);
          entry.attached = false; entry.cdpSessions.clear(); entry.cdpEvents.clear();
        });
        entry.guest.debugger.on('message', (_event, name, data: any, sourceSessionId?: string) => {
          try {
            this.ensureCdpOrigin(entry);
            // Idle leases do not forward CDP events. Keep a content-free frame
            // generation for the next action without revoking the active lease.
            if (['Page.frameNavigated', 'Page.frameAttached', 'Page.frameDetached'].includes(name)) {
              entry.frameEpoch++;
            }
            if (name === 'Target.attachedToTarget' && typeof data?.sessionId === 'string'
              && data.targetInfo?.type === 'iframe' && typeof data.targetInfo.targetId === 'string') {
              const childUrl = String(data.targetInfo.url ?? '');
              entry.cdpSessions.set(data.sessionId,
                { targetId: data.targetInfo.targetId, url: childUrl, revision: 0,
                  ...(sourceSessionId ? { parentSessionId: sourceSessionId } : {}) });
            } else if (name === 'Target.detachedFromTarget' && typeof data?.sessionId === 'string') {
              entry.cdpSessions.delete(data.sessionId);
            } else if (name === 'Page.frameNavigated' && sourceSessionId && entry.cdpSessions.has(sourceSessionId)) {
              entry.cdpSessions.get(sourceSessionId)!.revision++;
            } else if (name === 'Target.targetInfoChanged' && typeof data?.targetInfo?.targetId === 'string') {
              for (const session of entry.cdpSessions.values()) {
                if (session.targetId === data.targetInfo.targetId) {
                  const nextUrl = String(data.targetInfo.url ?? '');
                  session.url = nextUrl; session.revision++;
                }
              }
            }
            const child = sourceSessionId ? entry.cdpSessions.get(sourceSessionId) : undefined;
            const eventTarget = data?.targetInfo?.type === 'iframe' ? data.targetInfo : null;
            const safePage = (url: string) => { try { origin(url); return true; } catch { return false; } };
            if ((!eventTarget || safePage(String(eventTarget.url ?? '')))
              && (!sourceSessionId || (child && safePage(child.url)))) {
              if (!entry.credentialProtected && !entry.protectedActivity) {
                entry.cdpEvents.record(name, data, { tabId: entry.guest.id,
                  ...(child ? { sessionId: sourceSessionId, targetId: child.targetId } : {}) });
                const lease = entry.playwrightLease;
                if (lease?.emit && lease.expiresAt > Date.now()) lease.emit({ leaseId: lease.id, method: name,
                  params: data && typeof data === 'object' ? data : {}, ...(child ? { sessionId: sourceSessionId } : {}) });
              }
            }
          } catch { this.revokePlaywright(entry); entry.cdpEvents.clear(); entry.cdpSessions.clear(); entry.cdpOrigin = null; }
          if (entry.credentialProtected || entry.protectedActivity) return;
          if (name === 'Runtime.consoleAPICalled') {
            entry.console.push({ type: String(data.type ?? ''), text: (data.args ?? []).map((arg: any) =>
              String(arg.value ?? arg.description ?? '')).join(' ').slice(0, 1000) });
            if (entry.console.length > 100) entry.console.shift();
          } else if (name === 'Network.requestWillBeSent') {
            entry.requests.push({ method: String(data.request?.method ?? ''), url: String(data.request?.url ?? '') });
            if (entry.requests.length > 100) entry.requests.shift();
          }
        });
      }
      await Promise.all([
        entry.guest.debugger.sendCommand('Page.enable'),
        entry.guest.debugger.sendCommand('Runtime.enable'),
        entry.guest.debugger.sendCommand('Network.enable'),
      ]);
      try {
        await entry.guest.debugger.sendCommand('Target.setAutoAttach', {
          autoAttach: true, flatten: true, waitForDebuggerOnStart: false,
          filter: [{ type: 'iframe', exclude: false }],
        });
      } catch { /* Child targets remain unavailable if this debugger does not support auto-attach. */ }
    }
    beforeSend?.();
    if (method === 'Input.insertText' || method === 'Input.dispatchKeyEvent') {
      assertEmbeddedBrowserInputReceiver(entry.guest, entry.host);
    }
    if (!method.startsWith('Input.')) return sessionId
      ? entry.guest.debugger.sendCommand(method, params, sessionId)
      : entry.guest.debugger.sendCommand(method, params);
    entry.agentInputDepth++;
    try { return sessionId
      ? await entry.guest.debugger.sendCommand(method, params, sessionId)
      : await entry.guest.debugger.sendCommand(method, params); }
    finally { entry.agentInputDepth--; }
  }

  private revokePlaywright(entry: Entry, reason?: 'navigation'): void {
    const lease = entry.playwrightLease;
    entry.playwrightLease = null;
    clearTimeout(lease?.expiryTimer);
    try { lease?.restoreAnimation?.(); } catch { /* A closing guest can no longer be restored. */ }
    // The executor may be waiting for an event, with no command outstanding.
    try { lease?.emit?.({ leaseId: lease.id, method: 'Memmy.executorRevoked', params: reason ? { reason } : {} }); }
    catch { /* The Agent process is gone; its executor is already closed. */ }
  }

  private async playwrightControl(entry: Entry, request: EmbeddedBrowserRequest, upload: ApprovedBrowserUpload | undefined,
    approval: ApprovedBrowserCdpRead | undefined, isCurrent?: () => boolean,
    emitEvent?: EmbeddedExecutorEventSink): Promise<unknown> {
    const args = request.args, id = args.leaseId;
    if (typeof id !== 'string' || !/^[a-f0-9]{32}$/.test(id) || request.tabId !== entry.guest.id) {
      throw new Error('Invalid browser executor lease');
    }
    if (request.command === 'playwrightEnd') {
      if (entry.playwrightLease?.id === id) this.revokePlaywright(entry);
      // Old cleanup cannot detach a replacement owner's debugger or leave the
      // current lease alive. Cleanup remains possible after Stop/navigation.
      if (args.detach === true && entry.playwrightLastLeaseId === id && !entry.playwrightLease) {
        entry.playwrightLastLeaseId = null;
        if (!entry.guest.isDestroyed() && entry.attached) {
          try { entry.guest.debugger.detach(); } catch { /* Guest is already detaching. */ }
          entry.attached = false; entry.cdpSessions.clear(); entry.cdpEvents.clear();
        }
      }
      return { ok: true };
    }
    const current = (lease?: PlaywrightLease) => {
      if (this.entries.get(entry.guest.id) !== entry || entry.guest.isDestroyed() || entry.host.isDestroyed()
        || (isCurrent && !isCurrent()) || !approval?.isCurrentChild() || !approval.isAllowed()) {
        throw new Error('Browser executor was cancelled or its site permission was revoked');
      }
      if (typeof args.approvedOrigin !== 'string' || origin(args.approvedOrigin) !== args.approvedOrigin
        || approval.origin !== args.approvedOrigin || origin(entry.guest.getURL()) !== args.approvedOrigin
        || !entry.allowedOrigins.has(args.approvedOrigin) || entry.pendingNavigation) {
        throw new Error('Browser executor page changed; take a new snapshot');
      }
      if (entry.credentialProtected || entry.protectedActivity || entry.cdpReadDepth || entry.cdpWriteDepth) {
        throw new Error('Browser executor is unavailable during credential protection or raw CDP');
      }
      if (lease && (entry.playwrightLease !== lease || lease.id !== id || lease.origin !== args.approvedOrigin
        || lease.expiresAt <= Date.now() || lease.documentEpoch !== entry.documentEpoch || lease.cdpEpoch !== entry.cdpEpoch)) {
        throw new Error('Browser executor lease expired or page changed; take a new snapshot');
      }
    };
    current();
    if (request.command === 'playwrightStart') {
      if (typeof args.input !== 'boolean' || typeof args.fresh !== 'boolean') throw new Error('Invalid browser executor configuration');
      if (args.input) {
        await this.waitForUserIdle(entry.guest.id, isCurrent ?? approval?.isCurrentChild);
        current(); if (this.userActive(entry)) throw new Error('USER_ACTIVE_ON_TARGET_TAB');
      }
      if (entry.playwrightLease && entry.playwrightLease.id !== id && entry.playwrightLease.expiresAt > Date.now()) {
        throw new Error('Browser executor is already busy');
      }
      let uploadPaths: string[] | undefined;
      if (args.uploadPaths !== undefined) {
        if (!args.input || !Array.isArray(args.uploadPaths) || !args.uploadPaths.length || args.uploadPaths.length > 20
          || args.uploadPaths.some(file => typeof file !== 'string' || !path.isAbsolute(file))
          || !upload || !upload.isCurrentChild() || upload.origin !== args.approvedOrigin
          || upload.stamps.length !== args.uploadPaths.length || args.uploadPaths.some((file, index) => upload.stamps[index]?.path !== file)
          || this.uploadOrigin(entry.guest.id) !== args.approvedOrigin) throw new Error('Browser upload was not approved for this executor action');
        uploadPaths = [...args.uploadPaths] as string[];
      }
      this.ensureCdpOrigin(entry);
      this.revokePlaywright(entry);
      const lease: PlaywrightLease = { id, origin: args.approvedOrigin as string, input: args.input,
        documentEpoch: entry.documentEpoch, cdpEpoch: entry.cdpEpoch, expiresAt: Date.now() + 45_000, targetId: '',
        ...(emitEvent ? { emit: emitEvent } : {}),
        ...(uploadPaths && upload ? { uploadPaths, uploadStamps: upload.stamps.map(stamp => ({ ...stamp })) } : {}) };
      entry.playwrightLease = lease; entry.playwrightLastLeaseId = id;
      try {
        if (lease.input) {
          lease.restoreAnimation = keepEmbeddedBrowserAnimating(entry.guest);
          lease.expiryTimer = setTimeout(() => {
            if (entry.playwrightLease === lease) this.revokePlaywright(entry);
          }, Math.max(0, lease.expiresAt - Date.now()));
          lease.expiryTimer.unref?.();
          await focusEmbeddedBrowserInput(entry.guest, entry.host, () => {
            current(lease);
            if (this.userActive(entry)) throw new Error('USER_ACTIVE_ON_TARGET_TAB');
          });
        }
        const info = await this.command(entry, 'Target.getTargetInfo', {}, () => current(lease));
        if (typeof info.targetInfo?.targetId !== 'string' || !info.targetInfo.targetId) throw new Error('Browser executor target is unavailable');
        lease.targetId = info.targetInfo.targetId;
        const tree = await this.command(entry, 'Page.getFrameTree', {}, () => current(lease));
        if (!tree.frameTree?.frame?.id) throw new Error('Browser executor document is unavailable');
        const childTargets = [...entry.cdpSessions.values()].flatMap(child => {
          try { origin(child.url); return [{ targetId: child.targetId, url: child.url }]; } catch { return []; }
        });
        if (args.fresh) {
          await this.command(entry, 'Runtime.disable', {}, () => current(lease));
          await this.command(entry, 'Target.setAutoAttach', { autoAttach: false, flatten: true,
            waitForDebuggerOnStart: false }, () => current(lease));
        }
        current(lease);
        return { targetInfo: { ...info.targetInfo, type: 'page' }, frameTree: tree.frameTree, childTargets,
          documentEpoch: entry.documentEpoch, cdpEpoch: entry.cdpEpoch, frameEpoch: entry.frameEpoch };
      } catch (error) { if (entry.playwrightLease === lease) this.revokePlaywright(entry); throw error; }
    }
    const lease = entry.playwrightLease;
    if (!lease) throw new Error('Browser executor lease expired; take a new snapshot');
    current(lease);
    const method = typeof args.method === 'string' ? args.method : '';
    if (request.command !== 'playwrightCdp' || (!PLAYWRIGHT_METHODS.has(method) && method !== 'DOM.setFileInputFiles')
      || !args.params || typeof args.params !== 'object' || Array.isArray(args.params)) throw new Error('Browser executor CDP method is unavailable');
    const params = { ...args.params as Record<string, unknown> };
    if (JSON.stringify(params).length > 512_000) throw new Error('Browser executor parameters are too large');
    if (args.sessionId !== undefined && (typeof args.sessionId !== 'string' || !args.sessionId || args.sessionId.length > 200)) {
      throw new Error('Invalid browser executor child session');
    }
    // A metadata round trip here would let this command overtake earlier ones.
    // Child sessions are registered and revised by their own debugger events.
    let child: { sessionId: string; info: CdpSession; revision: number } | undefined;
    if (typeof args.sessionId === 'string') {
      const info = entry.cdpSessions.get(args.sessionId);
      let webChild = false;
      try { webChild = !!info && !!origin(info.url); } catch { /* Non-web child targets stay unavailable. */ }
      if (!info || !webChild) throw new Error('Browser executor frame changed; take a new snapshot');
      child = { sessionId: args.sessionId, info, revision: info.revision };
    }
    if (method === 'Target.getTargetInfo' && params.targetId !== undefined && params.targetId !== lease.targetId
      && ![...entry.cdpSessions.values()].some(session => session.targetId === params.targetId)) {
      throw new Error('Browser executor target is outside this tab');
    }
    if (method === 'Target.setAutoAttach') params.filter = [{ type: 'iframe', exclude: false }];
    const beforeSend = () => {
      current(lease);
      if (child && (entry.cdpSessions.get(child.sessionId) !== child.info || child.info.revision !== child.revision)) {
        throw new Error('Browser executor frame changed; take a new snapshot');
      }
      if (method.startsWith('Input.') || method === 'DOM.setFileInputFiles') {
        if (!lease.input) throw new Error('Browser executor observation cannot send input');
        if (this.userActive(entry)) throw new Error('USER_ACTIVE_ON_TARGET_TAB');
      }
      if (method === 'DOM.setFileInputFiles') {
        if (!lease.uploadPaths || !lease.uploadStamps || JSON.stringify(params.files) !== JSON.stringify(lease.uploadPaths)
          || this.uploadOrigin(entry.guest.id) !== lease.origin) throw new Error('Upload paths are not approved for this executor action');
        for (const stamp of lease.uploadStamps) {
          const stat = lstatSync(stamp.path);
          if (!stat.isFile() || stat.isSymbolicLink() || realpathSync(stamp.path) !== stamp.realPath
            || stat.dev !== stamp.dev || stat.ino !== stamp.ino || stat.size !== stamp.size || stat.mtimeMs !== stamp.mtimeMs) {
            throw new Error('Approved browser upload file changed');
          }
        }
      }
    };
    beforeSend();
    if (method.startsWith('Input.') || method === 'DOM.setFileInputFiles') this.markVisitSource(entry, 'agent');
    const result = await this.command(entry, method, params, beforeSend, child?.sessionId);
    current(lease);
    if (child && (entry.cdpSessions.get(child.sessionId) !== child.info || child.info.revision !== child.revision)) {
      throw new Error('Browser executor frame changed; take a new snapshot');
    }
    return result;
  }

  private async attachedChildMetadata(entry: Entry, sessionId: string, info: CdpSession): Promise<any> {
    const revision = info.revision;
    const current = () => {
      if (this.entries.get(entry.guest.id) !== entry || entry.guest.isDestroyed()
        || entry.cdpSessions.get(sessionId) !== info || info.revision !== revision) {
        throw new Error('CDP child target site changed');
      }
    };
    current();
    // Use the already attached child session to query its own metadata. Native
    // Chrome debugging rejects parent-session queries for a foreign targetId.
    const live = await this.command(entry, 'Target.getTargetInfo', {}, current, sessionId);
    current();
    if (live?.targetInfo?.targetId !== info.targetId || live.targetInfo.type !== 'iframe'
      || !String(live.targetInfo.url ?? '')) throw new Error('CDP child target site changed');
    origin(String(live.targetInfo.url));
    return live;
  }

  private async resolveCdpTarget(entry: Entry, target: BrowserCdpTarget | undefined): Promise<ResolvedCdpTarget | undefined> {
    if (!target) return undefined;
    const found = [...entry.cdpSessions.entries()].find(([sessionId, info]) =>
      'sessionId' in target ? sessionId === target.sessionId : info.targetId === target.targetId);
    if (!found) throw new Error('CDP child target is not attached to this tab');
    const [sessionId, info] = found;
    const live = await this.attachedChildMetadata(entry, sessionId, info);
    if (entry.cdpSessions.get(sessionId) !== info || live?.targetInfo?.targetId !== info.targetId
      || live.targetInfo.type !== 'iframe' || !String(live.targetInfo.url ?? '')) {
      throw new Error('CDP child target site changed');
    }
    const childOrigin = origin(String(live.targetInfo.url));
    info.url = String(live.targetInfo.url);
    return { sessionId, info, revision: info.revision, origin: childOrigin };
  }

  private async fillFields(entry: Entry, input: BrowserAutofillPayload,
    beforeSend?: () => void): Promise<number> {
    return this.withProtectedActivity(entry, async () => {
    if (origin(entry.guest.getURL()) !== input.origin) throw new Error('Autofill site changed');
    if (input.kind === 'credential') {
      entry.credentialProtected = true;
      entry.credentialRecoveryOrigin = input.origin;
    }
    entry.cdpEvents.clear(); entry.console.length = 0; entry.requests.length = 0;
    const documentEpoch = entry.documentEpoch;
    const fields = input.kind === 'credential'
      ? [
          ['input[autocomplete=username], input[type=email], input[name*=user i], input[name*=email i]', input.username],
          ['input[type=password]', input.password],
        ]
      : [
          ['input[autocomplete=name]', input.name],
          ['input[autocomplete=email], input[type=email]', input.email],
          ['input[autocomplete=tel], input[type=tel]', input.phone],
          ['input[autocomplete=street-address]', input.address],
        ];
    const expression = `(() => { if(location.origin!==${JSON.stringify(input.origin)}) throw Error('Autofill site changed'); const fields=${JSON.stringify(fields)}; let count=0; for(const [selector,value] of fields){ if(!value)continue; const input=[...document.querySelectorAll(selector)].find(el=>el.getClientRects().length); if(!input)continue; const setter=Object.getOwnPropertyDescriptor(Object.getPrototypeOf(input),'value')?.set; if(!setter)continue; setter.call(input,String(value)); input.dispatchEvent(new Event('input',{bubbles:true})); input.dispatchEvent(new Event('change',{bubbles:true})); count++; } return count; })()`;
    const response = await this.command(entry, 'Runtime.evaluate', { expression, returnByValue: true }, () => {
      if (entry.documentEpoch !== documentEpoch) throw new Error('Autofill page changed');
      beforeSend?.();
    });
    if (response.exceptionDetails) throw new Error('Autofill failed');
    return Number(response.result?.value || 0);
    });
  }

  private async withProtectedActivity<T>(entry: Entry, work: () => Promise<T>): Promise<T> {
    if (entry.cdpReadDepth || entry.cdpWriteDepth || entry.protectedActivity)
      throw new Error('Browser operation is unavailable during raw CDP or another protected operation');
    this.revokePlaywright(entry);
    entry.protectedActivity++;
    try { return await work(); }
    finally { entry.protectedActivity--; }
  }

  private async withCdpTimeout<T>(work: Promise<T>, timeoutMs: number): Promise<T> {
    let timer: ReturnType<typeof setTimeout> | undefined;
    try { return await Promise.race([work, new Promise<T>((_resolve, reject) => {
      timer = setTimeout(() => reject(new Error('Browser CDP command timed out')), timeoutMs);
    })]); }
    finally { if (timer) clearTimeout(timer); }
  }

  private async withCdpWrite<T>(entry: Entry, work: () => Promise<T>, timeoutMs: number): Promise<T> {
    if (entry.credentialProtected || entry.protectedActivity) {
      throw new Error('Raw CDP is unavailable during browser credential protection, autofill or upload');
    }
    entry.cdpWriteDepth++;
    const ongoing = work().finally(() => { entry.cdpWriteDepth--; });
    return this.withCdpTimeout(ongoing, timeoutMs);
  }

  private async withCdpRead<T>(entry: Entry, work: () => Promise<T>, timeoutMs: number): Promise<T> {
    if (entry.credentialProtected || entry.protectedActivity) {
      throw new Error('Raw CDP is unavailable during browser credential protection or autofill');
    }
    entry.cdpReadDepth++;
    const ongoing = work().finally(() => { entry.cdpReadDepth--; });
    return this.withCdpTimeout(ongoing, timeoutMs);
  }

  private async snapshot(entry: Entry): Promise<Node[]> {
    const { nodes = [] } = await this.command(entry, 'Accessibility.getFullAXTree');
    return nodes.filter((node: any) => !node.ignored).map((node: any) => ({
      ref: node.backendDOMNodeId ? `ax-${node.backendDOMNodeId}` : '',
      role: String(node.role?.value ?? 'generic'),
      name: String(node.name?.value ?? '').slice(0, 300),
      value: node.value?.value == null ? '' : String(node.value.value).slice(0, 300),
    })).filter((node: Node) => node.ref || node.name || node.value).slice(0, 3000);
  }

  private async target(entry: Entry, ref: unknown, beforeSend?: () => void): Promise<string> {
    const value = String(ref ?? '').trim();
    if (!value || value.length > 500) throw new Error('Invalid browser element target');
    const match = /^(?:ax-(\d+)|\[ax-(\d+)\])$/.exec(value);
    const backendNodeId = match ? Number(match[1] ?? match[2]) : undefined;
    if (match && (!Number.isSafeInteger(backendNodeId) || backendNodeId! <= 0)) throw new Error('Invalid browser element reference');
    const nth = /^(.*?)\s*>>\s*nth=(\d+)$/.exec(value);
    const locator = nth ? nth[1]!.trim() : value;
    const index = nth ? Number(nth[2]) : null;
    if (index !== null && (!Number.isSafeInteger(index) || index > 3000)) throw new Error('Invalid browser element index');
    const text = locator.startsWith('text=') ? locator.slice(5) : null;
    const hasText = /^(.*):has-text\(("(?:[^"\\]|\\.)*"|'(?:[^'\\]|\\.)*')\)$/.exec(locator);
    let filterText: string | null = text;
    if (hasText) {
      try { filterText = hasText[2]!.startsWith('"') ? JSON.parse(hasText[2]!) : hasText[2]!.slice(1, -1).replace(/\\'/g, "'"); }
      catch { throw new Error('Invalid browser text locator'); }
    }
    const selector = text !== null ? '*' : hasText ? hasText[1] : locator;
    // Match ordinary CSS, accessibility references, text=, and a terminal
    // :has-text(...) / >> nth=N. Never treat a locator exception as a DOM node.
    const expression = `(() => { const normalize = value => String(value ?? '').replace(/\\s+/g,' ').trim();
      const text = ${JSON.stringify(filterText)}; let found = [...document.querySelectorAll(${JSON.stringify(selector)})];
      if (text !== null) { const wanted = normalize(text); if (!wanted) throw Error('Text locator is empty');
        found = found.filter(el => normalize(el.textContent).includes(wanted));
        ${text !== null ? "found = found.filter(el => !found.some(child => child !== el && el.contains(child)));" : ''}
        found = found.filter(el => { const style=el.ownerDocument.defaultView.getComputedStyle(el);
          return el.getClientRects().length && style.visibility!=='hidden' && style.display!=='none'; }); }
      if (${JSON.stringify(index)} !== null) { if (!found[${JSON.stringify(index)}]) throw Error('Element is no longer available'); return found[${JSON.stringify(index)}]; }
      if (found.length > 1) throw Error('Browser element target is ambiguous; choose an exact reference or nth index');
      return found[0] ?? null; })()`;
    const response = match
      ? await this.command(entry, 'DOM.resolveNode', { backendNodeId }, beforeSend)
      : await this.command(entry, 'Runtime.evaluate', { expression }, beforeSend);
    let object: any;
    try { object = match ? response.object : runtimeResult(response, 'Browser element locator failed'); }
    catch (error) {
      const exceptionObjects = new Set([response.result?.objectId, response.exceptionDetails?.exception?.objectId]);
      for (const objectId of exceptionObjects) if (typeof objectId === 'string')
        await this.command(entry, 'Runtime.releaseObject', { objectId }).catch(() => undefined);
      throw error;
    }
    if (!object?.objectId || (object.subtype && object.subtype !== 'node')) {
      if (object?.objectId) await this.command(entry, 'Runtime.releaseObject', { objectId: object.objectId }).catch(() => undefined);
      throw new Error('Element is no longer available; take a new snapshot');
    }
    return object.objectId;
  }

  private userActive(entry: Entry): boolean {
    return Date.now() - (this.hostInput.get(entry.host)?.lastInputAt ?? 0) < USER_ACTIVE_WINDOW_MS
      || (!entry.guest.isDestroyed() && entry.guest.isFocused()
        && Date.now() - entry.lastUserInputAt < USER_ACTIVE_WINDOW_MS);
  }

  /** Delay a write until a brief user interaction settles; nothing has been sent yet. */
  private async waitForUserIdle(tabId: number | undefined, isCurrent?: () => boolean): Promise<void> {
    const entry = this.entries.get(tabId ?? this.selectedTabId ?? -1);
    if (!entry) return;
    const deadline = Date.now() + USER_IDLE_WAIT_MS;
    while (this.userActive(entry) && Date.now() < deadline) {
      if (isCurrent && !isCurrent()) throw new Error('Browser operation was canceled');
      await new Promise(resolve => setTimeout(resolve, 200));
    }
    if (isCurrent && !isCurrent()) throw new Error('Browser operation was canceled');
  }

  private actionGuard(entry: Entry): () => void {
    const documentEpoch = entry.documentEpoch, url = entry.guest.getURL();
    const checkCurrent = () => {
      if (this.entries.get(entry.guest.id) !== entry || entry.guest.isDestroyed() || entry.host.isDestroyed())
        throw new Error('Embedded browser tab is no longer open');
      if (entry.documentEpoch !== documentEpoch || entry.guest.getURL() !== url || entry.pendingNavigation)
        throw new Error('Browser document changed during the action. Take a new snapshot; input was not replayed.');
      if (entry.credentialProtected || entry.protectedActivity) throw new Error('Browser page control is unavailable during credential protection or a protected operation');
      if (!entry.allowedOrigins.has(origin(entry.guest.getURL()))) throw new Error('This site needs Memmy access approval first');
      if (this.userActive(entry)) throw new Error('USER_ACTIVE_ON_TARGET_TAB');
    };
    checkCurrent();
    return checkCurrent;
  }

  private async clickGeometry(entry: Entry, objectId: string | undefined, checkCurrent: () => void): Promise<ClickGeometry> {
    const metrics = await this.command(entry, 'Page.getLayoutMetrics', {}, checkCurrent);
    const viewport = metrics.cssLayoutViewport ?? metrics.cssVisualViewport;
    const width = viewport?.clientWidth, height = viewport?.clientHeight;
    if (!Number.isFinite(width) || !Number.isFinite(height) || width <= 0 || height <= 0)
      throw new Error('Browser viewport layout is unavailable. Take a new snapshot.');
    const layout = objectId ? await this.command(entry, 'DOM.getContentQuads', { objectId }, checkCurrent) : { quads: [] };
    if (!Array.isArray(layout.quads) || layout.quads.some((quad: unknown) => !Array.isArray(quad)
      || quad.length !== 8 || quad.some(value => typeof value !== 'number' || !Number.isFinite(value))))
      throw new Error('Browser element returned invalid native layout. Take a new snapshot.');
    return { width, height, quads: layout.quads };
  }

  private async assertClickNode(entry: Entry, action: ClickAction): Promise<void> {
    action.checkCurrent();
    if (!action.objectId) return;
    const described = await this.command(entry, 'DOM.describeNode', { objectId: action.objectId }, action.checkCurrent);
    if (described.node?.backendNodeId !== action.backendNodeId || described.node?.nodeType !== 1)
      throw new Error('Browser element changed during the action. Take a new snapshot.');
  }

  private async assertClickHit(entry: Entry, action: ClickAction): Promise<void> {
    const hit = await this.command(entry, 'DOM.getNodeForLocation', {
      x: Math.floor(action.x), y: Math.floor(action.y), includeUserAgentShadowDOM: true,
    }, action.checkCurrent);
    if (hit.backendNodeId === action.backendNodeId) return;
    if (!Number.isSafeInteger(hit.backendNodeId) || hit.backendNodeId <= 0)
      throw new Error('Element has no native hit target at the visible click point. Take a new snapshot.');
    const object = (await this.command(entry, 'DOM.resolveNode', { backendNodeId: hit.backendNodeId }, action.checkCurrent)).object;
    if (!object?.objectId) throw new Error('Browser click hit target changed. Take a new snapshot.');
    try {
      const result = runtimeResult(await this.command(entry, 'Runtime.callFunctionOn', {
        objectId: action.objectId, functionDeclaration: 'function(node){ for(let depth=0; node && depth<64; depth++){ if(this === node || Node.prototype.contains.call(this,node)) return true; node=node.getRootNode()?.host ?? null; } return false; }',
        arguments: [{ objectId: object.objectId }], returnByValue: true,
      }, action.checkCurrent), 'Browser click hit validation failed');
      if (result?.value !== true) throw new Error('Element is covered by another element at the click point. Take a new snapshot.');
    } finally { await this.command(entry, 'Runtime.releaseObject', { objectId: object.objectId }).catch(() => undefined); }
  }

  private async prepareClick(entry: Entry, args: Record<string, unknown>): Promise<ClickAction> {
    const checkCurrent = this.actionGuard(entry);
    if (args.x !== undefined || args.y !== undefined) {
      if (typeof args.x !== 'number' || typeof args.y !== 'number' || !Number.isFinite(args.x) || !Number.isFinite(args.y))
        throw new Error('Browser click requires finite x/y coordinates or an element target');
      const viewport = await this.clickGeometry(entry, undefined, checkCurrent);
      if (args.x < 0 || args.y < 0 || args.x >= viewport.width || args.y >= viewport.height)
        throw new Error('Browser click point is outside the visible viewport');
      return { x: args.x, y: args.y, checkCurrent };
    }
    const objectId = await this.target(entry, args.target ?? args.ref, checkCurrent);
    try {
      const described = await this.command(entry, 'DOM.describeNode', { objectId }, checkCurrent);
      const backendNodeId = described.node?.backendNodeId;
      if (!Number.isSafeInteger(backendNodeId) || backendNodeId <= 0 || described.node?.nodeType !== 1)
        throw new Error('Browser element locator did not resolve to a native DOM node. Take a new snapshot.');
      await this.command(entry, 'DOM.scrollIntoViewIfNeeded', { objectId }, checkCurrent);
      const geometry = await this.clickGeometry(entry, objectId, checkCurrent);
      const action: ClickAction = { ...visibleClickPoint(geometry), objectId, backendNodeId, geometry, checkCurrent };
      await this.assertClickNode(entry, action);
      await this.assertClickHit(entry, action);
      const fresh = await this.clickGeometry(entry, objectId, checkCurrent);
      if (!sameClickGeometry(geometry, fresh)) throw new Error('Browser element layout changed before clicking. Take a new snapshot.');
      await this.assertClickNode(entry, action);
      await this.assertClickHit(entry, action);
      return action;
    } catch (error) {
      await this.command(entry, 'Runtime.releaseObject', { objectId }).catch(() => undefined);
      throw error;
    }
  }

  private async dispatchClick(entry: Entry, args: Record<string, unknown>, action: ClickAction): Promise<Point> {
    const { x, y } = action;
    const button = ['left', 'right', 'middle'].includes(String(args.button)) ? String(args.button) : 'left';
    const modifiers = Array.isArray(args.modifiers) ? args.modifiers.reduce((bits: number, name: string) =>
      bits | (({ Alt: 1, Control: 2, Meta: 4, Shift: 8 } as Record<string, number>)[name] ?? 0), 0) : 0;
    for (let count = 1; count <= (args.doubleClick ? 2 : 1); count++) {
      await this.assertClickNode(entry, action);
      if (action.objectId && action.geometry) {
        const geometry = await this.clickGeometry(entry, action.objectId, action.checkCurrent);
        if (!sameClickGeometry(action.geometry, geometry)) throw new Error('Browser element layout changed before clicking. Take a new snapshot; input was not replayed.');
        await this.assertClickHit(entry, action);
      }
      await this.command(entry, 'Input.dispatchMouseEvent', { type: 'mousePressed', x, y, button, modifiers, clickCount: count }, action.checkCurrent);
      // Release the matching press once, even if that press navigated the page.
      // Never repeat the press after navigation or an uncertain dispatch.
      await this.command(entry, 'Input.dispatchMouseEvent', { type: 'mouseReleased', x, y, button, modifiers, clickCount: count });
    }
    return { x, y };
  }

  private async click(entry: Entry, args: Record<string, unknown>): Promise<Point> {
    const action = await this.prepareClick(entry, args);
    try { return await this.dispatchClick(entry, args, action); }
    finally { if (action.objectId) await this.command(entry, 'Runtime.releaseObject', { objectId: action.objectId }).catch(() => undefined); }
  }

  private async history(entry: Entry, change: number): Promise<{ url: string }> {
    const state = await this.command(entry, 'Page.getNavigationHistory');
    const item = state.entries?.[state.currentIndex + change];
    if (!item) return { url: entry.guest.getURL() };
    if (!entry.allowedOrigins.has(origin(item.url))) throw new Error('This site needs Memmy access approval first');
    await this.command(entry, 'Page.navigateToHistoryEntry', { entryId: item.id });
    return { url: item.url };
  }

  async handle(request: EmbeddedBrowserRequest, approvedUpload?: ApprovedBrowserUpload,
    approvedCdp?: ApprovedBrowserCdpRead, isCurrent?: () => boolean,
    emitEvent?: EmbeddedExecutorEventSink): Promise<unknown> {
    if (request.command === 'playwrightEnd') {
      const entry = this.entries.get(request.tabId ?? -1);
      return entry ? this.playwrightControl(entry, request, approvedUpload, approvedCdp, isCurrent, emitEvent) : { ok: true };
    }
    if (request.command === 'screenshot'
      || ((request.command === 'cdpCall' || request.command === 'playwrightCdp') && request.args.method === 'Page.captureScreenshot')) {
      throw new Error('Screenshots are not supported by the embedded browser. Use a text snapshot instead.');
    }
    if (WRITES.has(request.command)) {
      await this.waitForUserIdle(request.tabId,
        approvedUpload?.isCurrentChild ?? approvedCdp?.isCurrentChild ?? isCurrent);
    }
    const protectedEntry = this.entries.get(request.tabId ?? this.selectedTabId ?? -1);
    if (protectedEntry?.credentialProtected) {
      const target = request.command === 'navigate' ? String(request.args.url ?? '') : '';
      let sameOrigin = false;
      try { sameOrigin = origin(request.command === 'allowOrigin'
        ? String(request.args.origin ?? '') : target) === protectedEntry.credentialRecoveryOrigin; }
      catch { /* Invalid or missing navigation target. */ }
      if (!sameOrigin || !['navigate', 'allowOrigin'].includes(request.command)
        || request.tabId !== protectedEntry.guest.id) {
        throw new Error('credential protection permits only explicit navigation to the current site');
      }
    }
    if (request.command === 'listTabs') {
      return { browserId: this.browserId, selectedTabId: this.selectedTabId, tabs: [...this.entries.values()].flatMap(entry => {
        if (entry.guest.isDestroyed() || entry.host.isDestroyed()) return [];
        if (entry.guest.getURL() !== 'about:blank') {
          try { origin(entry.guest.getURL()); }
          catch { return []; }
        }
        if (entry.guest.getURL().length > 4096 || entry.guest.getTitle().length > 4096) return [];
        return [{ tabId: entry.guest.id, title: entry.guest.getTitle(), url: entry.guest.getURL(),
          everSelected: entry.everSelected }];
      }) };
    }
    if (request.command === 'closeTab') {
      const entry = this.entries.get(request.tabId ?? -1);
      if (!entry || entry.guest.isDestroyed() || entry.host.isDestroyed()) return { closed: true };
      entry.host.webContents.send('memmy:browser:close-tab', entry.guest.id);
      const deadline = Date.now() + 5_000;
      while (Date.now() < deadline && !entry.guest.isDestroyed()) {
        await new Promise(resolve => setTimeout(resolve, 50));
      }
      if (!entry.guest.isDestroyed()) {
        entry.guest.close();
        await new Promise(resolve => setTimeout(resolve, 100));
      }
      if (!entry.guest.isDestroyed()) throw new Error('Memmy browser tab did not close');
      return { closed: true };
    }
    if (request.command === 'openTab') {
      const scopeKey = request.args.scopeKey;
      if (typeof scopeKey !== 'string' || !scopeKey.trim() || scopeKey.length > 512
        || /[\u0000-\u001f\u007f]/.test(scopeKey)) throw new Error('Browser tab owner is required');
      const target = new URL(String(request.args.url ?? ''));
      origin(target.href);
      const host = this.getHost();
      if (!host || host.isDestroyed()) throw new Error('Memmy browser window is not available');
      const existingIds = new Set(this.entries.keys());
      const assertCurrent = () => {
        if (isCurrent && !isCurrent()) throw new Error('Browser tab opening was canceled');
        if (host.isDestroyed()) throw new Error('Memmy browser window is not available');
      };
      assertCurrent();
      host.webContents.send('memmy:browser:open-url', target.href, { scopeKey });
      const deadline = Date.now() + 20_000;
      let opened: Entry | undefined;
      try {
        while (Date.now() < deadline) {
          if (!opened) {
            opened = [...this.entries.values()].find(candidate => !existingIds.has(candidate.guest.id)
              && !candidate.guest.isDestroyed() && candidate.host === host
              && candidate.initialNavigationUrl === target.href);
          }
          assertCurrent();
          const entry = opened;
          if (entry && (entry.guest.isDestroyed() || this.entries.get(entry.guest.id) !== entry)) {
            throw new Error('Memmy browser tab closed while opening');
          }
          const navigation = entry?.navigation;
          if (navigation?.state === 'failed') throw navigation.error ?? new Error('Memmy browser navigation failed');
          if (entry && navigation?.state === 'complete') {
            assertCurrent();
            entry.allowedOrigins.add(target.origin);
            this.markVisitSource(entry, 'agent');
            try {
              if (entry.lastRecordedUrl === entry.guest.getURL()) {
                this.historyStore?.reviseLatestVisit(String(entry.guest.id), entry.guest.getURL(),
                  entry.guest.getTitle(), 'agent');
              } else {
                this.historyStore?.recordVisit(String(entry.guest.id), entry.guest.getURL(), entry.guest.getTitle(),
                  Date.now(), 'agent');
              }
            } catch { /* History disk errors cannot interrupt browser control. */ }
            entry.lastRecordedUrl = entry.guest.getURL();
            entry.lastRecordedAt = Date.now();
            entry.lastRecordedSource = 'agent';
            entry.pendingNavigation = false;
            return { tabId: entry.guest.id, title: entry.guest.getTitle(), url: entry.guest.getURL() };
          }
          await new Promise(resolve => setTimeout(resolve, 100));
        }
        assertCurrent();
        throw new Error('Memmy browser tab did not finish loading within 20 seconds');
      } catch (error) {
        // No tab identity has reached the Agent yet, so it cannot clean up an
        // unsuccessful open. Close only the new guest this request matched.
        if (opened && this.entries.get(opened.guest.id) === opened && !opened.guest.isDestroyed()) {
          try {
            if (!host.isDestroyed()) host.webContents.send('memmy:browser:close-tab', opened.guest.id);
            if (!opened.guest.isDestroyed()) opened.guest.close();
          } catch { /* Preserve the actual navigation/cancellation error. */ }
        }
        throw error;
      }
    }
    if (request.command === 'probe') {
      try {
        const entry = this.active();
        if (entry.allowedOrigins.size === 0) entry.allowedOrigins.add(origin(entry.guest.getURL()));
        return { tabId: entry.guest.id, title: entry.guest.getTitle().slice(0, 256),
          url: entry.guest.getURL().slice(0, 4096) };
      } catch { return null; }
    }
    const entry = this.active(request.tabId);
    const args = request.args;
    if (entry.protectedActivity && request.command !== 'navigate') {
      throw new Error('Browser page control is unavailable during a protected browser operation');
    }
    if (entry.credentialProtected && OBSERVES_PAGE.has(request.command)) {
      throw new Error('Browser page observation is unavailable during credential protection');
    }
    if (request.command === 'upload' && (!request.tabId || !approvedUpload
      || !approvedUpload.isCurrentChild()
      || this.uploadOrigin(request.tabId) !== approvedUpload.origin)) {
      throw new Error('Browser upload was not approved for this tab and site');
    }
    if ((request.command === 'cdpCall' || request.command === 'cdpEvents' || request.command === 'cdpWrite')
      && (!request.tabId || !approvedCdp || !approvedCdp.isCurrentChild()
        || !approvedCdp.isAllowed() || this.uploadOrigin(request.tabId) !== approvedCdp.origin
        || (request.command === 'cdpWrite' && approvedCdp.mode !== 'write'))) {
      throw new Error('Browser CDP operation was not approved for this tab and site');
    }
    if (WRITES.has(request.command) && this.userActive(entry)) {
      throw new Error('USER_ACTIVE_ON_TARGET_TAB');
    }
    if (request.command !== 'allowOrigin' && request.command !== 'open'
      && !entry.allowedOrigins.has(origin(entry.guest.getURL()))) {
      throw new Error('This site needs Memmy access approval first');
    }
    if (NAVIGATION_ACTIONS.has(request.command)) this.markVisitSource(entry, 'agent');
    if (request.command.startsWith('playwright')) return this.playwrightControl(entry, request, approvedUpload, approvedCdp, isCurrent, emitEvent);
    if (entry.playwrightLease && ['cdpCall', 'cdpWrite', 'cdpEvents', 'upload', 'authRequest', 'fillCredential', 'fillContact'].includes(request.command)) {
      throw new Error('Browser operation cannot overlap the current browser executor lease');
    }
    switch (request.command) {
      case 'allowOrigin': {
        const allowed = origin(String(args.origin ?? ''));
        entry.allowedOrigins.add(allowed);
        return { origin: allowed };
      }
      case 'snapshot': {
        if (args.boxes) throw new Error('Embedded browser snapshot boxes are not supported. Use element references; clicks obtain native DOM layout directly.');
        return { nodes: await this.snapshot(entry), tab: { id: entry.guest.id,
          title: entry.guest.getTitle(), url: entry.guest.getURL() } };
      }
      case 'find': {
        const nodes = await this.snapshot(entry);
        const text = String(args.text ?? '').toLowerCase();
        const pattern = args.regex ? new RegExp(String(args.regex).slice(0, 250)) : null;
        return { nodes: nodes.filter(node => {
          const line = `${node.role} ${node.name} ${node.value}`;
          return pattern ? pattern.test(line) : line.toLowerCase().includes(text);
        }) };
      }
      case 'navigate': {
        const url = new URL(String(args.url ?? ''));
        if (!entry.allowedOrigins.has(origin(url.href))) throw new Error('This site needs Memmy access approval first');
        if (entry.credentialProtected) entry.recoveryNavigationPending = true;
        try { await entry.guest.loadURL(url.href); }
        catch (error) { entry.recoveryNavigationPending = false; throw error; }
        return { url: entry.guest.getURL() };
      }
      case 'back': return this.history(entry, -1);
      case 'forward': return this.history(entry, 1);
      case 'reload': await this.command(entry, 'Page.reload'); return { ok: true };
      case 'click': return this.click(entry, args);
      case 'type': {
        const text = String(args.text ?? '');
        if (text.length > 100_000) throw new Error('Text is too long');
        const action = await this.prepareClick(entry, args);
        try {
          if (!action.objectId) throw new Error('Browser typing requires an exact editable element target');
          const editable = runtimeResult(await this.command(entry, 'Runtime.callFunctionOn', { objectId: action.objectId,
            functionDeclaration: "function(){ return this.isConnected && !this.disabled && !this.readOnly && (this.tagName==='TEXTAREA' || (this.tagName==='INPUT' && !['button','submit','reset','checkbox','radio','file','image','hidden','range','color'].includes(this.type)) || this.isContentEditable); }",
            returnByValue: true }, action.checkCurrent), 'Browser editable target validation failed');
          if (editable?.value !== true) throw new Error('Element is not editable, is disabled, or is read-only; no input was sent.');
          await focusEmbeddedBrowserInput(entry.guest, entry.host, action.checkCurrent);
          await this.dispatchClick(entry, args, action);
          await this.assertClickNode(entry, action);
          const selected = runtimeResult(await this.command(entry, 'Runtime.callFunctionOn', { objectId: action.objectId,
            functionDeclaration: "function(){ if(!this.isConnected) throw Error('Element is no longer available'); if(this.disabled || this.readOnly) throw Error('Element is not editable'); if(typeof this.select==='function'){this.focus();this.select();return true;} if(this.isContentEditable){this.focus();const r=this.ownerDocument.createRange();r.selectNodeContents(this);const s=this.ownerDocument.defaultView.getSelection();s.removeAllRanges();s.addRange(r);return true;} throw Error('Element is not editable'); }",
            returnByValue: true }, action.checkCurrent), 'Browser editable target failed');
          if (selected?.value !== true) throw new Error('Browser editable target could not be verified. Take a new snapshot.');
          const assertTextReceiver = async () => {
            await this.assertClickNode(entry, action);
            const focused = runtimeResult(await this.command(entry, 'Runtime.callFunctionOn', { objectId: action.objectId,
              functionDeclaration: 'function(){ if(!this.isConnected || this.disabled || this.readOnly) return false; let node=this; for(let depth=0; depth<64; depth++){ const root=node.getRootNode(); if(root.activeElement !== node) return false; if(!root.host) return root === this.ownerDocument; node=root.host; } return false; }',
              returnByValue: true }, action.checkCurrent), 'Browser text receiver validation failed');
            if (focused?.value !== true) throw new Error('Browser text receiver changed; no further text was sent. Take a new snapshot.');
          };
          const insert = async (value: string) => {
            await assertTextReceiver();
            await this.command(entry, 'Input.insertText', { text: value }, action.checkCurrent);
          };
          if (args.slowly) for (const character of text) await insert(character);
          else await insert(text);
          if (args.submit) { await assertTextReceiver(); await this.pressKey(entry, 'Enter', action.checkCurrent); }
          return { ok: true };
        } finally {
          if (action.objectId) await this.command(entry, 'Runtime.releaseObject', { objectId: action.objectId }).catch(() => undefined);
        }
      }
      case 'selectOption': {
        const checkCurrent = this.actionGuard(entry);
        const objectId = await this.target(entry, args.target ?? args.ref, checkCurrent);
        const values = Array.isArray(args.values) ? args.values.map(String) : [String(args.value ?? '')];
        try {
          const result = runtimeResult(await this.command(entry, 'Runtime.callFunctionOn', { objectId,
            functionDeclaration: "function(values){ if(!this.isConnected || this.disabled || this.matches(':disabled') || this.tagName!=='SELECT') throw Error('Target is not an enabled select'); if(!values.length || (!this.multiple && values.length>1)) throw Error('Invalid select option values'); const options=[...this.options]; if(values.some(value => !options.some(option => option.value===value && !option.disabled && !option.matches(':disabled')))) throw Error('Requested select option is unavailable'); for(const option of options) option.selected=values.includes(option.value); this.dispatchEvent(new Event('input',{bubbles:true})); this.dispatchEvent(new Event('change',{bubbles:true})); return this.value; }",
            arguments: [{ value: values }], returnByValue: true, awaitPromise: true }, checkCurrent), 'Browser select option failed');
          if (typeof result?.value !== 'string') throw new Error('Browser select option returned no verified result. Take a new snapshot.');
          return { value: result.value };
        } finally { await this.command(entry, 'Runtime.releaseObject', { objectId }).catch(() => undefined); }
      }
      case 'pressKey': {
        const checkCurrent = this.actionGuard(entry);
        await focusEmbeddedBrowserInput(entry.guest, entry.host, checkCurrent);
        await this.pressKey(entry, String(args.key ?? ''), checkCurrent);
        return { ok: true };
      }
      case 'scroll': await this.command(entry, 'Input.dispatchMouseEvent', { type: 'mouseWheel',
        x: Number(args.x) || 300, y: Number(args.y) || 300,
        deltaX: Number(args.deltaX) || 0, deltaY: Number(args.deltaY) || 0 }); return { ok: true };
      case 'waitFor': {
        const timeout = Math.max(0, Math.min(25_000, (Number(args.time) || 0) * 1000));
        if (!args.text && !args.textGone) {
          if (timeout) await new Promise(resolve => setTimeout(resolve, timeout));
          return { ok: true };
        }
        const deadline = Date.now() + (timeout || 5000);
        while (true) {
          const text = (await this.snapshot(entry)).map(node => `${node.name} ${node.value}`).join('\n');
          if ((!args.text || text.includes(String(args.text))) && (!args.textGone || !text.includes(String(args.textGone)))) break;
          if (Date.now() >= deadline) throw new Error('Wait condition was not met');
          await new Promise(resolve => setTimeout(resolve, 150));
        }
        return { ok: true };
      }
      case 'consoleMessages': return { messages: entry.console };
      case 'networkRequests': return { requests: entry.requests };
      case 'viewport': {
        const metrics = await this.command(entry, 'Page.getLayoutMetrics');
        return { width: metrics.cssVisualViewport?.clientWidth || metrics.cssLayoutViewport?.clientWidth,
          height: metrics.cssVisualViewport?.clientHeight || metrics.cssLayoutViewport?.clientHeight };
      }
      case 'historyState': {
        const state = await this.command(entry, 'Page.getNavigationHistory');
        const current = Number(state.currentIndex || 0);
        return { canGoBack: current > 0, canGoForward: current + 1 < (state.entries || []).length };
      }
      case 'resize': {
        const width = Number(args.width), height = Number(args.height);
        if (!Number.isInteger(width) || !Number.isInteger(height)
          || width < 320 || height < 240 || width > 4096 || height > 4096) throw new Error('Invalid viewport');
        await this.command(entry, 'Emulation.setDeviceMetricsOverride', { width, height, deviceScaleFactor: 1, mobile: false });
        return { width, height };
      }
      case 'fillCredential':
      case 'fillContact': {
        const input = request.command === 'fillCredential'
          ? { kind: 'credential' as const, origin: String(args.origin ?? ''),
              username: String(args.username ?? ''), password: String(args.password ?? '') }
          : { kind: 'contact' as const, origin: String(args.origin ?? ''),
              name: String(args.name ?? ''), email: String(args.email ?? ''),
              phone: String(args.phone ?? ''), address: String(args.address ?? '') };
        return { fieldsFilled: await this.fillFields(entry, input) };
      }
      case 'upload': {
        return this.withProtectedActivity(entry, async () => {
        const files = args.paths;
        if (!Array.isArray(files) || files.length < 1 || files.length > 20
          || files.some(file => typeof file !== 'string' || file.length > 4096
            || !path.isAbsolute(file)) || approvedUpload?.stamps.length !== files.length
          || files.some((file, index) => approvedUpload.stamps[index]?.path !== file)) {
          throw new Error('Invalid browser upload paths');
        }
        const target = args.target ?? args.ref;
        if (typeof target !== 'string' || !target || target.length > 500) {
          throw new Error('Browser upload requires a file input target');
        }
        const objectId = await this.target(entry, target);
        const checked = await this.command(entry, 'Runtime.callFunctionOn', { objectId,
          functionDeclaration: "function(){ return this instanceof HTMLInputElement && this.type === 'file' && this.isConnected; }",
          returnByValue: true });
        if (checked.exceptionDetails || checked.result?.value !== true) throw new Error('Target is not a file input');
        const beforeSend = () => {
          if (!approvedUpload.isCurrentChild()) throw new Error('Browser upload request is no longer active');
          if (this.uploadOrigin(request.tabId!) !== approvedUpload.origin) {
            throw new Error('Browser upload site changed after approval');
          }
          for (const stamp of approvedUpload.stamps) {
            const info = lstatSync(stamp.path);
            if (!info.isFile() || info.isSymbolicLink() || realpathSync(stamp.path) !== stamp.realPath
              || info.dev !== stamp.dev || info.ino !== stamp.ino
              || info.size !== stamp.size || info.mtimeMs !== stamp.mtimeMs) {
              throw new Error('Browser upload file changed after approval');
            }
          }
        };
        await this.command(entry, 'DOM.setFileInputFiles', { files, objectId }, beforeSend);
        return { uploaded: files.length };
        });
      }
      case 'cdpCall':
      case 'cdpWrite': {
        const call = request.command === 'cdpWrite'
          ? normalizeBrowserCdpWriteCall(args.method, args.params ?? {})
          : normalizeBrowserCdpReadCall(args.method, args.params ?? {});
        const { target, timeoutMs } = normalizeBrowserCdpCommandOptions(args);
        const commandTimeout = timeoutMs ?? 3_000;
        const run = async () => {
        this.ensureCdpOrigin(entry);
        const approvedEpoch = entry.cdpEpoch;
        if (!entry.attached) await this.command(entry, 'Page.enable');
        const child = await this.resolveCdpTarget(entry, target);
        if (child) this.assertCdpTargetApproval(entry, child, approvedCdp!.target);
        const sessionId = child?.sessionId;
        const result = await this.command(entry, call.method, call.params, () => {
          if (!approvedCdp!.isCurrentChild() || !approvedCdp!.isAllowed()
            || this.uploadOrigin(request.tabId!) !== approvedCdp!.origin
            || entry.cdpEpoch !== approvedEpoch) {
            throw new Error('Browser CDP operation is no longer approved');
          }
          if (child && (entry.cdpSessions.get(child.sessionId) !== child.info
            || child.info.revision !== child.revision || origin(child.info.url) !== child.origin)) {
            throw new Error('CDP child target changed');
          }
        }, sessionId);
        if (child) {
          const live = await this.attachedChildMetadata(entry, child.sessionId, child.info);
          if (entry.cdpSessions.get(child.sessionId) !== child.info
            || child.info.revision !== child.revision
            || live?.targetInfo?.targetId !== child.info.targetId
            || String(live.targetInfo.url ?? '') !== approvedCdp!.target?.url
            || origin(String(live.targetInfo.url ?? '')) !== child.origin) {
            throw new Error('CDP child target site changed while reading');
          }
        }
        if (!approvedCdp!.isCurrentChild() || !approvedCdp!.isAllowed()
          || this.uploadOrigin(request.tabId!) !== approvedCdp!.origin
          || entry.cdpEpoch !== approvedEpoch
          || (child && (entry.cdpSessions.get(child.sessionId) !== child.info
            || child.info.revision !== child.revision))) {
          throw new Error('Browser CDP site changed while reading');
        }
        return result;
        };
        return request.command === 'cdpWrite'
          ? this.withCdpWrite(entry, run, commandTimeout)
          : this.withCdpRead(entry, run, commandTimeout);
      }
      case 'cdpEvents': {
        this.ensureCdpOrigin(entry);
        const approvedEpoch = entry.cdpEpoch;
        if (!entry.attached) await this.command(entry, 'Page.enable');
        const { target } = normalizeBrowserCdpCommandOptions(args);
        const child = await this.resolveCdpTarget(entry, target);
        if (child) this.assertCdpTargetApproval(entry, child, approvedCdp!.target);
        const targetStillApproved = () => !child || (entry.cdpSessions.get(child.sessionId) === child.info
          && child.info.revision === child.revision && child.info.url === approvedCdp!.target?.url);
        if (!approvedCdp!.isCurrentChild() || !approvedCdp!.isAllowed()
          || this.uploadOrigin(request.tabId!) !== approvedCdp!.origin
          || entry.cdpEpoch !== approvedEpoch || !targetStillApproved()) {
          throw new Error('Browser CDP events are no longer approved');
        }
        const { approvedOrigin: _approvedOrigin, ...query } = args;
        const result = await entry.cdpEvents.wait(query, () => !entry.credentialProtected && !entry.protectedActivity
          && approvedCdp!.isCurrentChild()
          && approvedCdp!.isAllowed() && this.uploadOrigin(request.tabId!) === approvedCdp!.origin
          && entry.cdpEpoch === approvedEpoch && targetStillApproved());
        if (entry.credentialProtected || entry.protectedActivity
          || !approvedCdp!.isCurrentChild() || !approvedCdp!.isAllowed()
          || this.uploadOrigin(request.tabId!) !== approvedCdp!.origin || entry.cdpEpoch !== approvedEpoch
          || !targetStillApproved()) {
          throw new Error('Browser CDP events are no longer approved');
        }
        return result;
      }
      case 'open': entry.host.show(); entry.guest.focus(); return { ok: true };
      default: throw new Error('Unsupported embedded browser command');
    }
  }

  private async pressKey(entry: Entry, value: string, beforeSend?: () => void): Promise<void> {
    if (!value || value.length > 50) throw new Error('Invalid key');
    const parts = value.split('+');
    const actual = parts.pop()!;
    const modifiers: Record<string, { key: string; code: string; flag: number; virtualKeyCode: number }> = {
      Alt: { key: 'Alt', code: 'AltLeft', flag: 1, virtualKeyCode: 18 },
      Control: { key: 'Control', code: 'ControlLeft', flag: 2, virtualKeyCode: 17 },
      Meta: { key: 'Meta', code: 'MetaLeft', flag: 4, virtualKeyCode: 91 },
      Shift: { key: 'Shift', code: 'ShiftLeft', flag: 8, virtualKeyCode: 16 },
    };
    const aliases: Record<string, string> = { Ctrl: 'Control', Command: 'Meta',
      ControlOrMeta: process.platform === 'darwin' ? 'Meta' : 'Control' };
    const held = parts.map(part => modifiers[aliases[part] ?? part]);
    if (held.some(item => !item)) throw new Error('Unsupported modifier key');
    const validHeld = held as Array<NonNullable<typeof held[number]>>;
    let bits = 0;
    for (const item of validHeld) {
      bits |= item.flag;
      await this.command(entry, 'Input.dispatchKeyEvent', { type: 'keyDown',
        key: item.key, code: item.code, modifiers: bits,
        windowsVirtualKeyCode: item.virtualKeyCode, nativeVirtualKeyCode: item.virtualKeyCode }, beforeSend);
    }
    const event = keyEvent(actual, bits);
    if ((bits & 6) && event.code === 'KeyA') event.commands = ['SelectAll'];
    await this.command(entry, 'Input.dispatchKeyEvent', { type: 'keyDown', ...event }, beforeSend);
    await this.command(entry, 'Input.dispatchKeyEvent', { type: 'keyUp', ...event, text: '', unmodifiedText: '' });
    for (const item of validHeld.reverse()) {
      bits &= ~item.flag;
      await this.command(entry, 'Input.dispatchKeyEvent', { type: 'keyUp',
        key: item.key, code: item.code, modifiers: bits,
        windowsVirtualKeyCode: item.virtualKeyCode, nativeVirtualKeyCode: item.virtualKeyCode });
    }
  }

  dispose(): void {
    for (const entry of this.entries.values()) {
      this.revokePlaywright(entry);
      if (!entry.guest.isDestroyed() && entry.attached) {
        try { entry.guest.debugger.detach(); } catch { /* Guest may be closing. */ }
      }
    }
    this.entries.clear();
    for (const host of this.hostInput.values()) host.dispose();
    this.hostInput.clear();
    this.selectedTabId = null;
  }
}
