import { afterEach, describe, expect, it, vi } from "vitest";
import { Repositories } from "../../../src/storage/repositories.js";
import { updateTraceImportSummary } from "../../../src/service/import/import-job-processor.js";
import {
  addAgentSourceImport, createBatchReflectionLlm, createMemoryServiceFixture
} from "../../fixtures/memory-service-fixture.js";

const { cleanup, createTestService } = createMemoryServiceFixture();
afterEach(async () => { vi.restoreAllMocks(); await cleanup(); });
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
  it("batches polling lookups without loading vectors or changing stored diagnostics", () => {
    const { service, added, repos } = setup();
    const owner = service as unknown as { repos: Repositories };
    const get = vi.spyOn(owner.repos.memories, "get");
    const getMany = vi.spyOn(owner.repos.memories, "getMany");
    const before = repos.processing.get(added.id);
    const items = service.memoryProcessingStatus(Array(400).fill(added.id), { namespace }).items;
    expect(items).toHaveLength(1);
    expect(items[0]?.retryAction).toBe("retry");
    expect(get).not.toHaveBeenCalled();
    expect(getMany).toHaveBeenCalledExactlyOnceWith([added.id], { includeVectors: false });
    expect(repos.processing.get(added.id)).toEqual(before);
  });

  it.each(["work_memory", "span"] as const)("preserves embedding retries for L1 %s records without trace metadata", async kind => {
    const { service, added, repos } = setup();
    const memory = repos.memories.get(added.id)!;
    const { trace: _trace, plugin_algorithm: _algorithm, ...internal } = memory.properties.internal_info;
    repos.memories.update({ ...memory, memoryValue: "Completed quartzdeploy validation.", tags: [],
      info: { ...memory.info, summary: "Completed quartzdeploy validation." },
      properties: { ...memory.properties, internal_info: { ...internal, memory_kind: kind } } });
    repos.processing.update(added.id, { stage: "embedding", retryAction: "retry", errorCode: "transient_provider_error" });
    const result = service.retryMemoryProcessing(added.id, { namespace });
    expect(result.accepted).toBe(true);
    expect(result.processing.state).toBe("embedding_pending");
    await service.runWorkerOnce(1, { targetMemoryIds: [added.id] });
    expect(repos.processing.get(added.id)?.state).toBe("ready");
  });

  it("honours the caller's tenant when recovering scan failures", () => {
    const { service, added, repos } = setup();
    const memory = repos.memories.get(added.id)!;
    repos.memories.update({ ...memory, properties: { ...memory.properties, internal_info: {
      ...memory.properties.internal_info, external_evidence: { source: "fixture", namespace: { ...namespace, tenantId: "owner" } }
    } } });
    const before = repos.processing.get(added.id);
    expect(service.retryFailedMemoryProcessingOnScan(added.id, { namespace: { ...namespace, tenantId: "other" } })).toBe(false);
    expect(repos.processing.get(added.id)).toEqual(before);
    expect(service.retryFailedMemoryProcessingOnScan(added.id, { namespace: { ...namespace, tenantId: "owner" } })).toBe(true);
  });

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

  function nativeFailure() {
    const fixture = createTestService({ llm: createBatchReflectionLlm([]) });
    const request = { namespace, source: "codex", channel: "agent_source_scan" as const, captureLegacyHistory: true,
      sourceTurn: { source: "codex", profileId: "default", conversationId: "recovery-episode-conversation", turnId: "episode-turn",
        startedAt: "2099-01-01T10:00:00.000Z", completedAt: "2099-01-01T10:01:00.000Z", sequence: 1,
        completionEvidence: "stop:episode-turn" },
      query: "Validate the isolated recovery transaction.", answer: "Preserve the original capture and dependent tasks." };
    return { ...fixture, request };
  }

  async function failedNativeWithEpisodeTasks() {
    const fixture = nativeFailure();
    const { db, service, request } = fixture;
    const first = await service.completeSourceTurn(request);
    const id = first.result!.l1MemoryId;
    const rawTurnId = first.result!.rawTurnId;
    const repos = new Repositories(db.db);
    const row = db.db.prepare("SELECT id FROM evolution_jobs WHERE target_memory_id=? LIMIT 1").get(id) as { id: string };
    const template = repos.runtime.getJob(row.id)!;
    db.db.prepare("UPDATE evolution_jobs SET status='dead_letter' WHERE target_memory_id=?").run(id);
    repos.processing.update(id, { state: "failed", stage: "summary", activeJobId: null, retryAction: "none", errorCode: "invalid_model_request" });
    db.db.prepare("UPDATE raw_turns SET message_payload_json=json_set(message_payload_json,'$.episode_assignment',json(?)) WHERE id=?")
      .run(JSON.stringify({ status: "failed", generation: 1 }), rawTurnId);
    const tasks = ["episode_assignment", "episode_finalize"] as const;
    for (const jobType of tasks) repos.runtime.enqueueJob({ ...template, id: `recovery-${jobType}`, jobType, status: "dead_letter",
      dedupeKey: undefined, payload: { rawTurnId, generation: 1 }, targetMemoryId: id });
    // This task belongs to an earlier generation and must remain untouched.
    repos.runtime.enqueueJob({ ...template, id: "recovery-stale-generation", jobType: "episode_assignment", status: "dead_letter",
      dedupeKey: undefined, payload: { rawTurnId, generation: 0 }, targetMemoryId: id });
    return { ...fixture, id, rawTurnId, repos, tasks };
  }

  function internals(service: ReturnType<typeof createTestService>["service"]) {
    return service as unknown as {
      repos: Repositories;
      importJobs: { retryMemoryProcessing: (...args: unknown[]) => unknown };
      workerHandlers: { appendJobChange: (...args: unknown[]) => void };
    };
  }

  it.each(["manual", "scan"] as const)("atomically recovers memory and matching Episode work through %s retry", async kind => {
    const { service, db, request, id, tasks, repos } = await failedNativeWithEpisodeTasks();
    const original = repos.memories.get(id);
    const observed: unknown[] = [];
    const notify = vi.fn(() => observed.push({ inTransaction: db.db.inTransaction,
      memoryState: repos.processing.get(id)?.state,
      episodeStates: tasks.map(task => repos.runtime.getJob(`recovery-${task}`)?.status) }));
    service.setCapturePendingListener(notify);
    if (kind === "manual") expect(service.retryMemoryProcessing(id, { namespace }).accepted).toBe(true);
    else expect(service.retryFailedMemoryProcessingOnScan(id)).toBe(true);
    expect(notify).toHaveBeenCalledOnce();
    expect(observed).toEqual([{ inTransaction: false, memoryState: "summary_pending", episodeStates: ["queued", "queued"] }]);
    expect(repos.memories.get(id)).toEqual(original);
    expect(repos.runtime.getJob("recovery-stale-generation")?.status).toBe("dead_letter");
    for (const task of tasks) {
      expect(db.db.prepare("SELECT COUNT(*) AS n FROM memory_change_log WHERE entity_id=? AND change_type='job_queued'")
        .get(`recovery-${task}`)).toEqual({ n: 1 });
    }
    const after = repos.processing.get(id);
    expect(service.retryFailedMemoryProcessingOnScan(id)).toBe(false);
    expect(repos.processing.get(id)).toEqual(after);
    expect(notify).toHaveBeenCalledOnce();
    service.setCapturePendingListener(undefined);
    expect((await service.completeSourceTurn(request)).status).toBe("existing");
  });

  it.each(["enqueue", "episode", "change"] as const)("rolls back all recovery writes on %s failure; scan is best effort and manual retry reports failure", async step => {
    const { service, db, id, repos } = await failedNativeWithEpisodeTasks();
    const target = internals(service);
    const before = repos.processing.get(id);
    const jobsBefore = db.db.prepare("SELECT * FROM evolution_jobs ORDER BY id").all();
    const changesBefore = db.db.prepare("SELECT COUNT(*) AS n FROM memory_change_log").get();
    const notify = vi.fn();
    service.setCapturePendingListener(notify);
    if (step === "enqueue") {
      const real = target.importJobs.retryMemoryProcessing.bind(target.importJobs);
      vi.spyOn(target.importJobs, "retryMemoryProcessing").mockImplementation((...args) => {
        real(...args); throw new Error("injected enqueue failure");
      });
    } else if (step === "episode") {
      const real = target.repos.runtime.requeueFailedEpisodeAssignments.bind(target.repos.runtime);
      vi.spyOn(target.repos.runtime, "requeueFailedEpisodeAssignments").mockImplementation((...args) => {
        real(...args); throw new Error("injected episode failure");
      });
    } else {
      vi.spyOn(target.workerHandlers, "appendJobChange").mockImplementation(() => { throw new Error("injected change failure"); });
    }
    expect(service.retryFailedMemoryProcessingOnScan(id)).toBe(false);
    expect(() => service.retryMemoryProcessing(id, { namespace })).toThrow(`injected ${step} failure`);
    expect(repos.processing.get(id)).toEqual(before);
    expect(db.db.prepare("SELECT * FROM evolution_jobs ORDER BY id").all()).toEqual(jobsBefore);
    expect(db.db.prepare("SELECT COUNT(*) AS n FROM memory_change_log").get()).toEqual(changesBefore);
    expect(notify).not.toHaveBeenCalled();
  });

  it("keeps native capture accepted when dependent recovery fails", async () => {
    const { service, db, request, id, repos } = await failedNativeWithEpisodeTasks();
    vi.spyOn(internals(service).repos.runtime, "requeueFailedEpisodeAssignments").mockImplementation(() => {
      throw new Error("injected native recovery failure");
    });
    const response = await service.completeSourceTurn(request);
    expect(response.status).toBe("existing");
    expect(response.result?.l1MemoryId).toBe(id);
    expect(repos.processing.get(id)?.state).toBe("failed");
    expect(db.db.prepare("SELECT COUNT(*) AS n FROM source_turn_captures").get()).toEqual({ n: 1 });
    expect(db.db.prepare("SELECT COUNT(*) AS n FROM memories").get()).toEqual({ n: 1 });
  });

  it("does not touch failed Episode tasks behind ready or active memory during scan replay", async () => {
    const { service, id, repos } = await failedNativeWithEpisodeTasks();
    for (const state of ["ready", "summary_pending", "summarizing", "embedding_pending", "embedding"] as const) {
      repos.processing.update(id, { state });
      expect(service.retryFailedMemoryProcessingOnScan(id)).toBe(false);
      expect(repos.runtime.getJob("recovery-episode_assignment")?.status).toBe("dead_letter");
    }
  });

  it("does not report a committed retry as failed when its scheduling listener throws", () => {
    const { service, added, repos } = setup();
    service.setCapturePendingListener(() => { throw new Error("injected listener failure"); });
    expect(service.retryFailedMemoryProcessingOnScan(added.id)).toBe(true);
    expect(repos.processing.get(added.id)?.state).toBe("summary_pending");
  });

  it.each(["assigned", "deleted", "redacted"] as const)("does not restore %s raw-turn Episode work", async reason => {
    const { service, db, id, rawTurnId, repos } = await failedNativeWithEpisodeTasks();
    if (reason === "assigned") db.db.prepare("UPDATE raw_turns SET message_payload_json=json_set(message_payload_json,'$.episode_assignment.status','assigned') WHERE id=?").run(rawTurnId);
    else db.db.prepare(`UPDATE raw_turns SET ${reason === "deleted" ? "deleted_at" : "redacted_at"}=? WHERE id=?`)
      .run(new Date().toISOString(), rawTurnId);
    expect(service.retryFailedMemoryProcessingOnScan(id)).toBe(true);
    expect(repos.processing.get(id)?.state).toBe("summary_pending");
    expect(repos.runtime.getJob("recovery-episode_assignment")?.status).toBe("dead_letter");
    expect(repos.runtime.getJob("recovery-episode_finalize")?.status).toBe("dead_letter");
  });
});
