import { randomUUID } from 'node:crypto';
import { lstatSync, realpathSync } from 'node:fs';
import path from 'node:path';
import type { BrowserWindow, Session, WebContents } from 'electron';
import { formatEmbeddedBrowserTabMention, normalizeBrowserCdpReadCall, normalizeBrowserCdpWriteCall,
  normalizeBrowserCdpCommandOptions, type BrowserCdpTarget,
  type EmbeddedBrowserCommand, type EmbeddedBrowserRequest } from '@memmy/local-api-contracts';
import type { BrowserHistoryStore, BrowserVisitSource } from './browser-history-store.js';
import { BrowserCdpEventBuffer } from './browser-cdp-event-buffer.js';
import { parseBrowserAuthRequest, type BrowserAuthRequest, type BrowserAuthResult } from './browser-auth-request.js';
import type { BrowserAuthFormResult } from './browser-auth-form.js';

type Node = { ref: string; role: string; name: string; value: string };
type CdpSession = { targetId: string; url: string; revision: number; parentSessionId?: string };
type Entry = { guest: WebContents; host: BrowserWindow; allowedOrigins: Set<string>;
  console: Array<{ type: string; text: string }>; requests: Array<{ method: string; url: string }>;
  cdpEvents: BrowserCdpEventBuffer;
  cdpSessions: Map<string, CdpSession>;
  cdpOrigin: string | null;
  cdpEpoch: number;
  protectedActivity: number; cdpReadDepth: number; cdpWriteDepth: number;
  credentialProtected: boolean; credentialRecoveryOrigin: string | null;
  recoveryNavigationPending: boolean; documentEpoch: number;
  attached: boolean; lastUserInputAt: number; agentInputDepth: number; lastStartedUrl: string;
  visitSource: BrowserVisitSource; visitSourceUntil: number; visitSourceMarkedAt: number;
  lastRecordedUrl: string; lastRecordedAt: number; lastRecordedSource: BrowserVisitSource;
  pendingNavigation: boolean };

export type ApprovedBrowserUpload = { origin: string; stamps: Array<{
  path: string; realPath: string; dev: number; ino: number; size: number; mtimeMs: number;
}>; isCurrentChild: () => boolean };

export type ApprovedBrowserCdpRead = { origin: string; isCurrentChild: () => boolean;
  isAllowed: () => boolean; mode?: 'read' | 'write' };

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
  'snapshot', 'find', 'screenshot', 'consoleMessages', 'networkRequests',
  'cdpCall', 'cdpEvents', 'cdpWrite',
]);
const NAVIGATION_ACTIONS = new Set<EmbeddedBrowserCommand>([
  'navigate', 'back', 'forward', 'reload', 'click', 'type', 'selectOption', 'pressKey', 'fillCredential', 'fillContact',
]);

