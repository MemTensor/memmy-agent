import { describe, expect, it, vi } from "vitest";
import Fastify from "fastify";
import { registerTokenQuotaRoutes } from "../adapters/inbound/local-api/routes/token-quota.js";

describe("POST /api/token-quota/request", () => {
  it("校验通过则调 service 并回 200", async () => {
    const app = Fastify();
    const requestQuota = vi.fn(async () => ({ requestId: "r1", status: "pending" as const }));
    registerTokenQuotaRoutes(app, {
      tokenQuota: { requestQuota } as never,
      authenticateRuntimeToken: async () => undefined
    });
    const res = await app.inject({
      method: "POST",
      url: "/api/token-quota/request",
      payload: { reason: "x".repeat(20) }
    });
    expect(res.statusCode).toBe(200);
    expect(res.json()).toMatchObject({ requestId: "r1", status: "pending" });
  });

  it("reason <20 字回 4xx", async () => {
    const app = Fastify();
    registerTokenQuotaRoutes(app, {
      tokenQuota: { requestQuota: vi.fn() } as never,
      authenticateRuntimeToken: async () => undefined
    });
    const res = await app.inject({
      method: "POST",
      url: "/api/token-quota/request",
      payload: { reason: "短" }
    });
    expect(res.statusCode).toBeGreaterThanOrEqual(400);
  });
});
