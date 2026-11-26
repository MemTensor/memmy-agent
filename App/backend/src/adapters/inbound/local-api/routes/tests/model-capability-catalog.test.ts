import Fastify, { type FastifyInstance } from "fastify";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { ModelCapabilityCatalogSyncResult } from "../../../../../services/model-capability-catalog-sync-service.js";
import { registerModelCapabilityCatalogRoutes } from "../model-capability-catalog.js";

const catalog = { catalogVersion: 21, models: {} };

describe("model catalog refresh route", () => {
  let app: FastifyInstance;
  afterEach(async () => { await app.close(); });

  function register(result: ModelCapabilityCatalogSyncResult) {
    app = Fastify();
    const sync = vi.fn().mockResolvedValue(result);
    registerModelCapabilityCatalogRoutes(app, {
      modelCapabilityCatalog: { sync, start: vi.fn(), stop: vi.fn() },
      async authenticateRuntimeToken(request, reply) {
        if (request.headers["x-memmy-local-token"] !== "test-token") {
          return reply.code(401).send({ error: "unauthorized" });
        }
      }
    });
    return sync;
  }

  it.each([undefined, "wrong-token"])("rejects unauthenticated refresh without invoking synchronization", async (token) => {
    const sync = register({ status: "updated", catalog });
    const response = await app.inject({
      method: "POST", url: "/api/app/model-catalog/refresh",
      headers: token ? { "x-memmy-local-token": token } : {}
    });
    expect(response.statusCode).toBe(401);
    expect(sync).not.toHaveBeenCalled();
  });

  it.each(["updated", "not-modified"] as const)("returns a synchronized version after %s", async (status) => {
    register({ status, catalog });
    const response = await app.inject({
      method: "POST", url: "/api/app/model-catalog/refresh", headers: { "x-memmy-local-token": "test-token" }
    });
    expect(response.statusCode).toBe(200);
    expect(response.json()).toEqual({ status: "synced", hasValidCatalog: true, catalogVersion: 21 });
  });

  it.each([
    { reason: "retries-exhausted" as const, local: catalog },
    { reason: "retries-exhausted" as const, local: null },
    { reason: "unauthenticated" as const, local: null },
    { reason: "stopped" as const, local: null }
  ])("returns explicit synchronization state without exposing internal errors: %j", async ({ reason, local }) => {
    register({ status: "failed", reason, catalog: local, error: new Error("internal diagnostic") });
    const response = await app.inject({
      method: "POST", url: "/api/app/model-catalog/refresh", headers: { "x-memmy-local-token": "test-token" }
    });
    expect(response.statusCode).toBe(200);
    expect(response.json()).toEqual({
      status: reason, hasValidCatalog: local !== null, ...(local ? { catalogVersion: 21 } : {})
    });
  });
});
