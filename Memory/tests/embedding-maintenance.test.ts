import { afterEach, describe, expect, it } from "vitest";
import { DEFAULT_MEMMY_CONFIG, type Embedder, type MemoryRow } from "../src/index.js";
import { Repositories } from "../src/storage/repositories.js";
import { attachMemoryVector } from "../src/storage/memory-vector-state.js";
import { rememberEmbeddingIdentity } from "../src/model/embedding-identity.js";
import { buildUserMemory } from "../src/service/user-memory/user-memory.js";
import { createMemoryServiceFixture } from "./fixtures/memory-service-fixture.js";
import { adaptViewerResponse } from "../viewer/src/api/memmy-adapter.js";

const fixture = createMemoryServiceFixture();
afterEach(() => fixture.cleanup());
const at = "2026-10-01T00:00:00.000Z";
const identity = { provider: "openai_compatible", model: "current-model" } as const;
const vector = (dimension = 3) => Array.from({ length: dimension }, (_, i) => i === 0 ? 1 : 0);
function model(inputs: string[], dimension = 3): Embedder {
  return {
    config: { ...DEFAULT_MEMMY_CONFIG.embedding, ...identity, mode: "custom", extraBody: { dimensions: dimension } },
    isRemote: () => true,
    status: () => ({ ...identity, configured: true, remote: true }),
    embed: async (texts) => { inputs.push(...texts); return texts.map(() => vector(dimension)); },
    embedOne: async (text) => { inputs.push(text); return vector(dimension); }
  };
}
function memory(id: string, options: { model?: string | null; dimension?: number; field?: "vec" | "vec_action"; layer?: "L1" | "L2" } = {}): MemoryRow {
  const record: MemoryRow = {
    id, userId: "local-user", timeline: at, memoryType: "LongTermMemory", status: "activated",
    visibility: "private", memoryValue: `Synthetic requirement ${id}`, tags: [], info: {},
    properties: { internal_info: { memory_layer: options.layer ?? "L2" } }, memoryLayer: options.layer ?? "L2",
    version: 1, createdAt: at, updatedAt: at
  };
  return options.dimension ? attachMemoryVector(record, {
    vectorField: options.field ?? "vec", vector: vector(options.dimension),
    embeddingProvider: identity.provider, embeddingModel: options.model === undefined ? identity.model : options.model
  }) : record;
}
function setup(inputs: string[] = [], embedder = model(inputs)) {
  const result = fixture.createTestService({ embedder });
  return { ...result, repos: new Repositories(result.db.db), embedder, inputs };
}

