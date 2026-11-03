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
  it("requires runtime and account authentication for all three routes", async () => {
    const f = fixture();
    for (const path of ["summary", "grants", "ledger"]) {
      expect((await f.read(`/api/credits/${path}`, false)).statusCode).toBe(401);
    }
    f.setCredential(null);
    for (const path of ["summary", "grants", "ledger"]) expect((await f.read(`/api/credits/${path}`)).statusCode).toBe(401);
    expect(f.getCredits).not.toHaveBeenCalled();
  });
  it("forwards validated filters and opaque cursors, without exposing the cloud credential", async () => {
    const f = fixture();
    const response = await f.read("/api/credits/grants?sourceType=PLAN&status=AVAILABLE&limit=1&cursor=signed%2Bcursor");
    expect(response.statusCode).toBe(200);
    expect(f.getCredits).toHaveBeenCalledWith({ uuid: "private-account-token", resource: "grants",
      query: { sourceType: "PLAN", status: "AVAILABLE", limit: 1, cursor: "signed+cursor" } });
    expect(response.body).not.toContain("private-account-token");
    expect((await f.read("/api/credits/ledger?direction=DEBIT&businessType=MODEL_USAGE")).statusCode).toBe(200);
    for (const path of ["summary?userId=8", "grants?userId=8", "ledger?limit=101", "ledger?direction=unknown"]) {
      expect((await f.read(`/api/credits/${path}`)).statusCode).toBe(400);
    }
    expect(f.getCredits).toHaveBeenCalledTimes(2);
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

it("protects reward writes, preserves retry bodies and rejects account spoofing", async () => {
  let uuid: string | null = "account-a";
  const result = { claimed: true, alreadyClaimed: false, businessDate: "2026-11-03",
    grant: { grantId: "1", amount: "100.00", expiresAt: "2026-12-03T10:00:00+08:00" }, balance: "1100.00", accountVersion: 2 };
  const postCreditReward = vi.fn(async () => result);
  const app = Fastify(); apps.push(app);
  registerCreditsRoutes(app, { credits: createCreditsService({ ...createMockCloudClient(), postCreditReward }, { getCloudUuid: () => uuid } as never),
    authenticateRuntimeToken: async (req, reply) => { if (req.headers["x-memmy-local-token"] !== "runtime") return reply.code(401).send({}); } });
  const write = (resource: string, payload: unknown, authenticated = true) => app.inject({ method: "POST", url: `/api/credits/${resource}`, payload: payload as never,
    headers: authenticated ? { "x-memmy-local-token": "runtime" } : {} });
  for (const resource of ["check-ins", "redemptions"]) expect((await write(resource, { requestId: "same" }, false)).statusCode).toBe(401);
  expect((await write("check-ins", { requestId: "same", userId: "8" })).statusCode).toBe(400);
  expect((await write("redemptions", { requestId: "same" })).statusCode).toBe(400);
  expect((await write("check-ins", { requestId: "same" })).json()).toEqual(result);
  expect((await write("check-ins", { requestId: "same" })).json()).toEqual(result);
  expect(postCreditReward).toHaveBeenLastCalledWith({ uuid: "account-a", resource: "check-ins", body: { requestId: "same" } });
  postCreditReward.mockImplementationOnce(async () => { uuid = "account-b"; return result; });
  expect((await write("check-ins", { requestId: "next" })).statusCode).toBe(401);
  uuid = null;
  expect((await write("check-ins", { requestId: "no-session" })).statusCode).toBe(401);
});
