import { randomUUID } from 'node:crypto';
import { EMBEDDED_BROWSER_REQUEST, EMBEDDED_BROWSER_CANCEL, isEmbeddedBrowserEvent, isEmbeddedBrowserResult,
  formatEmbeddedBrowserTabMention, parseEmbeddedBrowserTabMention,
  type EmbeddedBrowserCommand, type ExternalBrowserState, type ExternalBrowserRecovery } from '@memmy/local-api-contracts';
import type { BrowserCommandOutcome, BrowserCommandSettle, ExternalBrowserClaim,
  ExternalBrowserPlaywrightEvent } from './external-browser-bridge.js';

type Pending = { resolve: (value: unknown) => void; reject: (reason: Error) => void;
  cleanup: () => void };

/** Child-process IPC for the actual webview owned by the Memmy desktop main process. */
export class EmbeddedBrowserBridge {
  private readonly pending = new Map<string, Pending>();
  private claim: ExternalBrowserClaim | null = null;
  private browserId: string | null = null;
  private selectedTabId: number | null = null;
  private visibleTabs: Array<{ tabId: number; title: string; url: string; tabMention: string | null }> = [];
  private readonly claims = new Map<number, ExternalBrowserClaim>();
  private readonly executorListeners = new Map<number, Set<(event: ExternalBrowserPlaywrightEvent) => void>>();
  private readonly receive = (value: unknown) => {
    if (isEmbeddedBrowserEvent(value)) {
      const event: ExternalBrowserPlaywrightEvent = { leaseId: value.leaseId, method: value.method, params: value.params,
        ...(value.sessionId === undefined ? {} : { sessionId: value.sessionId }) };
      for (const listener of this.executorListeners.get(value.tabId) ?? []) listener(event);
      return;
    }
    if (!isEmbeddedBrowserResult(value)) return;
    const pending = this.pending.get(value.requestId);
    if (!pending) return;
    this.pending.delete(value.requestId);
    pending.cleanup();
    if (value.ok) pending.resolve(value.result);
    else pending.reject(new Error(value.error || 'Embedded browser command failed'));
  };

  constructor() {
    if (process.send) process.on('message', this.receive);
  }

  private request(command: EmbeddedBrowserCommand, args: Record<string, unknown> = {}, tabId?: number,
    signal?: AbortSignal, settle?: BrowserCommandSettle): Promise<unknown> {
    if (!process.send) return Promise.reject(new Error('Embedded browser is available only in the desktop app'));
    if (signal?.aborted) return Promise.reject(new Error('Browser operation was canceled'));
    const requestId = randomUUID();
    return new Promise((resolvePromise, rejectPromise) => {
      const report = (outcome: BrowserCommandOutcome) => {
        try { settle?.(outcome); } catch { /* A caller's reply handling cannot break the bridge. */ }
      };
      const resolve = (value: unknown) => { report({ ok: true, result: value }); resolvePromise(value); };
      const reject = (error: Error) => { report({ ok: false, error }); rejectPromise(error); };
      const onAbort = () => {
        if (!this.pending.delete(requestId)) return;
        cleanup();
        try { process.send?.({ type: EMBEDDED_BROWSER_CANCEL, requestId }, () => undefined); }
        catch { /* Child exited. */ }
        reject(new Error('Browser operation was canceled'));
      };
      const cleanup = () => { clearTimeout(timer); signal?.removeEventListener('abort', onAbort); };
      const timer = setTimeout(() => {
        this.pending.delete(requestId);
        cleanup();
        try { process.send?.({ type: EMBEDDED_BROWSER_CANCEL, requestId }, () => undefined); }
        catch { /* A timed-out request remains cancelled locally. */ }
        reject(new Error('Embedded browser command timed out'));
      }, command === 'externalBrowserState' ? 5_000
        : command === 'recoverExternalBrowser' ? 15_000
        : command === 'waitDownloadDestination' ? 35_000
        : command === 'queryHistory' ? 5 * 60_000
        : command === 'authRequest' ? 5 * 60_000 + 15_000
        : command === 'upload' ? 5 * 60_000 + 15_000
        : command === 'playwrightStart' && Array.isArray(args.uploadPaths) && args.uploadPaths.length > 0
          ? 5 * 60_000 + 15_000
        : command === 'cdpCall' || command === 'cdpEvents' || command === 'cdpWrite'
          ? 5 * 60_000 + 45_000 : 30_000);
      timer.unref?.();
      this.pending.set(requestId, { resolve, reject, cleanup });
      signal?.addEventListener('abort', onAbort, { once: true });
      try {
        process.send!({ type: EMBEDDED_BROWSER_REQUEST, requestId, command, args,
          ...(tabId === undefined ? {} : { tabId }) }, error => {
          if (!error) return;
          const pending = this.pending.get(requestId);
          if (!pending) return;
          pending.cleanup();
          this.pending.delete(requestId);
          reject(error);
        });
      } catch (error) {
        cleanup();
        this.pending.delete(requestId);
        reject(error instanceof Error ? error : new Error(String(error)));
      }
    });
  }

