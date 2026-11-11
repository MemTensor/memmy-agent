import { afterEach, describe, expect, it, vi } from "vitest";
import { policyMetaFromMemory, traceMetaFromMemory } from "../../../src/algorithm/plugin-algorithms.js";
import type { MemmyConfig } from "../../../src/config/index.js";
import type { LlmClient } from "../../../src/model/types.js";
import { DEVICE_MEMORY_OWNER } from "../../../src/service/namespace/memory-owner.js";
import { listL2Candidates, upsertL2Candidate } from "../../../src/service/evolution/l2-candidate-service.js";
import { Repositories } from "../../../src/storage/repositories.js";
import { createCapturingEmbedder, createMemoryServiceFixture, LEGACY_TEST_CONFIG } from "../../fixtures/memory-service-fixture.js";

const fixture = createMemoryServiceFixture();
afterEach(fixture.cleanup);

describe("unified L2 storage owner integration", () => {
  it("uses the real captured owner through candidate admission, extraction and source withdrawal", async () => {
    const config: MemmyConfig = structuredClone(LEGACY_TEST_CONFIG);
    config.algorithm.l2Induction.mode = "unified";
    config.algorithm.l2Induction.minTraceValue = 1;
    config.algorithm.capture.embedAfterCapture = false;
    config.algorithm.capture.synthReflection = false;
    const disabled: LlmClient = {
      config: config.summary, isConfigured: () => false,
      complete: async () => { throw new Error("summary model is disabled"); },
      completeJson: async () => { throw new Error("summary model is disabled"); },
      status: () => ({ provider: "host", model: "disabled", configured: false, remote: false })
    };
    let sourceId = "";
    const extract = vi.fn(async () => ({ operations: [{ operation: "create", l1_ids: [sourceId], new_l2: {
      type: "check", title: "Verify exports", applicability: "Before reporting an export complete",
      content: "Compare the unrounded totals.", verification: "Recompute the sum.", exclusions: ""
    } }] }));
    const evolution: LlmClient = { ...disabled, config: config.evolution, isConfigured: () => true,
      completeJson: async <T extends Record<string, unknown>>(_messages: unknown, options: { operation: string }) => {
        expect(options.operation).toBe("l2.extraction.v2");
        return await extract() as unknown as T;
      }, status: () => ({ provider: "host", model: "l2-test", configured: true, remote: false }) };
    const { db, service } = fixture.createTestService({ config, llm: disabled, skillLlm: evolution,
      embedder: createCapturingEmbedder([]) });
    const repos = new Repositories(db.db);
    const session = service.openSession({ namespace: { userId: "account-a", source: "codex", profileId: "default" } });
    const captured = await service.completeTurn("export", { sessionId: session.sessionId,
      query: "Check unrounded totals before export", answer: "Found an export mismatch." });
    sourceId = captured.l1MemoryId;
    const source = repos.memories.get(sourceId)!;
    const episodeId = traceMetaFromMemory(source)!.episodeId ?? null;
    expect(repos.runtime.getSession(session.sessionId)!.userId).toBe(DEVICE_MEMORY_OWNER);
    expect(repos.runtime.getRawTurn(captured.rawTurnId!)!.userId).toBe(DEVICE_MEMORY_OWNER);
    expect(source.userId).toBe(DEVICE_MEMORY_OWNER);
    // Account UIDs are not storage-owner grants, even for the account which submitted the turn.
    expect(upsertL2Candidate(repos, { userId: "account-a", sourceMemoryId: sourceId, route: "negative" })).toBeNull();
    const candidate = upsertL2Candidate(repos, { userId: source.userId, sourceMemoryId: sourceId, route: "negative" })!;
    expect(candidate.userId).toBe(DEVICE_MEMORY_OWNER);
    const queue = (id: string, userId: string) => repos.runtime.enqueueJob({
      id, jobType: "l2_induction", userId, targetMemoryId: sourceId, sessionId: source.sessionId,
      episodeId: episodeId ?? undefined, payload: {}, status: "queued", attempts: 0, maxAttempts: 3,
      createdAt: new Date().toISOString(), updatedAt: new Date().toISOString()
    });
    queue("foreign-job", "account-b");
    await service.runWorkerOnce(20, { targetMemoryIds: [sourceId] });
    expect(extract).not.toHaveBeenCalled();
    expect(repos.memories.list({ memoryLayer: "L2" })).toEqual([]);
    expect(listL2Candidates(repos, { userId: source.userId, episodeId })).toHaveLength(1);
    queue("owned-job", source.userId);
    await service.runWorkerOnce(20, { targetMemoryIds: [sourceId] });
    expect(extract).toHaveBeenCalledTimes(1);
    const [policy] = repos.memories.list({ memoryLayer: "L2" });
    expect(policy!.userId).toBe(DEVICE_MEMORY_OWNER);
    expect(policyMetaFromMemory(policy!)).toMatchObject({ status: "candidate", skillEligible: false });
    expect(repos.runtime.getJob("owned-job")!.status).toBe("succeeded");
    expect(listL2Candidates(repos, { userId: source.userId, episodeId })).toEqual([]);
    const snapshots = db.db.prepare("SELECT key FROM runtime_kv WHERE key LIKE 'l2.extract.snapshot.%'").all() as Array<{ key: string }>;
    expect(snapshots).toHaveLength(1);
    expect(repos.runtime.invalidateUnifiedL2Source(sourceId, "account-b")).toEqual({ candidates: 0, snapshots: 0, operations: 0 });
    service.deleteMemory(sourceId);
    expect(repos.runtime.getKv(snapshots[0]!.key)!.value).toMatchObject({ sourceInvalidatedAt: expect.any(String) });
    expect(repos.runtime.getKv(snapshots[0]!.key)!.value).not.toHaveProperty("input");
  });
});
