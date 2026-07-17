/** Channels routes tests. */
import { afterEach, describe, expect, it, vi } from "vitest";
import { createProgressBus } from "../../../../services/progress-bus.js";
import { createLocalApiServer } from "../server.js";
import type { FastifyInstance } from "fastify";
import type { PermissionManager } from "../../../../permission/index.js";
import type { BackendServices } from "../../../../services/index.js";

let app: FastifyInstance | undefined;

afterEach(async () => {
  await app?.close();
  app = undefined;
});

describe("channels local api routes", () => {
  it("registers definitions, connections, connect, poll, and disconnect behind runtime token", async () => {
    const channels = {
      listDefinitions: vi.fn(async () => ({ channels: [{ id: "wechat", runtimeChannel: "weixin", name: "WeChat", authKind: "qrCode", enabled: true, capabilities: [], fields: [] }] })),
      listConnections: vi.fn(async () => ({ connections: [{ id: "channel-wechat-local", provider: "wechat", runtimeChannel: "weixin", status: "connected", running: true, displayName: "WeChat" }] })),
      connect: vi.fn(async () => ({ status: "pendingQr", connectionId: "channel-wechat-local", pollToken: "poll-1" })),
      pollConnect: vi.fn(async () => ({ status: "connected", connectionId: "channel-wechat-local" })),
      disconnect: vi.fn(async () => ({ ok: true }))
    };
    app = createServer({ channels });

    expect((await injectJson("GET", "/api/v1/channels/definitions")).json()).toMatchObject({ channels: [{ id: "wechat" }] });
    expect((await injectJson("GET", "/api/v1/channels/connections")).json()).toMatchObject({ connections: [{ provider: "wechat" }] });
    expect((await injectJson("POST", "/api/v1/channels/wechat/connect", {})).json()).toMatchObject({ status: "pendingQr", pollToken: "poll-1" });
    expect((await injectJson("GET", "/api/v1/channels/wechat/connect/poll-1")).json()).toMatchObject({ status: "connected" });
    expect((await injectJson("POST", "/api/v1/channels/wechat/disconnect", {})).json()).toEqual({ ok: true });
    expect(channels.connect).toHaveBeenCalledWith("wechat", {});
    expect(channels.pollConnect).toHaveBeenCalledWith("wechat", "poll-1");
    expect(channels.disconnect).toHaveBeenCalledWith("wechat");
  });

  it("rejects channel routes without a runtime token", async () => {
    app = createServer();

    const response = await app.inject({
      method: "GET",
      url: "/api/v1/channels/definitions"
    });

    expect(response.statusCode).toBe(401);
  });
});

async function injectJson(method: string, url: string, payload?: unknown) {
  if (!app) throw new Error("Test server is not initialized");
  return app.inject({
    method,
    url,
    headers: { "x-memmy-local-token": "test-token" },
    payload
  });
}

function createServer(overrides: Record<string, unknown> = {}): FastifyInstance {
  const services = {
    bootstrap: {
      async getBootstrap() {
        throw new Error("bootstrap not used");
      }
    },
    progressBus: createProgressBus(),
    channels: {
      async listDefinitions() {
        return { channels: [] };
      },
      async listConnections() {
        return { connections: [] };
      },
      async connect() {
        return { status: "unsupported", connectionId: "channel-imessage-local" };
      },
      async pollConnect() {
        return { status: "unsupported", connectionId: "channel-imessage-local" };
      },
      async disconnect() {
        return { ok: true };
      }
    },
    ...overrides
  } as unknown as BackendServices;

  return createLocalApiServer({
    permissionManager: createPermissionManager(),
    services,
    heartbeatIntervalMs: 20
  });
}

function createPermissionManager(): PermissionManager {
  return {
    async getRuntimeToken() {
      return "test-token";
    },
    async verifyRuntimeToken(token) {
      return token === "test-token";
    },
    async getScanPermission() {
      return "scan_and_write_skill";
    },
    async setScanPermission() {
      return undefined;
    },
    async canDetectAgentSources() {
      return true;
    },
    async canScanAgentSource() {
      return true;
    },
    async canWriteAgentSkill() {
      return true;
    }
  };
}
