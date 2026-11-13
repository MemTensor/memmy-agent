import Fastify from "fastify";
import { afterEach, describe, expect, it, vi } from "vitest";
import { registerKnowledgeRoutes } from "../src/routes.js";

const settings = { authenticated: true, enabled: true, serviceAvailable: true,
  bases: [{ id: "base-1", name: "Product docs", selected: true }], maxBases: 3 };
const usage = { used: 1024, limit: 1073741824 };
const applications: ReturnType<typeof Fastify>[] = [];
afterEach(async () => { await Promise.all(applications.splice(0).map(app => app.close())); });
function fixture(data: unknown, status = 200) {
  const fetcher = vi.fn(async () => new Response(JSON.stringify(status === 200 ? { code: 0, data } : data), { status }));
  const app = Fastify();applications.push(app);
  registerKnowledgeRoutes(app, { baseUrl: "https://cloud.example", getSession: () => ({ accountId: "owner", credential: "jwt" }),
    fetcher: fetcher as typeof fetch, authenticate: async () => undefined });
  return { app, fetcher };
}
function forwardedBody(fetcher: ReturnType<typeof vi.fn>) {
  return JSON.parse((fetcher.mock.calls.at(-1) as [string, RequestInit])[1].body as string);
}

it("creates with the documented fields and retains existing settings for the Knowledge UI", async () => {
  const created = { baseId: "base-1", name: "Product docs", createdAt: "2026-11-02T11:00:00+08:00", entitlement: { used: 2, limit: 3 } };
  const { app, fetcher } = fixture({ ...settings, ...created, apiKey: "must-not-leak" });
  const input = { name: "Product docs", description: "Credits documentation", visibility: "PRIVATE" };
  const response = await app.inject({ method: "POST", url: "/api/knowledge/bases", payload: input });
  expect(response.statusCode).toBe(200);
  expect(response.json()).toEqual({ ...settings, ...created });
  expect(forwardedBody(fetcher)).toEqual(input);
});

it("preserves deleted base capacity and the old settings response", async () => {
  const deleted = { deleted: true, releasedBaseCount: 1, releasedBytes: 1024,
    entitlementUsage: { baseCount: 1, baseLimit: 3, storageBytes: 0 } };
  const { app } = fixture({ ...settings, ...deleted });
  const response = await app.inject({ method: "DELETE", url: "/api/knowledge/bases/base-1" });
  expect(response.statusCode).toBe(200);
  expect(response.json()).toEqual({ ...settings, ...deleted });
});

it("accepts memberEmail and role while retaining the old userId input", async () => {
  const shared = { ok: true, userId: "123", name: "Member", member: { memberId: "123", role: "EDITOR", joinedAt: "2026-11-02T11:30:00+08:00" }, memberUsage: { used: 1, limit: 1 } };
  const { app, fetcher } = fixture({ ...shared, member: { ...shared.member, apiKey: "secret" } });
  for (const input of [{ memberEmail: "member@example.com", role: "EDITOR" }, { userId: "123" }]) {
    const response = await app.inject({ method: "POST", url: "/api/knowledge/bases/base-1/members", payload: input });
    expect(response.statusCode).toBe(200);
    expect(response.json()).toEqual(shared);
    expect(forwardedBody(fetcher)).toEqual(input);
  }
  for (const input of [{ userId: "123", memberEmail: "member@example.com" }, { memberEmail: "member@example.com", role: "OWNER" }]) {
    expect((await app.inject({ method: "POST", url: "/api/knowledge/bases/base-1/members", payload: input })).statusCode).toBe(400);
  }
  expect(fetcher).toHaveBeenCalledTimes(2);
});

it("preserves upload identifiers and authoritative storage usage", async () => {
  const uploaded = { fileId: "file-1", fileName: "credits.pdf", sizeBytes: 1024, status: "PROCESSING", storageUsage: usage };
  const { app, fetcher } = fixture(uploaded);
  const body = '--upload\r\nContent-Disposition: form-data; name="file"; filename="credits.pdf"\r\n\r\ncontents\r\n--upload--\r\n';
  const response = await app.inject({ method: "POST", url: "/api/knowledge/bases/base-1/files",
    headers: { "content-type": "multipart/form-data; boundary=upload" }, payload: body });
  expect(response.statusCode).toBe(200);
  expect(response.json()).toEqual({ ok: true, ...uploaded });
  expect((fetcher.mock.calls[0] as unknown as [string, RequestInit])[1].body).toBeInstanceOf(Uint8Array);
});

it.each([
  ["/api/knowledge/bases/base-1/files/file-1", { deleted: true, releasedBytes: 1024, storageUsage: usage }],
  ["/api/knowledge/bases/base-1/members/123", { removed: true, memberUsage: { used: 0, limit: 1 } }]
])("preserves mutation accounting for %s", async (url, result) => {
  const { app } = fixture(result);
  const response = await app.inject({ method: "DELETE", url: url as string });
  expect(response.statusCode).toBe(200);
  expect(response.json()).toEqual({ ok: true, ...(result as object) });
});

it("defaults a bodyless folder deletion to cascade and keeps the explicit move-out mode", async () => {
  const deleted = { deleted: true, deletedFileCount: 3, deletedFiles: 3, releasedBytes: 3072, storageUsage: usage };
  const { app, fetcher } = fixture(deleted);
  const response = await app.inject({ method: "DELETE", url: "/api/knowledge/folders/folder-1" });
  expect(response.statusCode).toBe(200);
  expect(response.json()).toEqual({ ok: true, ...deleted });
  expect(forwardedBody(fetcher)).toEqual({ mode: "all" });
  expect((await app.inject({ method: "DELETE", url: "/api/knowledge/folders/folder-1", payload: { mode: "out" } })).statusCode).toBe(200);
  expect(forwardedBody(fetcher)).toEqual({ mode: "out" });
  expect((await app.inject({ method: "DELETE", url: "/api/knowledge/folders/folder-1", payload: [] })).statusCode).toBe(400);
  expect(fetcher).toHaveBeenCalledTimes(2);
});

it("preserves cloud business failures instead of turning quota conflicts into 502", async () => {
  const { app } = fixture({ code: "KNOWLEDGE_BASE_LIMIT_EXCEEDED", message: "limit reached" }, 409);
  const response = await app.inject({ method: "POST", url: "/api/knowledge/bases", payload: { name: "Docs" } });
  expect(response.statusCode).toBe(409);
  expect(response.json()).toEqual({ error: "[HTTP 409] limit reached", code: "KNOWLEDGE_BASE_LIMIT_EXCEEDED" });
});
