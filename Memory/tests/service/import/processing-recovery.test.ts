import { afterEach, describe, expect, it, vi } from "vitest";
import { Repositories } from "../../../src/storage/repositories.js";
import { updateTraceImportSummary } from "../../../src/service/import/import-job-processor.js";
import {
  addAgentSourceImport, createBatchReflectionLlm, createMemoryServiceFixture
} from "../../fixtures/memory-service-fixture.js";

const { cleanup, createTestService } = createMemoryServiceFixture();
afterEach(cleanup);
const namespace = { source: "codex", profileId: "default", userId: "bug903-recovery-user" };

function setup() {
  const fixture = createTestService({ llm: createBatchReflectionLlm([]) });
  const added = addAgentSourceImport(fixture.service, namespace, "Preserve source content when recovering a failed summary.", "bug903-recovery");
  const repos = new Repositories(fixture.db.db);
  const processing = repos.processing.get(added.id)!;
  fixture.db.db.prepare("UPDATE evolution_jobs SET status = 'dead_letter' WHERE target_memory_id = ?").run(added.id);
  repos.processing.save({ ...processing, state: "failed", stage: "summary", activeJobId: null,
    errorCode: "invalid_model_request", errorMessage: "Request is missing x-opencode-session",
    retryAction: "none", failedAt: new Date().toISOString() });
  return { ...fixture, added, repos };
}

