/** Local data routes tests. */
import { afterEach, describe, expect, it } from "vitest";
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

describe("local data routes", () => {
  it("registers reveal, export, and clear behind the runtime token", async () => {
    const calls: string[] = [];
    app = createServer({
      localData: {
        async reveal() {
          calls.push("reveal");
          return { ok: true, dataPath: "/tmp/memmy-data" };
        },
        async export(input) {
          calls.push(`export:${input.targetPath}`);
          return { exportPath: "/tmp/export/memmy-export-1", bytes: 128 };
        },
        async clear(input) {
          calls.push(`clear:${input.confirm}`);
          return { ok: true, clearedAt: "2026-06-02T10:00:00.000Z" };
        }
      }
    });

    const reveal = await injectJson("POST", "/api/local-data/reveal", {});
    const exported = await injectJson("POST", "/api/local-data/export", { targetPath: "/tmp/export" });
    const cleared = await injectJson("DELETE", "/api/local-data", { confirm: true });

    expect(reveal.json()).toEqual({ ok: true, dataPath: "/tmp/memmy-data" });
    expect(exported.json()).toEqual({ exportPath: "/tmp/export/memmy-export-1", bytes: 128 });
    expect(cleared.json()).toEqual({ ok: true, clearedAt: "2026-06-02T10:00:00.000Z" });
    expect(calls).toEqual(["reveal", "export:/tmp/export", "clear:true"]);
  });

  it("rejects local data routes without a valid runtime token", async () => {
    app = createServer();

    const response = await app.inject({
      method: "POST",
      url: "/api/local-data/reveal",
      payload: {}
    });

    expect(response.statusCode).toBe(401);
  });

  it("returns invalid_argument when clear confirm is missing", async () => {
    app = createServer();

    const response = await injectJson("DELETE", "/api/local-data", { confirm: false });

    expect(response.statusCode).toBe(400);
    expect(response.json()).toMatchObject({
      error: {
        code: "invalid_argument"
      }
    });
  });
});

async function injectJson(method: string, url: string, payload: unknown) {
  if (!app) {
    throw new Error("Test server is not initialized");
  }

  return app.inject({
    method,
    url,
    headers: {
      "x-memmy-local-token": "test-token"
    },
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
    localData: {
      async reveal() {
        return { ok: true, dataPath: "/tmp/memmy-data" };
      },
      async export() {
        return { exportPath: "/tmp/export/memmy-export-1", bytes: 128 };
      },
      async clear() {
        return { ok: true, clearedAt: "2026-06-02T10:00:00.000Z" };
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
    },
    async canSearchMemory() {
      return true;
    },
    async revokeAgentSource() {
      return undefined;
    }
  };
}
