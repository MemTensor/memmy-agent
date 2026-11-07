import { afterEach, expect, it } from "vitest";
import { DEFAULT_MEMMY_CONFIG, MemoryDb, type LlmCompletionOptions, type LlmMessage } from "../../../src/index.js";
import { ModelHttpError } from "../../../src/model/http.js";
import { Repositories } from "../../../src/storage/repositories.js";
import { addAgentSourceImport, createBatchReflectionLlm, createMemoryServiceFixture } from "../../fixtures/memory-service-fixture.js";

const fixture = createMemoryServiceFixture();
afterEach(fixture.cleanup);

function deferred() {
  let resolve!: () => void;
  const promise = new Promise<void>((done) => { resolve = done; });
  return { promise, resolve };
}

it("resumes an old in-flight configuration failure after the replacement fingerprint was observed", async () => {
  const entered = deferred(), release = deferred();
  let currentConfig = { ...DEFAULT_MEMMY_CONFIG, summary: { ...DEFAULT_MEMMY_CONFIG.summary, model: "config-A" } };
  let unauthorized = true;
  const llm = createBatchReflectionLlm([]), complete = llm.completeJson.bind(llm);
  llm.completeJson = async <T extends Record<string, unknown>>(messages: LlmMessage[], options: LlmCompletionOptions): Promise<T> => {
    if (unauthorized) {
      entered.resolve();
      await release.promise;
      throw new Error("unauthorized API key from config-A request");
    }
    return complete<T>(messages, options);
  };
  const { db, service } = fixture.createTestService({ config: currentConfig, configLoader: () => ({ config: currentConfig }), llm });
  const item = addAgentSourceImport(service, { source: "codex", profileId: "review", userId: "review-user" }, "configuration repair race", "review-race");
  const oldRun = service.runWorkerOnce(1);
  await entered.promise;
  currentConfig = { ...currentConfig, summary: { ...currentConfig.summary, model: "config-B-repaired" } };
  service.reloadConfig({ reason: "model_settings_saved" });
  release.resolve();
  await oldRun;
  unauthorized = false;
  const retry = await service.runWorkerOnce(1);
  const repos = new Repositories(db.db);
  const job = repos.runtime.listJobs("succeeded").find((job) => job.targetMemoryId === item.id);
  expect(job).toMatchObject({ status: "succeeded", blockedReason: null, failureCount: 0 });
  expect(retry.leased).toBe(1);
});

it("preserves configuration failure and manual retry across a real database reopen", async () => {
  const llm = createBatchReflectionLlm([]);
  llm.completeJson = async () => { throw new Error("unauthorized API key"); };
  const { db, service } = fixture.createTestService({ llm });
  const namespace = { source: "codex", profileId: "review", userId: "review-startup" };
  const item = addAgentSourceImport(service, namespace, "configuration block on restart", "review-startup");
  await service.runWorkerOnce(1);
  const before = service.memoryProcessingStatus([item.id], { namespace }).items[0];
  expect(before).toMatchObject({ state: "failed", retryAction: "open_settings", errorCode: "model_configuration" });
  await service.stop();
  db.close();
  const reopened = new MemoryDb({ path: db.path });
  const nextService = fixture.createTestMemoryService({ db: reopened, mode: "dev", llm });
  nextService.reconcileWorkerStartup(100);
  const after = nextService.memoryProcessingStatus([item.id], { namespace }).items[0];
  const retry = nextService.retryMemoryProcessing(item.id, { namespace });
  expect(after).toMatchObject({ state: "failed", retryAction: "open_settings", errorCode: "model_configuration" });
  expect(retry.accepted).toBe(true);
});

it("does not recreate permanently invalid imported summaries on restart", async () => {
  const llm = createBatchReflectionLlm([]);
  llm.completeJson = async () => { throw new ModelHttpError("invalid input", "test", 400, undefined, "invalid request body"); };
  const { db, service } = fixture.createTestService({ llm });
  const namespace = { source: "codex", profileId: "permanent", userId: "permanent-restart" };
  const item = addAgentSourceImport(service, namespace, "permanent invalid summary input", "permanent-restart");
  await service.runWorkerOnce(1);
  expect(service.memoryProcessingStatus([item.id], { namespace }).items[0]).toMatchObject({ state: "failed", retryAction: "none" });
  const before = new Repositories(db.db).runtime.listJobs("dead_letter").filter((job) => job.targetMemoryId === item.id);
  expect(before).toHaveLength(1);
  await service.stop(); db.close();
  const reopened = new MemoryDb({ path: db.path });
  const nextService = fixture.createTestMemoryService({ db: reopened, mode: "dev", llm });
  expect(nextService.reconcileWorkerStartup(100).enqueuedImportSummaries).toBe(0);
  expect(nextService.memoryProcessingStatus([item.id], { namespace }).items[0]).toMatchObject({ state: "failed", retryAction: "none" });
  expect((await nextService.runWorkerOnce(1)).leased).toBe(0);
  expect(new Repositories(reopened.db).runtime.listJobs("dead_letter").filter((job) => job.targetMemoryId === item.id)).toHaveLength(1);
});
