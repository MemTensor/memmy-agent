import { localCalendarDate } from "@memmy/agent-source-core";
import { MEMORY_BYOK_BUDGET_KV_KEY } from "../src/service/memory-token-budget-ledger.js";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { DEFAULT_MEMMY_CONFIG, type Embedder, type MemoryRow } from "../src/index.js";
import { createMemoryHttpServer, closeMemoryHttpServer } from "../src/server/http.js";
import { rememberEmbeddingIdentity } from "../src/model/embedding-identity.js";
import { Repositories } from "../src/storage/repositories.js";
import { attachMemoryVector } from "../src/storage/memory-vector-state.js";
import { accountRuntimeConfig, byokRuntimeConfig, createMemoryServiceFixture } from "./fixtures/memory-service-fixture.js";

const fixture = createMemoryServiceFixture();
afterEach(() => fixture.cleanup());
const key = "embedding-provenance-upgrade:v1";
const identity = { provider: "openai_compatible", model: "current" } as const;
const at = "2026-10-01T00:00:00.000Z";
const vector = (n = 3) => Array.from({ length: n }, (_, i) => i === 0 ? 1 : 0);
function embedder(texts: string[] = []): Embedder {
  return {
    config: { ...DEFAULT_MEMMY_CONFIG.embedding, ...identity, extraBody: { dimensions: 3 } },
    isRemote: () => true,
    status: () => ({ ...identity, configured: true, remote: true }),
    embed: async input => { texts.push(...input); return input.map(() => vector()); },
    embedOne: async text => { texts.push(text); return vector(); }
  };
}
function record(id: string, layer: "L1" | "L2", feedback = false): MemoryRow {
  return {
    id, userId: "local-user", memoryLayer: layer, timeline: at, memoryType: "LongTermMemory",
    status: "activated", visibility: "private", memoryValue: `Original content ${id}`, tags: ["keep"],
    info: { summary: `Summary ${id}` }, version: 1, createdAt: at, updatedAt: at,
    properties: { internal_info: { memory_layer: layer,
      ...(feedback ? { source: "feedback.experience.v1" } : {}),
      ...(layer === "L1" ? { trace: { summary: `Summary ${id}`, agentText: `Action ${id}`, userText: "User task", tool_calls: [] } }
        : { policy: { title: id, trigger: "Original trigger", procedure: "Original procedure" } })
    } }
  };
}
function withVector(memory: MemoryRow, field: "vec" | "vec_summary" | "vec_action", model: string | null, n = 3) {
  return attachMemoryVector(memory, { vectorField: field, vector: vector(n), embeddingProvider: identity.provider, embeddingModel: model });
}
function setup(model = embedder()) {
  const result = fixture.createTestService({ embedder: model });
  return { ...result, repos: new Repositories(result.db.db), model };
}

async function feedbackSession(service: ReturnType<typeof setup>["service"]) {
  const session = service.openSession({ namespace: { source: "codex", profileId: "test", userId: "local-user" } });
  const turn = await service.completeTurn("positive-provenance", {
    sessionId: session.sessionId, query: "Parse SEC 13F issuer fields", answer: "Parsed and checked the issuer fields."
  });
  return { sessionId: session.sessionId, episodeId: turn.episodeId, l1MemoryId: turn.l1MemoryId,
    channel: "explicit" as const, polarity: "positive" as const, magnitude: 1,
    rationale: "Verifier feedback: passed. The SEC 13F parsing result is correct.", rawPayload: { source: "verifier", score: 1 } };
}

