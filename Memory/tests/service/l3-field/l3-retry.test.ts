import { mkdirSync } from "node:fs";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import { afterEach, describe, expect, it, vi } from "vitest";
import { createMemoryHttpServer, DEFAULT_MEMMY_CONFIG, MemoryDb } from "../../../src/index.js";
import { ModelHttpError } from "../../../src/model/http.js";
import type { LlmClient } from "../../../src/model/types.js";
import { l3FailureHandling } from "../../../src/service/worker/job-handlers.js";
import { Repositories, type EvolutionJobRecord } from "../../../src/storage/repositories.js";
import { createMemoryServiceFixture, settleCaptureAssignments } from "../../fixtures/memory-service-fixture.js";

const fixture = createMemoryServiceFixture();
afterEach(() => fixture.cleanup());

const MACHINE_ID = "9".repeat(64);
const networkError = () => new Error("fetch failed: network connect ECONNRESET");
/** Reached the host, then lost the connection: retried, unlike being offline. */
const networkErrorAfterConnect = () => new TypeError("fetch failed", { cause: { code: "ECONNRESET" } });

function job(over: Partial<EvolutionJobRecord> = {}): EvolutionJobRecord {
  return { id: "j", jobType: "l3_unit_update", status: "leased", userId: "u", payload: {}, attempts: 1, failureCount: 0, maxAttempts: 3,
    createdAt: "", updatedAt: "", ...over } as EvolutionJobRecord;
}

describe("L3 failure handling", () => {
  it("waits 1, 5, 15, 30 and 60 minutes after temporary failures, then sends the sixth failure to dead letter", () => {
    expect([0, 1, 2, 3, 4].map((failureCount) => l3FailureHandling(job({ failureCount }), networkError())))
      .toEqual([1, 5, 15, 30, 60].map((delayMinutes) => ({ kind: "retry_later", delayMinutes, maxAttempts: 6 })));
    expect(l3FailureHandling(job({ failureCount: 5 }), networkError())).toEqual({ kind: "dead_letter" });
  });

  it("recognizes the errors the model clients really throw", () => {
    const aborted = Object.assign(new Error("This operation was aborted"), { name: "AbortError" });
    expect(l3FailureHandling(job(), aborted).kind).toBe("retry_later");
    expect(l3FailureHandling(job(), new TypeError("fetch failed", { cause: { code: "ECONNRESET" } })).kind).toBe("retry_later");
    expect(l3FailureHandling(job(), new Error("openai_responses response missing output text")).kind).toBe("retry_later");
    expect(l3FailureHandling(job(), new Error("bedrock response missing output.message.content")).kind).toBe("retry_later");
    expect(l3FailureHandling(job(), new Error("host response missing text/content/output")).kind).toBe("retry_later");
    expect(l3FailureHandling(job(), new Error("deepseek HTTP 200: expected JSON but received an empty response")).kind).toBe("retry_later");
    expect(l3FailureHandling(job(), new Error("p HTTP 200: expected JSON but received text/html; check the configured model endpoint")).kind)
      .toBe("default");
    expect(l3FailureHandling(job(), new TypeError("Cannot read properties of undefined (reading 'x')")).kind).toBe("retry_later");
  });

  it("suspends without using an attempt when the model endpoint cannot be reached, as when offline", () => {
    expect(l3FailureHandling(job(), new TypeError("fetch failed")).kind).toBe("suspend");
    expect(l3FailureHandling(job(), new TypeError("fetch failed", { cause: { code: "ENOTFOUND" } })).kind).toBe("suspend");
    expect(l3FailureHandling(job({ failureCount: 5 }), new TypeError("fetch failed", { cause: { code: "ECONNREFUSED" } })).kind)
      .toBe("suspend");
  });

  it("retries empty replies, timeouts, rate limits and rejected answers later, and leaves other job types alone", () => {
    const rejected = new Error("l3 unit output rejected twice: ops[0]: content is empty");
    expect(l3FailureHandling(job({ failureCount: 0 }), rejected)).toEqual({ kind: "retry_later", delayMinutes: 1, maxAttempts: 6 });
    // Likely to fail the same way again: one more try only.
    expect(l3FailureHandling(job({ failureCount: 1 }), rejected)).toEqual({ kind: "dead_letter" });
    expect(l3FailureHandling(job(), new Error("openai_compatible response missing choices[0].message.content")).kind).toBe("retry_later");
    expect(l3FailureHandling(job(), new TypeError("invalid JSON: Unexpected end of JSON input")).kind).toBe("retry_later");
    expect(l3FailureHandling(job(), new Error("request timed out after 180000ms")).kind).toBe("retry_later");
    expect(l3FailureHandling(job(), new ModelHttpError("too many", "p", 429, undefined, "rate limit")).kind).toBe("retry_later");
    expect(l3FailureHandling(job(), new Error("l3 unit output rejected twice: ops[0]: content is empty")).kind).toBe("retry_later");
    expect(l3FailureHandling(job({ jobType: "reward" }), networkError()).kind).toBe("default");
  });

  it("suspends on used-up quota (40309) and leaves a bad key to the queue's configuration hold", () => {
    expect(l3FailureHandling(job(), new ModelHttpError("quota", "p", 403, "40309", "")).kind).toBe("suspend");
    expect(l3FailureHandling(job(), new Error("401 unauthorized: invalid api key")).kind).toBe("default");
  });
});

