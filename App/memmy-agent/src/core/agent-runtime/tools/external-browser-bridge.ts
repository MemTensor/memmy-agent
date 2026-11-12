import { randomBytes } from "node:crypto";
import http from "node:http";
import { WebSocket, WebSocketServer } from "ws";
import { browserHistoryConfiguration, BROWSER_HISTORY_CONFIG_TTL_MS } from "../../../tools/computer-history/browser-history-bridge.js";
import type { BrowserHistoryCaptureIntent, BrowserHistoryTrustedContext } from "../../../tools/computer-history/browser-semantic-history.js";
import { redactSensitive } from "../../../tools/computer-history/core/redaction.js";

// Derived from the public key in the packaged MV3 manifest. The private key is
// not needed to load an unpacked extension and is deliberately not distributed.
export const MEMMY_BROWSER_EXTENSION_ID = "mhodbgbbgalbhehapffidmdegokpoaom";
const EXTENSION_ORIGIN = `chrome-extension://${MEMMY_BROWSER_EXTENSION_ID}`;
// The unpacked extension probes these loopback ports. Keep them aligned with
// BRIDGE_PORTS in App/shell/desktop/extensions/memmy-browser/background.js.
export const EXTERNAL_BROWSER_BRIDGE_PORTS = [47321, 47322, 47323] as const;
const MAX_MESSAGE_BYTES = 8 * 1024 * 1024;
const COMMAND_TIMEOUT_MS = 30_000;
// Same bound as MAX_ANCESTORS in the extension's browser-history-background.js.
const MAX_HISTORY_ANCESTORS = 32;

export type ExternalBrowserClaim = {
  connectionId: string;
  tabId: number;
  browser: "chrome" | "edge" | "memmy";
  title: string;
  url: string;
  active?: boolean;
  /** Whether this in-app tab has appeared as the selected page in its chat panel. */
  everSelected?: boolean;
  openerTabId?: number;
  claimedAt: number;
};

export type ExternalBrowserTabStatus = {
  connectionId: string;
  tabId: number;
  browser: "chrome" | "edge";
  title: string;
  url: string;
  active?: boolean;
  status: "ready" | "attach_failed" | "unsupported" | "user_detached" | "protected";
  reason: string;
  updatedAt: number;
};

/** History focus evidence is separate from long-lived Computer Use claims. */
export type ExternalBrowserHistoryFocus = {
  connectionId: string;
  browser: "chrome" | "edge";
  focused: boolean;
  tabId: number | null;
  windowId: number | null;
  title: string;
  url: string;
  mode: "normal" | "private" | "unknown";
  observedAt: number;
  receivedAt: number;
};

type PendingCommand = {
  resolve: (value: unknown) => void;
  reject: (reason: Error) => void;
  timer: NodeJS.Timeout;
  cleanup: () => void;
};

type Client = {
  socket: WebSocket;
  authorized: boolean;
  browser: "chrome" | "edge" | null;
  capabilities: Set<string>;
  claims: Map<number, ExternalBrowserClaim>;
  tabStatuses: Map<number, ExternalBrowserTabStatus>;
  historyFocus: ExternalBrowserHistoryFocus | null;
  historySequence: number;
  extensionVersion?: string;
};

type ConnectionEvent = {
  stage: 'listening' | 'connected' | 'disconnected';
  at: number;
  port: number;
  browser?: 'chrome' | 'edge';
  extensionVersion?: string;
  closeCode?: number;
};
type ConnectionWaiter = { browser: 'chrome' | 'edge'; finish: (connected: boolean) => void };

/** Internal executor events. They are never exposed as a model CDP tool. */
export type ExternalBrowserPlaywrightEvent = {
  leaseId: string;
  method: string;
  params: Record<string, unknown>;
  sessionId?: string;
};

/** Reported in the same turn the reply arrives, in order with executor events. */
export type BrowserCommandOutcome = { ok: true; result: unknown } | { ok: false; error: Error };
export type BrowserCommandSettle = (outcome: BrowserCommandOutcome) => void;

export const EXTERNAL_BROWSER_EXTENSION_OUTDATED = 'The installed Memmy browser extension is too old to open tabs. Ask the user to reload it in the browser\'s extensions page or restart the browser after updating Memmy (setup: memmy://settings/browser-extension), or use a tab that is already open.';
export const EXTERNAL_BROWSER_EXTENSION_NOT_READY = 'external_browser_extension_not_ready';
export const EXTERNAL_BROWSER_EXTENSION_NOT_READY_MESSAGE = 'External browser extension is not ready.';

function isSafePageUrl(value: unknown): value is string {
  if (typeof value !== "string" || value.length > 4096) return false;
  try { return ["http:", "https:"].includes(new URL(value).protocol); }
  catch { return false; }
}

