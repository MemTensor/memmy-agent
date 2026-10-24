import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { createAgentSourceExecutor } from "../../../src/agent-source/runtime.js";
import { createSourceRegistry } from "../../../src/agent-source/adapters/source-registry.js";
import { MemoryDb } from "../../../src/index.js";
import { Repositories } from "../../../src/storage/repositories.js";
import type { SourceTurnCompleteRequest } from "../../../src/types.js";
import { WorkerConcurrencyController } from "../../../src/service/worker/worker-concurrency.js";
import {
  createMemoryServiceFixture, createBatchReflectionLlm, createCapturingEmbedder
} from "../../fixtures/memory-service-fixture.js";

const fixture = createMemoryServiceFixture();
afterEach(() => fixture.cleanup());

const namespace = { source: "codex", profileId: "default", userId: "scan-scheduling-user" };

function turn(index: number, overrides: Partial<SourceTurnCompleteRequest> = {}): SourceTurnCompleteRequest {
  return {
    namespace, source: "codex", channel: "agent_source_scan", captureLegacyHistory: true,
    sourceTurn: {
      source: "codex", profileId: "default", conversationId: "history-conversation", turnId: `source-turn-${index}`,
      startedAt: new Date(Date.UTC(2000, 0, 1, 10, index)).toISOString(),
      completedAt: new Date(Date.UTC(2000, 0, 1, 10, index, 30)).toISOString(),
      sequence: index, completionEvidence: `task_complete:${index}`
    },
    query: `Implement database transaction test case ${index} and preserve rollback safety.`,
    answer: `Implemented database transaction test case ${index}; rollback safety is verified.`,
    tags: ["database", "test"],
    ...overrides
  };
}

function current(index: number, overrides: Partial<SourceTurnCompleteRequest> = {}) {
  const input = turn(index);
  return turn(index, { ...input, channel: "hook", captureLegacyHistory: undefined,
    sourceTurn: { ...input.sourceTurn, conversationId: "current-conversation",
      startedAt: "2099-01-01T10:00:00.000Z", completedAt: "2099-01-01T10:00:30.000Z" }, ...overrides });
}

function harness() {
  const calls: Parameters<typeof createBatchReflectionLlm>[0] = [];
  const embeddingTexts: string[] = [];
  const h = fixture.createTestService({
    llm: createBatchReflectionLlm(calls), embedder: createCapturingEmbedder(embeddingTexts),
    concurrency: new WorkerConcurrencyController({ maxActiveJobs: 1 })
  });
  return { ...h, calls, embeddingTexts, repos: new Repositories(h.db.db) };
}

function jobs(db: MemoryDb, id: string) {
  return db.db.prepare(`SELECT id, job_type, queue_lane, base_priority, enqueue_seq, status, payload_json
    FROM evolution_jobs WHERE target_memory_id = ? ORDER BY enqueue_seq`).all(id) as Array<{
      id: string; job_type: string; queue_lane: string; base_priority: number; enqueue_seq: number;
      status: string; payload_json: string;
    }>;
}

function capture(h: ReturnType<typeof harness>, input: SourceTurnCompleteRequest) {
  const result = h.service.completeSourceTurn(input);
  expect(result.status).toBe("stored");
  expect(result.result?.l1MemoryIds).toHaveLength(1);
  return result.result!;
}