describe("L3 retries through the job queue", () => {
  function setup(complete: LlmClient["complete"], configured = true) {
    const root = fixture.createTestRoot("l3-retry-");
    const home = join(root, "home");
    const project = join(home, "code", "demo");
    mkdirSync(project, { recursive: true });
    const db = new MemoryDb({ path: join(root, "memory.sqlite") });
    const config = structuredClone(DEFAULT_MEMMY_CONFIG);
    config.algorithm.l3FieldCognition.enabled = true;
    const skillLlm = testLlm(complete, configured);
    const service = fixture.createTestMemoryService({
      db, mode: "dev", config, skillLlm,
      l3FieldEnvironment: () => ({ machineId: MACHINE_ID, homeDir: home, tempRoots: [] }),
      l3MachineProbe: () => new Promise(() => undefined)
    });
    const repos = new Repositories(db.db);
    const sessions: string[] = [];
    const freeze = async (key: string) => {
      const opened = service.openSession({
        l3WorldModelProtocolVersion: 2, l3WorldModelTransition: "resume_only",
        workspaceUri: pathToFileURL(project).href, workspaceHostId: "b".repeat(64),
        namespace: { source: "codex", profileId: "default", sessionKey: key, userId: "u1" }
      });
      await service.completeTurn(`${key}-turn`, {
        sessionId: opened.sessionId, query: "以后改完都跑 npm test", answer: "好", status: "succeeded",
        toolCalls: [{ id: "c", name: "exec_command", input: { cmd: "npm test", workdir: project }, success: false }],
        toolResults: [{ id: "c", name: "exec_command", output: "vitest: command not found", exitCode: 127 }]
      });
      service.closeSession(opened.sessionId);
      // The close freezes the session once its turns are assigned to a task.
      await settleCaptureAssignments(service);
      sessions.push(opened.sessionId);
      // This test is about the L3 job, not summaries: mark the L1 summaries done so the job can be leased.
      repos.db.prepare(`UPDATE memory_processing_state SET state = 'ready'`).run();
      repos.db.prepare(`UPDATE evolution_jobs SET status = 'succeeded' WHERE job_type IN ('trace_summary', 'episode_title')`).run();
    };
    const unitJobs = () => repos.db.prepare(
      `SELECT id, status, attempts, max_attempts, scope_seq, json_extract(payload_json, '$.runAfter') AS run_after,
              json_extract(payload_json, '$.batchId') AS batch_id
       FROM evolution_jobs WHERE job_type = 'l3_unit_update' ORDER BY scope_seq`
    ).all() as Array<{ id: string; status: string; attempts: number; max_attempts: number; scope_seq: number; run_after: string | null; batch_id: string }>;
    const runNow = async () => {
      repos.db.prepare(
        `UPDATE evolution_jobs SET payload_json = json_set(payload_json, '$.runAfter', '2000-01-01T00:00:00.000Z'),
           available_at = NULL
         WHERE job_type = 'l3_unit_update' AND status = 'queued' AND json_extract(payload_json, '$.runAfter') IS NOT NULL`
      ).run();
      await service.runWorkerOnce(50);
    };
    return { service, repos, freeze, unitJobs, runNow };
  }

  it("retries a temporary failure later, dead-letters the sixth failure, lets the next batch run, and reruns on request", async () => {
    let failing = true;
    const complete = vi.fn<LlmClient["complete"]>(async () => {
      if (failing) throw networkError();
      return JSON.stringify({ reason: "ok", ops: [] });
    });
    const { service, repos, freeze, unitJobs, runNow } = setup(complete);
    await freeze("first");
    await service.runWorkerOnce(50);
    let [first] = unitJobs();
    expect(first).toMatchObject({ status: "queued", attempts: 1, max_attempts: 6 });
    expect(Date.parse(first!.run_after!) - Date.now()).toBeGreaterThan(50_000);

    for (let run = 2; run <= 6; run += 1) await runNow();
    [first] = unitJobs();
    expect(first).toMatchObject({ status: "dead_letter", attempts: 6 });
    expect(repos.l3Field.getBatch(first!.batch_id)!.status).toBe("failed");

    failing = false;
    await freeze("second");
    await service.runWorkerOnce(50);
    expect(unitJobs()[1]).toMatchObject({ status: "succeeded" });

    expect(service.retryFailedL3Batches({
      requestId: "9353298b-4d3d-46f0-9178-27c27e81543e",
      adapterId: "codex-memory",
      source: "codex",
      namespace: { source: "codex", profileId: "default", sessionKey: "x", userId: "u1" }
    }))
      .toMatchObject({ requeued: 1 });
    expect(unitJobs()[0]).toMatchObject({ status: "queued", attempts: 0, run_after: null });
    await service.runWorkerOnce(50);
    expect(unitJobs()[0]).toMatchObject({ status: "succeeded" });
    expect(repos.l3Field.getBatch(first!.batch_id)!.status).toBe("applied");
  });

  it("gives a dead-lettered batch one automatic rerun when the worker starts, and only one", async () => {
    let failing = true;
    const complete = vi.fn<LlmClient["complete"]>(async () => {
      if (failing) throw networkErrorAfterConnect();
      return JSON.stringify({ reason: "ok", ops: [] });
    });
    const { service, repos, freeze, unitJobs, runNow } = setup(complete);
    await freeze("restart");
    await service.runWorkerOnce(50);
    for (let run = 2; run <= 6; run += 1) await runNow();
    expect(unitJobs()[0]).toMatchObject({ status: "dead_letter" });

    service.reconcileWorkerStartup();
    expect(unitJobs()[0]).toMatchObject({ status: "queued", attempts: 0 });
    expect(repos.l3Field.getBatch(unitJobs()[0]!.batch_id)!.status).toBe("queued");
    await runNow();
    for (let run = 2; run <= 6; run += 1) await runNow();
    expect(unitJobs()[0]).toMatchObject({ status: "dead_letter" });

    service.reconcileWorkerStartup();
    expect(unitJobs()[0]).toMatchObject({ status: "dead_letter" });
    failing = false;
  });

  it("wakes the worker when the rerun endpoint puts batches back", async () => {
    let failing = true;
    const complete = vi.fn<LlmClient["complete"]>(async () => {
      if (failing) throw networkError();
      return JSON.stringify({ reason: "ok", ops: [] });
    });
    const { service, freeze, unitJobs, runNow } = setup(complete);
    await freeze("http-rerun");
    await service.runWorkerOnce(50);
    for (let run = 2; run <= 6; run += 1) await runNow();
    expect(unitJobs()[0]).toMatchObject({ status: "dead_letter" });
    failing = false;

    // The startup fallback stays out of the window, so only the endpoint can wake the worker.
    const server = createMemoryHttpServer({
      service, startAgentSourceAutomation: false, auth: { mode: "local", allowAnonymous: true }, workerStartupFallbackMs: 60_000
    });
    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
    try {
      const address = server.address();
      if (!address || typeof address === "string") throw new Error("expected TCP address");
      const response = await fetch(`http://127.0.0.1:${address.port}/api/v1/l3/failed-batches/retry`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          requestId: "9353298b-4d3d-46f0-9178-27c27e81543e", adapterId: "codex-memory", source: "codex",
          namespace: { source: "codex", profileId: "default", sessionKey: "x", userId: "u1" }
        })
      });
      expect(await response.json()).toMatchObject({ requeued: 1 });
      await vi.waitFor(() => expect(unitJobs()[0]).toMatchObject({ status: "succeeded" }), { timeout: 5000 });
    } finally {
      await new Promise<void>((resolve) => server.close(() => resolve()));
    }
  });

  it("does not let a rejected answer hold back later batches until a restart", async () => {
    let bad = true;
    const complete = vi.fn<LlmClient["complete"]>(async () =>
      JSON.stringify(bad ? { reason: "bad", ops: [{ op: "confirm", id: "missing", evidence: [] }] } : { reason: "ok", ops: [] }));
    const { service, freeze, unitJobs, runNow } = setup(complete);
    await freeze("rejected");
    await freeze("after");
    await service.runWorkerOnce(50);
    expect(unitJobs()[0]).toMatchObject({ status: "queued", attempts: 1, max_attempts: 6 });
    await runNow();
    expect(unitJobs()[0]).toMatchObject({ status: "dead_letter", attempts: 2 });
    bad = false;
    await runNow();
    expect(unitJobs()[1]).toMatchObject({ status: "succeeded" });
  });

  it("waits out an offline spell without using attempts, then runs the batch", async () => {
    let offline = true;
    const complete = vi.fn<LlmClient["complete"]>(async () => {
      if (offline) throw new TypeError("fetch failed", { cause: { code: "ENOTFOUND" } });
      return JSON.stringify({ reason: "ok", ops: [] });
    });
    const { service, freeze, unitJobs, runNow } = setup(complete);
    await freeze("offline");
    await service.runWorkerOnce(50);
    const [suspended] = unitJobs();
    expect(suspended).toMatchObject({ status: "queued", attempts: 0 });
    expect(Date.parse(suspended!.run_after!) - Date.now()).toBeGreaterThan(29 * 60_000);
    for (let run = 0; run < 10; run += 1) await runNow();
    expect(unitJobs()[0]).toMatchObject({ status: "queued", attempts: 0 });
    offline = false;
    await runNow();
    expect(unitJobs()[0]).toMatchObject({ status: "succeeded" });
  });

  it("does not wake the worker for a batch whose wait is over but an earlier batch still holds it back", () => {
    const db = new MemoryDb({ path: ":memory:" });
    const repos = new Repositories(db.db);
    const at = new Date().toISOString();
    for (const [id, seq] of [["first", 1], ["second", 2]] as const) {
      repos.l3WorldModels.insertImmutableJob({
        id, jobType: "l3_unit_update", status: "queued", dedupeKey: `k-${id}`, userId: "u", sessionId: "s",
        scopeKey: "machine", scopeSeq: seq, payload: { batchId: `b-${id}` }, attempts: 0, maxAttempts: 3, createdAt: at, updatedAt: at
      });
    }
    // The second batch failed and its wait is over; the first was put back from dead letter and now waits 30 minutes.
    db.db.prepare(`UPDATE evolution_jobs SET status = 'leased', attempts = 1`).run();
    repos.runtime.rescheduleFailedJob("second", { runAfter: new Date(Date.now() - 1000).toISOString(), error: "x" });
    repos.runtime.rescheduleFailedJob("first", { runAfter: new Date(Date.now() + 30 * 60_000).toISOString(), error: "offline" });
    expect(repos.runtime.leaseQueuedJobs(10, 60)).toEqual([]);
    expect(repos.runtime.nextWorkerRunAt()! - Date.now()).toBeGreaterThan(29 * 60_000);
    db.close();
  });

  it("runs every ready batch of a machine in one worker pass, one after another", async () => {
    const complete = vi.fn<LlmClient["complete"]>(async () => JSON.stringify({ reason: "ok", ops: [] }));
    const { service, freeze, unitJobs } = setup(complete);
    await freeze("one");
    await freeze("two");
    await freeze("three");
    await service.runWorkerOnce(50);
    expect(unitJobs().map((job) => job.status)).toEqual(["succeeded", "succeeded", "succeeded"]);
  });

  it("reruns an earlier batch even when a later batch's run was lost with its lease", async () => {
    let failing = true;
    const complete = vi.fn<LlmClient["complete"]>(async () => {
      if (failing) throw new Error("l3 unit output rejected twice: ops[0]: content is empty");
      return JSON.stringify({ reason: "ok", ops: [] });
    });
    const { service, repos, freeze, unitJobs, runNow } = setup(complete);
    await freeze("earlier");
    await service.runWorkerOnce(50);
    await runNow();
    expect(unitJobs()[0]).toMatchObject({ status: "dead_letter" });
    failing = false;
    await freeze("later");
    // The later batch's run stopped (the computer slept) and its lease ran out while it was still marked leased.
    const past = new Date(Date.now() - 60_000).toISOString();
    repos.db.prepare(`UPDATE evolution_jobs SET status = 'leased', leased_until = ?, lease_owner = 'gone', lease_token = 'gone'
      WHERE id = ?`).run(past, unitJobs()[1]!.id);
    expect(service.retryFailedL3Batches({
      requestId: "1d9b6f8e-6c39-4c7a-9a43-7a3f1b2f5d10", adapterId: "codex-memory", source: "codex",
      namespace: { source: "codex", profileId: "default", sessionKey: "x", userId: "u1" }
    })).toMatchObject({ requeued: 1 });
    await service.runWorkerOnce(50);
    expect(unitJobs().map((job) => job.status)).toEqual(["succeeded", "succeeded"]);
  });

  it("holds a batch that failed on a bad key until the configuration changes, without counting a failure", async () => {
    const complete = vi.fn<LlmClient["complete"]>(async () => { throw new Error("401 unauthorized: invalid api key"); });
    const { service, repos, freeze, unitJobs } = setup(complete);
    await freeze("bad-key");
    await service.runWorkerOnce(50);
    const held = repos.db.prepare(`SELECT status, failure_count, blocked_reason FROM evolution_jobs WHERE id = ?`)
      .get(unitJobs()[0]!.id);
    expect(held).toEqual({ status: "failed", failure_count: 0, blocked_reason: "configuration" });
  });

  it("holds the old L3's queued jobs while the new L3 is on, without waking the worker for them", async () => {
    const complete = vi.fn<LlmClient["complete"]>(async () => JSON.stringify({ reason: "ok", ops: [] }));
    const { service, repos, freeze } = setup(complete);
    await freeze("old-held");
    await service.runWorkerOnce(50);
    const now = new Date().toISOString();
    repos.db.prepare(
      `INSERT INTO evolution_jobs (id, job_type, status, user_id, scope_key, scope_seq, payload_json, attempts, max_attempts, created_at, updated_at)
       VALUES ('old-update', 'l3_world_model_update', 'queued', 'u1', 'old-scope', 1,
               json_object('batchId', 'x', 'targetField', 'project_contract', 'runAfter', '2000-01-01T00:00:00.000Z'), 0, 3, ?, ?),
              ('old-profile', 'project_environment_profile', 'queued', 'u1', NULL, NULL,
               json_object('userId', 'u1', 'projectId', 'p', 'runAfter', '2000-01-01T00:00:00.000Z'), 0, 3, ?, ?)`
    ).run(now, now, now, now);
    repos.db.prepare(`UPDATE evolution_jobs SET status = 'succeeded' WHERE id NOT IN ('old-update', 'old-profile')`).run();
    expect(service.nextWorkerRunAt() ?? Number.POSITIVE_INFINITY).toBeGreaterThan(Date.parse(now));
    await service.runWorkerOnce(20);
    const statuses = repos.db.prepare(`SELECT id, status FROM evolution_jobs WHERE id IN ('old-update', 'old-profile') ORDER BY id`).all();
    expect(statuses).toEqual([{ id: "old-profile", status: "queued" }, { id: "old-update", status: "queued" }]);
  });

  it("suspends on a quota error without using an attempt", async () => {
    const complete = vi.fn<LlmClient["complete"]>(async () => { throw new ModelHttpError("quota", "p", 403, "40309", ""); });
    const { service, freeze, unitJobs } = setup(complete);
    await freeze("quota");
    await service.runWorkerOnce(50);
    const [suspended] = unitJobs();
    expect(suspended).toMatchObject({ status: "queued", attempts: 0 });
    expect(Date.parse(suspended!.run_after!) - Date.now()).toBeGreaterThan(29 * 60_000);
  });

  it("leaves L3 jobs in the queue while no evolution model is configured", async () => {
    const complete = vi.fn<LlmClient["complete"]>();
    const { service, freeze, unitJobs } = setup(complete, false);
    await freeze("unconfigured");
    await service.runWorkerOnce(50);
    expect(unitJobs()[0]).toMatchObject({ status: "queued", attempts: 0 });
    expect(complete).not.toHaveBeenCalled();
  });
});

function testLlm(complete: LlmClient["complete"], configured: boolean): LlmClient {
  return {
    config: {
      provider: "host", endpoint: "http://localhost/unused", model: "l3-retry-test", apiKey: "",
      temperature: 0, maxTokens: 4096, timeoutMs: 30_000, maxRetries: 0, malformedRetries: 0, enableThinking: false
    },
    isConfigured: () => configured,
    complete,
    completeJson: vi.fn(),
    status: () => ({ provider: "host", model: "l3-retry-test", configured, remote: false })
  };
}