describe("PR689 feedback vector provenance", () => {
  it("makes new feedback immediately retrievable and preserves provenance on merge", async () => {
    const { service, repos } = setup();
    const request = await feedbackSession(service);
    await service.feedback(request);
    const first = repos.vectors.exportRows().find(row => row.vector_field === "vec")!;
    expect(first).toMatchObject({ embedding_provider: identity.provider, embedding_model: identity.model });
    const query = rememberEmbeddingIdentity(vector(), identity);
    expect(repos.memories.searchVectorIds(query, "vec").map(hit => hit.id)).toContain(first.memory_id);
    await service.feedback({ ...request, rationale: request.rationale + " Keep using this verified parsing procedure." });
    const rows = repos.vectors.exportRows().filter(row => row.vector_field === "vec");
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({ memory_id: first.memory_id, embedding_provider: identity.provider, embedding_model: identity.model });
    expect(repos.memories.searchVectorIds(query, "vec").map(hit => hit.id)).toContain(first.memory_id);
  });

  it("records the model that actually generated feedback during a settings switch", async () => {
    const model = embedder();
    let release!: () => void, entered!: () => void;
    const started = new Promise<void>(resolve => { entered = resolve; });
    const gate = new Promise<void>(resolve => { release = resolve; });
    model.embedOne = async () => { entered(); await gate; return vector(); };
    const { service, repos } = setup(model);
    const pending = service.feedback(await feedbackSession(service));
    await started;
    model.config.model = "new-model";
    release(); await pending;
    expect(repos.vectors.exportRows().find(row => row.vector_field === "vec")).toMatchObject({ embedding_model: "current" });
    expect(repos.memories.searchVectorIds(rememberEmbeddingIdentity(vector(), { ...identity, model: "new-model" }), "vec")).toHaveLength(0);
  });
});