function isWebOrigin(value: unknown): value is string {
  return isSafePageUrl(value) && new URL(value).origin === value;
}

function safeText(value: unknown, length: number): string {
  return typeof value === "string" ? value.slice(0, length) : "";
}

/**
 * A loopback-only bridge. After the Memmy extension is installed it connects
 * by itself and exposes ordinary http(s) pages. Web pages cannot connect:
 * the upgrade requires the packaged extension origin.
 */
export class ExternalBrowserBridge {
  private readonly server = http.createServer((_req, response) => {
    response.writeHead(404).end();
  });
  private readonly webSockets = new WebSocketServer({ noServer: true, maxPayload: MAX_MESSAGE_BYTES });
  private readonly clients = new Map<string, Client>();
  private readonly pending = new Map<string, PendingCommand>();
  private readonly playwrightListeners = new Map<string, Set<(event: ExternalBrowserPlaywrightEvent) => void>>();
  private browserHistoryIntentProvider: (() => BrowserHistoryCaptureIntent) | null = null;
  private readonly browserHistoryListeners = new Set<(payload: unknown, context: BrowserHistoryTrustedContext) => void>();
  private readonly browserHistoryInputs = new Map<string, { connectionId: string; tabId: number; sentAt: number }>();
  private readonly teachingListeners = new Map<string, Set<(message: Record<string, unknown>) => void>>();
  private nextId = 1;
  private port = 0;
  private startTask: Promise<{ port: number }> | null = null;
  private closing = false;
  private closeTask: Promise<void> | null = null;
  private readonly connectionWaiters = new Set<ConnectionWaiter>();
  private readonly connectionEvents: ConnectionEvent[] = [];

  constructor(private readonly onClaimsChanged?: (claims: ExternalBrowserClaim[]) => void) {
    this.server.on("upgrade", (request, socket, head) => {
      const remote = request.socket.remoteAddress;
      const local = remote === "127.0.0.1" || remote === "::1" || remote === "::ffff:127.0.0.1";
      if (this.closing || !local || request.headers.origin !== EXTENSION_ORIGIN || request.url !== "/extension") {
        socket.destroy();
        return;
      }
      this.webSockets.handleUpgrade(request, socket, head, client => this.accept(client));
    });
  }

  async start(requestedPort?: number): Promise<{ port: number }> {
    if (this.closing) throw new Error('Browser bridge closed');
    if (this.port) return { port: this.port };
    if (this.startTask) return this.startTask;
    this.startTask = this.startListening(requestedPort).finally(() => { this.startTask = null; });
    return this.startTask;
  }

  private async startListening(requestedPort?: number): Promise<{ port: number }> {
    const configuredPort = process.env.MEMMY_EXTERNAL_BROWSER_BRIDGE_PORT;
    if (requestedPort === undefined && configuredPort !== undefined) {
      const port = Number(configuredPort);
      if (!/^\d+$/.test(configuredPort) || !Number.isInteger(port) || port < 1 || port > 65535) {
        throw new Error("MEMMY_EXTERNAL_BROWSER_BRIDGE_PORT must be an integer from 1 to 65535");
      }
      requestedPort = port;
    }
    const candidates = requestedPort === undefined ? [...EXTERNAL_BROWSER_BRIDGE_PORTS] : [requestedPort];
    let lastError: unknown;
    for (const candidate of candidates) {
      if (this.closing) throw new Error('Browser bridge closed');
      try {
        await this.listen(candidate);
        return { port: this.port };
      } catch (error) { lastError = error; }
    }
    throw lastError instanceof Error ? lastError : new Error("browser bridge failed to bind loopback");
  }

  listConnected(): Array<"chrome" | "edge"> {
    return [...new Set([...this.clients.values()].flatMap(client =>
      client.authorized && client.browser && client.socket.readyState === WebSocket.OPEN ? [client.browser] : []))];
  }

  /** Wait only for a handshake; discovery never grants page access or attaches a debugger. */
  waitForConnection(browser: 'chrome' | 'edge', timeoutMs: number, signal?: AbortSignal): Promise<boolean> {
    if (signal?.aborted) return Promise.reject(new Error('Browser connection wait was canceled'));
    if (this.closing) return Promise.resolve(false);
    if (this.listConnected().includes(browser)) return Promise.resolve(true);
    if (!Number.isFinite(timeoutMs) || timeoutMs <= 0) return Promise.resolve(false);
    return new Promise((resolve, reject) => {
      const cleanup = () => {
        clearTimeout(timer);
        signal?.removeEventListener('abort', onAbort);
        this.connectionWaiters.delete(waiter);
      };
      const waiter: ConnectionWaiter = { browser, finish: value => { cleanup(); resolve(value); } };
      const onAbort = () => { cleanup(); reject(new Error('Browser connection wait was canceled')); };
      const timer = setTimeout(() => waiter.finish(false), Math.min(timeoutMs, 60_000));
      timer.unref?.();
      this.connectionWaiters.add(waiter);
      signal?.addEventListener('abort', onAbort, { once: true });
      if (signal?.aborted) onAbort();
      else if (this.listConnected().includes(browser)) waiter.finish(true);
    });
  }

