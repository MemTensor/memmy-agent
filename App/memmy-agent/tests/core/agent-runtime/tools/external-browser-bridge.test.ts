import http from "node:http";
import net from "node:net";
import { afterEach, describe, expect, it, vi } from "vitest";
import { WebSocket } from "ws";
import { ExternalBrowserBridge, EXTERNAL_BROWSER_BRIDGE_PORTS, MEMMY_BROWSER_EXTENSION_ID } from "../../../../src/core/agent-runtime/tools/external-browser-bridge.js";

const origin = `chrome-extension://${MEMMY_BROWSER_EXTENSION_ID}`;
const bridges: ExternalBrowserBridge[] = [];
const clients: WebSocket[] = [];

async function unusedIsolatedPort(): Promise<number> {
  for (;;) {
    const server = net.createServer();
    const port = await new Promise<number>((resolve, reject) => {
      server.once("error", reject);
      server.listen(0, "127.0.0.1", () => {
        const address = server.address();
        if (!address || typeof address === "string") { reject(new Error("No loopback port assigned")); return; }
        server.close(error => error ? reject(error) : resolve(address.port));
      });
    });
    if (!EXTERNAL_BROWSER_BRIDGE_PORTS.some(candidate => candidate === port)) return port;
  }
}

function connected(url: string, suppliedOrigin: string): Promise<WebSocket> {
  return new Promise((resolve, reject) => {
    const socket = new WebSocket(url, { origin: suppliedOrigin });
    clients.push(socket);
    socket.once("open", () => resolve(socket));
    socket.once("error", reject);
  });
}

function nextMessage(socket: WebSocket): Promise<any> {
  return new Promise((resolve, reject) => {
    socket.once("message", data => {
      try { resolve(JSON.parse(String(data))); } catch (error) { reject(error); }
    });
  });
}

afterEach(async () => {
  for (const client of clients.splice(0)) client.terminate();
  await Promise.all(bridges.splice(0).map(bridge => bridge.close()));
  vi.unstubAllEnvs();
});