describe("native source-turn historical scheduling through MemoryService", () => {
  it.each([
    ["historical full/initial scan", (index: number) => turn(index), "import", "agent_source_scan"],
    ["post-activation historical full/initial scan", (index: number) => current(index, {
      channel: "agent_source_scan", captureLegacyHistory: true
    }), "import", "agent_source_scan"],
    ["current Hook", (index: number) => current(index), "interactive", undefined],
    ["current incremental scan", (index: number) => current(index, { channel: "agent_source_scan" }), "interactive", undefined],
    ["Hook with an irrelevant history flag", (index: number) => current(index, { captureLegacyHistory: true }), "interactive", undefined]
  ] as const)("keeps %s on the native capture pipeline with the appropriate lane", (_label, input, lane, origin) => {
    const h = harness();
    const result = capture(h, input(1));
    const memory = h.repos.memories.get(result.l1MemoryId)!;
    expect(memory.properties.internal_info.plugin_algorithm).toBe("capture.v7");
    expect(memory.properties.internal_info.capture_origin).toBe(origin);
    expect(memory.tags).toEqual(expect.arrayContaining(["database", "test"]));
    expect(memory.tags).not.toContain("agent-source");
    expect(jobs(h.db, memory.id)).toEqual([expect.objectContaining({ job_type: "trace_summary", queue_lane: lane })]);
    expect(JSON.parse(jobs(h.db, memory.id)[0]!.payload_json)).toMatchObject({ decideCapture: true });
    expect(h.repos.processing.get(memory.id)?.state).toBe("summary_pending");
  });

  it("preserves historical origin for a detached out-of-order source turn", () => {
    const h = harness();
    const newer = capture(h, turn(2));
    const older = capture(h, turn(1));
    expect(older.sessionId).not.toBe(newer.sessionId);
    expect(h.repos.memories.get(older.l1MemoryId)?.properties.internal_info.capture_origin).toBe("agent_source_scan");
    expect(jobs(h.db, older.l1MemoryId)[0]).toMatchObject({ job_type: "trace_summary", queue_lane: "import" });
  });

  it.each(["history", "current"] as const)("runs the real %s trace summarizer and inherits provenance in the generated embedding", async kind => {
    const h = harness();
    const result = capture(h, kind === "history" ? turn(1) : current(1));
    const summary = jobs(h.db, result.l1MemoryId)[0]!;
    await h.service.runWorkerOnce(1, { targetMemoryIds: [result.l1MemoryId] });
    expect(h.calls.some(call => call.options.operation === "capture.summarize")).toBe(true);
    const afterSummary = jobs(h.db, result.l1MemoryId);
    expect(afterSummary[0]).toMatchObject({ job_type: "trace_summary", status: "succeeded" });
    expect(afterSummary[1]).toMatchObject({ job_type: "embedding", queue_lane: kind === "history" ? "import" : "interactive" });
    expect(JSON.parse(afterSummary[1]!.payload_json)).toMatchObject({ reason: "trace.summary.updated", sourceJobId: summary.id });
    expect(h.repos.processing.get(result.l1MemoryId)?.state).toBe("embedding_pending");
    await h.service.runWorkerOnce(1, { targetMemoryIds: [result.l1MemoryId] });
    expect(h.embeddingTexts).toHaveLength(1);
    expect(h.repos.processing.get(result.l1MemoryId)?.state).toBe("ready");
    expect(h.repos.memories.get(result.l1MemoryId)?.properties.internal_info.plugin_algorithm).toBe("capture.v7");
    expect(h.repos.memories.get(result.l1MemoryId)?.properties.internal_info.capture_origin)
      .toBe(kind === "history" ? "agent_source_scan" : undefined);
  });

  it.each(["history", "mixed", "current"] as const)("keeps provisional and final titles in the proper %s lane", kind => {
    const h = harness();
    const input = kind === "current" ? current(1) : current(1, { channel: "agent_source_scan", captureLegacyHistory: true });
    const first = capture(h, input);
    if (kind === "mixed") {
      const next = current(2);
      next.sourceTurn = { ...next.sourceTurn, conversationId: input.sourceTurn.conversationId,
        startedAt: "2099-01-01T10:01:00.000Z", completedAt: "2099-01-01T10:01:30.000Z" };
      const second = capture(h, next);
      expect(second.episodeId).toBe(first.episodeId);
    }
    const provisional = h.db.db.prepare("SELECT queue_lane,payload_json FROM evolution_jobs WHERE episode_id=? AND job_type='episode_title'")
      .all(first.episodeId) as Array<{queue_lane: string;payload_json: string}>;
    expect(provisional.length).toBeGreaterThan(0);
    expect(provisional[0]!.queue_lane).toBe(kind === "current" ? "interactive" : "import");
    h.service.closeSession(first.sessionId);
    // A final title is only produced once capture decisions finish. Exercise the
    // same production enqueuer directly with the now-closed real episode.
    const episode = h.repos.runtime.getEpisode(first.episodeId)!;
    const inputJob = { jobType: "episode_title" as const, userId: episode.userId,
      sessionId: episode.sessionId, episodeId: episode.id, payload: { stage: "final", captureOrigin: "agent_source_scan" } };
    // A distinct stage avoids reusing the existing provisional title.
    const queued = h.service["workerHandlers"].enqueueJob(inputJob);
    expect(queued.queueLane).toBe(kind === "history" ? "import" : "interactive");
    expect(queued.payload.captureOrigin).toBe(kind === "history" ? "agent_source_scan" : undefined);
  });

  it("keeps historical embedding behind an earlier runnable historical summary in the same FIFO lane", async () => {
    const h = harness();
    const first = capture(h, turn(1));
    const second = capture(h, turn(2));
    await h.service.runWorkerOnce(1, { targetMemoryIds: [first.l1MemoryId] });
    const firstEmbedding = jobs(h.db, first.l1MemoryId).find(job => job.job_type === "embedding")!;
    const secondSummary = jobs(h.db, second.l1MemoryId)[0]!;
    expect(firstEmbedding.queue_lane).toBe("import");
    expect(secondSummary.queue_lane).toBe("import");
    expect(secondSummary.enqueue_seq).toBeLessThan(firstEmbedding.enqueue_seq);
    const executed: string[] = [];
    for (let round = 0; round < 8; round++) {
      executed.push(...(await h.service.runWorkerOnce(1)).jobs.map(job => job.jobId));
      if (executed.includes(firstEmbedding.id)) break;
    }
    expect(executed).toContain(secondSummary.id);
    expect(executed).toContain(firstEmbedding.id);
    expect(executed.indexOf(secondSummary.id)).toBeLessThan(executed.indexOf(firstEmbedding.id));
  });

  it.each([false, true])("finishes a current native summary and embedding before a historical backlog drains (separate conversations: %s)", async separate => {
    const h = harness();
    const historicalIds: string[] = [];
    for (let index = 1; index <= 48; index++) {
      const input = turn(index);
      if (separate) input.sourceTurn = { ...input.sourceTurn, conversationId: `history-conversation-${index}` };
      historicalIds.push(capture(h, input).l1MemoryId);
    }
    const live = capture(h, current(100));
    const executed: Array<{ jobType: string; targetMemoryId?: string }> = [];
    for (let round = 0; round < 24; round++) executed.push(...(await h.service.runWorkerOnce(1)).jobs);
    expect(executed).toEqual(expect.arrayContaining([
      expect.objectContaining({ jobType: "trace_summary", targetMemoryId: live.l1MemoryId }),
      expect.objectContaining({ jobType: "embedding", targetMemoryId: live.l1MemoryId })
    ]));
    expect(h.repos.processing.get(live.l1MemoryId)?.state).toBe("ready");
    expect(historicalIds.some(id => jobs(h.db, id).some(job => job.job_type === "trace_summary" && job.status === "queued"))).toBe(true);
    const historicalExecution = executed.filter(job => job.jobType === "trace_summary" && historicalIds.includes(job.targetMemoryId ?? ""));
    expect(historicalExecution.length).toBeGreaterThan(0);
    expect(historicalExecution.map(job => job.targetMemoryId)).toEqual(historicalIds.slice(0, historicalExecution.length));
  });

  it.each(["hook-first", "scan-first"] as const)("keeps the first capture origin and FIFO position through %s replay and restart", async order => {
    const h = harness();
    const live = current(1);
    const historical = { ...live, channel: "agent_source_scan" as const, captureLegacyHistory: true };
    const firstInput = order === "hook-first" ? live : historical;
    const secondInput = order === "hook-first" ? historical : live;
    const first = capture(h, firstInput);
    const expectedOrigin = order === "hook-first" ? undefined : "agent_source_scan";
    const expectedLane = order === "hook-first" ? "interactive" : "import";
    const before = jobs(h.db, first.l1MemoryId);
    expect(before[0]?.queue_lane).toBe(expectedLane);
    const duplicate = h.service.completeSourceTurn(secondInput);
    expect(duplicate).toMatchObject({ status: "existing", result: { l1MemoryId: first.l1MemoryId, jobs: [], duplicate: true } });
    expect(jobs(h.db, first.l1MemoryId)).toEqual(before);
    expect(h.repos.memories.get(first.l1MemoryId)?.properties.internal_info.capture_origin).toBe(expectedOrigin);
    expect(h.service.completeSourceTurn({ ...secondInput, answer: "A conflicting answer." }))
      .toMatchObject({ status: "conflict", reason: "source_turn_content_conflict" });
    expect(jobs(h.db, first.l1MemoryId)).toEqual(before);
    expect(h.repos.memories.get(first.l1MemoryId)?.properties.internal_info.capture_origin).toBe(expectedOrigin);
    await h.service.stop();
    h.db.close();
    const reopened = new MemoryDb({ path: join(h.root, "memory.sqlite") });
    const restarted = fixture.createTestMemoryService({ db: reopened, llm: createBatchReflectionLlm([]) });
    expect(restarted.completeSourceTurn(secondInput)).toMatchObject({ status: "existing", result: { l1MemoryId: first.l1MemoryId, jobs: [] } });
    expect(jobs(reopened, first.l1MemoryId)).toEqual(before);
    expect(new Repositories(reopened.db).memories.get(first.l1MemoryId)?.properties.internal_info.capture_origin).toBe(expectedOrigin);
  });

  it("keeps a real onboarding report and its embedding interactive during historical native backlog", async () => {
    const h = harness();
    for (let index = 1; index <= 16; index++) capture(h, turn(index));
    const report = h.service.addMemory({
      namespace, adapterId: "agent-source:memmy-onboarding", requestId: "scan-backlog-report", layer: "L1",
      source: "memmy-onboarding", tags: ["agent-source", "first-encounter-report", "onboarding-report"],
      title: "Memmy First Encounter Report", turnId: "scan-backlog-report", deferProcessing: true,
      content: "## user\n\nGenerate the first encounter report.\n\n## assistant\n\nThe report and next step are ready."
    });
    h.service.enqueuePendingImportSummaries(10_000, [report.id]);
    expect(jobs(h.db, report.id)[0]).toMatchObject({ job_type: "import_summary", queue_lane: "interactive", base_priority: -100 });
    for (let round = 0; round < 16; round++) await h.service.runWorkerOnce(1);
    expect(jobs(h.db, report.id)).toEqual(expect.arrayContaining([
      expect.objectContaining({ job_type: "embedding", queue_lane: "interactive", base_priority: -100, status: "succeeded" })
    ]));
    expect(h.repos.processing.get(report.id)?.state).toBe("ready");
  });

  it.each(["manual", "startup"] as const)("keeps the %s recovery override ahead of historical origin", mode => {
    const h = harness();
    const result = capture(h, turn(1));
    // Represent an interrupted/missing queue row without changing the captured
    // memory. Recovery must use its existing API and retain native provenance.
    h.db.db.prepare("DELETE FROM evolution_jobs WHERE target_memory_id = ?").run(result.l1MemoryId);
    if (mode === "manual") {
      h.repos.processing.update(result.l1MemoryId, { state: "failed", stage: "summary", activeJobId: null,
        errorCode: "llm_request_failed", errorMessage: "fixture transient failure", retryAction: "retry",
        updatedAt: new Date().toISOString() });
      expect(h.service.retryMemoryProcessing(result.l1MemoryId, { namespace }).accepted).toBe(true);
    } else h.service.reconcileWorkerStartup();
    expect(jobs(h.db, result.l1MemoryId)[0]).toMatchObject({
      job_type: "trace_summary", queue_lane: mode === "manual" ? "repair_retry" : "maintenance"
    });
    expect(h.repos.memories.get(result.l1MemoryId)?.properties.internal_info.capture_origin).toBe("agent_source_scan");
  });

  it.each(["full", "initial_subset", "incremental"] as const)("passes native %s scan provenance from the actual executor into MemoryService", async mode => {
    const h = harness();
    const input = current(1);
    const sourceTurn = { ...input.sourceTurn, query: input.query, answer: input.answer, status: "succeeded" as const,
      toolCalls: [], toolResults: [] };
    const executor = createAgentSourceExecutor({
      service: h.service, configPath: join(h.root, "config.yaml"), statePath: join(h.root, "source-state.json"),
      sourceRegistry: createSourceRegistry([{
        descriptor: { sourceId: "codex", displayName: "Codex fixture", builtin: true, dataPath: h.root },
        async detect() { return true; },
        async *scan() {
          for (const [ordinal, role] of ["user", "assistant"].entries()) yield {
            messageId: `native-message-${ordinal}`, sourceId: "codex", conversationId: sourceTurn.conversationId,
            role: role as "user" | "assistant", content: role === "user" ? input.query : input.answer,
            createdAt: role === "user" ? sourceTurn.startedAt : sourceTurn.completedAt,
            workspacePath: null, gitRoot: null,
            rawMeta: { sourceTurnState: "complete", sourceTurnId: sourceTurn.turnId, sourceTurn }
          };
        }
      }])
    });
    try {
      await executor.startScan({ sourceId: "codex", mode });
      await vi.waitFor(() => expect(executor.scanStatus().running).toBe(false));
      expect(executor.scanStatus().error).toBeNull();
      const rows = h.db.db.prepare("SELECT target_memory_id FROM evolution_jobs WHERE job_type = 'trace_summary'")
        .all() as Array<{ target_memory_id: string }>;
      expect(rows).toHaveLength(1);
      const id = rows[0]!.target_memory_id;
      expect(jobs(h.db, id)[0]?.queue_lane).toBe(mode === "incremental" ? "interactive" : "import");
      expect(h.repos.memories.get(id)?.properties.internal_info.capture_origin)
        .toBe(mode === "incremental" ? undefined : "agent_source_scan");
      expect(h.repos.memories.get(id)?.properties.internal_info.plugin_algorithm).toBe("capture.v7");
      const before = jobs(h.db, id);
      await executor.startScan({ sourceId: "codex", mode });
      await vi.waitFor(() => expect(executor.scanStatus().running).toBe(false));
      expect(executor.scanStatus().error).toBeNull();
      expect(jobs(h.db, id)).toEqual(before);
    } finally { await executor.dispose(); }
  });
});
