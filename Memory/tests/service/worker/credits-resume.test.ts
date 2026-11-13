import { afterEach, describe, expect, it, vi } from "vitest";
import { accountRuntimeConfig, byokRuntimeConfig, createMemoryServiceFixture } from "../../fixtures/memory-service-fixture.js";
import { ModelHttpError, postJsonWithRetry } from "../../../src/model/http.js";
import { Repositories } from "../../../src/storage/repositories.js";
import { SpanPipeline } from "../../../src/service/evolution/span-pipeline.js";

const fixture = createMemoryServiceFixture();
afterEach(() => { vi.unstubAllGlobals(); fixture.cleanup(); });

describe("durable credit pauses", () => {
  it.each(["CREDIT_INSUFFICIENT", "CREDIT_BALANCE_RESERVED", "CREDIT_CALL_UNCERTAIN"])("propagates %s out of reflection retries without losing completed windows", async (code) => {
    const config = accountRuntimeConfig();
    const { db, service } = fixture.createTestService({ config });
    const now = new Date().toISOString();
    const memories = ["first", "second"].map(id => ({ id, memoryLayer: "L1", status: "activated",
      createdAt: now, timeline: now, info: {}, tags: [], properties: { internal_info: { trace: {} } } }));
    const pipeline = new SpanPipeline({ config: { ...config, algorithm: { ...config.algorithm,
      capture: { ...config.algorithm.capture, alphaScoring: true, reflectionBatchWindowSize: 1,
        reflectionBatchOverlap: 0, reflectionBatchPrimaryMaxRetries: 2, reflectionBatchDegradedMaxRetries: 2 } } },
      repos: { runtime: { getEpisode: () => ({ status: "closed", l1MemoryIds: ["first", "second"] }) },
        memories: { getMany: () => memories } } } as never);
    let blocked = true;
    const calls: string[] = [];
    vi.stubGlobal("fetch", vi.fn(async (_url: unknown, options?: RequestInit) => {
      const step = JSON.parse(String(options?.body)).step; calls.push(step);
      if (step === "second" && blocked) return Response.json({ code, message: code }, {
        status: code === "CREDIT_CALL_UNCERTAIN" ? 502 : code === "CREDIT_BALANCE_RESERVED" ? 409 : 422
      });
      return Response.json([{ idx: 0, reflectionText: "RELATED", alpha: 0.5, usable: true }]);
    }));
    (pipeline as any).scoreBatchReflectionWindow = (_episode: unknown, window: Array<{ id: string }>) =>
      postJsonWithRetry({ provider: "openai_compatible", operation: "reflection", body: { step: window[0]!.id },
        url: "https://fixture.invalid/api/agentExternal/v1/chat/completions", timeoutMs: 1000, maxRetries: 3,
        actualModelContext: config.evolution.actualModelContext });
    const applyScores = vi.fn();
    (pipeline as any).applyBatchReflectionScores = applyScores;
    const runner = (service as any).workerRunner;
    runner.deps.jobHandlers.processJob = (job: unknown) => (pipeline as any).reflectEpisodeBatch(job);
    db.db.prepare(`INSERT INTO evolution_jobs(id,job_type,status,user_id,episode_id,payload_json,attempts,max_attempts,created_at,updated_at)
      VALUES('reflection-credit','reflection','queued','local-user','episode','{}',0,3,?,?)`).run(now, now);
    await service.runWorkerOnce(1);
    const runtime = new Repositories(db.db).runtime;
    expect(calls).toEqual(["first", "second"]);
    expect(applyScores).not.toHaveBeenCalled();
    expect(Object.keys(runtime.getJob("reflection-credit")!.payload.modelSteps as object)).toHaveLength(1);
    if (code === "CREDIT_CALL_UNCERTAIN") {
      expect(runtime.getJob("reflection-credit")!.status).toBe("dead_letter");
      await service.runWorkerOnce(1);
      expect(calls).toEqual(["first", "second"]);
    } else {
      expect(runtime.getJob("reflection-credit")!.status).toBe("queued");
      if (code === "CREDIT_INSUFFICIENT") expect(runtime.getJob("reflection-credit")!.payload.creditState).toBe("PAUSED_CREDIT");
      else expect(runtime.getJob("reflection-credit")!.payload.creditState).toBeUndefined();
      blocked = false;
      runner.deps.canResumeCredits = async () => true;
      runner.nextCreditCheckAt = 0;
      if (code === "CREDIT_BALANCE_RESERVED") db.db.prepare(`UPDATE evolution_jobs SET payload_json=json_remove(payload_json,'$.runAfter') WHERE id='reflection-credit'`).run();
      await service.runWorkerOnce(1);
      expect(calls).toEqual(["first", "second", "second"]);
      expect(applyScores).toHaveBeenCalledTimes(1);
      expect(runtime.getJob("reflection-credit")!.status).toBe("succeeded");
    }
  });

  it("checks eligible BYOK jobs beyond the first 100 blocked jobs without skipping resumed rows", async () => {
    const { db, service } = fixture.createTestService({ config: accountRuntimeConfig() });
    const insert = db.db.prepare(`INSERT INTO evolution_jobs(id,job_type,status,user_id,payload_json,attempts,max_attempts,created_at,updated_at)
      VALUES(?,?,'queued','local-user',?,0,3,?,?)`);
    for (let i = 0; i < 202; i++) insert.run(`scan-${String(i).padStart(3, "0")}`, i < 100 ? "reflection" : "trace_summary",
      JSON.stringify({ creditState: "PAUSED_CREDIT", runAfter: "9999-12-31T00:00:00.000Z" }), new Date(i * 1000).toISOString(), new Date(i * 1000).toISOString());
    const runner = (service as any).workerRunner;
    runner.deps.canResumeCredits = vi.fn(async (type: string) => type === "trace_summary");
    runner.deps.jobHandlers.processJob = async () => {};
    await service.runWorkerOnce(1);
    const runtime = new Repositories(db.db).runtime;
    expect(runtime.creditPausedJobs(500)).toHaveLength(100);
    expect(runtime.getJob("scan-100")!.payload.creditState).toBeUndefined();
    expect(runtime.getJob("scan-201")!.payload.creditState).toBeUndefined();
    expect(runner.deps.canResumeCredits.mock.calls).toEqual([["reflection"], ["trace_summary"]]);
  });

  it("defers reserved credits without an exhaustion state or replaying completed steps", async () => {
    const config = accountRuntimeConfig();
    const { db, service } = fixture.createTestService({config});
    let available = false;
    const calls: string[] = [];
    vi.stubGlobal("fetch", vi.fn(async (_url: unknown, options?: RequestInit) => {
      const step = JSON.parse(String(options?.body)).step; calls.push(step);
      return step === "second" && !available
        ? Response.json({code:"CREDIT_BALANCE_RESERVED",message:"reserved"},{status:409})
        : Response.json({result:step});
    }));
    db.db.prepare(`INSERT INTO evolution_jobs(id,job_type,status,user_id,payload_json,attempts,max_attempts,created_at,updated_at)
      VALUES('reserved-job','reflection','queued','local-user','{}',0,1,?,?)`).run(new Date().toISOString(),new Date().toISOString());
    const runner = (service as any).workerRunner;
    runner.deps.jobHandlers.processJob = async () => {
      for (const step of ["first","second"]) await postJsonWithRetry({provider:"openai_compatible",operation:step,
        url:"https://fixture.invalid/api/agentExternal/v1/chat/completions",body:{step},timeoutMs:1000,maxRetries:3,
        actualModelContext:config.summary.actualModelContext});
    };
    await service.runWorkerOnce(1);
    const runtime = new Repositories(db.db).runtime;
    const deferred = runtime.getJob("reserved-job")!;
    expect(deferred.status).toBe("queued"); expect(deferred.attempts).toBe(0);
    expect(deferred.payload.creditState).toBeUndefined();
    expect(Date.parse(String(deferred.payload.runAfter))).toBeGreaterThan(Date.now()+20_000);
    expect(service.health().creditPaused).toBe(false);
    await service.runWorkerOnce(1); expect(calls).toEqual(["first","second"]);
    available=true;
    db.db.prepare(`UPDATE evolution_jobs SET payload_json=json_remove(payload_json,'$.runAfter') WHERE id='reserved-job'`).run();
    await service.runWorkerOnce(1);
    expect(calls).toEqual(["first","second","second"]);
    expect(runtime.getJob("reserved-job")?.status).toBe("succeeded");
  });
  it("defers legacy embedding reservation conflicts without consuming attempts", () => {
    const {db, service} = fixture.createTestService({config:accountRuntimeConfig()});
    const runtime = new Repositories(db.db).runtime;
    const now=Date.now();
    runtime.enqueueEmbeddingRetry({id:"reserved-embedding",targetKind:"trace",targetId:"fixture-memory",vectorField:"vec_summary",sourceText:"test",maxAttempts:1,now});
    const [retry] = runtime.claimDueEmbeddingRetries({now,workerId:"fixture",leaseUntil:now+1000});
    (service as any).workerRunner.failClaimedEmbeddingRetry(retry,{workerId:"fixture",leaseUntil:now+1000},1,
      new ModelHttpError("reserved","openai_compatible",409,"CREDIT_BALANCE_RESERVED","reserved"));
    expect(runtime.getEmbeddingRetry(retry!.id)?.attempts).toBe(0);
    expect(service.health().creditPaused).toBe(false);
    expect(runtime.claimDueEmbeddingRetries({now:now+5000,workerId:"fixture",leaseUntil:now+6000})).toEqual([]);
    expect(runtime.claimDueEmbeddingRetries({now:now+35000,workerId:"fixture",leaseUntil:now+36000})).toHaveLength(1);
  });
  it("does not silently repeat an account call whose transport outcome is unknown", async () => {
    const config = accountRuntimeConfig();
    const { db, service } = fixture.createTestService({ config });
    const fetch = vi.fn().mockRejectedValue(new TypeError("socket reset"));
    vi.stubGlobal("fetch", fetch);
    db.db.prepare(`INSERT INTO evolution_jobs(id,job_type,status,user_id,payload_json,attempts,max_attempts,created_at,updated_at)
      VALUES('uncertain-job','reflection','queued','local-user','{}',0,3,?,?)`).run(new Date().toISOString(), new Date().toISOString());
    const runner = (service as any).workerRunner;
    runner.deps.jobHandlers.processJob = () => postJsonWithRetry({ provider: "openai_compatible",
      url: "https://fixture.invalid/api/agentExternal/v1/chat/completions", body: {}, timeoutMs: 1000,
      maxRetries: 3, actualModelContext: config.summary.actualModelContext });
    await service.runWorkerOnce(1);
    await service.runWorkerOnce(1);
    expect(fetch).toHaveBeenCalledTimes(1);
    expect(new Repositories(db.db).runtime.getJob("uncertain-job")?.status).toBe("dead_letter");
  });
  it("pauses legacy embedding retries without exhausting attempts and wakes after funding", async () => {
    const { db, service } = fixture.createTestService({ config: accountRuntimeConfig() });
    const runtime = new Repositories(db.db).runtime;
    const now = Date.now();
    runtime.enqueueEmbeddingRetry({ id: "paused-embedding", targetKind: "trace", targetId: "fixture-memory",
      vectorField: "vec_summary", sourceText: "test", maxAttempts: 1, now });
    const [retry] = runtime.claimDueEmbeddingRetries({ now, workerId: "fixture", leaseUntil: now + 1000 });
    if (!retry) throw new Error("Expected the fixture retry to be claimed");
    const runner = (service as any).workerRunner;
    runner.failClaimedEmbeddingRetry(retry, { workerId: "fixture", leaseUntil: now + 1000 }, 1,
      new ModelHttpError("insufficient", "openai_compatible", 422, "CREDIT_INSUFFICIENT", "insufficient"));
    expect(runtime.getEmbeddingRetry(retry.id)?.attempts).toBe(0);
    expect(runtime.creditPausedEmbeddingRetries()).toHaveLength(1);
    expect(service.health().creditPaused).toBe(true);
    expect(runtime.claimDueEmbeddingRetries({ now: now + 5000, workerId: "fixture", leaseUntil: now + 6000 })).toEqual([]);
    runner.deps.canResumeCredits = vi.fn().mockResolvedValue(false);
    runner.runEmbeddingRetryOnce = vi.fn().mockResolvedValue({ succeeded: 0, failed: 0, items: [] });
    await service.runWorkerOnce(1);
    expect(runtime.creditPausedEmbeddingRetries()).toHaveLength(1);
    expect(service.health().creditPaused).toBe(true);
    runner.deps.canResumeCredits.mockResolvedValue(true);
    runner.nextCreditCheckAt = 0;
    await service.runWorkerOnce(1);
    expect(runtime.creditPausedEmbeddingRetries()).toHaveLength(0);
    expect(service.health().creditPaused).toBe(false);
    expect(runtime.claimDueEmbeddingRetries({ now: Date.now(), workerId: "fixture", leaseUntil: now + 10000 })).toHaveLength(1);
  });
  it.each(["balance", "byok"])("keeps completed steps and resumes only unfinished work after %s changes", async (resumeMode) => {
    const config = accountRuntimeConfig();
    const { db, service } = fixture.createTestService({ config });
    let funded = false;
    const calls: string[] = [];
    vi.stubGlobal("fetch", vi.fn(async (url: string | URL, options?: RequestInit) => {
      if (String(url).endsWith("/credits/v1/summary")) return Response.json({ code: 0, data: { account: { spendable: funded ? "1.00" : "0.00" } } });
      const step = JSON.parse(String(options?.body)).step;
      calls.push(step);
      return step === "second" && !funded
        ? Response.json({ code: "CREDIT_INSUFFICIENT", message: "insufficient credits" }, { status: 422 })
        : Response.json({ result: step });
    }));
    db.db.prepare(`INSERT INTO evolution_jobs(id,job_type,status,user_id,payload_json,attempts,max_attempts,created_at,updated_at)
      VALUES('credit-job','reflection','queued','local-user','{}',0,3,?,?)`).run(new Date().toISOString(),new Date().toISOString());
    const runner = (service as any).workerRunner;
    runner.deps.jobHandlers.processJob = async () => {
      for (const step of ["first", "second"]) await postJsonWithRetry({ provider: "openai_compatible", operation: step,
        url: "https://fixture.invalid/api/agentExternal/v1/chat/completions", body: { step }, timeoutMs: 1000, maxRetries: 0 });
    };
    await service.runWorkerOnce(1);
    const runtime = new Repositories(db.db).runtime;
    const paused = runtime.getJob("credit-job")!;
    expect(service.health().creditPaused).toBe(true);
    expect(paused.payload.creditState).toBe("PAUSED_CREDIT");expect(paused.attempts).toBe(0);
    expect(Object.keys(paused.payload.modelSteps as object)).toHaveLength(1);
    expect(runtime.leaseQueuedJobs(10)).toHaveLength(0);
    runner.nextCreditCheckAt = 0;
    await service.runWorkerOnce(1);
    expect(calls).toEqual(["first", "second"]);
    if (resumeMode === "byok") {
      (service as any).config = byokRuntimeConfig();
    }
    funded = true;runner.nextCreditCheckAt = 0;
    await service.runWorkerOnce(1);
    expect(calls).toEqual(["first", "second", "second"]);
    expect(runtime.getJob("credit-job")?.status).toBe("succeeded");
    expect(service.health().creditPaused).toBe(false);
    expect(runtime.getJob("credit-job")?.payload.modelSteps).toBeUndefined();
  });
});
