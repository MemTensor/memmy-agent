import { randomBytes } from "node:crypto";
import http from "node:http";
import { WebSocket, WebSocketServer } from "ws";

// Derived from the public key in the packaged MV3 manifest. The private key is
// not needed to load an unpacked extension and is deliberately not distributed.
export const MEMMY_BROWSER_EXTENSION_ID = "mhodbgbbgalbhehapffidmdegokpoaom";
const EXTENSION_ORIGIN = `chrome-extension://${MEMMY_BROWSER_EXTENSION_ID}`;
// The unpacked extension probes these loopback ports. Keep them aligned with
// BRIDGE_PORTS in App/shell/desktop/extensions/memmy-browser/background.js.
export const EXTERNAL_BROWSER_BRIDGE_PORTS = [47321, 47322, 47323] as const;
const MAX_MESSAGE_BYTES = 8 * 1024 * 1024;
const COMMAND_TIMEOUT_MS = 30_000;

export type ExternalBrowserClaim = {
  connectionId: string;
  tabId: number;
  browser: "chrome" | "edge" | "memmy";
  title: string;
  url: string;
  active?: boolean;
  claimedAt: number;
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
  claims: Map<number, ExternalBrowserClaim>;
};

function isSafePageUrl(value: unknown): value is string {
  if (typeof value !== "string" || value.length > 4096) return false;
  try { return ["http:", "https:"].includes(new URL(value).protocol); }
  catch { return false; }
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
  private nextId = 1;
  private port = 0;

  constructor(private readonly onClaimsChanged?: (claims: ExternalBrowserClaim[]) => void) {
    this.server.on("upgrade", (request, socket, head) => {
      const remote = request.socket.remoteAddress;
      const local = remote === "127.0.0.1" || remote === "::1" || remote === "::ffff:127.0.0.1";
      if (!local || request.headers.origin !== EXTENSION_ORIGIN || request.url !== "/extension") {
        socket.destroy();
        return;
      }
      this.webSockets.handleUpgrade(request, socket, head, client => this.accept(client));
    });
  }

  async start(requestedPort?: number): Promise<{ port: number }> {
    if (this.port) return { port: this.port };
    const candidates = requestedPort === undefined ? [...EXTERNAL_BROWSER_BRIDGE_PORTS] : [requestedPort];
    let lastError: unknown;
    for (const candidate of candidates) {
      try {
        await this.listen(candidate);
        return { port: this.port };
      } catch (error) { lastError = error; }
    }
    throw lastError instanceof Error ? lastError : new Error("browser bridge failed to bind loopback");
  }

  listConnected(): Array<"chrome" | "edge"> {
    return [...new Set([...this.clients.values()].flatMap(client =>
      client.authorized && client.browser ? [client.browser] : []))];
  }

  private listen(port: number): Promise<void> {
    return new Promise((resolve, reject) => {
      const onError = (error: Error) => {
        this.server.off("listening", onListening);
        reject(error);
      };
      const onListening = () => {
        this.server.off("error", onError);
        const address = this.server.address();
        if (!address || typeof address === "string") {
          reject(new Error("browser bridge failed to bind loopback"));
          return;
        }
        this.port = address.port;
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

  getClaim(identity: Pick<ExternalBrowserClaim, "connectionId" | "tabId">): ExternalBrowserClaim | null {
    return this.clients.get(identity.connectionId)?.claims.get(identity.tabId) ?? null;
  }

  async command(claim: Pick<ExternalBrowserClaim, "connectionId" | "tabId">,
    command: string, args: Record<string, unknown> = {}, signal?: AbortSignal): Promise<unknown> {
    const client = this.clients.get(claim.connectionId);
    if (!client?.authorized || !client.claims.has(claim.tabId)
      || client.socket.readyState !== WebSocket.OPEN) {
      throw new Error("External browser tab is no longer connected or claimed");
    }
    const id = `${claim.connectionId}:${this.nextId++}`;
    if (signal?.aborted) throw new Error("External browser command cancelled");
    const result = new Promise<unknown>((resolve, reject) => {
      const cleanup = () => signal?.removeEventListener("abort", onAbort);
      const onAbort = () => {
        const pending = this.pending.get(id);
        if (!pending) return;
        this.pending.delete(id);
        clearTimeout(timer);
        cleanup();
        try { if (client.socket.readyState === WebSocket.OPEN) client.socket.send(JSON.stringify({ type: "cancel", id })); }
        catch { /* The rejected command is already cancelled locally. */ }
        reject(new Error("External browser command cancelled"));
      };
      const timer = setTimeout(() => {
        this.pending.delete(id);
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
        pending.reject(error instanceof Error ? error : new Error("External browser disconnected")); }
    }
    return result;
  }

  private accept(socket: WebSocket): void {
    const connectionId = randomBytes(12).toString("hex");
    const client: Client = { socket, authorized: false, browser: null, claims: new Map() };
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
        socket.send(JSON.stringify({ type: "ready", connectionId }));
        this.onClaimsChanged?.(this.listClaims());
        return;
      }
      if (message.type === "claim") {
        const tabId = message.tabId;
        if (!Number.isSafeInteger(tabId) || (tabId as number) < 0
          || !isSafePageUrl(message.url)
          || !["chrome", "edge"].includes(String(message.browser))) return;
        const active = message.active === true;
        if (active) for (const existing of client.claims.values()) existing.active = false;
        client.claims.set(tabId as number, {
          connectionId, tabId: tabId as number,
          browser: message.browser as "chrome" | "edge",
          title: safeText(message.title, 256), url: message.url, active,
          claimedAt: client.claims.get(tabId as number)?.claimedAt ?? Date.now(),
        });
        this.onClaimsChanged?.(this.listClaims());
      } else if (message.type === "unclaim") {
        if (typeof message.tabId === "number") client.claims.delete(message.tabId);
        this.onClaimsChanged?.(this.listClaims());
      } else if (message.type === "response" && typeof message.id === "string") {
        const pending = this.pending.get(message.id);
        if (!pending || !message.id.startsWith(`${connectionId}:`)) return;
        this.pending.delete(message.id);
        clearTimeout(pending.timer);
        pending.cleanup();
        if (message.ok === true) pending.resolve(message.result);
        else pending.reject(new Error(safeText(message.error, 500) || "External browser command failed"));
      }
    });
    socket.on("close", () => {
      clearTimeout(helloTimer);
      this.clients.delete(connectionId);
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

  async close(): Promise<void> {
    for (const client of this.clients.values()) client.socket.close(1001, "Memmy closed");
    for (const pending of this.pending.values()) {
      clearTimeout(pending.timer);
      pending.cleanup();
      pending.reject(new Error("Browser bridge closed"));
    }
    this.pending.clear();
    this.clients.clear();
    this.webSockets.close();
    if (this.server.listening) await new Promise<void>(resolve => this.server.close(() => resolve()));
    this.port = 0;
  }
}

// The Agent's browser tools and authenticated settings endpoint share this
// instance. It remains dormant until the desktop-managed runtime starts it.
export const externalBrowserBridge = new ExternalBrowserBridge();
