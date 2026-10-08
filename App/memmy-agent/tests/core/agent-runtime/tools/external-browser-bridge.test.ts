import { afterEach, describe, expect, it } from "vitest";
import { WebSocket } from "ws";
import { ExternalBrowserBridge, MEMMY_BROWSER_EXTENSION_ID } from "../../../../src/core/agent-runtime/tools/external-browser-bridge.js";

const origin = `chrome-extension://${MEMMY_BROWSER_EXTENSION_ID}`;
const bridges: ExternalBrowserBridge[] = [];
const clients: WebSocket[] = [];

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
});

describe("external browser bridge", () => {
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
});