  async refresh(): Promise<ExternalBrowserClaim | null> {
    const result = await this.request('listTabs') as {
      browserId?: unknown; selectedTabId?: unknown;
      tabs?: Array<{ tabId?: unknown; title?: unknown; url?: unknown; everSelected?: unknown }>
    } | null;
    this.browserId = typeof result?.browserId === 'string' ? result.browserId : null;
    this.selectedTabId = Number.isSafeInteger(result?.selectedTabId) && (result!.selectedTabId as number) > 0
      ? result!.selectedTabId as number : null;
    const next = new Map<number, ExternalBrowserClaim>();
    const visibleTabs: typeof this.visibleTabs = [];
    for (const tab of Array.isArray(result?.tabs) ? result.tabs : []) {
      if (!this.browserId || !Number.isSafeInteger(tab.tabId) || typeof tab.url !== 'string'
        || tab.url.length > 4096 || typeof tab.title !== 'string' || tab.title.length > 4096) continue;
      const tabId = tab.tabId as number;
      if (tab.url === 'about:blank') {
        visibleTabs.push({ tabId, title: tab.title, url: tab.url, tabMention: null });
        continue;
      }
      let url: URL;
      try { url = new URL(tab.url); }
      catch { continue; }
      if (!['http:', 'https:'].includes(url.protocol)) continue;
      visibleTabs.push({ tabId, title: tab.title, url: tab.url,
        tabMention: formatEmbeddedBrowserTabMention({ browserId: this.browserId, tabId,
          title: tab.title, url: tab.url }) });
      next.set(tabId, { connectionId: `memmy-webview:${this.browserId}`, tabId, browser: 'memmy',
        title: tab.title, url: tab.url,
        everSelected: typeof tab.everSelected === 'boolean' ? tab.everSelected : undefined,
        claimedAt: this.claims.get(tabId)?.claimedAt ?? Date.now() });
    }
    this.visibleTabs = visibleTabs;
    this.claims.clear();
    for (const [id, claim] of next) this.claims.set(id, claim);
    this.claim = this.selectedTabId !== null ? this.claims.get(this.selectedTabId) ?? null : null;
    return this.claim;
  }

  listClaims(): ExternalBrowserClaim[] { return this.claim ? [this.claim] : []; }