describe("external browser bridge", () => {
  it('closes a pending startup without leaving a late loopback listener', async () => {
    const bridge = new ExternalBrowserBridge(); bridges.push(bridge);
    const started = expect(bridge.start(0)).rejects.toThrow(/closed/);
    await Promise.all([bridge.close(), bridge.close()]);
    await started;
    expect((bridge as any).server.listening).toBe(false);
    expect(bridge.connectionDiagnostics().port).toBe(0);
    await expect(bridge.waitForConnection('chrome', 60_000)).resolves.toBe(false);
    await expect(bridge.start(0)).rejects.toThrow(/closed/);
  });

  it.each(['chrome', 'edge'] as const)("waits for the requested %s handshake without requiring a web page", async browser => {
    const bridge = new ExternalBrowserBridge(); bridges.push(bridge);
    const { port } = await bridge.start(0);
    const waiting = bridge.waitForConnection(browser, 1_000);
    const other = await connected(`ws://127.0.0.1:${port}/extension`, origin);
    const otherReady = nextMessage(other);
    other.send(JSON.stringify({ type: 'hello', browser: browser === 'chrome' ? 'edge' : 'chrome' }));
    await otherReady;
    expect((bridge as any).connectionWaiters.size).toBe(1);
    const requested = await connected(`ws://127.0.0.1:${port}/extension`, origin);
    const ready = nextMessage(requested);
    requested.send(JSON.stringify({ type: 'hello', browser, extensionVersion: '1.0.12' }));
    await expect(ready).resolves.toMatchObject({ type: 'ready', heartbeat: true });
    await expect(waiting).resolves.toBe(true);
    expect((bridge as any).connectionWaiters.size).toBe(0);
    expect(bridge.listClaims()).toEqual([]);
    await expect(bridge.waitForConnection(browser, 60_000)).resolves.toBe(true);
    const pong = nextMessage(requested);
    requested.send(JSON.stringify({ type: 'ping' }));
    await expect(pong).resolves.toEqual({ type: 'pong' });
    expect(bridge.connectionDiagnostics()).toMatchObject({ port, events: [
      expect.objectContaining({ stage: 'listening' }),
      expect.objectContaining({ stage: 'connected' }),
      expect.objectContaining({ stage: 'connected', browser, extensionVersion: '1.0.12' }),
    ] });
  });

  it("bounds and cancels connection waits and releases them when the bridge closes", async () => {
    const bridge = new ExternalBrowserBridge(); bridges.push(bridge);
    await bridge.start(0);
    await expect(bridge.waitForConnection('chrome', 5)).resolves.toBe(false);
    const abort = new AbortController();
    const waiting = bridge.waitForConnection('chrome', 60_000, abort.signal);
    abort.abort();
    await expect(waiting).rejects.toThrow(/canceled/);
    await expect(bridge.waitForConnection('chrome', 60_000, abort.signal)).rejects.toThrow(/canceled/);
    expect((bridge as any).connectionWaiters.size).toBe(0);
    const closing = bridge.waitForConnection('edge', 60_000);
    await bridge.close();
    await expect(closing).resolves.toBe(false);
    expect((bridge as any).connectionWaiters.size).toBe(0);
  });

  it("serializes simultaneous startup and records only bounded connection metadata", async () => {
    const bridge = new ExternalBrowserBridge(); bridges.push(bridge);
    const [first, second] = await Promise.all([bridge.start(0), bridge.start(0)]);
    expect(first.port).toBe(second.port);
    const socket = await connected(`ws://127.0.0.1:${first.port}/extension`, origin);
    const ready = nextMessage(socket);
    socket.send(JSON.stringify({ type: 'hello', browser: 'chrome', extensionVersion: 'secret.invalid.version',
      title: 'private-title', url: 'https://private.test/', token: 'private-token' }));
    await ready;
    socket.close(1000);
    await vi.waitFor(() => expect(bridge.listConnected()).toEqual([]));
    const diagnostic = JSON.stringify(bridge.connectionDiagnostics());
    for (const secret of ['secret.invalid.version', 'private-title', 'private.test', 'private-token']) {
      expect(diagnostic).not.toContain(secret);
    }
    expect(bridge.connectionDiagnostics().events.at(-1)).toMatchObject({ stage: 'disconnected', browser: 'chrome', closeCode: 1000 });
  });

  it("does not treat the v1 completeness flag as support for document handoff", async () => {
    const bridge = new ExternalBrowserBridge(); bridges.push(bridge);
    const {port} = await bridge.start(0), socket = await connected(`ws://127.0.0.1:${port}/extension`, origin);
    const ready = nextMessage(socket);
    socket.send(JSON.stringify({type: "hello", browser: "edge", capabilities: ["teachingCapture/v1"]}));
    const {connectionId} = await ready;
    expect(bridge.listTeachingProfiles()[0]?.supported).toBe(false);
    await expect(bridge.teachingCommand(connectionId, "session-a", "prepare")).rejects.toThrow("v2");
  });
  it("routes teaching commands and observations to the exact extension connection and expires them on disconnect", async () => {
    const bridge = new ExternalBrowserBridge(); bridges.push(bridge);
    const { port } = await bridge.start(0);
    const first = await connected(`ws://127.0.0.1:${port}/extension`, origin);
    const firstReady = nextMessage(first);
    first.send(JSON.stringify({ type: "hello", browser: "chrome", capabilities: ["teachingCapture/v2"] }));
    const personal = (await firstReady).connectionId;
    const second = await connected(`ws://127.0.0.1:${port}/extension`, origin);
    const secondReady = nextMessage(second);
    second.send(JSON.stringify({ type: "hello", browser: "chrome", capabilities: ["teachingCapture/v2"] }));
    const work = (await secondReady).connectionId;
    expect(bridge.listTeachingProfiles().map(profile => profile.connectionId)).toEqual([personal, work]);
    const observation = vi.fn(), off = bridge.subscribeTeaching(work, "session-a", observation);
    const request = nextMessage(second), result = bridge.teachingCommand(work, "session-a", "prepare", {});
    const command = await request;
    expect(command).toMatchObject({ type: "teaching_command", sessionId: "session-a", action: "prepare" });
    first.send(JSON.stringify({ type: "response", id: command.id, ok: true, result: { windowId: 999 } }));
    first.send(JSON.stringify({ type: "teaching_event", sessionId: "session-a", kind: "event" }));
    second.send(JSON.stringify({ type: "response", id: command.id, ok: true, result: { windowId: 20 } }));
    expect(await result).toEqual({ windowId: 20 }); expect(observation).not.toHaveBeenCalled();
    second.send(JSON.stringify({ type: "teaching_event", sessionId: "session-a", kind: "document", tabId: 8 }));
    await vi.waitFor(() => expect(observation).toHaveBeenCalledOnce());
    second.terminate();
    await vi.waitFor(() => expect(observation).toHaveBeenLastCalledWith({ kind: "disconnected" }));
    await expect(bridge.teachingCommand(work, "session-a", "start")).rejects.toThrow("disconnected"); off();
  });
  it("tracks fresh history focus separately from persistent Computer Use claims", async () => {
    const bridge = new ExternalBrowserBridge(); bridges.push(bridge);
    const { port } = await bridge.start(0);
    const socket = await connected(`ws://127.0.0.1:${port}/extension`, origin);
    const ready = nextMessage(socket);
    socket.send(JSON.stringify({ type: "hello", browser: "chrome" }));
    const { connectionId } = await ready;
    socket.send(JSON.stringify({ type: "claim", browser: "chrome", tabId: 7, active: true,
      title: "Old page", url: "https://allowed.test/" }));
    await vi.waitFor(() => expect(bridge.listClaims()).toHaveLength(1));
    expect(bridge.listHistoryFocusObservations()).toEqual([]);
    const observedAt = Date.now() - 2_000;
    socket.send(JSON.stringify({ type: "history_focus", browser: "chrome", sequence: 1,
      observedAt, focused: true, mode: "normal", tabId: 8, windowId: 3,
      title: "Current page", url: "https://current.test/" }));
    await vi.waitFor(() => expect(bridge.listHistoryFocusObservations()).toHaveLength(1));
    expect(bridge.listHistoryFocusObservations()).toMatchObject([{ connectionId, browser: "chrome",
      focused: true, tabId: 8, windowId: 3, url: "https://current.test/", observedAt }]);
    expect(bridge.listClaims()).toMatchObject([{ tabId: 7, active: true }]);
    // Focus loss must invalidate history even though the old tab stays usable by tools.
    socket.send(JSON.stringify({ type: "history_focus", browser: "chrome", sequence: 2,
      observedAt: Date.now(), focused: false, mode: "unknown" }));
    await vi.waitFor(() => expect(bridge.listHistoryFocusObservations()[0]?.focused).toBe(false));
    expect(bridge.listHistoryFocusObservations()[0]).toMatchObject({ tabId: null, windowId: null, title: "", url: "" });
    expect(bridge.listClaims()).toHaveLength(1);
    socket.terminate();
    await vi.waitFor(() => expect(bridge.listHistoryFocusObservations()).toEqual([]));
  });

  it("rejects replayed or mismatched history identity and redacts private focus metadata", async () => {
    const bridge = new ExternalBrowserBridge(); bridges.push(bridge);
    const { port } = await bridge.start(0);
    const socket = await connected(`ws://127.0.0.1:${port}/extension`, origin);
    const ready = nextMessage(socket);
    socket.send(JSON.stringify({ type: "hello", browser: "edge" })); await ready;
    const message = { type: "history_focus", browser: "edge", sequence: 4, observedAt: Date.now(),
      focused: true, mode: "private", tabId: 7, windowId: 1, title: "secret", url: "https://secret.test/" };
    socket.send(JSON.stringify({ ...message, browser: "chrome" }));
    socket.send(JSON.stringify({ ...message, windowId: null }));
    socket.send(JSON.stringify({ ...message, observedAt: Date.now() + 60_000 }));
    await new Promise(resolve => setTimeout(resolve, 10));
    expect(bridge.listHistoryFocusObservations()).toEqual([]);
    socket.send(JSON.stringify(message));
    await vi.waitFor(() => expect(bridge.listHistoryFocusObservations()).toHaveLength(1));
    expect(bridge.listHistoryFocusObservations()[0]).toMatchObject({ mode: "private", title: "", url: "" });
    socket.send(JSON.stringify({ ...message, sequence: 3, mode: "normal", url: "https://old.test/" }));
    await new Promise(resolve => setTimeout(resolve, 10));
    expect(bridge.listHistoryFocusObservations()[0]?.mode).toBe("private");
  });
  it("binds the configured isolated port instead of extension discovery ports", async () => {
    const isolatedPort = await unusedIsolatedPort();
    vi.stubEnv("MEMMY_EXTERNAL_BROWSER_BRIDGE_PORT", String(isolatedPort));
    const bridge = new ExternalBrowserBridge(); bridges.push(bridge);
    const { port } = await bridge.start();
    expect(port).toBe(isolatedPort);
    const socket = await connected(`ws://127.0.0.1:${isolatedPort}/extension`, origin);
    const ready = nextMessage(socket);
    socket.send(JSON.stringify({ type: "hello", browser: "chrome" }));
    await expect(ready).resolves.toMatchObject({ type: "ready" });
  });

  it.each(["", "0", "65536", "-1", "3.5", "1e3", " 47321", "NaN"])
    ("rejects invalid configured port %j before listening", async value => {
      vi.stubEnv("MEMMY_EXTERNAL_BROWSER_BRIDGE_PORT", value);
      const listen = vi.spyOn(http.Server.prototype, "listen");
      const bridge = new ExternalBrowserBridge(); bridges.push(bridge);
      await expect(bridge.start()).rejects.toThrow(/integer from 1 to 65535/);
      expect(listen).not.toHaveBeenCalled();
      // An explicit caller port keeps its existing behavior, including ephemeral 0.
      const { port } = await bridge.start(0);
      expect(port).toBeGreaterThan(0);
      const socket = await connected(`ws://127.0.0.1:${port}/extension`, origin);
      const ready = nextMessage(socket);
      socket.send(JSON.stringify({ type: "hello", browser: "edge" }));
      await expect(ready).resolves.toMatchObject({ type: "ready" });
    });

  it("accepts only the packaged extension origin", async () => {
    const bridge = new ExternalBrowserBridge(); bridges.push(bridge);
    const { port } = await bridge.start(0);
    await expect(connected(`ws://127.0.0.1:${port}/extension`, "https://example.test"))
      .rejects.toThrow();
    const socket = await connected(`ws://127.0.0.1:${port}/extension`, origin);
    const closed = new Promise(resolve => socket.once("close", resolve));
    socket.send(JSON.stringify({ type: "hello" }));
    await closed;
    expect(bridge.listClaims()).toEqual([]);
    expect(bridge.listConnected()).toEqual([]);
  });

  it("exposes only explicitly claimed tabs, routes commands, and revokes on disconnect", async () => {
    const changes: number[] = [];
    const bridge = new ExternalBrowserBridge(claims => changes.push(claims.length));
    bridges.push(bridge);
    const { port } = await bridge.start(0);
    const socket = await connected(`ws://127.0.0.1:${port}/extension`, origin);
    const ready = nextMessage(socket);
    socket.send(JSON.stringify({ type: "hello", browser: "edge" }));
    const { connectionId } = await ready;
    expect(bridge.listClaims()).toEqual([]);
    socket.send(JSON.stringify({ type: "claim", tabId: 7, title: "Local test", url: "http://127.0.0.1:8080/", browser: "edge" }));
    await new Promise(resolve => setTimeout(resolve, 10));
    expect(bridge.listClaims()).toMatchObject([{ connectionId, tabId: 7, browser: "edge" }]);
    expect(bridge.listConnected()).toEqual(["edge"]);
    await expect(bridge.command({ connectionId, tabId: 8 }, "snapshot"))
      .rejects.toThrow(/no longer connected or claimed/);
    const received = nextMessage(socket);
    const result = bridge.command({ connectionId, tabId: 7 }, "snapshot");
    const request = await received;
    expect(request).toMatchObject({ type: "command", tabId: 7, command: "snapshot" });
    socket.send(JSON.stringify({ type: "response", id: request.id, ok: true, result: { nodes: [] } }));
    await expect(result).resolves.toEqual({ nodes: [] });
    socket.terminate();
    await new Promise(resolve => setTimeout(resolve, 10));
    expect(bridge.listClaims()).toEqual([]);
    expect(changes).toContain(1);
    expect(changes.at(-1)).toBe(0);
  });

  it("keeps only a valid opener tab ID on page claims", async () => {
    const bridge = new ExternalBrowserBridge(); bridges.push(bridge);
    const { port } = await bridge.start(0);
    const socket = await connected(`ws://127.0.0.1:${port}/extension`, origin);
    const ready = nextMessage(socket);
    socket.send(JSON.stringify({ type: "hello", browser: "chrome" }));
    await ready;
    socket.send(JSON.stringify({ type: "claim", browser: "chrome", tabId: 8, openerTabId: 7,
      title: "官网", url: "https://example.test/" }));
    socket.send(JSON.stringify({ type: "claim", browser: "chrome", tabId: 9, openerTabId: "7",
      title: "其他", url: "https://example.test/other" }));
    await new Promise(resolve => setTimeout(resolve, 10));
    expect(bridge.listClaims().find(claim => claim.tabId === 8)).toMatchObject({ openerTabId: 7 });
    expect(bridge.listClaims().find(claim => claim.tabId === 9)).not.toHaveProperty("openerTabId");
  });

  it("rejects claimed internal pages and cannot accept a response from another connection", async () => {
    const bridge = new ExternalBrowserBridge(); bridges.push(bridge);
    const { port } = await bridge.start(0);
    const first = await connected(`ws://127.0.0.1:${port}/extension`, origin);
    const firstReady = nextMessage(first);
    first.send(JSON.stringify({ type: "hello", browser: "chrome" }));
    const { connectionId } = await firstReady;
    first.send(JSON.stringify({ type: "claim", tabId: 1, title: "Settings", url: "chrome://settings", browser: "chrome" }));
    await new Promise(resolve => setTimeout(resolve, 10));
    expect(bridge.listClaims()).toEqual([]);
    first.send(JSON.stringify({ type: "claim", tabId: 1, title: "Test", url: "https://example.test/", browser: "chrome" }));
    await new Promise(resolve => setTimeout(resolve, 10));
    const second = await connected(`ws://127.0.0.1:${port}/extension`, origin);
    const secondReady = nextMessage(second);
    second.send(JSON.stringify({ type: "hello", browser: "chrome" }));
    await secondReady;
    const received = nextMessage(first);
    const result = bridge.command({ connectionId, tabId: 1 }, "snapshot");
    const request = await received;
    second.send(JSON.stringify({ type: "response", id: request.id, ok: true, result: "wrong" }));
    first.send(JSON.stringify({ type: "response", id: request.id, ok: true, result: "right" }));
    await expect(result).resolves.toBe("right");
  });

  it('cancels an in-flight upload and ignores a late extension response', async () => {
    const bridge = new ExternalBrowserBridge(); bridges.push(bridge);
    const { port } = await bridge.start(0);
    const socket = await connected(`ws://127.0.0.1:${port}/extension`, origin);
    const ready = nextMessage(socket);
    socket.send(JSON.stringify({ type: 'hello', browser: 'chrome' }));
    const { connectionId } = await ready;
    socket.send(JSON.stringify({ type: 'claim', tabId: 7, title: 'Form',
      url: 'https://example.test/form', browser: 'chrome' }));
    await new Promise(resolve => setTimeout(resolve, 10));
    const controller = new AbortController();
    const received = nextMessage(socket);
    const result = bridge.command({ connectionId, tabId: 7 }, 'upload', {}, controller.signal);
    const rejected = expect(result).rejects.toThrow(/cancelled/);
    const request = await received;
    const cancelled = nextMessage(socket);
    controller.abort();
    expect(await cancelled).toMatchObject({ type: 'cancel', id: request.id });
    await rejected;
    socket.send(JSON.stringify({ type: 'response', id: request.id, ok: true, result: { uploaded: 1 } }));
    await expect(bridge.command({ connectionId, tabId: 7 }, 'snapshot', {}, controller.signal))
      .rejects.toThrow(/cancelled/);
  });

  it("keeps connection, page readiness, and failure status distinct", async () => {
    const bridge = new ExternalBrowserBridge(); bridges.push(bridge);
    const { port } = await bridge.start(0);
    const socket = await connected(`ws://127.0.0.1:${port}/extension`, origin);
    const ready = nextMessage(socket);
    socket.send(JSON.stringify({ type: "hello", browser: "edge" }));
    await ready;
    socket.send(JSON.stringify({ type: "tab_status", browser: "edge", tabId: 7,
      title: "百度", url: "https://www.baidu.com/", status: "attach_failed", reason: "调试会话占用" }));
    socket.send(JSON.stringify({ type: "tab_status", browser: "edge", tabId: 8,
      title: "设置", url: "edge://extensions/", status: "unsupported", reason: "内部页面不支持" }));
    socket.send(JSON.stringify({ type: "tab_status", browser: "edge", tabId: 9,
      title: "未声明", url: "https://example.test/", status: "ready" }));
    await new Promise(resolve => setTimeout(resolve, 10));
    expect(bridge.listConnected()).toEqual(["edge"]);
    expect(bridge.listClaims()).toEqual([]);
    expect(bridge.listTabStatuses()).toMatchObject([
      { tabId: 7, browser: "edge", status: "attach_failed", reason: "调试会话占用" },
      { tabId: 8, status: "unsupported", url: "edge://extensions/" },
    ]);
    socket.send(JSON.stringify({ type: "claim", browser: "edge", tabId: 7,
      title: "百度", url: "https://www.baidu.com/" }));
    socket.send(JSON.stringify({ type: "tab_status", browser: "edge", tabId: 7,
      title: "百度", url: "https://www.baidu.com/", status: "ready", reason: "已就绪" }));
    await new Promise(resolve => setTimeout(resolve, 10));
    expect(bridge.listClaims()).toHaveLength(1);
    expect(bridge.listTabStatuses().find(tab => tab.tabId === 7)?.status).toBe("ready");
    socket.send(JSON.stringify({ type: "tab_removed", tabId: 7 }));
    await new Promise(resolve => setTimeout(resolve, 10));
    expect(bridge.listClaims()).toEqual([]);
    expect(bridge.listTabStatuses()).toHaveLength(1);
  });

  it("waits for refreshed page claims to register and targets only the requested browser", async () => {
    const bridge = new ExternalBrowserBridge(); bridges.push(bridge);
    const { port } = await bridge.start(0);
    const edge = await connected(`ws://127.0.0.1:${port}/extension`, origin);
    const edgeReady = nextMessage(edge);
    edge.send(JSON.stringify({ type: "hello", browser: "edge" }));
    await edgeReady;
    const chrome = await connected(`ws://127.0.0.1:${port}/extension`, origin);
    const chromeReady = nextMessage(chrome);
    chrome.send(JSON.stringify({ type: "hello", browser: "chrome" }));
    await chromeReady;
    const chromeMessage = vi.fn(); chrome.on("message", chromeMessage);
    const refreshed = nextMessage(edge);
    const work = bridge.refreshTabs("edge");
    const request = await refreshed;
    expect(request).toMatchObject({ type: "refresh_tabs" });
    edge.send(JSON.stringify({ type: "claim", browser: "edge", tabId: 7,
      title: "百度", url: "https://www.baidu.com/" }));
    edge.send(JSON.stringify({ type: "response", id: request.id, ok: true }));
    await work;
    expect(bridge.listClaims()).toMatchObject([{ browser: "edge", tabId: 7 }]);
    expect(chromeMessage).not.toHaveBeenCalled();
  });

  it("opens a background tab beside the source page and returns it once the extension offers it", async () => {
    const bridge = new ExternalBrowserBridge(); bridges.push(bridge);
    const { port } = await bridge.start(0);
    const edge = await connected(`ws://127.0.0.1:${port}/extension`, origin);
    const ready = nextMessage(edge);
    edge.send(JSON.stringify({ type: "hello", browser: "edge", capabilities: ["openTab"] }));
    const { connectionId } = await ready;
    edge.send(JSON.stringify({ type: "claim", browser: "edge", tabId: 7, title: "百度", url: "https://www.baidu.com/" }));
    await vi.waitFor(() => expect(bridge.listClaims()).toHaveLength(1));
    const requested = nextMessage(edge);
    const opening = bridge.openBrowserTab("edge", "https://www.taobao.com/", { connectionId, tabId: 7 });
    const request = await requested;
    expect(request).toMatchObject({ type: "open_tab", url: "https://www.taobao.com/", sourceTabId: 7 });
    edge.send(JSON.stringify({ type: "claim", browser: "edge", tabId: 8, title: "淘宝",
      url: "https://www.taobao.com/", openerTabId: 7 }));
    edge.send(JSON.stringify({ type: "response", id: request.id, ok: true, result: { tabId: 8 } }));
    await expect(opening).resolves.toMatchObject({ connectionId, tabId: 8, browser: "edge", openerTabId: 7 });
    await expect(bridge.openBrowserTab("chrome", "https://www.taobao.com/")).rejects.toThrow(/chrome is not connected/);
  });

  it("asks for an extension update instead of waiting when the installed copy cannot open tabs", async () => {
    const bridge = new ExternalBrowserBridge(); bridges.push(bridge);
    const { port } = await bridge.start(0);
    const chrome = await connected(`ws://127.0.0.1:${port}/extension`, origin);
    const ready = nextMessage(chrome);
    chrome.send(JSON.stringify({ type: "hello", browser: "chrome" }));
    await ready;
    const sent = vi.fn(); chrome.on("message", sent);
    await expect(bridge.openBrowserTab("chrome", "https://www.taobao.com/")).rejects.toThrow(/too old to open tabs/);
    expect(sent).not.toHaveBeenCalled();
  });

  it("redacts private and protected status metadata and rejects browser identity mismatch", async () => {
    const bridge = new ExternalBrowserBridge(); bridges.push(bridge);
    const { port } = await bridge.start(0);
    const socket = await connected(`ws://127.0.0.1:${port}/extension`, origin);
    const ready = nextMessage(socket);
    socket.send(JSON.stringify({ type: "hello", browser: "chrome" }));
    await ready;
    socket.send(JSON.stringify({ type: "tab_status", browser: "chrome", tabId: 7,
      title: "secret", url: "https://secret.test/", status: "protected", reason: "登录信息受保护" }));
    socket.send(JSON.stringify({ type: "tab_status", browser: "chrome", tabId: 8,
      title: "private", url: "https://private.test/", status: "unsupported", private: true, reason: "私密页面" }));
    socket.send(JSON.stringify({ type: "claim", browser: "edge", tabId: 9,
      title: "wrong browser", url: "https://example.test/" }));
    await new Promise(resolve => setTimeout(resolve, 10));
    expect(bridge.listClaims()).toEqual([]);
    expect(bridge.listTabStatuses()).toMatchObject([
      { tabId: 7, status: "protected", title: "受保护页面", url: "" },
      { tabId: 8, status: "unsupported", title: "受保护页面", url: "" },
    ]);
  });
});
