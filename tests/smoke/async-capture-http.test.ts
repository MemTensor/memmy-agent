import { afterEach, describe, expect, it } from "vitest";
import { join } from "node:path";
import { createMemoryHttpServer, closeMemoryHttpServer } from "../../Memory/src/server/http.js";
import { createHttpMemoryClient } from "../../App/backend/src/adapters/outbound/memory-client/http-memory-client.js";
import { createMemoryServiceFixture } from "../../Memory/tests/fixtures/memory-service-fixture.js";
import { createTurnJudgeLlm, turnJudgeConfig } from "../../Memory/tests/service/session/turn-judge-llm.js";
const fixture = createMemoryServiceFixture();
afterEach(fixture.cleanup);

describe("async capture through the real Backend HTTP client", () => {
  it.each([true, false].flatMap(enabled => ["episode.select.v1", "capture.summarize"].map(failedOperation => ({ enabled, failedOperation }))))(
    "recovers $failedOperation failure with turnJudge=$enabled through persisted completion states", async ({ enabled, failedOperation }) => {
    const { llm } = createTurnJudgeLlm(); const complete = llm.completeJson;
    let fail = true;
    let successfulIndependentCalls = 0;
    const operations: string[] = [];
    llm.completeJson = async (messages, options) => {
      operations.push(options.operation);
      if (fail && options.operation === failedOperation) throw new Error("network disconnected");
      if (["episode.select.v1", "capture.summarize"].includes(options.operation) && options.operation !== failedOperation) successfulIndependentCalls++;
      return complete(messages, options);
    };
    const { service, db, root } = fixture.createTestService({ llm, config: turnJudgeConfig(enabled) });
    const { sessionId } = service.openSession({});
    const server = createMemoryHttpServer({ service, configPath: join(root, "config.yaml"), startAgentSourceAutomation: false,
      workerStartupFallbackMs: 60_000, auth: { mode: "dev", allowAnonymous: true } });
    // Exercise the HTTP worker alongside the production automatic scheduler.
    try {
      await new Promise<void>((resolve, reject) => {
        server.once("error", reject);
        server.listen(0, "127.0.0.1", () => { server.off("error", reject); resolve(); });
      });
      const address = server.address() as { port: number };
      const client = createHttpMemoryClient({ baseUrl: `http://127.0.0.1:${address.port}`, token: "", timeoutMs: 5000, maxRetries: 0 });
      const result = await client.completeTurn({ sessionId, turnId: "http-failure", query: "Original HTTP request", answer: "Original HTTP answer" });
      expect(result.assignmentStatus).toBe("pending");
      expect(result.episodeId).toBeUndefined();
      expect(db.db.prepare("SELECT user_text FROM raw_turns WHERE id=?").get(result.rawTurnId)).toEqual({ user_text: "Original HTTP request" });
      expect(result.jobs.map(job => job.jobType)).toEqual(expect.arrayContaining(["episode_assignment", "episode_finalize"]));
      await client.runWorker({ limit: 30 });
      const failedJobType = failedOperation === "episode.select.v1" ? "episode_assignment" : "trace_summary";
      await expect.poll(() => db.db.prepare("SELECT status FROM evolution_jobs WHERE job_type=?").get(failedJobType))
        .toEqual({ status: "dead_letter" });
      const completedIndependentCalls = successfulIndependentCalls;
      expect(completedIndependentCalls).toBe(1);
      fail = false;
      expect((await client.retryMemoryProcessing(result.l1MemoryId)).accepted).toBe(true);
      const seen: string[] = [];
      for (let i = 0; i < 8; i++) {
        const run = await client.runWorker({ limit: 30 });
        seen.push(...run.jobs.map(job => job.jobType));
        expect(run.failed, JSON.stringify({ operations, jobs: db.db.prepare("SELECT job_type,status,last_error FROM evolution_jobs").all() })).toBe(0);
        if (!run.leased) break;
      }
      await expect.poll(() => db.db.prepare("SELECT status FROM evolution_jobs WHERE job_type='episode_finalize'").get())
        .toEqual({ status: "succeeded" });
      await expect.poll(() => db.db.prepare("SELECT state FROM memory_processing_state WHERE memory_id=?").get(result.l1MemoryId))
        .toEqual({ state: "ready" });
      expect(successfulIndependentCalls).toBe(completedIndependentCalls);
      expect(db.db.prepare("SELECT job_type,status FROM evolution_jobs WHERE status='succeeded' AND job_type IN ('trace_summary','episode_assignment','episode_finalize') ORDER BY job_type").all())
        .toEqual(["episode_assignment", "episode_finalize", "trace_summary"].map(job_type => ({ job_type, status: "succeeded" })));
      expect(db.db.prepare("SELECT count(*) AS n FROM evolution_jobs WHERE status IN ('queued','leased','failed') AND job_type IN ('trace_summary','episode_assignment','episode_finalize')").get()).toEqual({ n: 0 });
      expect(db.db.prepare("SELECT episode_id FROM raw_turns WHERE id=?").get(result.rawTurnId)).toMatchObject({ episode_id: expect.any(String) });
      const duplicate = await client.completeTurn({ sessionId, turnId: "http-failure", query: "Original HTTP request", answer: "Original HTTP answer" });
      expect(duplicate.duplicate).toBe(true);
      expect(duplicate.rawTurnId).toBe(result.rawTurnId);
      expect(duplicate.assignmentStatus).toBe("assigned");
      expect(db.db.prepare("SELECT count(*) AS n FROM raw_turns").get()).toEqual({ n: 1 });
    } finally { await closeMemoryHttpServer(server); }
  });
});