  /** Read the same tab inventory shown in Memmy's browser sidebar. */
  async listTabs(): Promise<{ browserId: string | null; selectedTabId: number | null;
    tabs: Array<{ tabId: number; title: string; url: string; tabMention: string | null }> }> {
    await this.refresh();
    return {
      browserId: this.browserId,
      selectedTabId: this.selectedTabId,
      tabs: this.visibleTabs,
    };
  }
  async getExternalBrowserState(signal?: AbortSignal): Promise<ExternalBrowserState> {
    const result = await this.request('externalBrowserState', {}, undefined, signal) as Partial<ExternalBrowserState> | null;
    const installation = (browser: 'chrome' | 'edge') => {
      const state = result?.installation?.[browser];
      return { installed: typeof state?.installed === 'boolean' ? state.installed : null,
        enabled: typeof state?.enabled === 'boolean' ? state.enabled : null };
    };
    const running = result?.runningBrowsers;
    return { installation: { chrome: installation('chrome'), edge: installation('edge') },
      runningBrowsers: Array.isArray(running) && running.every(browser => browser === 'chrome' || browser === 'edge')
        ? [...new Set(running)] : null };
  }
  async recoverExternalBrowser(browser: 'chrome' | 'edge', signal?: AbortSignal): Promise<ExternalBrowserRecovery> {
    const result = await this.request('recoverExternalBrowser', { browser }, undefined, signal);
    return result === 'woken' || result === 'failed' ? result : 'unavailable';
  }
  async queryHistory(input: { from: string; to: string; keyword: string; limit: number }): Promise<unknown> {
    return this.request('queryHistory', input);
  }
  async openTab(url: string, scopeKey: string): Promise<ExternalBrowserClaim | null> {
    if (typeof scopeKey !== 'string' || !scopeKey.trim() || scopeKey.length > 512) {
      throw new Error('Embedded browser tabs require a valid chat scope');
    }
    const opened = await this.request('openTab', { url, scopeKey }) as { tabId?: unknown };
    await this.refresh();
    return Number.isSafeInteger(opened?.tabId) ? this.claims.get(opened.tabId as number) ?? null : null;
  }
  async resolveMention(value: string): Promise<ExternalBrowserClaim> {
    const mention = parseEmbeddedBrowserTabMention(value);
    if (!mention) throw new Error('Invalid browser tab mention');
    await this.refresh();
    const claim = this.claims.get(mention.tabId);
    if (!claim || this.browserId !== mention.browserId || claim.title !== mention.title
      || claim.url !== mention.url) throw new Error('Stale tab mention: the browser tab changed or closed');
    return claim;
  }
  getClaim(identity: Pick<ExternalBrowserClaim, 'connectionId' | 'tabId'>): ExternalBrowserClaim | null {
    return identity.connectionId === `memmy-webview:${this.browserId}` ? this.claims.get(identity.tabId) ?? null : null;
  }
  command(claim: Pick<ExternalBrowserClaim, 'connectionId' | 'tabId'>,
    command: string, args: Record<string, unknown> = {}, signal?: AbortSignal,
    settle?: BrowserCommandSettle): Promise<unknown> {
    if (!this.getClaim(claim)) return Promise.reject(new Error('Embedded browser tab is no longer open'));
    return this.request(command as EmbeddedBrowserCommand, args, claim.tabId, signal, settle);
  }

  subscribePlaywright(identity: Pick<ExternalBrowserClaim, 'connectionId' | 'tabId'>,
    listener: (event: ExternalBrowserPlaywrightEvent) => void): () => void {
    if (!this.getClaim(identity)) throw new Error('Embedded browser tab is no longer open');
    const listeners = this.executorListeners.get(identity.tabId) ?? new Set();
    listeners.add(listener); this.executorListeners.set(identity.tabId, listeners);
    return () => {
      listeners.delete(listener);
      if (!listeners.size) this.executorListeners.delete(identity.tabId);
    };
  }

  close(): void {
    this.executorListeners.clear();
    process.removeListener('message', this.receive);
    for (const pending of this.pending.values()) {
      pending.cleanup();
      pending.reject(new Error('Embedded browser bridge closed'));
    }
    this.pending.clear();
    this.claim = null;
    this.browserId = null;
    this.claims.clear();
  }
}