describe("one-time upgrade repair", () => {
  it("repairs only existing bad action and feedback vectors, keeping healthy vectors and other fields", async () => {
    const texts: string[] = [];
    const { service, repos } = setup(embedder(texts));
    for (const [id, model, dim] of [["unknown", null, 3], ["old", "old-model", 3], ["wrong-dim", "current", 2]] as const) {
      repos.memories.insert(withVector(withVector(record(id, "L1"), "vec_summary", "current"), "vec_action", model, dim));
      repos.memories.insert(withVector(record(`feedback-${id}`, "L2", true), "vec", model, dim));
    }
    repos.memories.insert(withVector(withVector(record("healthy-action", "L1"), "vec_summary", "current"), "vec_action", "current"));
    repos.memories.insert(withVector(record("healthy-feedback", "L2", true), "vec", "current"));
    repos.memories.insert(withVector(record("no-action", "L1"), "vec_summary", "current"));
    repos.memories.insert(withVector(record("other-policy", "L2"), "vec", null));
    const before = repos.vectors.exportRows();
    const beforeMemory = repos.memories.get("unknown")!;
    await service.runWorkerOnce(200);
    const run = repos.runtime.getKv(key)!.value as any;
    expect(run.targets).toHaveLength(6);
    expect(run.targets.every((target: any) => target.result === "updated")).toBe(true);
    expect(run.completedAt).toBeTruthy();
    expect(service.embeddingMaintenanceProgress(run.runId)).toMatchObject({ updated: 6, failed: 0, done: true });
    const after = repos.vectors.exportRows();
    for (const row of before.filter(row => row.vector_field === "vec_summary" || /healthy|other-policy/.test(row.memory_id))) {
      expect(after.find(item => item.memory_id === row.memory_id && item.vector_field === row.vector_field)).toEqual(row);
    }
    expect(after.some(row => row.memory_id === "no-action" && row.vector_field === "vec_action")).toBe(false);
    const saved = repos.memories.get("unknown")!;
    expect(saved.properties).toEqual(beforeMemory.properties);
    expect(saved.memoryValue).toBe(beforeMemory.memoryValue);
    expect(saved.info).toEqual(beforeMemory.info);
    expect(texts.filter(text => text.startsWith("Action "))).toHaveLength(3);
    expect(texts).toHaveLength(6);
    expect(repos.memories.searchVectorIds(rememberEmbeddingIdentity(vector(), identity), "vec_action")).toHaveLength(4);
    expect(repos.memories.searchVectorIds(rememberEmbeddingIdentity(vector(), identity), "vec")).toHaveLength(4);
  });

  it("keeps separate summary/action targets in manual maintenance", async () => {
    const { service, repos } = setup();
    repos.memories.insert(withVector(record("both-fields", "L1"), "vec_action", null));
    const run = await service.rebuildEmbeddings("repair");
    expect(run.enqueued).toBe(2);
    await service.runWorkerOnce(200);
    expect(service.embeddingMaintenanceProgress(run.runId)).toMatchObject({ updated: 2, failed: 0, done: true });
    expect(repos.vectors.exportRows().map(row => row.vector_field).sort()).toEqual(["vec_action", "vec_summary"]);
  });

  it("resumes only unfinished targets after restart, then never repeats after completion", async () => {
    const texts: string[] = [];
    const { service, repos, db, model } = setup(embedder(texts));
    for (let i = 0; i < 3; i++) repos.memories.insert(withVector(record(`legacy-${i}`, "L2", true), "vec", null));
    await service.runWorkerOnce(1);
    expect(texts).toHaveLength(1);
    const restarted = fixture.createTestMemoryService({ db, embedder: model });
    await restarted.runWorkerOnce(200);
    expect(texts).toHaveLength(3);
    const completed = repos.runtime.getKv(key)!;
    expect((completed.value as any).completedAt).toBeTruthy();
    const again = fixture.createTestMemoryService({ db, embedder: model });
    await again.runWorkerOnce(200);
    expect(texts).toHaveLength(3);
    expect(repos.runtime.getKv(key)).toEqual(completed);
  });

  it("keeps unavailable/failed repair durable and retries without a false completed marker", async () => {
    let configured = false, fail = true;
    const model = embedder();
    model.status = () => ({ ...identity, configured, remote: true });
    model.embed = async texts => { if (fail) throw new Error("synthetic model outage"); return texts.map(() => vector()); };
    model.embedOne = async () => { if (fail) throw new Error("synthetic model outage"); return vector(); };
    const { service, repos, db } = setup(model);
    repos.memories.insert(withVector(record("legacy", "L2", true), "vec", null));
    await service.runWorkerOnce(200);
    let run = repos.runtime.getKv(key)!.value as any;
    expect(run.completedAt).toBeUndefined();
    expect(run.error).toContain("unavailable");
    configured = true;
    repos.runtime.setKv(key, { ...run, nextAttemptAt: 1 });
    await service.runWorkerOnce(200);
    expect(service.embeddingMaintenanceProgress()).toMatchObject({ updated: 0, retrying: 1, done: false });
    db.db.prepare("UPDATE embedding_retry_queue SET max_attempts = 2, next_attempt_at = 0").run();
    await service.runWorkerOnce(200);
    expect(service.embeddingMaintenanceProgress()).toMatchObject({ updated: 0, failed: 1, done: false });
    run = repos.runtime.getKv(key)!.value as any;
    expect(run.completedAt).toBeUndefined();
    expect(run.nextAttemptAt).toBeGreaterThan(Date.now());
    fail = false;
    repos.runtime.setKv(key, { ...run, nextAttemptAt: 1 });
    const restarted = fixture.createTestMemoryService({ db, embedder: model });
    await restarted.runWorkerOnce(200);
    expect(restarted.embeddingMaintenanceProgress()).toMatchObject({ updated: 1, failed: 0, done: true });
  });

  it("checks actual dimensions when the model has no declared dimensions", async () => {
    const model = embedder(); model.config.extraBody = undefined;
    const { service, repos } = setup(model);
    repos.memories.insert(withVector(record("legacy", "L2", true), "vec", "current", 2));
    await service.runWorkerOnce(200);
    expect(repos.vectors.exportRows()[0]!.embedding_dim).toBe(3);
    expect((repos.runtime.getKv(key)!.value as any).completedAt).toBeTruthy();
  });

  it("automatically starts the upgrade in the production HTTP worker without a manual repair", async () => {
    const { service, repos, root } = setup();
    repos.memories.insert(withVector(record("legacy-startup", "L2", true), "vec", null));
    const server = createMemoryHttpServer({ service, configPath: join(root, "config.json"), workerStartupFallbackMs: 0 });
    try {
      await new Promise<void>(resolve => server.listen(0, "127.0.0.1", resolve));
      await expect.poll(() => (repos.runtime.getKv(key)?.value as any)?.completedAt).toBeTruthy();
      expect(repos.vectors.exportRows()[0]).toMatchObject({ embedding_model: "current" });
    } finally { await closeMemoryHttpServer(server); }
  });

  it("wakes automatically at the persisted retry deadline after restarting an unavailable upgrade", async () => {
    const model = embedder();
    let configured = false;
    model.status = () => ({ ...identity, configured, remote: true });
    const { service, repos, db, root } = setup(model);
    repos.memories.insert(withVector(record("legacy-timer", "L2", true), "vec", null));
    await service.runWorkerOnce();
    const run = repos.runtime.getKv(key)!.value as any;
    expect(run.candidates).toHaveLength(1);
    const due = Date.now() + 150;
    repos.runtime.setKv(key, { ...run, nextAttemptAt: due });
    configured = true;
    const restarted = fixture.createTestMemoryService({ db, embedder: model });
    expect(restarted.nextWorkerRunAt()).toBe(due);
    const server = createMemoryHttpServer({ service: restarted, configPath: join(root, "config.json"), workerStartupFallbackMs: 0 });
    try {
      await new Promise<void>(resolve => server.listen(0, "127.0.0.1", resolve));
      await expect.poll(() => (repos.runtime.getKv(key)?.value as any)?.completedAt).toBeTruthy();
    } finally { await closeMemoryHttpServer(server); }
  });

  it("shares one upgrade plan across concurrent worker calls", async () => {
    const model = embedder(); model.config.extraBody = undefined;
    let calls = 0, release!: () => void, entered!: () => void;
    const started = new Promise<void>(resolve => { entered = resolve; });
    const gate = new Promise<void>(resolve => { release = resolve; });
    model.embedOne = async () => { calls++; entered(); await gate; return vector(); };
    const { service, repos } = setup(model);
    repos.memories.insert(withVector(record("legacy-concurrent", "L2", true), "vec", null));
    const first = service.runWorkerOnce();
    await started;
    const runId = (repos.runtime.getKv(key)!.value as any).runId;
    const second = service.runWorkerOnce();
    release();
    await Promise.all([first, second]);
    expect(calls).toBe(1);
    expect(repos.runtime.getKv(key)!.value).toMatchObject({ runId, completedAt: expect.any(String) });
  });

  it("regenerates changed feedback content instead of writing a stale upgrade vector", async () => {
    const model = embedder();
    const { service, repos } = setup(model);
    repos.memories.insert(withVector(record("legacy-edited", "L2", true), "vec", null));
    let edited = false;
    model.embed = async texts => {
      if (!edited) {
        edited = true;
        const memory = repos.memories.get("legacy-edited")!;
        repos.memories.update({ ...memory, memoryValue: "Revised content", properties: {
          ...memory.properties, internal_info: { ...memory.properties.internal_info,
            policy: { title: "Revised", trigger: "Revised trigger", procedure: "Revised procedure" } }
        } });
      }
      return texts.map(() => vector());
    };
    await service.runWorkerOnce();
    expect(service.embeddingMaintenanceProgress()).toMatchObject({ done: false, updated: 0 });
    await service.runWorkerOnce();
    expect(service.embeddingMaintenanceProgress()).toMatchObject({ done: true, updated: 1 });
  });

  it("finishes an empty upgrade without requiring a configured model or creating retries", async () => {
    const model = embedder(); model.status = () => ({ ...identity, configured: false, remote: true });
    const { service, repos } = setup(model);
    await service.runWorkerOnce();
    expect((repos.runtime.getKv(key)!.value as any).completedAt).toBeTruthy();
    expect(service.embeddingMaintenanceProgress()).toMatchObject({ enqueued: 0, done: true });
  });


  it("schedules another round when the model changes during an upgrade job", async () => {
    const model = embedder();
    let changed = false;
    model.embed = async texts => {
      const generatedBy = { ...identity, model: model.config.model! };
      if (!changed) { model.config.model = "switched"; changed = true; }
      return texts.map(() => rememberEmbeddingIdentity(vector(), generatedBy));
    };
    const { service, repos } = setup(model);
    repos.memories.insert(withVector(record("legacy-switch", "L2", true), "vec", null));
    await service.runWorkerOnce();
    const run = repos.runtime.getKv(key)!.value as any;
    expect(run.completedAt).toBeUndefined();
    expect(run.nextAttemptAt).toBeGreaterThan(Date.now());
    expect(service.nextWorkerRunAt()).toBeLessThanOrEqual(run.nextAttemptAt);
    repos.runtime.setKv(key, { ...run, nextAttemptAt: 1 });
    await service.runWorkerOnce();
    expect(repos.vectors.exportRows()[0]!.embedding_model).toBe("switched");
    expect(service.embeddingMaintenanceProgress()).toMatchObject({ updated: 1, done: true });
  });

});