function origin(value: string): string {
  const url = new URL(value);
  if (url.protocol !== 'http:' && url.protocol !== 'https:') throw new Error('Only HTTP(S) pages can be controlled');
  return url.origin;
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
  private selectedTabId: number | null = null;
  private historyStore: BrowserHistoryStore | null = null;

  constructor(private readonly getHost: () => BrowserWindow | null = () => null) {}

  setHistoryStore(store: BrowserHistoryStore): void { this.historyStore = store; }

  attach(guest: WebContents, host: BrowserWindow): void {
    const entry: Entry = { guest, host, allowedOrigins: new Set(), console: [], requests: [],
      cdpEvents: new BrowserCdpEventBuffer(), cdpSessions: new Map(), cdpOrigin: null, cdpEpoch: 0,
      protectedActivity: 0, cdpReadDepth: 0, cdpWriteDepth: 0, credentialProtected: false,
      credentialRecoveryOrigin: null, recoveryNavigationPending: false,
      documentEpoch: 0,
      attached: false, lastUserInputAt: 0, agentInputDepth: 0, lastStartedUrl: '',
      visitSource: 'other', visitSourceUntil: 0, visitSourceMarkedAt: 0,
      lastRecordedUrl: '', lastRecordedAt: 0, lastRecordedSource: 'other', pendingNavigation: false };
    this.entries.set(guest.id, entry);
    this.selectedTabId = guest.id;
    guest.on('did-start-navigation', details => {
      if (details.isMainFrame) {
        try { this.ensureCdpOrigin(entry, origin(details.url)); }
        catch { entry.cdpEvents.clear(); entry.cdpOrigin = null; entry.cdpEpoch++; }
        entry.lastStartedUrl = details.url;
        entry.pendingNavigation = true;
      }
    });
    guest.on('before-input-event', () => {
      if (!entry.agentInputDepth) {
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
    guest.on('did-stop-loading', recordNavigation);
    guest.on('did-navigate', () => {
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
      entry.pendingNavigation = true;
      recordNavigation();
    });
    guest.on('page-title-updated', () => {
      try { this.historyStore?.reviseLatestVisit(String(guest.id), guest.getURL(), guest.getTitle()); }
      catch { /* A history title update must not interrupt the browser. */ }
    });
    guest.once('destroyed', () => {
      this.historyStore?.finishSession(String(guest.id));
      if (this.entries.get(guest.id) !== entry) return;
      this.entries.delete(guest.id);
      if (this.selectedTabId === guest.id) this.selectedTabId = [...this.entries.keys()].at(-1) ?? null;
    });
  }

  private markVisitSource(entry: Entry, source: BrowserVisitSource): void {
    entry.visitSource = source;
    entry.visitSourceMarkedAt = Date.now();
    entry.visitSourceUntil = Date.now() + 10_000;
  }

  private ensureCdpOrigin(entry: Entry, current: string = origin(entry.guest.getURL())): void {
    if (entry.cdpOrigin !== current) {
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

  selectTab(tabId: number, host: BrowserWindow): void {
    const entry = this.entries.get(tabId);
    if (!entry || entry.host !== host || entry.guest.isDestroyed()) throw new Error('Browser tab is unavailable');
    this.selectedTabId = tabId;
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
        const live = await this.command(entry, 'Target.getTargetInfo',
          { targetId: info.targetId }, undefined, sessionId);
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
      const answer = await collect(request);
      if (!answer) return { status: 'declined' };
      if ('status' in answer) return answer;
      if (!stillCurrent()) return { status: 'page_changed' };
      const selected = request.options?.find(option => option.id === answer.selected_option);
      if (request.options && !selected) return { status: 'cancelled' };
      const selectedFields = selected?.field_ids
        ? request.fields.filter(field => selected.field_ids!.includes(field.id))
        : selected?.selector ? [] : request.fields;
      const values = selectedFields.map(field => {
        const value = answer.values[field.id];
        if (typeof value !== 'string' || value.length > 4096 || (field.required && !value))
          throw new Error('Invalid secure browser auth input');
        return { selector: field.selector, value };
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

  private async command(entry: Entry, method: string, params: Record<string, unknown> = {},
    beforeSend?: () => void, sessionId?: string): Promise<any> {
    if (!entry.attached) {
      entry.guest.debugger.attach('1.3');
      entry.attached = true;
      entry.guest.debugger.on('detach', () => {
        entry.attached = false; entry.cdpSessions.clear(); entry.cdpEvents.clear();
      });
      entry.guest.debugger.on('message', (_event, name, data: any, sourceSessionId?: string) => {
        try {
          this.ensureCdpOrigin(entry);
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
            }
          }
        } catch { entry.cdpEvents.clear(); entry.cdpSessions.clear(); entry.cdpOrigin = null; }
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
    if (!method.startsWith('Input.')) return sessionId
      ? entry.guest.debugger.sendCommand(method, params, sessionId)
      : entry.guest.debugger.sendCommand(method, params);
    entry.agentInputDepth++;
    try { return sessionId
      ? await entry.guest.debugger.sendCommand(method, params, sessionId)
      : await entry.guest.debugger.sendCommand(method, params); }
    finally { entry.agentInputDepth--; }
  }

  private async resolveCdpTarget(entry: Entry, target: BrowserCdpTarget | undefined): Promise<{
    sessionId: string; info: CdpSession; revision: number; origin: string } | undefined> {
    if (!target) return undefined;
    const found = [...entry.cdpSessions.entries()].find(([sessionId, info]) =>
      'sessionId' in target ? sessionId === target.sessionId : info.targetId === target.targetId);
    if (!found) throw new Error('CDP child target is not attached to this tab');
    const [sessionId, info] = found;
    const live = await entry.guest.debugger.sendCommand('Target.getTargetInfo', { targetId: info.targetId });
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

  private async target(entry: Entry, ref: unknown): Promise<string> {
    const value = String(ref ?? '');
    if (!value || value.length > 500) throw new Error('Invalid browser element target');
    const match = /^ax-(\d+)$/.exec(value);
    const object = match
      ? (await this.command(entry, 'DOM.resolveNode', { backendNodeId: Number(match[1]) })).object
      : (await this.command(entry, 'Runtime.evaluate', {
          expression: `(() => { const found = document.querySelectorAll(${JSON.stringify(value)}); return found.length === 1 ? found[0] : null; })()`,
        })).result;
    if (!object?.objectId) throw new Error('Element is no longer available; take a new snapshot');
    return object.objectId;
  }

  private async click(entry: Entry, args: Record<string, unknown>): Promise<{ x: number; y: number }> {
    let x = Number(args.x), y = Number(args.y);
    if (!Number.isFinite(x) || !Number.isFinite(y)) {
      const objectId = await this.target(entry, args.target ?? args.ref);
      const { result } = await this.command(entry, 'Runtime.callFunctionOn', { objectId,
        functionDeclaration: "function(){ this.scrollIntoView({block:'center'}); const r=this.getBoundingClientRect(); return {x:r.left+r.width/2,y:r.top+r.height/2}; }",
        returnByValue: true });
      x = result?.value?.x; y = result?.value?.y;
    }
    if (!Number.isFinite(x) || !Number.isFinite(y)) throw new Error('Element has no visible click point');
    const button = ['left', 'right', 'middle'].includes(String(args.button)) ? String(args.button) : 'left';
    const modifiers = Array.isArray(args.modifiers) ? args.modifiers.reduce((bits: number, name: string) =>
      bits | (({ Alt: 1, Control: 2, Meta: 4, Shift: 8 } as Record<string, number>)[name] ?? 0), 0) : 0;
    for (let count = 1; count <= (args.doubleClick ? 2 : 1); count++) {
      await this.command(entry, 'Input.dispatchMouseEvent', { type: 'mousePressed', x, y, button, modifiers, clickCount: count });
      await this.command(entry, 'Input.dispatchMouseEvent', { type: 'mouseReleased', x, y, button, modifiers, clickCount: count });
    }
    return { x, y };
  }

  private async history(entry: Entry, change: number): Promise<{ url: string }> {
    const state = await this.command(entry, 'Page.getNavigationHistory');
    const item = state.entries?.[state.currentIndex + change];
    if (!item) return { url: entry.guest.getURL() };
    if (!entry.allowedOrigins.has(origin(item.url))) throw new Error('This site needs Memmy access approval first');
    await this.command(entry, 'Page.navigateToHistoryEntry', { entryId: item.id });
    return { url: item.url };
  }

  private async screenshot(entry: Entry, args: Record<string, unknown>): Promise<{ format: 'png' | 'jpeg'; data: string }> {
    const format = args.type === 'jpeg' ? 'jpeg' : 'png';
    const metrics = await this.command(entry, 'Page.getLayoutMetrics');
    const size = args.fullPage ? metrics.cssContentSize : metrics.cssVisualViewport;
    const width = size?.width ?? size?.clientWidth, height = size?.height ?? size?.clientHeight;
    if (!(width > 0 && height > 0)) throw new Error('Browser page size is unavailable');
    const ratioResult = await this.command(entry, 'Runtime.evaluate', { expression: 'window.devicePixelRatio', returnByValue: true });
    const ratio = Number(ratioResult.result?.value) || 1;
    const scale = args.scale === 'device' ? 1 : 1 / ratio;
    let clip: Record<string, number> = { x: size.pageX ?? size.x ?? 0, y: size.pageY ?? size.y ?? 0,
      width, height, scale };
    if (args.target || args.ref) {
      if (args.fullPage) throw new Error('fullPage cannot be combined with an element screenshot');
      const objectId = await this.target(entry, args.target ?? args.ref);
      const { result, exceptionDetails } = await this.command(entry, 'Runtime.callFunctionOn', { objectId,
        functionDeclaration: "function(){ const r=this.getBoundingClientRect(); return {x:r.left+scrollX,y:r.top+scrollY,width:r.width,height:r.height}; }",
        returnByValue: true });
      const box = result?.value;
      if (exceptionDetails || !box || ![box.x, box.y, box.width, box.height].every(Number.isFinite)
        || box.width <= 0 || box.height <= 0) throw new Error('Element is not visible');
      clip = { ...box, scale };
    }
    const { data } = await this.command(entry, 'Page.captureScreenshot', { format,
      captureBeyondViewport: args.fullPage === true || Boolean(args.target || args.ref), clip });
    return { format, data };
  }

  async handle(request: EmbeddedBrowserRequest, approvedUpload?: ApprovedBrowserUpload,
    approvedCdp?: ApprovedBrowserCdpRead): Promise<unknown> {
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
        return [{ tabId: entry.guest.id, title: entry.guest.getTitle(), url: entry.guest.getURL() }];
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
      const target = new URL(String(request.args.url ?? ''));
      origin(target.href);
      const host = this.getHost();
      if (!host || host.isDestroyed()) throw new Error('Memmy browser window is not available');
      const existingIds = new Set(this.entries.keys());
      host.webContents.send('memmy:browser:open-url', target.href);
      const deadline = Date.now() + 20_000;
      while (Date.now() < deadline) {
        const entry = [...this.entries.values()].find(candidate => !existingIds.has(candidate.guest.id)
          && !candidate.guest.isDestroyed() && candidate.host === host
          && (candidate.guest.getURL() === target.href
            || (candidate.lastStartedUrl === target.href && !candidate.guest.isLoading())));
        if (entry) {
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
      throw new Error('Memmy browser tab did not open');
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
    if (WRITES.has(request.command) && entry.guest.isFocused()
      && Date.now() - entry.lastUserInputAt < 2_000) {
      throw new Error('USER_ACTIVE_ON_TARGET_TAB');
    }
    if (request.command !== 'allowOrigin' && request.command !== 'open'
      && !entry.allowedOrigins.has(origin(entry.guest.getURL()))) {
      throw new Error('This site needs Memmy access approval first');
    }
    if (NAVIGATION_ACTIONS.has(request.command)) this.markVisitSource(entry, 'agent');
    switch (request.command) {
      case 'allowOrigin': {
        const allowed = origin(String(args.origin ?? ''));
        entry.allowedOrigins.add(allowed);
        return { origin: allowed };
      }
      case 'snapshot': return { nodes: await this.snapshot(entry), tab: { id: entry.guest.id,
        title: entry.guest.getTitle(), url: entry.guest.getURL() } };
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
        await this.click(entry, args);
        const text = String(args.text ?? '');
        if (text.length > 100_000) throw new Error('Text is too long');
        const objectId = await this.target(entry, args.target ?? args.ref);
        await this.command(entry, 'Runtime.callFunctionOn', { objectId,
          functionDeclaration: "function(){ this.focus(); if(typeof this.select==='function'){this.select();return;} if(this.isContentEditable){const r=document.createRange();r.selectNodeContents(this);const s=window.getSelection();s.removeAllRanges();s.addRange(r);return;} throw Error('Element is not editable'); }" });
        if (args.slowly) for (const character of text) await this.command(entry, 'Input.insertText', { text: character });
        else await this.command(entry, 'Input.insertText', { text });
        if (args.submit) await this.pressKey(entry, 'Enter');
        return { ok: true };
      }
      case 'selectOption': {
        const objectId = await this.target(entry, args.target ?? args.ref);
        const values = Array.isArray(args.values) ? args.values.map(String) : [String(args.value ?? '')];
        const { result } = await this.command(entry, 'Runtime.callFunctionOn', { objectId,
          functionDeclaration: "function(values){ if(this.tagName!=='SELECT') throw Error('Not a select'); for(const option of this.options) option.selected=values.includes(option.value); this.dispatchEvent(new Event('input',{bubbles:true})); this.dispatchEvent(new Event('change',{bubbles:true})); return this.value; }",
          arguments: [{ value: values }], returnByValue: true, awaitPromise: true });
        return { value: result?.value };
      }
      case 'pressKey': await this.pressKey(entry, String(args.key ?? '')); return { ok: true };
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
      case 'screenshot': return this.screenshot(entry, args);
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
          const live = await entry.guest.debugger.sendCommand('Target.getTargetInfo', { targetId: child.info.targetId });
          if (entry.cdpSessions.get(child.sessionId) !== child.info
            || child.info.revision !== child.revision
            || live?.targetInfo?.targetId !== child.info.targetId
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
        if (!approvedCdp!.isCurrentChild() || !approvedCdp!.isAllowed()
          || this.uploadOrigin(request.tabId!) !== approvedCdp!.origin
          || entry.cdpEpoch !== approvedEpoch) {
          throw new Error('Browser CDP events are no longer approved');
        }
        const { approvedOrigin: _approvedOrigin, ...query } = args;
        const result = await entry.cdpEvents.wait(query, () => !entry.credentialProtected && !entry.protectedActivity
          && approvedCdp!.isCurrentChild()
          && approvedCdp!.isAllowed() && this.uploadOrigin(request.tabId!) === approvedCdp!.origin
          && entry.cdpEpoch === approvedEpoch);
        if (entry.credentialProtected || entry.protectedActivity
          || !approvedCdp!.isCurrentChild() || !approvedCdp!.isAllowed()
          || this.uploadOrigin(request.tabId!) !== approvedCdp!.origin || entry.cdpEpoch !== approvedEpoch) {
          throw new Error('Browser CDP events are no longer approved');
        }
        return result;
      }
      case 'open': entry.host.show(); entry.guest.focus(); return { ok: true };
      default: throw new Error('Unsupported embedded browser command');
    }
  }

  private async pressKey(entry: Entry, value: string): Promise<void> {
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
        windowsVirtualKeyCode: item.virtualKeyCode, nativeVirtualKeyCode: item.virtualKeyCode });
    }
    const event = keyEvent(actual, bits);
    if ((bits & 6) && event.code === 'KeyA') event.commands = ['SelectAll'];
    await this.command(entry, 'Input.dispatchKeyEvent', { type: 'keyDown', ...event });
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
      if (!entry.guest.isDestroyed() && entry.attached) {
        try { entry.guest.debugger.detach(); } catch { /* Guest may be closing. */ }
      }
    }
    this.entries.clear();
    this.selectedTabId = null;
  }
}
