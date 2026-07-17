import { afterEach, describe, expect, it, vi } from "vitest";
import type { FastifyInstance } from "fastify";
import type { PermissionManager } from "../../../../permission/index.js";
import type { BackendServices } from "../../../../services/index.js";
import { createProgressBus } from "../../../../services/progress-bus.js";
import { createLocalApiServer } from "../server.js";

let app: FastifyInstance | undefined;

afterEach(async () => {
  await app?.close();
  app = undefined;
});

describe("BYOK token usage local api routes", () => {
  it("records usage events behind the runtime token", async () => {
    const recordEvent = vi.fn(async () => undefined);
    app = createServer({
      byokTokenUsage: {
        recordEvent,
        async getSummary() {
          return summaryFixture();
        },
      },
    });

    const response = await injectJson("POST", "/api/app/byok-token-usage/events", eventFixture());

    expect(response.statusCode).toBe(200);
    expect(response.json()).toEqual({ ok: true });
    expect(recordEvent).toHaveBeenCalledWith(expect.objectContaining({
      id: "event-1",
      kind: "agent_chat",
      source: "agent",
      operationId: "turn-1",
      totalTokens: 30,
    }));
  });

  it("returns usage summary behind the runtime token", async () => {
    app = createServer({
      byokTokenUsage: {
        async recordEvent() {
          throw new Error("record not used");
        },
        async getSummary() {
          return summaryFixture();
        },
      },
    });

    const response = await injectJson("GET", "/api/app/byok-token-usage/summary");

    expect(response.statusCode).toBe(200);
    expect(response.json()).toMatchObject({
      inputTokens: 10,
      outputTokens: 20,
      totalTokens: 30,
      byKind: [{ kind: "agent_chat", totalTokens: 30 }],
    });
  });

  it("rejects BYOK usage routes without a valid runtime token", async () => {
    app = createServer();

    const response = await app.inject({
      method: "GET",
      url: "/api/app/byok-token-usage/summary",
    });

    expect(response.statusCode).toBe(401);
  });

  it("returns invalid_argument for invalid BYOK usage event payloads", async () => {
    app = createServer();

    const response = await injectJson("POST", "/api/app/byok-token-usage/events", {
      ...eventFixture(),
      inputTokens: -1,
    });

    expect(response.statusCode).toBe(400);
    expect(response.json()).toMatchObject({
      error: {
        code: "invalid_argument",
      },
    });
  });
});

async function injectJson(method: string, url: string, payload?: unknown) {
  if (!app) throw new Error("Test server is not initialized");
  return app.inject({
    method,
    url,
    headers: {
      "x-memmy-local-token": "test-token",
    },
    payload,
  });
}

function createServer(overrides: Record<string, unknown> = {}): FastifyInstance {
  const services = {
    bootstrap: {
      async getBootstrap() {
        throw new Error("bootstrap not used");
      },
    },
    progressBus: createProgressBus(),
    byokTokenUsage: {
      async recordEvent() {
        return undefined;
      },
      async getSummary() {
        return summaryFixture();
      },
    },
    ...overrides,
  } as unknown as BackendServices;

  return createLocalApiServer({
    permissionManager: createPermissionManager(),
    services,
    heartbeatIntervalMs: 20,
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
    },
    async canSearchMemory() {
      return true;
    },
    async revokeAgentSource() {
      return undefined;
    },
  };
}

function eventFixture() {
  return {
    id: "event-1",
    kind: "agent_chat",
    source: "agent",
    operationId: "turn-1",
    inputTokens: 10,
    outputTokens: 20,
    totalTokens: 30,
    cachedInputTokens: 5,
    cacheCreationInputTokens: 2,
    metadata: {
      sessionKey: "cli:direct",
      provider: "openai",
      modelId: "gpt-4.1-mini",
    },
    rawUsage: { prompt_tokens: 10, completion_tokens: 20 },
    createdAt: "2026-06-11T10:00:00.000Z",
  };
}

function summaryFixture() {
  return {
    inputTokens: 10,
    outputTokens: 20,
    totalTokens: 30,
    cachedInputTokens: 5,
    cacheCreationInputTokens: 2,
    updatedAt: "2026-06-11T10:00:00.000Z",
    byKind: [{
      kind: "agent_chat",
      inputTokens: 10,
      outputTokens: 20,
      totalTokens: 30,
      cachedInputTokens: 5,
      cacheCreationInputTokens: 2,
      eventCount: 1,
      updatedAt: "2026-06-11T10:00:00.000Z",
    }],
  };
}