  connectionDiagnostics(): { port: number; events: ConnectionEvent[] } {
    return { port: this.port, events: this.connectionEvents.map(event => ({ ...event })) };
  }

  private recordConnection(event: Omit<ConnectionEvent, 'at' | 'port'>, port = this.port): void {
    const entry = { ...event, at: Date.now(), port };
    this.connectionEvents.push(entry);
    if (this.connectionEvents.length > 24) this.connectionEvents.shift();
    // Never include page URLs, titles, payloads, credentials, or user profile paths.
    console.info('[browser-connection]', JSON.stringify(entry));
  }

  private listen(port: number): Promise<void> {
    return new Promise((resolve, reject) => {
      const onError = (error: Error) => {
        this.server.off("listening", onListening);
        reject(error);
      };
      const onListening = () => {
        this.server.off("error", onError);
        if (this.closing) { reject(new Error('Browser bridge closed')); return; }
        const address = this.server.address();
        if (!address || typeof address === "string") {
          reject(new Error("browser bridge failed to bind loopback"));
          return;
        }
        this.port = address.port;
        this.recordConnection({ stage: 'listening' });
        resolve();
      };
      this.server.once("error", onError);
      this.server.once("listening", onListening);
      this.server.listen(port, "127.0.0.1");
    });
  }

  listClaims(): ExternalBrowserClaim[] {
    return [...this.clients.values()].flatMap(client => [...client.claims.values()]);
  }

  listTabStatuses(): ExternalBrowserTabStatus[] {
    return [...this.clients.values()].flatMap(client => [...client.tabStatuses.values()]);
  }

  listHistoryFocusObservations(): ExternalBrowserHistoryFocus[] {
    return [...this.clients.values()].flatMap(client => client.authorized && client.historyFocus
      ? [{ ...client.historyFocus }] : []);
  }

  /** Each connection belongs to one extension/profile. Never choose the first profile for teaching. */
  listTeachingProfiles() {
    const connected = [...this.clients.entries()].filter(([, client]) => client.authorized && client.browser);
    return connected.flatMap(([connectionId, client]) => client.authorized && client.browser
      ? [{ connectionId, browser: client.browser, supported: client.capabilities.has("teachingCapture/v2"),
        // A single profile needs no inventory. Ambiguous profiles expose only a few chooser labels,
        // never full navigation URLs, query strings, page values or browsing history.
        windows: connected.filter(([, other]) => other.browser === client.browser).length < 2 ? []
          : [...client.claims.values()].sort((a, b) => Number(!!b.active) - Number(!!a.active)).slice(0, 3)
            .map(tab => ({ tabId: tab.tabId, title: redactSensitive(safeText(tab.title, 160)), url: new URL(tab.url).origin })) }] : []);
  }

  subscribeTeaching(connectionId: string, sessionId: string, listener: (message: Record<string, unknown>) => void) {
    const key = `${connectionId}:${sessionId}`, listeners = this.teachingListeners.get(key) ?? new Set();
    listeners.add(listener); this.teachingListeners.set(key, listeners);
    return () => { listeners.delete(listener); if (!listeners.size) this.teachingListeners.delete(key); };
  }

