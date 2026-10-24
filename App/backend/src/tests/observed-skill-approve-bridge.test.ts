import Fastify from "fastify";
import { afterEach, describe, expect, it } from "vitest";
import { createMemoryHttpServer, DEFAULT_MEMMY_CONFIG, type LlmClient, type LlmMessage, type RuntimeNamespace } from "../../../../Memory/src/index.js";
import { Repositories } from "../../../../Memory/src/storage/repositories.js";
import { createMemoryServiceFixture } from "../../../../Memory/tests/fixtures/memory-service-fixture.js";
import { createHttpMemoryClient } from "../adapters/outbound/memory-client/http-memory-client.js";
import { registerMemoryRoutes } from "../adapters/inbound/local-api/routes/agent-runtime/memory.js";
import type { AgentRuntimeRouteDeps } from "../adapters/inbound/local-api/routes/agent-runtime/index.js";

const { cleanup, createTestService } = createMemoryServiceFixture();
afterEach(cleanup);
const namespace = { source: "memmy", profileId: "default", userId: "original-history-user" };
const draft = { create: true, name: "review_release", summary: "Review the release and record its blocker",
  trigger: "When reviewing a release", selectedActionIds: ["a1", "a2", "a3", "a4"] };

function model(): LlmClient {
  return {
    config: DEFAULT_MEMMY_CONFIG.summary, isConfigured: () => true,
    async complete() { return ""; },
    async completeJson<T extends Record<string, unknown>>(messages: LlmMessage[], options: { operation: string }) {
      if (options.operation === "skill.external_evidence.suggest") return draft as unknown as T;
      const input = JSON.parse(messages.find((message) => message.role === "user")!.content) as {
        sources: Array<{ id: string; content: string }>;
      };
      return { keep: true, title: "Release review blocker", summary: "The release is awaiting approval.",
        items: [{ category: "blocker", text: "The release is awaiting approval.",
          source_memory_id: input.sources[0]!.id, evidence_quote: "The release is awaiting approval." }] } as unknown as T;
    },
    status: () => ({ provider: "test", configured: true, remote: false })
  };
}

function evidence(scope: RuntimeNamespace, index = 0) {
  return { action: "upsert" as const, source: "computer_history", namespace: scope,
    sourceRecordId: `2026-09-27T10-${index === 0 ? "00" : "10"}-00Z-10min-summary`,
    revision: "2026-09-27T10:20:00.000Z", title: "Release review", summary: "The release is awaiting approval.",
    content: "Open the draft. Review the changes. Record the blocker. Save the review. The release is awaiting approval.",
    startedAt: "2026-09-27T10:00:00.000Z", endedAt: "2026-09-27T10:20:00.000Z" };
}

async function candidate(service: ReturnType<typeof createTestService>["service"], scope: RuntimeNamespace, source = "manual_capture") {
  const sources = [evidence(scope, 0), evidence(scope, 1)].map((item) => ({ ...item, source }));
  sources.forEach((source) => service.syncExternalEvidence(source));
  await service.runWorkerOnce(100);
  await service.runWorkerOnce(100);
  return service.suggestExternalEvidenceSkill({ source, namespace: scope,
    groupId: "2026-09-27T06-00-00Z-6h-summary", revision: "2026-09-27T12:00:00.000Z",
    sourceRecordIds: sources.map((source) => source.sourceRecordId), actions: [
      { sourceRecordId: sources[0]!.sourceRecordId, text: "Open the draft" },
      { sourceRecordId: sources[0]!.sourceRecordId, text: "Review the changes" },
      { sourceRecordId: sources[1]!.sourceRecordId, text: "Record the blocker" },
      { sourceRecordId: sources[1]!.sourceRecordId, text: "Save the review" }
    ] });
}

async function withMemoryServer(
  service: ReturnType<typeof createTestService>["service"],
  run: (baseUrl: string) => Promise<void>
) {
  const scopeA = { ...namespace, tenantId: "tenant-a" };
  const server = createMemoryHttpServer({ service, startAgentSourceAutomation: false, auth: {
    mode: "local", localServiceToken: "local-write-token",
    scopedApiKeys: {
      "tenant-a-token": { namespace: scopeA, scopes: ["memory:write", "memory:read"] },
      "read-token": { namespace: scopeA, scopes: ["memory:read"] }
    }, cloudAccessTokens: { "tenant-a-cloud-token": scopeA }
  } });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const address = server.address();
  if (!address || typeof address === "string") throw new Error("expected TCP port");
  try { await run(`http://127.0.0.1:${address.port}`); }
  finally { await new Promise<void>((resolve) => server.close(() => resolve())); }
}

function post(baseUrl: string, path: string, body: unknown, token = "local-write-token", headers: Record<string, string> = {}) {
  return fetch(`${baseUrl}/api/v1/${path}`, { method: "POST", headers: {
    authorization: `Bearer ${token}`, "content-type": "application/json", ...headers
  }, body: JSON.stringify(body) });
}

