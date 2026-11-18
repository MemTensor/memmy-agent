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

describe("GET /api/token-quota/eligibility", () => {
  it("返回当前账号的申请资格", async () => {
    const app = Fastify();
    const getEligibility = vi.fn(async () => ({
      state: "cooldown" as const,
      requestCount: 1,
      maxRequestCount: 5 as const,
      nextAllowedAtEpochMs: 1_785_312_000_000,
      latestRequestStatus: "rejected" as const,
      latestReviewNote: "额度用途不明确"
    }));
    registerTokenQuotaRoutes(app, {
      tokenQuota: { getEligibility } as never,
      authenticateRuntimeToken: async () => undefined
    });

    const res = await app.inject({ method: "GET", url: "/api/token-quota/eligibility" });

    expect(res.statusCode).toBe(200);
    expect(res.json()).toMatchObject({ state: "cooldown", latestReviewNote: "额度用途不明确" });
    expect(getEligibility).toHaveBeenCalledTimes(1);
  });
});


it("passes the upgrade request through service and both HTTP boundaries without reporting pending", async () => {
  const { createHttpCloudClient } = await import("../adapters/outbound/cloud-client/http-cloud-client.js");
  const { createTokenQuotaService } = await import("../services/token-quota-service.js");
  const redirect = { accepted: true, deprecated: true, formType: "CN_ZH",
    formUrl: "https://alidocs.dingtalk.com/notable/share/form/official",
    latestApplicationApi: "/api/credits/v1/plan-applications/latest" };
  const eligibility = { eligible: true, deprecated: true, plansApi: "/api/credits/v1/plans",
    latestApplicationApi: redirect.latestApplicationApi, compatibilityEndAt: null };
  const fetchImpl = vi.fn(async (url: string | URL | Request) => new Response(JSON.stringify({
    data: String(url).endsWith("eligibility") ? eligibility : redirect
  })));
  const cloudClient = createHttpCloudClient({ baseUrl: "https://cloud.test", fetchImpl: fetchImpl as typeof fetch });
  const app = Fastify();
  registerTokenQuotaRoutes(app, { tokenQuota: createTokenQuotaService({ cloudClient,
    accountSessionRepository: { getCloudUuid: () => "current-account" } }), authenticateRuntimeToken: async () => undefined });
  try {
    const response = await app.inject({ method: "POST", url: "/api/token-quota/request",
      payload: { requestId: "upgrade:1", region: "CN", language: "zh-CN" } });
    expect(response.statusCode).toBe(200);
    expect(response.json()).toEqual(redirect);
    const status = await app.inject({ method: "GET", url: "/api/token-quota/eligibility" });
    expect(status.statusCode).toBe(200);
    expect(status.json()).toEqual(eligibility);
  } finally { await app.close(); }
});

it.each([
  [410, "LEGACY_QUOTA_RETIRED"],
  [409, "PLAN_APPLICATION_NOT_ELIGIBLE"],
  [409, "BUSINESS_REQUEST_REUSED"]
])("preserves the cloud HTTP %s compatibility failure %s", async (status, code) => {
  const { createHttpCloudClient } = await import("../adapters/outbound/cloud-client/http-cloud-client.js");
  const { createTokenQuotaService } = await import("../services/token-quota-service.js");
  const cloudClient = createHttpCloudClient({ baseUrl: "https://cloud.test", fetchImpl: (async () =>
    new Response(JSON.stringify({ code, message: "Action unavailable" }), { status: status as number })) as typeof fetch });
  const app = Fastify();
  registerTokenQuotaRoutes(app, { tokenQuota: createTokenQuotaService({ cloudClient,
    accountSessionRepository: { getCloudUuid: () => "current-account" } }), authenticateRuntimeToken: async () => undefined });
  try {
    const response = await app.inject({ method: "POST", url: "/api/token-quota/request", payload: { requestId: "upgrade:1" } });
    expect(response.statusCode).toBe(status);
    expect(response.json().error.code).toBe(code);
  } finally { await app.close(); }
});