  teachingCommand(connectionId: string, sessionId: string, action: "prepare" | "start" | "checkpoint" | "stop" | "cancel",
    input: Record<string, unknown> = {}): Promise<Record<string, unknown>> {
    const client = this.clients.get(connectionId);
    if (!client?.authorized || client.socket.readyState !== WebSocket.OPEN) return Promise.reject(new Error("browser_capture_disconnected"));
    if (!client.capabilities.has("teachingCapture/v2")) return Promise.reject(new Error("Reload the Memmy browser extension to enable teaching capture v2: memmy://settings/browser-extension"));
    const id = `${connectionId}:${this.nextId++}`;
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => { this.pending.delete(id); reject(new Error("browser_capture_ack_timeout")); }, action === "stop" ? 5000 : COMMAND_TIMEOUT_MS);
      timer.unref?.();
      this.pending.set(id, { resolve: value => resolve(value as Record<string, unknown>), reject, timer, cleanup: () => undefined });
      try { client.socket.send(JSON.stringify({ type: "teaching_command", id, sessionId, action, input })); }
      catch (error) { clearTimeout(timer); this.pending.delete(id); reject(error); }
    });
  }

  /** Rescan existing pages without opening tabs; pages the user stopped return only after the extension's cooldown. */
  async refreshTabs(browser?: "chrome" | "edge"): Promise<void> {
    const clients = [...this.clients.entries()].filter(([, client]) => client.authorized
      && (!browser || client.browser === browser) && client.socket.readyState === WebSocket.OPEN);
    await Promise.all(clients.map(([connectionId, client]) => {
      const id = `${connectionId}:${this.nextId++}`;
      return new Promise<unknown>((resolve, reject) => {
        const timer = setTimeout(() => {
          this.pending.delete(id);
          reject(new Error("Browser extension page refresh timed out"));
        }, 4_000);
        timer.unref?.();
        this.pending.set(id, { resolve, reject, timer, cleanup: () => undefined });
        try { client.socket.send(JSON.stringify({ type: "refresh_tabs", id })); }
        catch (error) {
          clearTimeout(timer); this.pending.delete(id);
          reject(error instanceof Error ? error : new Error("External browser disconnected"));
        }
      });
    }));
  }

  /** Opens a background tab beside the source tab, or in the browser's current window, and resolves once it is offered. */
  async openBrowserTab(browser: "chrome" | "edge", url: string,
    source?: Pick<ExternalBrowserClaim, "connectionId" | "tabId">): Promise<ExternalBrowserClaim> {
    const usable = (client?: Client) => client?.authorized === true && client.browser === browser
      && client.socket.readyState === WebSocket.OPEN;
    const connectionId = source && usable(this.clients.get(source.connectionId)) ? source.connectionId
      : [...this.clients.entries()].find(([, client]) => usable(client))?.[0];
    const client = connectionId ? this.clients.get(connectionId) : undefined;
    if (!connectionId || !client) throw new Error(`${browser} is not connected through the Memmy extension`);
    if (!client.capabilities.has("openTab")) throw new Error(EXTERNAL_BROWSER_EXTENSION_OUTDATED);
    const id = `${connectionId}:${this.nextId++}`;
    const opened = await new Promise<unknown>((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(id);
        reject(new Error("The browser did not open the tab in time"));
      }, 15_000);
      timer.unref?.();
      this.pending.set(id, { resolve, reject, timer, cleanup: () => undefined });
      try {
        client.socket.send(JSON.stringify({ type: "open_tab", id, url,
          ...(source?.connectionId === connectionId ? { sourceTabId: source.tabId } : {}) }));
      } catch (error) {
        clearTimeout(timer); this.pending.delete(id);
        reject(error instanceof Error ? error : new Error("External browser disconnected"));
      }
    }) as { tabId?: unknown } | null;
    const tabId = opened?.tabId;
    if (!Number.isSafeInteger(tabId)) throw new Error("The browser did not open the tab");
    const deadline = Date.now() + 5_000;
    let claim = this.getClaim({ connectionId, tabId: tabId as number });
    while (!claim && Date.now() < deadline) {
      await new Promise(resolve => setTimeout(resolve, 100));
      claim = this.getClaim({ connectionId, tabId: tabId as number });
    }
    if (!claim) throw new Error("The new tab opened, but Memmy cannot control it yet. Use browser_list_tabs to check its status.");
    return claim;
  }

  getClaim(identity: Pick<ExternalBrowserClaim, "connectionId" | "tabId">): ExternalBrowserClaim | null {
    return this.clients.get(identity.connectionId)?.claims.get(identity.tabId) ?? null;
  }

  subscribePlaywright(identity: Pick<ExternalBrowserClaim, "connectionId" | "tabId">,
    listener: (event: ExternalBrowserPlaywrightEvent) => void): () => void {
    const key = `${identity.connectionId}:${identity.tabId}`;
    const listeners = this.playwrightListeners.get(key) ?? new Set();
    listeners.add(listener);
    this.playwrightListeners.set(key, listeners);
    return () => {
      listeners.delete(listener);
      if (!listeners.size) this.playwrightListeners.delete(key);
    };
  }

  setBrowserHistoryIntentProvider(provider: () => BrowserHistoryCaptureIntent): () => void {
    this.browserHistoryIntentProvider = provider;
    this.refreshBrowserHistoryIntent();
    return () => {
      if (this.browserHistoryIntentProvider !== provider) return;
      this.browserHistoryIntentProvider = null;
      this.refreshBrowserHistoryIntent();
    };
  }

  subscribeBrowserHistory(listener: (payload: unknown, context: BrowserHistoryTrustedContext) => void): () => void {
    this.browserHistoryListeners.add(listener);
    return () => { this.browserHistoryListeners.delete(listener); };
  }

  private browserHistoryIntent(): BrowserHistoryCaptureIntent {
    try {
      if (this.browserHistoryIntentProvider) return this.browserHistoryIntentProvider();
    } catch { /* Unavailable recording settings revoke page observation. */ }
    return { enabled: false, generation: null, settings: null, captureText: false };
  }

  private sendBrowserHistoryIntent(client: Client): void {
    if (!client.authorized || !client.capabilities.has("browserHistory") || client.socket.readyState !== WebSocket.OPEN) return;
    const intent = this.browserHistoryIntent();
    try {
      client.socket.send(JSON.stringify({ type: "browser_history_intent", enabled: intent.enabled === true,
        generation: intent.enabled ? intent.generation : null, captureText: intent.enabled && intent.captureText,
        expiresAt: Date.now() + BROWSER_HISTORY_CONFIG_TTL_MS }));
    } catch { /* The content sensor also stops when its short authorization expires. */ }
  }

  refreshBrowserHistoryIntent(): void {
    for (const client of this.clients.values()) this.sendBrowserHistoryIntent(client);
  }

  /** Only extension/browser-owned metadata determines the capture target and privacy. */
  private browserHistoryContext(client: Client, connectionId: string,
    message: Record<string, unknown>): BrowserHistoryTrustedContext | null {
    if (message.browser !== client.browser || !Number.isSafeInteger(message.tabId) || (message.tabId as number) < 0
      || !Number.isSafeInteger(message.windowId) || (message.windowId as number) < 0
      || !Number.isSafeInteger(message.frameId) || (message.frameId as number) < 0
      || typeof message.documentId !== "string" || !/^[A-Za-z0-9._:-]{1,200}$/u.test(message.documentId)
      || !isSafePageUrl(message.topUrl) || !isSafePageUrl(message.frameUrl)
      || message.privateBrowsing !== false || message.protected !== false) return null;
    // An older extension reports no ancestry, so only its top frames can be recorded.
    const ancestorOrigins = message.ancestorOrigins ?? [];
    if (!Array.isArray(ancestorOrigins) || ancestorOrigins.length > MAX_HISTORY_ANCESTORS
      || !ancestorOrigins.every(isWebOrigin) || (message.frameId === 0 ? ancestorOrigins.length > 0
        : ancestorOrigins.at(-1) !== new URL(message.topUrl).origin)) return null;
    const tabId = message.tabId as number;
    const status = client.tabStatuses.get(tabId)?.status;
    if (status === "protected" || status === "unsupported") return null;
    const claim = client.claims.get(tabId);
    if (claim && claim.url !== message.topUrl) return null;
    return { connectionId, browser: client.browser!, tabId, windowId: message.windowId as number,
      url: message.topUrl, frameUrl: message.frameUrl, ancestorOrigins, documentId: message.documentId,
      privateBrowsing: false, protected: false };
  }

  async command(claim: Pick<ExternalBrowserClaim, "connectionId" | "tabId">,
    command: string, args: Record<string, unknown> = {}, signal?: AbortSignal,
    settle?: BrowserCommandSettle): Promise<unknown> {
    const client = this.clients.get(claim.connectionId);
    if (!client?.authorized || !client.claims.has(claim.tabId)
      || client.socket.readyState !== WebSocket.OPEN) {
      throw new Error("External browser tab is no longer connected or claimed");
    }
    if (signal?.aborted) throw new Error("External browser command cancelled");
    if (["playwrightStart", "playwrightCdp", "playwrightEnd"].includes(command)
      && !client.capabilities.has("playwright")) {
      throw Object.assign(new Error(EXTERNAL_BROWSER_EXTENSION_NOT_READY_MESSAGE), {
        code: EXTERNAL_BROWSER_EXTENSION_NOT_READY, retryable: false,
        dispatchState: "none", noActionDispatched: true, inputDispatched: false,
      });
    }
    const id = `${claim.connectionId}:${this.nextId++}`;
    const input = ["click", "type", "selectOption", "pressKey", "scroll"].includes(command)
      || (command === "playwrightCdp" && typeof args.method === "string" && args.method.startsWith("Input."));
    if (input) {
      const now = Date.now();
      for (const [key, value] of this.browserHistoryInputs) if (now - value.sentAt > 5_000) this.browserHistoryInputs.delete(key);
      if (this.browserHistoryInputs.size >= 2_048) this.browserHistoryInputs.delete(this.browserHistoryInputs.keys().next().value!);
      this.browserHistoryInputs.set(id, { connectionId: claim.connectionId, tabId: claim.tabId, sentAt: now });
    }
    const result = new Promise<unknown>((resolvePromise, rejectPromise) => {
      const report = (outcome: BrowserCommandOutcome) => {
        try { settle?.(outcome); } catch { /* A caller's reply handling cannot break the bridge. */ }
      };
      const resolve = (value: unknown) => { report({ ok: true, result: value }); resolvePromise(value); };
      const reject = (error: Error) => { report({ ok: false, error }); rejectPromise(error); };
      const cleanup = () => signal?.removeEventListener("abort", onAbort);
      const onAbort = () => {
        const pending = this.pending.get(id);
        if (!pending) return;
        this.pending.delete(id);
        this.browserHistoryInputs.delete(id);
        clearTimeout(timer);
        cleanup();
        try { if (client.socket.readyState === WebSocket.OPEN) client.socket.send(JSON.stringify({ type: "cancel", id })); }
        catch { /* The rejected command is already cancelled locally. */ }
        reject(new Error("External browser command cancelled"));
      };
      const timer = setTimeout(() => {
        this.pending.delete(id);
        this.browserHistoryInputs.delete(id);
        cleanup();
        try { if (client.socket.readyState === WebSocket.OPEN) client.socket.send(JSON.stringify({ type: "cancel", id })); }
        catch { /* The rejected command has already timed out locally. */ }
        reject(new Error("External browser command timed out"));
      }, command === "upload" ? 70_000
        : command === "authRequest" ? 5 * 60_000 + 15_000
        : ['cdpCall', 'cdpWrite', 'cdpEvents'].includes(command) ? 45_000 : COMMAND_TIMEOUT_MS);
      timer.unref?.();
      this.pending.set(id, { resolve, reject, timer, cleanup });
      signal?.addEventListener("abort", onAbort, { once: true });
    });
    try { client.socket.send(JSON.stringify({ type: "command", id, tabId: claim.tabId, command, args })); }
    catch (error) {
      const pending = this.pending.get(id);
      if (pending) { this.pending.delete(id); clearTimeout(pending.timer); pending.cleanup();
        this.browserHistoryInputs.delete(id);
        pending.reject(error instanceof Error ? error : new Error("External browser disconnected")); }
    }
    return result;
  }

  private accept(socket: WebSocket): void {
    const connectionPort = this.port;
    const connectionId = randomBytes(12).toString("hex");
    const client: Client = { socket, authorized: false, browser: null, capabilities: new Set(),
      claims: new Map(), tabStatuses: new Map(), historyFocus: null, historySequence: 0 };
    this.clients.set(connectionId, client);
    const helloTimer = setTimeout(() => socket.close(1008, "extension required"), 5_000);
    helloTimer.unref?.();
    socket.on("message", raw => {
      let message: Record<string, unknown>;
      try { message = JSON.parse(String(raw)); }
      catch { socket.close(1003, "invalid JSON"); return; }
      if (!message || typeof message !== "object" || Array.isArray(message)) {
        socket.close(1003, "invalid message"); return;
      }
      if (!client.authorized) {
        if (message.type !== "hello" || (message.browser !== "chrome" && message.browser !== "edge")) {
          socket.close(1008, "extension required"); return;
        }
        clearTimeout(helloTimer);
        client.authorized = true;
        client.browser = message.browser;
        client.extensionVersion = typeof message.extensionVersion === 'string'
          && /^\d{1,5}(?:\.\d{1,5}){0,3}$/.test(message.extensionVersion) ? message.extensionVersion : undefined;
        client.capabilities = new Set(Array.isArray(message.capabilities)
          ? message.capabilities.filter((value): value is string => typeof value === "string").slice(0, 20) : []);
        socket.send(JSON.stringify({ type: "ready", connectionId, heartbeat: true }));
        this.recordConnection({ stage: 'connected', browser: client.browser!, extensionVersion: client.extensionVersion });
        for (const waiter of [...this.connectionWaiters]) if (waiter.browser === client.browser) waiter.finish(true);
        this.sendBrowserHistoryIntent(client);
        this.onClaimsChanged?.(this.listClaims());
        return;
      }
      if (message.type === 'ping') {
        socket.send(JSON.stringify({ type: 'pong' }));
      } else if (message.type === "browser_history_config_request") {
        if (!client.capabilities.has("browserHistory")) return;
        if (typeof message.id !== "string" || !/^[A-Za-z0-9._:-]{1,200}$/u.test(message.id)) return;
        const context = this.browserHistoryContext(client, connectionId, message);
        const config = context ? browserHistoryConfiguration(this.browserHistoryIntent(), context)
          : { enabled: false, generation: null, expiresAt: Date.now(), captureText: false };
        socket.send(JSON.stringify({ type: "browser_history_config", id: message.id, ...config }));
      } else if (message.type === "browser_history") {
        if (!client.capabilities.has("browserHistory")) return;
        const context = this.browserHistoryContext(client, connectionId, message);
        const intent = this.browserHistoryIntent();
        if (!context || message.generation !== intent.generation || !browserHistoryConfiguration(intent, context).enabled) return;
        const evidence = message.actorEvidence as Record<string, unknown> | undefined;
        const observedAt = (message.payload as Record<string, unknown> | undefined)?.observedAt;
        if (evidence?.kind === "memmy_command" && typeof evidence.commandId === "string" && typeof observedAt === "number") {
          const dispatched = this.browserHistoryInputs.get(evidence.commandId);
          if (dispatched?.connectionId === connectionId && dispatched.tabId === context.tabId
            && observedAt >= dispatched.sentAt - 100 && observedAt <= dispatched.sentAt + 1_500) {
            context.actorEvidence = { kind: "memmy_command", commandId: evidence.commandId };
          }
        }
        for (const listener of this.browserHistoryListeners) {
          try { listener(message.payload, context); } catch { /* Optional recording cannot interrupt page control. */ }
        }
      } else if (message.type === "playwright_event") {
        const tabId = message.tabId;
        if (!Number.isSafeInteger(tabId) || !client.claims.has(tabId as number)
          || typeof message.leaseId !== 'string' || !/^[a-f0-9]{32}$/.test(message.leaseId)
          || typeof message.method !== 'string' || !/^[A-Za-z]+\.[A-Za-z]+$/.test(message.method)
          || !message.params || typeof message.params !== 'object' || Array.isArray(message.params)
          || (message.sessionId !== undefined && typeof message.sessionId !== 'string')) return;
        const event: ExternalBrowserPlaywrightEvent = {
          leaseId: message.leaseId, method: message.method,
          params: message.params as Record<string, unknown>,
          ...(typeof message.sessionId === 'string' ? { sessionId: message.sessionId } : {}),
        };
        for (const listener of this.playwrightListeners.get(`${connectionId}:${tabId}`) ?? []) listener(event);
      } else if (message.type === "teaching_event" && typeof message.sessionId === "string") {
        for (const listener of this.teachingListeners.get(`${connectionId}:${message.sessionId}`) ?? []) {
          // The source owns validation and durable writes. Its failures must not escape a socket callback.
          try { listener(message); } catch { /* Source records its own terminal failure. */ }
        }
      } else if (message.type === "history_focus") {
        const now = Date.now();
        if (message.browser !== client.browser || typeof message.focused !== "boolean"
          || !Number.isSafeInteger(message.sequence) || (message.sequence as number) <= client.historySequence
          || typeof message.observedAt !== "number" || !Number.isFinite(message.observedAt)
          || message.observedAt <= 0 || message.observedAt > now + 1_000
          || !["normal", "private", "unknown"].includes(String(message.mode))) return;
        const focused = message.focused === true;
        const normal = focused && message.mode === "normal";
        if (focused && (!Number.isSafeInteger(message.tabId) || (message.tabId as number) < 0
          || !Number.isSafeInteger(message.windowId) || (message.windowId as number) < 0)) return;
        if (normal && !isSafePageUrl(message.url)) return;
        client.historySequence = message.sequence as number;
        client.historyFocus = {
          connectionId, browser: client.browser!, focused,
          tabId: focused ? message.tabId as number : null,
          windowId: focused ? message.windowId as number : null,
          title: "", url: normal ? message.url as string : "",
          mode: focused ? message.mode as ExternalBrowserHistoryFocus["mode"] : "unknown",
          observedAt: message.observedAt, receivedAt: now,
        };
        this.onClaimsChanged?.(this.listClaims());
      } else if (message.type === "claim") {
        const tabId = message.tabId;
        if (!Number.isSafeInteger(tabId) || (tabId as number) < 0
          || !isSafePageUrl(message.url)
          || message.browser !== client.browser) return;
        const active = message.active === true;
        if (active) for (const existing of client.claims.values()) existing.active = false;
        client.claims.set(tabId as number, {
          connectionId, tabId: tabId as number,
          browser: message.browser as "chrome" | "edge",
          title: safeText(message.title, 256), url: message.url, active,
          ...(Number.isSafeInteger(message.openerTabId) && (message.openerTabId as number) >= 0
            ? { openerTabId: message.openerTabId as number } : {}),
          claimedAt: client.claims.get(tabId as number)?.claimedAt ?? Date.now(),
        });
        this.onClaimsChanged?.(this.listClaims());
      } else if (message.type === "tab_status") {
        const tabId = message.tabId;
        const status = message.status;
        if (!Number.isSafeInteger(tabId) || (tabId as number) < 0 || message.browser !== client.browser
          || !["ready", "attach_failed", "unsupported", "user_detached", "protected"].includes(String(status))) return;
        if (status === "ready" && !client.claims.has(tabId as number)) return;
        const hidden = status === "protected" || message.protected === true || message.private === true;
        const url = hidden ? "" : safeText(message.url, 4096);
        // Non-HTTP pages are status-only; never turn internal or private pages into claims.
        if (!hidden && status !== "unsupported" && !isSafePageUrl(url)) return;
        if (status === "unsupported" && url && !/^(?:https?:|chrome:|edge:|about:)/.test(url)) return;
        if (message.private === true || status === "unsupported" || status === "user_detached"
          || status === "attach_failed") client.claims.delete(tabId as number);
        client.tabStatuses.set(tabId as number, {
          connectionId, tabId: tabId as number, browser: client.browser!,
          title: hidden ? "受保护页面" : safeText(message.title, 256), url,
          active: !hidden && message.active === true,
          status: status as ExternalBrowserTabStatus["status"],
          reason: safeText(message.reason, 300), updatedAt: Date.now(),
        });
        this.onClaimsChanged?.(this.listClaims());
      } else if (message.type === "tab_removed") {
        if (Number.isSafeInteger(message.tabId)) {
          client.claims.delete(message.tabId as number);
          client.tabStatuses.delete(message.tabId as number);
          this.onClaimsChanged?.(this.listClaims());
        }
      } else if (message.type === "unclaim") {
        if (typeof message.tabId === "number") client.claims.delete(message.tabId);
        if (typeof message.tabId === "number" && client.tabStatuses.get(message.tabId)?.status === "ready") {
          client.tabStatuses.delete(message.tabId);
        }
        this.onClaimsChanged?.(this.listClaims());
      } else if (message.type === "response" && typeof message.id === "string") {
        const pending = this.pending.get(message.id);
        if (!pending || !message.id.startsWith(`${connectionId}:`)) return;
        this.pending.delete(message.id);
        clearTimeout(pending.timer);
        pending.cleanup();
        if (message.ok === true) pending.resolve(message.result);
        else {
          this.browserHistoryInputs.delete(message.id);
          pending.reject(new Error(safeText(message.error, 500) || "External browser command failed"));
        }
      }
    });
    socket.on("close", (code: number) => {
      clearTimeout(helloTimer);
      if (client.authorized && client.browser) this.recordConnection({ stage: 'disconnected',
        browser: client.browser, extensionVersion: client.extensionVersion, closeCode: code }, connectionPort);
      this.clients.delete(connectionId);
      for (const [id, input] of this.browserHistoryInputs) if (input.connectionId === connectionId) this.browserHistoryInputs.delete(id);
      for (const [key, listeners] of this.teachingListeners) if (key.startsWith(`${connectionId}:`)) {
        for (const listener of listeners) { try { listener({ kind: "disconnected" }); } catch { /* Isolate source failures. */ } }
        this.teachingListeners.delete(key);
      }
      for (const [id, pending] of this.pending) {
        if (!id.startsWith(`${connectionId}:`)) continue;
        clearTimeout(pending.timer);
        pending.cleanup();
        pending.reject(new Error("External browser disconnected"));
        this.pending.delete(id);
      }
      this.onClaimsChanged?.(this.listClaims());
    });
  }

  close(): Promise<void> {
    if (this.closeTask) return this.closeTask;
    this.closing = true;
    this.closeTask = this.finishClose();
    return this.closeTask;
  }

  private async finishClose(): Promise<void> {
    for (const waiter of [...this.connectionWaiters]) waiter.finish(false);
    // A listen(0) may still be pending when shutdown begins. Await it before
    // inspecting server.listening so it cannot create a listener after close.
    await this.startTask?.catch(() => undefined);
    for (const client of this.clients.values()) client.socket.close(1001, "Memmy closed");
    for (const pending of this.pending.values()) {
      clearTimeout(pending.timer);
      pending.cleanup();
      pending.reject(new Error("Browser bridge closed"));
    }
    this.pending.clear();
    this.clients.clear();
    this.browserHistoryInputs.clear();
    this.webSockets.close();
    if (this.server.listening) await new Promise<void>(resolve => this.server.close(() => resolve()));
    this.port = 0;
  }
}

// The Agent's browser tools and authenticated settings endpoint share this
// instance. It remains dormant until the desktop-managed runtime starts it.
export const externalBrowserBridge = new ExternalBrowserBridge();
