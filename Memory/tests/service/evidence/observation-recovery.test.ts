import type { Server } from "node:http";
import { afterEach, describe, expect, it, vi } from "vitest";
import { DEFAULT_MEMMY_CONFIG, MemoryDb, createMemoryHttpServer, type LlmClient } from "../../../src/index.js";
import type { LlmMessage } from "../../../src/model/types.js";
import { closeMemoryHttpServer } from "../../../src/server/http.js";
import { observationMemoryState } from "../../../src/service/observation-memory-state.js";
import { Repositories } from "../../../src/storage/repositories.js";
import { createMemoryServiceFixture, runWorkerRoundsWithDueRetries } from "../../fixtures/memory-service-fixture.js";

const { cleanup, createTestMemoryService } = createMemoryServiceFixture();
const servers: Server[] = [];
afterEach(async () => {
  for (const server of servers.splice(0)) await closeMemoryHttpServer(server);
  await cleanup();
});

const namespace = { source: "memmy", profileId: "default", userId: "history-recovery-user" };
const revision = "2026-10-19T12:00:00.000Z";

describe("History recovery across runtime lifecycle", () => {
  it.each(["startup", "config reload"] as const)("recovers five exhausted observation failures on %s without manual retry", async (lifecycle) => {
    let validOutput = false;
    const llm: LlmClient = {
      config: DEFAULT_MEMMY_CONFIG.summary,
      isConfigured: () => true,
      complete: async () => "",
      status: () => ({ provider: "test", configured: true, remote: false }),
      async completeJson<T extends Record<string, unknown>>(messages: LlmMessage[]) {
        const input = JSON.parse(messages[1]!.content) as { sources: Array<{ id: string; content: string }> };
        const source = input.sources.find((item) => item.content.includes("The A17 order review"))!;
        const fact = validOutput
          ? source.content.match(/The A17 order review for source \d must retain locked production orders\./u)![0]
          : "All locked production orders were rescheduled.";
        return { keep: true, title: "A17 production constraint", summary: fact,
          items: [{ category: "constraint", text: fact, source_memory_id: source.id, evidence_quote: fact }] } as unknown as T;
      }
    };
    const skillLlm: LlmClient = { ...llm, async completeJson<T extends Record<string, unknown>>() {
      return { create: true, name: "review_a17_production", summary: "Review A17 production while preserving locked orders.",
        trigger: "When planning the A17 order", selectedActionIds: ["a1", "a2", "a3", "a4"] } as unknown as T;
    } };
    const db = new MemoryDb({ path: ":memory:" });
    let service = createTestMemoryService({ db, mode: "dev", config: DEFAULT_MEMMY_CONFIG,
      configLoader: () => ({ config: DEFAULT_MEMMY_CONFIG }), llm, skillLlm });
    const repos = new Repositories(db.db);
    const sourceRecordIds = Array.from({ length: 5 }, (_value, index) => `recovery-window-${index}`);
    const baseEvidence = { action: "upsert" as const, source: "computer_history", namespace, revision,
      title: "A17 production review", summary: "Preserve locked orders when reviewing A17 production.",
      startedAt: "2026-10-19T10:00:00.000Z", endedAt: "2026-10-19T10:10:00.000Z" };
    const rows = sourceRecordIds.map((sourceRecordId, index) => service.syncExternalEvidence({ ...baseEvidence, sourceRecordId,
      content: `**Production constraint**: The A17 order review for source ${index} must retain locked production orders.` }));
    // Lifecycle recovery starts from exhausted failures; make only these retries
    // due explicitly instead of bypassing the production backoff rule.
    await runWorkerRoundsWithDueRetries(service, db, rows.map(row => row.id), 3);
    for (const row of rows) {
      expect(service.memoryProcessingStatus([row.id]).items[0]).toMatchObject({
        state: "failed", stage: "summary", attemptCount: 3, manualRetryCount: 0,
        errorMessage: expect.stringContaining("quote_grounding")
      });
    }

    const aggregate = service.syncExternalEvidence({ ...baseEvidence, sourceRecordId: "recovery-six-hour-summary",
      content: "Six hours of A17 production planning observations.", parentSourceRecordIds: sourceRecordIds });
    const suggestion = { source: "computer_history", namespace, revision, groupId: "a17-production-recovery",
      sourceRecordIds: sourceRecordIds.slice(0, 2), actions: [
        { sourceRecordId: sourceRecordIds[0]!, text: "Open the A17 order" },
        { sourceRecordId: sourceRecordIds[0]!, text: "Review the production requirement" },
        { sourceRecordId: sourceRecordIds[1]!, text: "Identify locked production orders" },
        { sourceRecordId: sourceRecordIds[1]!, text: "Preserve the locked production schedule" }
      ] };
    await expect(service.suggestExternalEvidenceSkill(suggestion)).rejects.toThrow("source meaningful memory requires retry");

    validOutput = true;
    if (lifecycle === "startup") {
      await service.stop();
      service = createTestMemoryService({ db, mode: "dev", config: DEFAULT_MEMMY_CONFIG,
        configLoader: () => ({ config: DEFAULT_MEMMY_CONFIG }), llm, skillLlm });
      // Exercise the actual HTTP startup worker used by a newly activated runtime.
      const server = createMemoryHttpServer({ service, workerStartupFallbackMs: 0 });
      servers.push(server);
      await new Promise<void>((resolveListen) => server.listen(0, "127.0.0.1", resolveListen));
    } else {
      service.reloadConfig();
      for (const row of rows) expect(service.memoryProcessingStatus([row.id]).items[0]).toMatchObject({
        state: "summary_pending", attemptCount: 0, manualRetryCount: 0
      });
    }

    await vi.waitFor(async () => {
      if (lifecycle === "config reload") await service.runWorkerOnce(100);
      for (const row of [...rows, aggregate]) expect(service.memoryProcessingStatus([row.id]).items[0]?.state).toBe("ready");
    }, { timeout: 5_000, interval: 20 });

    for (const row of rows) {
      expect(service.memoryProcessingStatus([row.id]).items[0]).toMatchObject({
        state: "ready", manualRetryCount: 0, errorCode: null, errorMessage: null, failedAt: null
      });
      expect(observationMemoryState(repos.memories.get(row.id)!)).toMatchObject({ status: "processed" });
      expect(db.db.prepare("SELECT status, attempts FROM evolution_jobs WHERE target_memory_id = ? AND job_type = 'observation_extract' ORDER BY created_at, id")
        .all(row.id)).toEqual(expect.arrayContaining([{ status: "dead_letter", attempts: 3 }, { status: "succeeded", attempts: 1 }]));
    }
    expect(observationMemoryState(repos.memories.get(aggregate.id)!)).toMatchObject({ status: "processed" });
    expect(await service.suggestExternalEvidenceSkill(suggestion)).toMatchObject({ status: "active" });
  });
});