describe("observed Skill editing and legacy approval through the desktop bridge", () => {
  it("approves a shared local candidate using the real empty-body HTTP request", async () => {
    const { service, db } = createTestService({ llm: model(), skillLlm: model() });
    const selected = await candidate(service, namespace);
    const repos = new Repositories(db.db);
    await withMemoryServer(service, async (baseUrl) => {
      const response = await post(baseUrl, `evidence/skills/${selected.id}/approve`, {});
      expect(response.status).toBe(200);
      expect(await response.json()).toMatchObject({ id: selected.id, status: "activated" });
      expect(repos.memories.get(selected.id!)?.status).toBe("activated");
      expect(db.db.prepare("SELECT COUNT(*) AS n FROM evolution_jobs WHERE job_type = 'embedding' AND target_memory_id = ?")
        .get(selected.id)).toEqual({ n: 1 });
    });
  });

  it("rejects explicit wrong tenant, missing write scope and forged scoped or cloud headers", async () => {
    const { service, db } = createTestService({ llm: model(), skillLlm: model() });
    const selected = await candidate(service, { ...namespace, tenantId: "tenant-b" });
    const repos = new Repositories(db.db);
    await withMemoryServer(service, async (baseUrl) => {
      const path = `evidence/skills/${selected.id}/approve`;
      expect((await post(baseUrl, path, { namespace: { ...namespace, tenantId: "tenant-a" } })).status).toBe(404);
      expect((await post(baseUrl, path, {}, "read-token")).status).toBe(403);
      for (const token of ["tenant-a-token", "tenant-a-cloud-token"]) {
        expect((await post(baseUrl, path, {}, token, {
          "x-memmy-tenant-id": "tenant-b", "x-memmy-user-id": namespace.userId
        })).status).toBe(404);
        expect((await post(baseUrl, path, { namespace: { ...namespace, tenantId: "tenant-b" } }, token)).status).toBe(403);
      }
      expect(repos.memories.get(selected.id!)?.status).toBe("resolving");
    });
  });

  it("keeps scoped sync and delete in the token tenant despite forged headers", async () => {
    const { service, db } = createTestService({ llm: model(), skillLlm: model() });
    const repos = new Repositories(db.db);
    const sourceA = service.syncExternalEvidence(evidence({ ...namespace, tenantId: "tenant-a" }));
    const sourceB = service.syncExternalEvidence(evidence({ ...namespace, tenantId: "tenant-b" }));
    await withMemoryServer(service, async (baseUrl) => {
      const { namespace: _scope, ...body } = evidence(namespace);
      const headers = { "x-memmy-tenant-id": "tenant-b" };
      const updated = await post(baseUrl, "evidence/sync", { ...body, revision: "2026-09-27T10:21:00.000Z",
        content: `${body.content} Still pending.` }, "tenant-a-token", headers);
      expect(updated.status).toBe(200);
      expect(await updated.json()).toMatchObject({ id: sourceA.id });
      expect(repos.memories.get(sourceB.id)?.properties.internal_info.external_evidence).toMatchObject({ source_content: body.content });
      const deletion = await post(baseUrl, "evidence/sync", { action: "delete", source: body.source,
        sourceRecordId: body.sourceRecordId, revision: body.revision }, "tenant-a-token", headers);
      expect(await deletion.json()).toMatchObject({ id: sourceA.id, status: "deleted" });
      expect(repos.memories.get(sourceB.id)?.status).toBe("activated");
    });
  });

  it("forwards the desktop button route into Memory and activates the persisted candidate", async () => {
    const { service, db } = createTestService({ llm: model(), skillLlm: model() });
    const selected = await candidate(service, namespace);
    const repos = new Repositories(db.db);
    await withMemoryServer(service, async (baseUrl) => {
      const memoryClient = createHttpMemoryClient({ baseUrl, token: "local-write-token", timeoutMs: 2_000, maxRetries: 0 });
      const desktop = Fastify();
      registerMemoryRoutes(desktop, {
        services: { memoryClient } as AgentRuntimeRouteDeps["services"],
        async authenticateRuntimeToken(request, reply) {
          if (request.headers.authorization !== "Bearer desktop-runtime-token") return reply.code(401).send({ error: "unauthorized" });
        }
      });
      try {
        const url = `/api/v1/evidence/skills/${selected.id}/approve`;
        expect((await desktop.inject({ method: "POST", url, payload: {} })).statusCode).toBe(401);
        const response = await desktop.inject({ method: "POST", url, payload: {},
          headers: { authorization: "Bearer desktop-runtime-token" } });
        expect(response.statusCode).toBe(200);
        expect(response.json()).toMatchObject({ id: selected.id, status: "activated" });
        expect(repos.memories.get(selected.id!)?.status).toBe("activated");
      } finally { await desktop.close(); }
    });
  });

  it("automatically enables History Skills, then persists a user edit through desktop HTTP with a version guard", async () => {
    const { service, db } = createTestService({ llm: model(), skillLlm: model() });
    const selected = await candidate(service, namespace, "computer_history");
    const repos = new Repositories(db.db);
    expect(selected.status).toBe("active");
    expect(repos.memories.get(selected.id!)?.status).toBe("activated");
    await withMemoryServer(service, async (baseUrl) => {
      const memoryClient = createHttpMemoryClient({ baseUrl, token: "local-write-token", timeoutMs: 2_000, maxRetries: 0 });
      const desktop = Fastify();
      registerMemoryRoutes(desktop, {
        services: { memoryClient } as AgentRuntimeRouteDeps["services"],
        async authenticateRuntimeToken(request, reply) {
          if (request.headers.authorization !== "Bearer desktop-runtime-token") return reply.code(401).send({ error: "unauthorized" });
        }
      });
      try {
        const url = `/api/v1/evidence/skills/${selected.id}`;
        const before = repos.memories.get(selected.id!)!;
        const payload = { expectedVersion: before.version,
          body: "# release_review\n\nReview the current draft. Record the blocker, then verify the saved result." };
        expect((await desktop.inject({ method: "PATCH", url, payload })).statusCode).toBe(401);
        const response = await desktop.inject({ method: "PATCH", url, payload,
          headers: { authorization: "Bearer desktop-runtime-token" } });
        expect(response.statusCode).toBe(200);
        expect(response.json()).toMatchObject({ id: selected.id, status: "activated", version: before.version + 1 });
        const after = repos.memories.get(selected.id!)!;
        expect(after.memoryValue).toBe(payload.body);
        expect(after.properties.internal_info.skill).toMatchObject({ invocation_guide: payload.body });
        expect(after.properties.internal_info.external_evidence_candidate).toMatchObject({ sourceMemoryIds:
          (before.properties.internal_info.external_evidence_candidate as { sourceMemoryIds: string[] }).sourceMemoryIds });
        const conflicting = await desktop.inject({ method: "PATCH", url, payload: { ...payload, body: "Stale overwrite" },
          headers: { authorization: "Bearer desktop-runtime-token" } });
        expect(conflicting.statusCode).toBe(409);
        expect(repos.memories.get(selected.id!)?.memoryValue).toBe(payload.body);
        expect(db.db.prepare("SELECT COUNT(*) AS n FROM evolution_jobs WHERE job_type = 'embedding' AND target_memory_id = ?")
          .get(selected.id)).toEqual({ n: 2 });
      } finally { await desktop.close(); }
    });
  });

  it("keeps Skill edits in the authenticated tenant despite forged headers", async () => {
    const { service, db } = createTestService({ llm: model(), skillLlm: model() });
    const selected = await candidate(service, { ...namespace, tenantId: "tenant-b" }, "computer_history");
    const repos = new Repositories(db.db);
    const before = repos.memories.get(selected.id!)!;
    await withMemoryServer(service, async (baseUrl) => {
      for (const token of ["tenant-a-token", "tenant-a-cloud-token", "read-token"]) {
        const response = await fetch(`${baseUrl}/api/v1/evidence/skills/${selected.id}`, { method: "PATCH", headers: {
          authorization: `Bearer ${token}`, "content-type": "application/json", "x-memmy-tenant-id": "tenant-b"
        }, body: JSON.stringify({ body: "Unauthorized overwrite", expectedVersion: before.version }) });
        expect(response.status).toBe(token === "read-token" ? 403 : 404);
      }
      expect(repos.memories.get(selected.id!)?.memoryValue).toBe(before.memoryValue);
      const empty = await fetch(`${baseUrl}/api/v1/evidence/skills/${selected.id}`, { method: "PATCH", headers: {
        authorization: "Bearer local-write-token", "content-type": "application/json"
      }, body: JSON.stringify({ body: "   ", expectedVersion: before.version }) });
      expect(empty.status).toBe(400);
    });
  });

  it("does not let scoped credentials edit another History user's Skill within the same tenant", async () => {
    const { service, db } = createTestService({ llm: model(), skillLlm: model() });
    const selected = await candidate(service, { ...namespace, tenantId: "tenant-a", userId: "another-history-user" }, "computer_history");
    const repos = new Repositories(db.db);
    const before = repos.memories.get(selected.id!)!;
    await withMemoryServer(service, async (baseUrl) => {
      const response = await fetch(`${baseUrl}/api/v1/evidence/skills/${selected.id}`, { method: "PATCH", headers: {
        authorization: "Bearer tenant-a-token", "content-type": "application/json", "x-memmy-user-id": "another-history-user"
      }, body: JSON.stringify({ body: "Unauthorized same-tenant overwrite", expectedVersion: before.version }) });
      expect(response.status).toBe(404);
      expect(repos.memories.get(selected.id!)?.memoryValue).toBe(before.memoryValue);
    });
  });
});