describe("embedding maintenance regressions (MEMMY-709–711)", () => {
  it("repairs only the missing one of 55 and rebuilds all 55 on explicit request", async () => {
    const { repos, service, inputs } = setup();
    for (let i = 0; i < 55; i++) repos.memories.insert(memory(`m-${i}`, { dimension: i ? 3 : undefined }));
    const before = repos.vectors.exportRows();
    const run = service.rebuildEmbeddings("repair");
    expect(run).toMatchObject({ mode: "repair", enqueued: 1, updated: 0, pending: 1, done: false });
    expect(adaptViewerResponse("POST", "/api/v1/embeddings/rebuild", {}, run)).toEqual(run);
    expect(service.rebuildEmbeddings("repair").runId).toBe(run.runId);
    await service.runWorkerOnce(200);
    expect(service.embeddingMaintenanceProgress(run.runId)).toMatchObject({ updated: 1, failed: 0, pending: 0, done: true });
    expect(inputs).toHaveLength(1);
    expect(repos.vectors.exportRows().filter(row => row.memory_id !== "m-0")).toEqual(before);
    const rebuild = service.rebuildEmbeddings("rebuild");
    expect(rebuild.enqueued).toBe(55);
    await service.runWorkerOnce(200);
    expect(service.embeddingMaintenanceProgress(rebuild.runId)).toMatchObject({ updated: 55, failed: 0, done: true });
    expect(inputs).toHaveLength(56);
  });

  it("rejects same-dimension old and unknown models in health and vector retrieval", async () => {
    const { repos, service } = setup([], model([], 1024));
    repos.memories.insert(memory("current", { dimension: 1024 }));
    repos.memories.insert(memory("old", { dimension: 1024, model: "old-cloud-model" }));
    repos.memories.insert(memory("unknown", { dimension: 1024, model: null }));
    repos.memories.insert(memory("wrong-dim", { dimension: 384 }));
    repos.memories.insert(memory("missing"));
    expect(service.embeddingMaintenanceStats()).toMatchObject({ dimension: 1024, ready: 1, modelMismatch: 2, dimMismatch: 1, missing: 1, needsRepair: 4 });
    const query = rememberEmbeddingIdentity(vector(1024), identity);
    expect(repos.memories.searchVectorIds(query, "vec").map(hit => hit.id)).toEqual(["current"]);
    const run = service.rebuildEmbeddings("repair");
    expect(run.enqueued).toBe(4);
    await service.runWorkerOnce(200);
    expect(service.embeddingMaintenanceProgress(run.runId)).toMatchObject({ updated: 4, done: true, statsAfter: { ready: 5, needsRepair: 0 } });
    expect(repos.memories.searchVectorIds(query, "vec")).toHaveLength(5);
  });

  it("counts an existing L1 action independently from its missing summary vector", () => {
    const { repos, service } = setup();
    repos.memories.insert(memory("action-only", { dimension: 3, field: "vec_action", layer: "L1" }));
    expect(service.embeddingMaintenanceStats()).toMatchObject({ totalSlots: 2, missing: 1, ready: 1 });
  });

  it("does not use foreign model dimensions as the current dimension", () => {
    const embedder = model([]);
    embedder.config.extraBody = undefined;
    const { repos, service } = setup([], embedder);
    repos.memories.insert(memory("old", { dimension: 1024, model: "old-cloud-model" }));
    expect(service.embeddingMaintenanceStats()).toMatchObject({ dimension: 0, ready: 0, modelMismatch: 1 });
  });

  it("reports actual progress across 301 targets and retains the run after service recreation", async () => {
    const { repos, service, db, embedder, inputs } = setup();
    for (let i = 0; i < 301; i++) repos.memories.insert(memory(`m-${i}`));
    const run = service.rebuildEmbeddings("repair");
    expect(run).toMatchObject({ enqueued: 301, updated: 0, done: false });
    await service.runWorkerOnce(200);
    const middle = service.embeddingMaintenanceProgress(run.runId)!;
    expect(middle.updated).toBeGreaterThan(0);
    expect(middle.updated).toBeLessThan(301);
    expect(middle.pending).toBe(301 - middle.updated);
    const reopened = fixture.createTestMemoryService({ db, embedder });
    expect(reopened.embeddingMaintenanceProgress(run.runId)).toMatchObject({ updated: middle.updated, pending: middle.pending });
    for (let i = 0; i < 5 && !reopened.embeddingMaintenanceProgress(run.runId)!.done; i++) await reopened.runWorkerOnce(200);
    expect(reopened.embeddingMaintenanceProgress(run.runId)).toMatchObject({ updated: 301, failed: 0, done: true });
    expect(inputs).toHaveLength(301);
  });

  it("does not call accepted or in-flight work successful", async () => {
    let release!: () => void;
    let entered!: () => void;
    const gate = new Promise<void>(resolve => { release = resolve; });
    const started = new Promise<void>(resolve => { entered = resolve; });
    const embedder = model([]);
    embedder.embed = async texts => { entered(); await gate; return texts.map(() => vector()); };
    const { repos, service } = setup([], embedder);
    repos.memories.insert(memory("pending"));
    const run = service.rebuildEmbeddings("repair");
    const worker = service.runWorkerOnce(200);
    await started;
    expect(service.embeddingMaintenanceProgress(run.runId)).toMatchObject({ updated: 0, pending: 1, done: false });
    release(); await worker;
    expect(service.embeddingMaintenanceProgress(run.runId)).toMatchObject({ updated: 1, pending: 0, done: true });
  });

  it("reports retry waiting and terminal failures without inventing successful writes", async () => {
    const embedder = model([]);
    embedder.embed = async () => { throw new Error("synthetic provider unavailable"); };
    const { repos, service, db } = setup([], embedder);
    repos.memories.insert(memory("failure"));
    const run = service.rebuildEmbeddings("repair");
    await service.runWorkerOnce(200);
    expect(service.embeddingMaintenanceProgress(run.runId)).toMatchObject({ updated: 0, failed: 0, pending: 1, retrying: 1, done: false });
    db.db.prepare("UPDATE embedding_retry_queue SET max_attempts = 2, next_attempt_at = 0").run();
    await service.runWorkerOnce(200);
    expect(service.embeddingMaintenanceProgress(run.runId)).toMatchObject({ updated: 0, failed: 1, pending: 0, done: true });
    expect(repos.vectors.exportRows()).toHaveLength(0);
  });

  it("includes only this account's active user memories and filters their old-model vectors", async () => {
    const { repos, service } = setup();
    for (const [id, userId, current] of [["healthy", "local-user", true], ["old", "local-user", false], ["foreign", "other-user", false]] as const) {
      repos.userMemories.insert({ ...buildUserMemory({ id, sourceTurnId: id, userId, memoryTypes: ["User Preference"], content: `I prefer ${id}`, createdAt: at }),
        embedding: vector(), embeddingModel: current ? identity.model : "old-model", embeddingProvider: identity.provider });
    }
    expect(service.embeddingMaintenanceStats()).toMatchObject({ totalSlots: 2, ready: 1, modelMismatch: 1 });
    expect(repos.userMemories.searchVectorIds("local-user", rememberEmbeddingIdentity(vector(), identity), 10).map(hit => hit.id)).toEqual(["healthy"]);
    const run = service.rebuildEmbeddings("repair");
    await service.runWorkerOnce(200);
    expect(service.embeddingMaintenanceProgress(run.runId)).toMatchObject({ enqueued: 1, updated: 1, failed: 0, done: true });
    expect(repos.userMemories.get("foreign")!.embeddingModel).toBe("old-model");
  });

  it("keeps in-flight vector provenance when settings change and stops claiming the run completed", async () => {
    let release!: () => void;
    let entered!: () => void;
    const gate = new Promise<void>(resolve => { release = resolve; });
    const started = new Promise<void>(resolve => { entered = resolve; });
    const embedder = model([]);
    embedder.embed = async texts => { entered(); await gate; return texts.map(() => vector()); };
    const { repos, service } = setup([], embedder);
    repos.memories.insert(memory("inflight"));
    const run = service.rebuildEmbeddings("repair");
    const worker = service.runWorkerOnce(200);
    await started;
    embedder.config.model = "new-model";
    release(); await worker;
    expect(repos.vectors.exportRows()[0]!.embedding_model).toBe(identity.model);
    expect(service.embeddingMaintenanceProgress(run.runId)).toMatchObject({ updated: 0, done: true, error: expect.stringContaining("model changed"), statsAfter: { modelMismatch: 1 } });
  });
});
