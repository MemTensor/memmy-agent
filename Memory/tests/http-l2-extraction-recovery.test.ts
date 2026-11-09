import type { Server } from "node:http";
import { afterEach, describe, expect, it } from "vitest";
import { createMemoryHttpServer, type LlmClient, type LlmMessage } from "../src/index.js";
import { closeMemoryHttpServer } from "../src/server/http.js";
import { Repositories } from "../src/storage/repositories.js";
import { upsertL2Candidate } from "../src/service/evolution/l2-candidate-service.js";
import { byokRuntimeConfig, createMemoryServiceFixture } from "./fixtures/memory-service-fixture.js";

const fixture = createMemoryServiceFixture(), servers: Server[] = [];
afterEach(async () => { await Promise.all(servers.splice(0).map(closeMemoryHttpServer)); await fixture.cleanup(); });
const lesson = { type: "check", title: "Verify actual numeric inputs", applicability: "When checking a numeric parser",
  content: "Run both accepted and rejected input cases before claiming success.", verification: "Run the tests.", exclusions: "" };
function harness(count = 1, directFromTrace = true) {
  const config = byokRuntimeConfig(); config.algorithm.capture.embedAfterCapture = false;
  config.algorithm.l2Induction.mode = "unified";
  config.algorithm.skill.directFromTrace = directFromTrace;
  let output: (messages: LlmMessage[]) => Promise<Record<string, unknown>> = async () => ({ operations: [] });
  const calls: LlmMessage[][] = [];
  const llm = { config: config.evolution, isConfigured: () => true, complete: async () => "{}",
    completeJson: async (messages: LlmMessage[]) => { calls.push(messages); return output(messages); },
    status: () => ({ provider: config.evolution.provider, model: config.evolution.model, configured: true, remote: true }) } as LlmClient;
  const { db, service } = fixture.createTestService({ config, llm, skillLlm: llm });
  const repos = new Repositories(db.db), at = new Date().toISOString();
  repos.runtime.createSession({ id: "session", userId: "u", source: "codex", profileId: "default", status: "closed", meta: {}, openedAt: at, updatedAt: at });
  repos.runtime.createEpisode({ id: "episode", sessionId: "session", userId: "u", status: "closed",
    l1MemoryIds: Array.from({ length: count }, (_, i) => `source-${i}`), rawTurnIds: [], feedbackIds: [], decisionRepairIds: [],
    l2PolicyIds: [], l3WorldModelIds: [], skillMemoryIds: [], turnCount: count, rewardDetail: {}, pipelineStatus: "idle",
    meta: {}, openedAt: at, closedAt: at, updatedAt: at });
  for (let i = 0; i < count; i++) {
    const id = `source-${i}`;
    repos.memories.insert({ id, userId: "u", sessionId: "session", timeline: at, memoryLayer: "L1", memoryType: "LongTermMemory",
      status: "activated", visibility: "private", memoryValue: "The parser failed a real input; verify it before reporting success.",
      tags: [], info: {}, version: 1, createdAt: at, updatedAt: at,
      properties: { internal_info: { memory_layer: "L1", memory_kind: "trace", trace: {
        episode_id: "episode", summary: "Verify parser before acceptance", userText: "Verify actual input", agentText: "Test failed", value: -1
      } } } });
    upsertL2Candidate(repos, { sourceMemoryId: id, userId: "u", route: "negative", at });
  }
  repos.runtime.enqueueJob({ id: "original", jobType: "l2_induction", userId: "u", episodeId: "episode", sessionId: "session",
    targetMemoryId: "source-0", payload: { unified: true }, status: "queued", attempts: 0, maxAttempts: 3, createdAt: at, updatedAt: at });
  return { db, repos, service, calls, setOutput: (fn: typeof output) => { output = fn; } };
}
async function listen(service: ReturnType<typeof harness>["service"]) {
  const server = createMemoryHttpServer({ service, apiKey: "fixture-key", workerStartupFallbackMs: 60_000 }); servers.push(server);
  await new Promise<void>(resolve => server.listen(0, "127.0.0.1", resolve));
  const address = server.address(); if (!address || typeof address === "string") throw Error("missing address");
  return `http://127.0.0.1:${address.port}/api/v1/panel/tasks/episode/experience-processing`;
}
const headers = { "content-type": "application/json", authorization: "Bearer fixture-key" };
async function waitFor(check: () => boolean) {
  const start = Date.now();
  while (!check()) { if (Date.now() - start > 3000) throw Error("worker did not settle"); await new Promise(resolve => setTimeout(resolve, 5)); }
}
function valid(messages: LlmMessage[]) {
  const input = JSON.parse(messages[2]!.content);
  return { operations: [{ operation: "create", l1_ids: input.L1_RECORDS.map((r: { id: string }) => r.id), new_l2: lesson }] };
}