describe("recovery after repairing model configuration", () => {
  it.each(["summary", "embedding"] as const)("manually recovers a historical generic request error at %s without replacing the memory", async stage => {
    const { db, service, added, repos } = setup();
    repos.processing.update(added.id, { stage });
    if (stage === "embedding") repos.memories.update(updateTraceImportSummary(repos.memories.get(added.id)!, {
      summary: "The completed summary must not be regenerated during an embedding retry.",
      alpha: 0, value: 0, priority: 0.5, tags: [], updatedAt: new Date().toISOString()
    }));
    const original = repos.memories.get(added.id)!;
    expect(service.memoryProcessingStatus([added.id], { namespace }).items[0]?.retryAction).toBe("retry");
    expect(service.getMemory(added.id, { namespace }).item).toMatchObject({ processing: { retryAction: "retry" } });
    expect(service.panelItems({ layer: "L1" }).items.find(item => item.id === added.id)?.processing?.retryAction).toBe("retry");
    expect(repos.processing.get(added.id)?.retryAction).toBe("none");
    const result = service.retryMemoryProcessing(added.id, { namespace });
    expect(result.accepted).toBe(true);
    expect(result.processing.state).toBe(stage === "summary" ? "summary_pending" : "embedding_pending");
    expect(result.processing.manualRetryCount).toBe(1);
    expect(repos.memories.get(added.id)).toEqual(original);
    expect(service.retryMemoryProcessing(added.id, { namespace }).accepted).toBe(false);
    await service.runWorkerOnce(1, { targetMemoryIds: [added.id] });
    if (stage === "summary") await service.runWorkerOnce(1, { targetMemoryIds: [added.id] });
    expect(repos.processing.get(added.id)?.state).toBe("ready");
    expect(db.db.prepare("SELECT COUNT(*) AS n FROM memories").get()).toEqual({ n: 1 });
  });

  it("keeps duplicate imports inert and recovers only explicitly requested legacy scan retries", async () => {
    const { service, added, repos } = setup();
    const replay = () => addAgentSourceImport(service, namespace,
      "Preserve source content when recovering a failed summary.", "bug903-recovery");
    expect(replay().id).toBe(added.id);
    expect(replay().id).toBe(added.id);
    expect(repos.processing.get(added.id)).toMatchObject({ state: "failed", manualRetryCount: 0 });
    expect(service.retryFailedMemoryProcessingOnScan(added.id)).toBe(true);
    expect(repos.processing.get(added.id)).toMatchObject({ state: "summary_pending", manualRetryCount: 1 });
    const queued = repos.runtime.getPendingJob(added.id, "import_summary");
    replay();
    expect(service.retryFailedMemoryProcessingOnScan(added.id)).toBe(false);
    expect(repos.runtime.getPendingJob(added.id, "import_summary")?.id).toBe(queued?.id);
    expect(repos.processing.get(added.id)?.manualRetryCount).toBe(1);
    await service.runWorkerOnce(1, { targetMemoryIds: [added.id] });
    await service.runWorkerOnce(1, { targetMemoryIds: [added.id] });
    const ready = repos.processing.get(added.id);
    replay();
    expect(service.retryFailedMemoryProcessingOnScan(added.id)).toBe(false);
    expect(repos.processing.get(added.id)).toEqual(ready);
  });

  it.each(["missing_trace", "empty_source", "missing_content", "missing_stage", "corrupt", "input_too_long"])(
    "keeps %s records restricted for both manual retry and scan replay", reason => {
      const { db, service, added, repos } = setup();
      if (reason === "missing_trace") db.db.prepare("UPDATE memories SET properties_json = json_remove(properties_json, '$.internal_info.trace') WHERE id = ?").run(added.id);
      if (reason === "empty_source") db.db.prepare(`UPDATE memories SET properties_json = json_set(properties_json,
        '$.internal_info.trace.userText', '', '$.internal_info.trace.agentText', '', '$.internal_info.trace.tool_calls', json('[]')) WHERE id = ?`).run(added.id);
      if (reason === "missing_content") db.db.prepare("UPDATE memories SET memory_value = '' WHERE id = ?").run(added.id);
      if (reason === "missing_stage") repos.processing.update(added.id, { stage: null });
      if (reason === "corrupt") repos.processing.update(added.id, { errorCode: "memory_corrupt" });
      if (reason === "input_too_long") repos.processing.update(added.id, { errorCode: "model_input_too_long" });
      expect(() => service.retryMemoryProcessing(added.id, { namespace })).toThrow();
      // A scan with exactly the stored source remains subject to the same eligibility rule.
      expect(service.retryFailedMemoryProcessingOnScan(added.id)).toBe(false);
      expect(repos.processing.get(added.id)?.state).toBe("failed");
      expect(service.memoryProcessingStatus([added.id], { namespace }).items[0]?.retryAction).toBe("none");
    }
  );

  it("only recovers native existing captures on an explicit full scan, preserving their identity", async () => {
    const { service, db } = createTestService({ llm: createBatchReflectionLlm([]) });
    const request = { namespace, source: "codex", channel: "agent_source_scan" as const, captureLegacyHistory: true,
      sourceTurn: { source: "codex", profileId: "default", conversationId: "bug903-conversation", turnId: "native-turn",
        startedAt: "2099-01-01T10:00:00.000Z", completedAt: "2099-01-01T10:01:00.000Z", sequence: 1,
        completionEvidence: "stop:native-turn" },
      query: "Implement and validate the isolated repair transaction.", answer: "The repair preserves each original source record." };
    const first = await service.completeSourceTurn(request);
    const id = first.result!.l1MemoryId;
    const repos = new Repositories(db.db);
    const initial = repos.processing.get(id)!;
    db.db.prepare("UPDATE evolution_jobs SET status = 'dead_letter' WHERE target_memory_id = ?").run(id);
    repos.processing.save({ ...initial, state: "failed", activeJobId: null, retryAction: "none", errorCode: "invalid_model_request" });
    const wake = vi.fn();
    await service.completeSourceTurn({ ...request, channel: "hook" }, wake);
    await service.completeSourceTurn({ ...request, captureLegacyHistory: false }, wake);
    expect(repos.processing.get(id)?.state).toBe("failed");
    expect(wake).not.toHaveBeenCalled();
    const replay = await service.completeSourceTurn(request, wake);
    expect(replay.status).toBe("existing");
    expect(replay.result?.l1MemoryId).toBe(id);
    expect(repos.processing.get(id)).toMatchObject({ state: "summary_pending", manualRetryCount: 1 });
    expect(wake).toHaveBeenCalledOnce();
    await service.completeSourceTurn(request, wake);
    expect(wake).toHaveBeenCalledOnce();
    expect(db.db.prepare("SELECT COUNT(*) AS n FROM memories").get()).toEqual({ n: 1 });
    expect(db.db.prepare("SELECT COUNT(*) AS n FROM source_turn_captures").get()).toEqual({ n: 1 });
  });
});
