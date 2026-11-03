import { afterEach, describe, expect, it, vi } from "vitest";
import Fastify from "fastify";
import { registerCreditsRoutes } from "../adapters/inbound/local-api/routes/credits.js";
import { createCreditsService } from "../services/credits-service.js";
import { createMockCloudClient } from "./support/mock-cloud-client.js";

const apps: ReturnType<typeof Fastify>[] = [];
afterEach(async () => { await Promise.all(apps.splice(0).map(app => app.close())); });
function fixture() {
  let credential: string | null = "private-account-token";
  const getCredits = vi.fn(async () => ({ items: [], nextCursor: null, hasMore: false }));
  const credits = createCreditsService({ ...createMockCloudClient(), getCredits }, { getCloudUuid: () => credential } as never);
  const app = Fastify(); apps.push(app);
  registerCreditsRoutes(app, { credits, authenticateRuntimeToken: async (request, reply) => {
    if (request.headers["x-memmy-local-token"] !== "runtime-token") return reply.code(401).send({ error: "unauthorized" });
  } });
  const read = (url: string, authenticated = true) => app.inject({ method: "GET", url,
    headers: authenticated ? { "x-memmy-local-token": "runtime-token" } : {} });
  return { read, getCredits, setCredential: (value: string | null) => { credential = value; } };
}
describe("credits local proxy", () => {
  it("requires runtime and account authentication for every route", async () => {
    const f = fixture();
    for (const path of ["summary", "grants", "ledger", "usage", "usage/export", "usage/download?token=signed", "usage/test-call"]) {
      expect((await f.read(`/api/credits/${path}`, false)).statusCode).toBe(401);
    }
    f.setCredential(null);
    for (const path of ["summary", "grants", "ledger", "usage", "usage/export", "usage/download?token=signed", "usage/test-call"]) expect((await f.read(`/api/credits/${path}`)).statusCode).toBe(401);
    expect(f.getCredits).not.toHaveBeenCalled();
  });
  it("forwards validated filters and opaque cursors, without exposing the cloud credential", async () => {
    const f = fixture();
    const response = await f.read("/api/credits/grants?sourceType=PLAN&status=AVAILABLE&limit=1&cursor=signed%2Bcursor");
    expect(response.statusCode).toBe(200);
    expect(f.getCredits).toHaveBeenCalledWith({ uuid: "private-account-token", resource: "grants",
      query: { sourceType: "PLAN", status: "AVAILABLE", limit: 1, cursor: "signed+cursor" } });
    expect(response.headers["cache-control"]).toBe("no-store");
    expect(response.body).not.toContain("private-account-token");
    expect((await f.read("/api/credits/ledger?direction=DEBIT&businessType=MODEL_USAGE")).statusCode).toBe(200);
    for (const path of ["usage?userId=8", "usage/export?limit=10", "usage/test-call?userId=8", "usage?domain=bad", "summary?userId=8", "grants?userId=8", "ledger?limit=101", "ledger?direction=unknown"]) {
      expect((await f.read(`/api/credits/${path}`)).statusCode).toBe(400);
    }
    expect(f.getCredits).toHaveBeenCalledTimes(2);
  });
  it("forwards usage filters through the authenticated service", async () => {
    const f = fixture();
    expect((await f.read("/api/credits/usage?domain=memory&limit=10&from=2026-11-01T00%3A00%3A00%2B08%3A00")).statusCode).toBe(200);
    expect(f.getCredits).toHaveBeenCalledWith({ uuid: "private-account-token", resource: "usage", query: { domain: "memory", limit: 10, from: "2026-11-01T00:00:00+08:00" } });
  });
  it("discards an in-flight response after switching accounts", async () => {
    const f = fixture();
    f.getCredits.mockImplementationOnce(async () => {
      f.setCredential("different-account-token");
      return { items: [], nextCursor: null, hasMore: false };
    });
    expect((await f.read("/api/credits/grants")).statusCode).toBe(401);
  });
});
