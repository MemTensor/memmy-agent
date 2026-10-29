import { afterEach, describe, expect, it, vi } from "vitest";
import { MessageBus } from "../../../src/core/runtime-messages/index.js";
import { ChannelManager } from "../../../src/integrations/channels/manager.js";
import { WebSocketChannel } from "../../../src/integrations/channels/websocket.js";

vi.mock("../../../src/tools/computer-history/mac/computer-history-api.js", async (importOriginal) => ({
  ...await importOriginal<typeof import("../../../src/tools/computer-history/mac/computer-history-api.js")>(),
  getComputerHistoryDemoService: () => ({ restoreObservationOnLaunch: vi.fn(async () => undefined) }),
}));

const local = { remoteAddress: "127.0.0.1" };
afterEach(() => vi.restoreAllMocks());

function channel(runtimeReady?: () => boolean, config: Record<string, any> = {}) {
  return new WebSocketChannel({ enabled: true, websocketRequiresToken: true, ...config }, new MessageBus(), {
    runtimeReady,
  });
}

describe("WebSocket core readiness", () => {
  it("keeps legacy standalone bootstrap and one-use WebSocket tokens working without a resolver", () => {
    const ws = channel();
    const response = ws.handleBootstrap(local, { headers: {} });
    expect(response.status).toBe(200);
    const { token } = JSON.parse(String(response.body));
    expect(ws.authorizeWebsocketHandshake(local, { token: [token] })).toBeNull();
    expect(ws.authorizeWebsocketHandshake(local, { token: [token] })?.status).toBe(401);
  });

  it("does not issue or consume tokens while initialization or recovery is pending", () => {
    let ready = false;
    const ws = channel(() => ready);
    expect(ws.handleBootstrap(local, { headers: {} }).status).toBe(503);
    expect(ws.issuedTokens.size).toBe(0);
    expect(ws.apiTokens.size).toBe(0);
    expect(ws.authorizeWebsocketHandshake(local, {})?.status).toBe(503);
    ready = true;
    const { token } = JSON.parse(String(ws.handleBootstrap(local, { headers: {} }).body));
    ready = false;
    expect(ws.authorizeWebsocketHandshake(local, { token: [token] })?.status).toBe(503);
    expect(ws.issuedTokens.has(token)).toBe(true);
    ready = true;
    expect(ws.authorizeWebsocketHandshake(local, { token: [token] })).toBeNull();
    expect(ws.issuedTokens.has(token)).toBe(false);
  });

  it("preserves existing static-token and bootstrap-secret authentication after readiness", () => {
    let ready = false;
    const ws = channel(() => ready, { token: "existing-static-token" });
    const headers = { "X-Memmy-Agent-Auth": "existing-static-token" };
    expect(ws.handleBootstrap(local, { headers: {} }).status).toBe(401);
    expect(ws.handleBootstrap(local, { headers }).status).toBe(503);
    ready = true;
    expect(ws.handleBootstrap(local, { headers }).status).toBe(200);
    expect(ws.authorizeWebsocketHandshake(local, { token: ["existing-static-token"] })).toBeNull();
    expect(ws.authorizeWebsocketHandshake(local, { token: ["wrong-token"] })?.status).toBe(401);
  });

  it("withholds bootstrap and upgrades if the readiness resolver throws", () => {
    const ws = channel(() => { throw new Error("runtime unavailable"); });
    expect(ws.handleBootstrap(local, { headers: {} }).status).toBe(503);
    expect(ws.authorizeWebsocketHandshake(local, {})?.status).toBe(503);
    expect(ws.issuedTokens.size).toBe(0);
  });

  it("propagates the live resolver through ChannelManager to configured WebSocket channels", () => {
    let ready = false;
    const manager = new ChannelManager({ channels: { websocket: { enabled: true } } }, new MessageBus(), {
      webuiRuntimeReady: () => ready,
    });
    const ws = manager.getChannel("websocket") as WebSocketChannel;
    expect(ws.handleBootstrap(local, { headers: {} }).status).toBe(503);
    ready = true;
    expect(ws.handleBootstrap(local, { headers: {} }).status).toBe(200);
    ready = false;
    expect(ws.authorizeWebsocketHandshake(local, {})?.status).toBe(503);
  });

  it("returns 503 on the actual HTTP dispatch paths until the core is ready", async () => {
    let ready = false;
    const ws = channel(() => ready, { websocketRequiresToken: false });
    const upgrade = { path: "/", headers: { upgrade: "websocket", connection: "Upgrade" } };
    expect((await ws.dispatchHttp(local, { path: "/webui/bootstrap", headers: {} }))?.status).toBe(503);
    expect((await ws.dispatchHttp(local, upgrade))?.status).toBe(503);
    ready = true;
    expect((await ws.dispatchHttp(local, { path: "/webui/bootstrap", headers: {} }))?.status).toBe(200);
    expect(await ws.dispatchHttp(local, upgrade)).toBeNull();
  });
});