describe("L2 recovery through HTTP and real worker", () => {
  it.each([true, false])("exhausts one correction budget, coalesces HTTP retries and commits once with directFromTrace=%s", async directFromTrace => {
    const h = harness(1, directFromTrace);
    await h.service.runWorkerOnce(1, { targetMemoryIds: ["source-0"] });
    expect(h.calls).toHaveLength(3);
    expect(h.repos.runtime.getJob("original")).toMatchObject({ status: "dead_letter", failureCount: 1 });
    const base = await listen(h.service);
    expect(await (await fetch(base, { headers })).json()).toMatchObject({ state: "failed", pendingCount: 1, canRetry: true });
    let release!: () => void; const gate = new Promise<void>(resolve => { release = resolve; });
    h.setOutput(async messages => { await gate; return valid(messages); });
    try {
      const responses = await Promise.all([1, 2].map(() => fetch(base + "/retry", { method: "POST", headers, body: "{}" }).then(r => r.json())));
      expect(responses.filter(r => r.accepted)).toHaveLength(1);
      expect(new Set(responses.map(r => r.jobId)).size).toBe(1);
      release();
      await waitFor(() => h.service.taskExperienceProcessing("episode").state === "complete");
      expect(h.calls).toHaveLength(4);
      expect(h.repos.memories.list({ memoryLayer: "L2" })).toHaveLength(1);
      expect(await (await fetch(base + "/retry", { method: "POST", headers, body: "{}" })).json()).toMatchObject({ accepted: false, state: "complete" });
      expect(h.calls).toHaveLength(4);
      // Historical failure remains available for diagnostics, but is not reported as a current failure.
      expect(h.repos.runtime.getJob("original")!.status).toBe("dead_letter");
    } finally { release(); }
  });

  it("recovers only the unfinished batch after five of seven sources committed", async () => {
    const h = harness(7);
    h.setOutput(async messages => h.calls.length === 1 ? valid(messages) : { operations: [] });
    await h.service.runWorkerOnce(1, { targetMemoryIds: ["source-0"] });
    expect(h.service.taskExperienceProcessing("episode")).toMatchObject({ state: "failed", pendingCount: 2 });
    const old = h.repos.memories.list({ memoryLayer: "L2" })[0]!;
    const links = h.repos.runtime.listTracePolicyLinks({ l2MemoryId: old.id, limit: 100 });
    expect(links).toHaveLength(5);
    const base = await listen(h.service);
    h.setOutput(async messages => ({ operations: [{ operation: "ignore", l1_ids: JSON.parse(messages[2]!.content).L1_RECORDS.map((r: { id: string }) => r.id) }] }));
    await fetch(base + "/retry", { method: "POST", headers, body: "{}" });
    await waitFor(() => h.service.taskExperienceProcessing("episode").state === "complete");
    expect(h.repos.memories.get(old.id)).toEqual(old);
    expect(h.repos.runtime.listTracePolicyLinks({ l2MemoryId: old.id, limit: 100 })).toEqual(links);
    expect(JSON.parse(h.calls.at(-1)![2]!.content).L1_RECORDS).toHaveLength(2);
  });

  it("keeps the correction budget across automatic jobs, including after a failed manual round", async () => {
    const h = harness();
    await h.service.runWorkerOnce(1, { targetMemoryIds: ["source-0"] });
    const original = h.repos.runtime.getJob("original")!;
    function enqueue(id: string) {
      h.repos.runtime.enqueueJob({ ...original, id, status: "queued", attempts: 0, failureCount: 0,
        leaseOwner: null, leaseToken: null, leasedUntil: null, availableAt: null, blockedReason: null, payload: { unified: true } });
    }
    enqueue("automatic-after-failure");
    await h.service.runWorkerOnce(1, { targetMemoryIds: ["source-0"] });
    expect(h.calls).toHaveLength(3);
    h.service.retryTaskExperienceProcessing("episode");
    await h.service.runWorkerOnce(1, { targetMemoryIds: ["source-0"] });
    expect(h.calls).toHaveLength(6);
    enqueue("automatic-after-manual-failure");
    await h.service.runWorkerOnce(1, { targetMemoryIds: ["source-0"] });
    expect(h.calls).toHaveLength(6);
    expect(h.service.taskExperienceProcessing("episode")).toMatchObject({ state: "failed", pendingCount: 1 });
  });

  it("refreshes changed source text before retry and preserves unrelated user's failures", async () => {
    const h = harness(); await h.service.runWorkerOnce(1, { targetMemoryIds: ["source-0"] });
    const original = h.repos.runtime.getJob("original")!;
    h.repos.runtime.enqueueJob({ ...original, id: "other-user-job", userId: "other", status: "dead_letter", payload: {} });
    const otherBefore = h.repos.runtime.getJob("other-user-job");
    const source = h.repos.memories.get("source-0")!;
    h.repos.memories.update({ ...source, properties: { ...source.properties, internal_info: { ...source.properties.internal_info,
      trace: { ...(source.properties.internal_info.trace as object), summary: "Latest corrected parser evidence" } } } });
    h.setOutput(async messages => {
      expect(JSON.parse(messages[2]!.content).L1_RECORDS[0].content).toBe("Latest corrected parser evidence");
      return valid(messages);
    });
    h.service.retryTaskExperienceProcessing("episode");
    await h.service.runWorkerOnce(1, { targetMemoryIds: ["source-0"] });
    expect(h.service.taskExperienceProcessing("episode").state).toBe("complete");
    expect(h.repos.runtime.getJob("other-user-job")).toEqual(otherBefore);
  });

  it("keeps a manual edit made while the recovery response is in flight", async () => {
    const h = harness(); await h.service.runWorkerOnce(1, { targetMemoryIds: ["source-0"] });
    const source = h.repos.memories.get("source-0")!;
    h.repos.memories.insert({ ...source, id: "policy", memoryLayer: "L2", sessionId: undefined,
      properties: { internal_info: { memory_layer: "L2", memory_kind: "policy", policy: {
        title: "Original", procedure: "Original lesson", status: "active", source_trace_ids: []
      } } } });
    h.setOutput(async messages => {
      const input = JSON.parse(messages[2]!.content), target = input.HISTORICAL_L2_CANDIDATES[0];
      h.repos.memories.update({ ...h.repos.memories.get("policy")!, memoryValue: "User's manual edit" });
      return { operations: [{ operation: "revise", l1_ids: ["source-0"], target_l2: { id: target.id, version: target.version }, revised_l2: lesson }] };
    });
    h.service.retryTaskExperienceProcessing("episode");
    await h.service.runWorkerOnce(1, { targetMemoryIds: ["source-0"] });
    expect(h.repos.memories.get("policy")!.memoryValue).toBe("User's manual edit");
    expect(h.service.taskExperienceProcessing("episode").pendingCount).toBe(1);
    expect(h.repos.runtime.listTracePolicyLinks({ l2MemoryId: "policy", limit: 100 })).toHaveLength(0);
  });

  it("reports a model's invented target as invalid output rather than a changed task", async () => {
    const h = harness();
    h.setOutput(async () => ({ operations: [{ operation: "support", l1_ids: ["source-0"], target_l2: { id: "invented", version: 1 } }] }));
    await h.service.runWorkerOnce(1, { targetMemoryIds: ["source-0"] });
    expect(h.service.taskExperienceProcessing("episode")).toMatchObject({ state: "failed", errorCode: "invalid_model_output", pendingCount: 1 });
    expect(h.calls).toHaveLength(3);
  });

  it("rejects another user's retry and does not retry an open episode", async () => {
    const h = harness(); await h.service.runWorkerOnce(1, { targetMemoryIds: ["source-0"] });
    const base = await listen(h.service);
    const other = await fetch(base + "/retry", { method: "POST", headers, body: JSON.stringify({ namespace: { userId: "other" } }) });
    expect(other.status).toBe(403);
    h.db.db.prepare("UPDATE episodes SET status='open' WHERE id='episode'").run();
    expect(await (await fetch(base + "/retry", { method: "POST", headers, body: "{}" })).json()).toMatchObject({ accepted: false, state: "blocked" });
    expect(h.calls).toHaveLength(3);
    expect(h.repos.runtime.listL2JobsForEpisode("u", "episode")).toHaveLength(1);
  });

  it("rejects a response if the task reopens during recovery", async () => {
    const h = harness(); await h.service.runWorkerOnce(1, { targetMemoryIds: ["source-0"] });
    h.setOutput(async messages => { h.db.db.prepare("UPDATE episodes SET status='open' WHERE id='episode'").run(); return valid(messages); });
    h.service.retryTaskExperienceProcessing("episode");
    await h.service.runWorkerOnce(1, { targetMemoryIds: ["source-0"] });
    expect(h.repos.memories.list({ memoryLayer: "L2" })).toHaveLength(0);
    expect(h.service.taskExperienceProcessing("episode")).toMatchObject({ state: "blocked", pendingCount: 1 });
  });
});