describe("automatic provenance repair budget gates", () => {
  function budgetSetup(kind: "local" | "account" | "byok", enabled = true) {
    const texts: string[] = [];
    const config = kind === "account" ? accountRuntimeConfig() : byokRuntimeConfig();
    config.tokenBudget = { dailyLimitM: 1, totalLimitM: 500 };
    config.algorithm = { ...config.algorithm, enableMemoryAdd: enabled };
    if (kind === "local") config.embedding.mode = "local";
    const model = embedder(texts);
    Object.assign(model.config, config.embedding, identity, { extraBody: { dimensions: 3 } });
    model.isRemote = () => kind !== "local";
    model.status = () => ({ ...identity, configured: true, remote: kind !== "local" });
    config.embedding = { ...model.config };
    const result = fixture.createTestService({ config, embedder: model });
    const repos = new Repositories(result.db.db);
    repos.runtime.setKv(MEMORY_BYOK_BUDGET_KV_KEY, {
      dailyUsed: 1_000_000, lifetimeUsed: 1_000_000, dailyDate: localCalendarDate()
    });
    repos.memories.insert(withVector(record("budget-action", "L1"), "vec_action", null));
    repos.memories.insert(withVector(record("budget-feedback", "L2", true), "vec", null));
    return { ...result, repos, model, config, texts };
  }

  it.each(["local", "account"] as const)("repairs historical vectors with %s embedding despite an exhausted BYOK budget", async kind => {
    const { service, repos, texts } = budgetSetup(kind);
    expect(service.isMemoryBudgetPaused()).toBe(true);
    await service.runWorkerOnce();
    expect(texts).toHaveLength(2);
    expect(service.embeddingMaintenanceProgress()).toMatchObject({ updated: 2, done: true });
    const query = rememberEmbeddingIdentity(vector(), identity);
    expect(repos.memories.searchVectorIds(query, "vec_action").map(hit => hit.id)).toContain("budget-action");
    expect(repos.memories.searchVectorIds(query, "vec").map(hit => hit.id)).toContain("budget-feedback");
    await service.runWorkerOnce();
    expect(texts).toHaveLength(2);
  });

  it("holds budgeted embedding until its budget recovers", async () => {
    const { service, repos, texts } = budgetSetup("byok");
    await service.runWorkerOnce();
    expect(texts).toHaveLength(0);
    expect(repos.runtime.getKv(key)).toBeUndefined();
    repos.runtime.setKv(MEMORY_BYOK_BUDGET_KV_KEY, {
      dailyUsed: 0, lifetimeUsed: 1_000_000, dailyDate: localCalendarDate()
    });
    await service.runWorkerOnce();
    expect(texts).toHaveLength(2);
    expect(service.embeddingMaintenanceProgress()).toMatchObject({ updated: 2, done: true });
  });

  it("keeps the local retry deadline after restart while the BYOK budget remains exhausted", async () => {
    const { service, repos, model, db, config, root, texts } = budgetSetup("local");
    model.status = () => ({ ...identity, configured: false, remote: false });
    await service.runWorkerOnce();
    const run = repos.runtime.getKv(key)?.value as any;
    expect(run?.candidates).toHaveLength(2);
    const due = Date.now() + 150;
    repos.runtime.setKv(key, { ...run, nextAttemptAt: due });
    model.status = () => ({ ...identity, configured: true, remote: false });
    const restarted = fixture.createTestMemoryService({ db, config, embedder: model });
    expect(restarted.nextWorkerRunAt()).toBe(due);
    const server = createMemoryHttpServer({ service: restarted, configPath: join(root, "config.json"), workerStartupFallbackMs: 0 });
    try {
      await new Promise<void>(resolve => server.listen(0, "127.0.0.1", resolve));
      await expect.poll(() => (repos.runtime.getKv(key)?.value as any)?.completedAt).toBeTruthy();
      expect(texts).toHaveLength(2);
    } finally { await closeMemoryHttpServer(server); }
  });

  it("does not start or schedule automatic repair when memory writes are disabled", async () => {
    const { service, repos, texts } = budgetSetup("local", false);
    await service.runWorkerOnce();
    expect(texts).toHaveLength(0);
    expect(repos.runtime.getKv(key)).toBeUndefined();
    repos.runtime.setKv(key, { nextAttemptAt: Date.now() + 1000 });
    expect(service.nextWorkerRunAt()).toBeUndefined();
  });
});
