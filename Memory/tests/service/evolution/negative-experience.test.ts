import { revisionInputHash } from "../../../src/service/evolution/episode-revision.js";
import { NegativeExperiencePipeline } from "../../../src/service/evolution/negative-experience-pipeline.js";
import { Repositories } from "../../../src/storage/repositories.js";
import { assignedEpisodeId, settleCaptureAssignments } from "../../fixtures/memory-service-fixture.js";
import { LEGACY_TEST_CONFIG } from "../../fixtures/memory-service-fixture.js";
import { afterEach, describe, expect, it, vi } from "vitest";
import { type LlmClient } from "../../../src/index.js";
import {
  createCapturingEmbedder,
  createMemoryServiceFixture
} from "../../fixtures/memory-service-fixture.js";

const {
  cleanup,
  createTestService
} = createMemoryServiceFixture();

afterEach(cleanup);

function createCountingLlm(
  operations: string[],
  reward?: {
    goal_achievement: number;
    process_quality: number;
    user_satisfaction: number;
    reason: string;
  }
): LlmClient {
  return {
    config: {
      ...LEGACY_TEST_CONFIG.summary,
      provider: "host",
      endpoint: "http://127.0.0.1/negative-experience-test",
      model: "negative-experience-test"
    },
    isConfigured() {
      return true;
    },
    async complete() {
      operations.push("complete");
      return "{}";
    },
    async completeJson<T extends Record<string, unknown>>(
      messages: Array<{ role: "system" | "user" | "assistant"; content: string }>,
      options: { operation: string }
    ): Promise<T> {
      if (options.operation === "episode.select.v1") return { episodeId: null, title: "Test task", summary: "Test task summary" } as unknown as T;
      operations.push(options.operation);
      if (options.operation === "capture.summarize") {
        const payload = messages.find((message) => message.role === "user")?.content ?? "";
        const userQuote = payload.match(/\bUSER:\s*(.*?)\s+ASSISTANT:/)?.[1]?.trim() ?? "";
        return {
          l1: {
            title: "Completed task turn",
            summary: "completed task turn",
            evidence: [{ quote: userQuote, role: "user", kind: "task_outcome" }]
          },
          user: null
        } as unknown as T;
      }
      if (options.operation === "failure.experience.sink.v5") {
        const payload = JSON.parse(messages.find((message) => message.role === "user")?.content ?? "{}") as {
          evidence_trace_ids?: string[];
        };
        const traceId = payload.evidence_trace_ids?.[0];
        return {
          title: "Avoid reporting TLS completion before verification",
          trigger: "When configuring TLS and reporting the service endpoint.",
          procedure: "Use the requested secure port and verify TLS before reporting completion.",
          verification: "Confirm the secure endpoint responds successfully with certificate verification enabled.",
          boundary: "Use for TLS configuration tasks with an explicit port or verification requirement.",
          experience_type: "failure_avoidance",
          decision_guidance: {
            prefer: ["Verify the secure endpoint before reporting completion."],
            avoid: ["Do not report TLS completion while the requested port or verification remains wrong."]
          },
          support_trace_ids: traceId ? [traceId] : [],
          confidence: 0.82
        } as unknown as T;
      }
      if (options.operation === "reward.reward.r_human.v7" && reward) {
        return reward as unknown as T;
      }
      return {} as T;
    },
    status() {
      return {
        provider: "host",
        model: "negative-experience-test",
        configured: true,
        remote: true
      };
    }
  };
}

describe("MemoryService / evolution / negative experience", () => {
  it.each(["reopen", "reclose", "edit"] as const)("rejects stale negative drafts after %s", async scenario => {
    const llm = createCountingLlm([]);
    const { db, service } = createTestService({ llm, skillLlm: llm, config: LEGACY_TEST_CONFIG });
    const session = service.openSession({ namespace: { source: "codex", profileId: "647", userId: "negative-race" } });
    const turn = await service.completeTurn(`negative-race-${scenario}`, { sessionId: session.sessionId,
      query: "Configure TLS and verify port 443", answer: "Port 80 configured, TLS verification skipped" });
    await settleCaptureAssignments(service);
    const repos = new Repositories(db.db);
    const episodeId = assignedEpisodeId(service, turn);
    repos.runtime.closeEpisode(episodeId);
    let release!: () => void;
    let enter!: () => void;
    const gate = new Promise<void>(resolve => { release = resolve; });
    const entered = new Promise<void>(resolve => { enter = resolve; });
    const complete = llm.completeJson.bind(llm);
    llm.completeJson = async (messages, options) => {
      if (options.operation === "failure.experience.sink.v5") { enter(); await gate; }
      return complete(messages, options);
    };
    const save = vi.fn((): never => { throw new Error("stale draft must not write"); });
    const pipeline = new NegativeExperiencePipeline({ repos, config: LEGACY_TEST_CONFIG, skillLlm: llm,
      buildMemory: save, upsertEvolutionMemory: save, enqueueJob: save, namespaceIdFromMemory: () => "fixture" });
    const now = new Date().toISOString();
    const pending = pipeline.materialize({ id: `negative-${scenario}`, jobType: "negative_experience",
      userId: repos.runtime.getEpisode(episodeId)!.userId, episodeId, status: "queued", attempts: 0, maxAttempts: 3,
      payload: { source: "episode_reward", issue: "Wrong TLS port and verification skipped" }, createdAt: now, updatedAt: now });
    await Promise.race([entered, pending.then(() => { throw new Error("negative draft returned before model call"); })]);
    if (scenario === "edit") {
      const raw = repos.runtime.listRawTurnsByEpisode(episodeId)[0]!;
      repos.runtime.updateRawTurn({ ...raw, assistantText: "Port 443 and TLS verification now complete" });
    } else {
      repos.runtime.reopenEpisode(episodeId);
      if (scenario === "reclose") repos.runtime.closeEpisode(episodeId);
    }
    release();
    await expect(pending).rejects.toThrow("inputs changed during generation");
    expect(save).not.toHaveBeenCalled();
    expect(repos.memories.list({ memoryLayer: "L2" }, 100)).toHaveLength(0);
    db.close();
  });

  it("materializes explicit negative feedback from a complete failure sink draft", async () => {
    const operations: string[] = [];
    const embeddedTexts: string[] = [];
    const embeddingRoles: Array<"query" | "document" | undefined> = [];
    const llm = createCountingLlm(operations);
    let rephrase = false;
    const completeJson = llm.completeJson.bind(llm);
    llm.completeJson = async <T extends Record<string, unknown>>(messages: Parameters<LlmClient["completeJson"]>[0], options: Parameters<LlmClient["completeJson"]>[1]): Promise<T> => {
      const result = await completeJson<T>(messages, options);
      if (rephrase && options.operation === "failure.experience.sink.v5") {
        (result as Record<string, unknown>).trigger = "Before declaring a TLS service ready, check its secure listener.";
      }
      return result;
    };
    const { db, service } = createTestService({
      llm,
      skillLlm: llm,
      embedder: createCapturingEmbedder(embeddedTexts, embeddingRoles),
      config: {
        ...LEGACY_TEST_CONFIG,
        algorithm: {
          ...LEGACY_TEST_CONFIG.algorithm,
          capture: {
            ...LEGACY_TEST_CONFIG.algorithm.capture,
            embedAfterCapture: true,
            synthReflection: false
          },
          feedback: {
            ...LEGACY_TEST_CONFIG.algorithm.feedback,
            useLlm: false,
            attachToPolicy: false
          },
          l2Induction: {
            ...LEGACY_TEST_CONFIG.algorithm.l2Induction,
            useLlm: false
          },
          l3Abstraction: {
            ...LEGACY_TEST_CONFIG.algorithm.l3Abstraction,
            useLlm: false
          },
          skill: {
            ...LEGACY_TEST_CONFIG.algorithm.skill,
            useLlm: false
          }
        }
      }
    });
    const namespace = {
      source: "codex",
      profileId: "jiang",
      userId: "negative-experience-user"
    };
    const session = service.openSession({ namespace });
    const turn = (await service.completeTurn("negative-experience-turn", {
      sessionId: session.sessionId,
      episodeId: "negative-experience-episode",
      query: "Configure TLS and verify the service port.",
      answer: "I configured port 80 and skipped TLS verification."
    }));

    await settleCaptureAssignments(service);
    const feedback = await service.feedback({
      sessionId: session.sessionId,
      episodeId: assignedEpisodeId(service, turn),
      l1MemoryId: turn.l1MemoryId,
      channel: "explicit",
      polarity: "negative",
      magnitude: 1,
      rationale: "Wrong port: use 443 and verify TLS before reporting completion."
    });

    expect(service.panelItems({ namespace, layer: "L2" }).items).toEqual([]);
    expect(feedback.jobs.map((job) => job.jobType)).not.toContain("negative_experience");
    expect(feedback.jobs.map((job) => job.jobType)).not.toContain("reward");

    service.closeSession(session.sessionId);
    const run = await service.runWorkerOnce(50);
    expect(run.jobs).toEqual(expect.arrayContaining([
      expect.objectContaining({ jobType: "reward", status: "succeeded" }),
      expect.objectContaining({ jobType: "negative_experience", status: "succeeded" })
    ]));
    expect(run.jobs.findIndex(job => job.jobType === "reward"))
      .toBeLessThan(run.jobs.findIndex(job => job.jobType === "negative_experience"));
    const negativeJobCount = db.db.prepare(
      `SELECT COUNT(*) AS count
       FROM evolution_jobs
       WHERE job_type = 'negative_experience'
         AND 1=1`
    ).get() as { count: number };
    expect(negativeJobCount.count).toBe(1);

    const policies = service.panelItems({ namespace, layer: "L2" }).items;
    expect(policies).toHaveLength(1);
    const detail = service.getMemory(policies[0]!.id, { namespace });
    expect(detail.metadata).toMatchObject({
      properties: {
        internal_info: {
          policy: {
            status: "candidate",
            experience_type: "failure_avoidance",
            evidence_polarity: "negative",
            is_caveat: true,
            skill_eligible: false,
            gain: 0,
            raw_gain: 0
          }
        }
      }
    });
    expect(detail.body).toContain("Use the requested secure port and verify TLS before reporting completion.");
    expect(detail.body).not.toContain("I configured port 80 and skipped TLS verification.");
    expect(operations.filter((operation) => operation === "failure.experience.sink.v5")).toHaveLength(1);
    expect(operations[0]).toBe("capture.summarize");
    expect(operations.filter((operation) => operation === "reward.reward.r_human.v7")).toHaveLength(1);
    const negativePolicy = (detail.metadata.properties as {
      internal_info: {
        policy: {
          title: string;
          trigger: string;
        };
      };
    }).internal_info.policy;

    const initialVersion = policies[0]!.version;
    await service.runWorkerOnce(50);
    const policyEmbeddingText = [negativePolicy.title, negativePolicy.trigger].join("\n");
    expect(embeddedTexts).toContain(policyEmbeddingText);
    expect(embeddingRoles[embeddedTexts.indexOf(policyEmbeddingText)]).toBe("query");
    expect(service.panelItems({ namespace, layer: "L2" }).items).toEqual([
      expect.objectContaining({ id: policies[0]!.id, version: initialVersion })
    ]);
    const recall = await service.search({
      sessionId: session.sessionId,
      query: "TLS port verification",
      layers: ["L2"],
      includeInjectedContext: true
    });
    const avoidance = recall.injectedContext.sections.find(
      (section) => section.id === "failure-avoidance"
    );
    expect(avoidance?.memoryIds).toContain(policies[0]!.id);
    expect(avoidance?.content).toContain("TLS completion");
    expect(recall.injectedContext.sections.find(
      (section) => section.id === "decision-guidance"
    )?.memoryIds ?? []).not.toContain(policies[0]!.id);
    rephrase = true;
    const repos = new Repositories(db.db);
    const originalId = (db.db.prepare("SELECT id FROM evolution_jobs WHERE job_type = 'negative_experience' LIMIT 1").get() as { id: string }).id;
    const original = repos.runtime.getJob(originalId)!;
    repos.runtime.enqueueJob({ ...original, id: "647-rephrased-negative", dedupeKey: undefined,
      status: "queued", attempts: 0, createdAt: new Date().toISOString(), updatedAt: new Date().toISOString() });
    await service.runWorkerOnce(50);
    expect(service.panelItems({ namespace, layer: "L2" }).items).toHaveLength(1);
    expect(operations.filter(operation => operation === "failure.experience.sink.v5")).toHaveLength(1);
    const raw = repos.runtime.listRawTurnsByEpisode(original.episodeId!)[0]!;
    repos.runtime.updateRawTurn({ ...raw, assistantText: "Revised attempt: TLS port is still unverified." });
    repos.runtime.enqueueJob({ ...original, id: "647-revised-negative", dedupeKey: undefined,
      status: "queued", attempts: 0, createdAt: new Date().toISOString(), updatedAt: new Date().toISOString() });
    const revisedRun = await service.runWorkerOnce(50);
    expect(revisedRun.jobs.find(item => item.jobId === "647-revised-negative")?.status).toBe("succeeded");
    expect(repos.memories.list({ memoryLayer: "L2", status: ["activated", "resolving"] }, 100)).toHaveLength(1);
    expect(repos.memories.get(policies[0]!.id)?.status).toBe("archived");
    expect(operations.filter(operation => operation === "failure.experience.sink.v5")).toHaveLength(2);
    rephrase = false;
    repos.runtime.updateRawTurn({ ...raw, assistantText: "Return to the original TLS evidence after checking the transcript." });
    repos.runtime.enqueueJob({ ...original, id: "647-returned-negative", dedupeKey: undefined,
      status: "queued", attempts: 0, createdAt: new Date().toISOString(), updatedAt: new Date().toISOString() });
    const returned = await service.runWorkerOnce(50);
    expect(returned.jobs.find(item => item.jobId === "647-returned-negative")?.status).toBe("succeeded");
    expect(repos.memories.list({ memoryLayer: "L2", status: ["activated", "resolving"] }, 100).map(item => item.id)).toEqual([policies[0]!.id]);
    expect(repos.memories.list({ memoryLayer: "L2" }, 100)).toHaveLength(2);
    const edited = repos.memories.get(policies[0]!.id)!;
    repos.memories.update({ ...edited, memoryValue: `${edited.memoryValue}\nUser note: preserve my deployment exception.` });
    const protectedRows = repos.memories.list({ memoryLayer: "L2" }, 100);
    rephrase = true;
    repos.runtime.updateRawTurn({ ...raw, assistantText: "New source update after user editing the experience." });
    repos.runtime.enqueueJob({ ...original, id: "647-user-edited-negative", dedupeKey: undefined,
      status: "queued", attempts: 0, createdAt: new Date().toISOString(), updatedAt: new Date().toISOString() });
    const protectedRun = await service.runWorkerOnce(50);
    expect(protectedRun.jobs.find(item => item.jobId === "647-user-edited-negative")?.status).toBe("failed");
    expect(repos.memories.list({ memoryLayer: "L2" }, 100)).toEqual(protectedRows);
    db.close();
  });

  it.each([false, true])("lets a complete sink draft withdraw and restore; long body=%s", async longBody => {
    const operations: string[] = [];
    const llm = createCountingLlm(operations, {
      goal_achievement: -0.15,
      process_quality: -0.15,
      user_satisfaction: -0.15,
      reason: "TLS verification was skipped and the service port remained incorrect."
    });
    const { db, service } = createTestService({
      llm,
      skillLlm: llm,
      config: {
        ...LEGACY_TEST_CONFIG,
        algorithm: {
          ...LEGACY_TEST_CONFIG.algorithm,
          capture: {
            ...LEGACY_TEST_CONFIG.algorithm.capture,
            embedAfterCapture: false,
            synthReflection: false
          },
          feedback: {
            ...LEGACY_TEST_CONFIG.algorithm.feedback,
            useLlm: false,
            attachToPolicy: false
          },
          l2Induction: {
            ...LEGACY_TEST_CONFIG.algorithm.l2Induction,
            useLlm: false
          },
          l3Abstraction: {
            ...LEGACY_TEST_CONFIG.algorithm.l3Abstraction,
            useLlm: false
          },
          skill: {
            ...LEGACY_TEST_CONFIG.algorithm.skill,
            useLlm: false
          }
        }
      }
    });
    const namespace = {
      source: "codex",
      profileId: "jiang",
      userId: "negative-boundary-user"
    };
    const session = service.openSession({ namespace });
    const turn = (await service.completeTurn("negative-boundary-turn", {
      sessionId: session.sessionId,
      episodeId: "negative-boundary-episode",
      query: "Configure TLS on the correct port and verify it.",
      answer: "Configured port 80 without verification."
    }));
    await settleCaptureAssignments(service);
    await service.feedback({
      sessionId: session.sessionId,
      episodeId: assignedEpisodeId(service, turn),
      l1MemoryId: turn.l1MemoryId,
      channel: "explicit",
      polarity: "neutral",
      magnitude: 1
    });

    service.closeSession(session.sessionId);
    const run = await service.runWorkerOnce(50);
    expect(run.jobs).toEqual(expect.arrayContaining([
      expect.objectContaining({ jobType: "reward", status: "succeeded" }),
      expect.objectContaining({ jobType: "negative_experience", status: "succeeded" })
    ]));
    expect(run.jobs.findIndex(job => job.jobType === "reward"))
      .toBeLessThan(run.jobs.findIndex(job => job.jobType === "negative_experience"));

    const policies = service.panelItems({ namespace, layer: "L2" }).items;
    expect(policies).toHaveLength(1);
    expect(operations[0]).toBe("capture.summarize");
    expect(operations.filter((operation) => operation === "reward.reward.r_human.v7")).toHaveLength(1);
    const repos = new Repositories(db.db);
    const negativeId = (db.db.prepare("SELECT id FROM evolution_jobs WHERE job_type = 'negative_experience' LIMIT 1").get() as { id: string }).id;
    const original = repos.runtime.getJob(negativeId)!;
    const runRevision = async (id: string, rTask: number) => {
      const at = new Date().toISOString();
      repos.runtime.updateEpisodeReward(original.episodeId!, { rTask, rewardDetail: { reason: rTask > 0 ? "TLS now verified" : "TLS verification missing" } }, at);
      const current = repos.runtime.getEpisode(original.episodeId!)!;
      repos.runtime.enqueueJob({ ...original, id, payload: { ...original.payload,
        rewardVersion: revisionInputHash([current.rTask, current.rewardDetail]) },
        dedupeKey: undefined, status: "queued", attempts: 0, createdAt: at, updatedAt: at });
      await service.runWorkerOnce(50);
      expect(repos.runtime.getJob(id)?.status).toBe("succeeded");
    };
    if (longBody) {
      const row = repos.memories.get(policies[0]!.id)!;
      const body = row.memoryValue + "\n" + "Detailed accepted workflow. ".repeat(1200);
      repos.memories.update({ ...row, memoryValue: body, properties: { ...row.properties,
        internal_info: { ...row.properties.internal_info, negative_generated_hash: revisionInputHash(body) } } });
    }
    const generated = operations.filter(operation => operation === "failure.experience.sink.v5").length;
    await runRevision("647-negative-withdraw", 1);
    expect(repos.memories.get(policies[0]!.id)?.status).toBe("archived");
    expect(operations.filter(operation => operation === "failure.experience.sink.v5")).toHaveLength(generated);
    const retired = repos.memories.get(policies[0]!.id)!;
    await runRevision("647-negative-withdraw-repeat", 1);
    expect(repos.memories.get(retired.id)).toEqual(retired);
    await runRevision("647-negative-restore", -0.15);
    expect(repos.memories.get(retired.id)?.status).not.toBe("archived");
    expect(repos.memories.list({ memoryLayer: "L2" }, 100)).toHaveLength(1);
    db.close();
  });

  it("merges the same avoidance across episodes and user ids", async () => {
    const sink = createCountingLlm([]);
    const { db, service } = createTestService({
      llm: createCountingLlm([]),
      skillLlm: sink,
      config: {
        ...LEGACY_TEST_CONFIG,
        algorithm: {
          ...LEGACY_TEST_CONFIG.algorithm,
          capture: {
            ...LEGACY_TEST_CONFIG.algorithm.capture,
            embedAfterCapture: false,
            synthReflection: false
          },
          feedback: {
            ...LEGACY_TEST_CONFIG.algorithm.feedback,
            useLlm: false,
            attachToPolicy: false
          },
          l2Induction: {
            ...LEGACY_TEST_CONFIG.algorithm.l2Induction,
            useLlm: false
          },
          l3Abstraction: {
            ...LEGACY_TEST_CONFIG.algorithm.l3Abstraction,
            useLlm: false
          },
          skill: {
            ...LEGACY_TEST_CONFIG.algorithm.skill,
            useLlm: false
          }
        }
      }
    });
    const namespace = {
      source: "codex",
      profileId: "jiang",
      userId: "negative-support-user"
    };
    const policyIds: string[] = [];
    for (const suffix of ["one", "two"]) {
      const session = service.openSession({ namespace });
      const turn = (await service.completeTurn(`negative-support-turn-${suffix}`, {
        sessionId: session.sessionId,
        episodeId: `negative-support-episode-${suffix}`,
        query: "Configure TLS and verify the service port.",
        answer: "I configured port 80 and skipped TLS verification."
      }));
      await settleCaptureAssignments(service);
    await service.feedback({
        sessionId: session.sessionId,
        episodeId: assignedEpisodeId(service, turn),
        l1MemoryId: turn.l1MemoryId,
        channel: "explicit",
        polarity: "negative",
        magnitude: 1,
        rationale: "Wrong port: use 443 and verify TLS before reporting completion."
      });
      service.closeSession(session.sessionId);
      await service.runWorkerOnce(50);
      await service.runWorkerOnce(50);
      await service.runWorkerOnce(50);
      await service.runWorkerOnce(50);
      const recall = await service.search({
        sessionId: session.sessionId,
        query: "TLS port verification",
        layers: ["L2"]
      });
      const policyHit = recall.hits.find((hit) => hit.memoryLayer === "L2");
      expect(policyHit).toBeTruthy();
      policyIds.push(policyHit!.id);
    }

    expect(new Set(policyIds)).toHaveLength(1);
    const detail = service.getMemory(policyIds[0]!, { namespace });
    expect(detail.metadata).toMatchObject({
      properties: {
        internal_info: {
          policy: {
            support: 2,
            source_episode_ids: [
              "negative-support-episode-one",
              "negative-support-episode-two"
            ]
          }
        }
      }
    });

    const otherNamespace = {
      ...namespace,
      userId: "negative-support-other-user"
    };
    const otherSession = service.openSession({ namespace: otherNamespace });
    const otherTurn = (await service.completeTurn("negative-support-other-turn", {
      sessionId: otherSession.sessionId,
      episodeId: "negative-support-other-episode",
      query: "Configure TLS and verify the service port.",
      answer: "I configured port 80 and skipped TLS verification."
    }));
    await settleCaptureAssignments(service);
    await service.feedback({
      sessionId: otherSession.sessionId,
      episodeId: assignedEpisodeId(service, otherTurn),
      l1MemoryId: otherTurn.l1MemoryId,
      channel: "explicit",
      polarity: "negative",
      magnitude: 1,
      rationale: "Wrong port: use 443 and verify TLS before reporting completion."
    });
    service.closeSession(otherSession.sessionId);
    await service.runWorkerOnce(50);
    await service.runWorkerOnce(50);
    await service.runWorkerOnce(50);
    await service.runWorkerOnce(50);
    const otherRecall = await service.search({
      sessionId: otherSession.sessionId,
      query: "TLS port verification",
      layers: ["L2"]
    });
    const otherPolicy = otherRecall.hits.find((hit) => hit.memoryLayer === "L2");
    expect(otherPolicy?.id).toBe(policyIds[0]);
    expect(service.getMemory(otherPolicy!.id, { namespace: otherNamespace }).metadata).toMatchObject({
      properties: {
        internal_info: {
          policy: {
            support: 3,
            source_episode_ids: [
              "negative-support-episode-one",
              "negative-support-episode-two",
              "negative-support-other-episode"
            ]
          }
        }
      }
    });
    const repos = new Repositories(db.db);
    // Independent post-generation feedback must survive a source being revised.
    const shared = repos.memories.get(otherPolicy!.id)!;
    const sharedPolicy = shared.properties.internal_info.policy as Record<string, unknown>;
    repos.memories.update({ ...shared, status: "activated", properties: { ...shared.properties,
      status: "activated", internal_info: { ...shared.properties.internal_info,
        policy: { ...sharedPolicy, gain: 0.12, raw_gain: 0.12, status: "active" } } } });
    const complete = sink.completeJson.bind(sink);
    sink.completeJson = async <T extends Record<string, unknown>>(messages: Parameters<LlmClient["completeJson"]>[0], options: Parameters<LlmClient["completeJson"]>[1]): Promise<T> => {
      const result = await complete<T>(messages, options);
      if (options.operation === "failure.experience.sink.v5") (result as Record<string, unknown>).trigger = "Revised scope: validate the TLS listener before migration.";
      return result;
    };
    const raw = repos.runtime.listRawTurnsByEpisode("negative-support-episode-one")[0]!;
    repos.runtime.updateRawTurn({ ...raw, assistantText: "The TLS listener remains unverified after migration." });
    const row = db.db.prepare("SELECT id FROM evolution_jobs WHERE job_type = 'negative_experience' AND episode_id = ? LIMIT 1")
      .get("negative-support-episode-one") as { id: string };
    const original = repos.runtime.getJob(row.id)!;
    repos.runtime.enqueueJob({ ...original, id: "647-shared-revision", dedupeKey: undefined,
      status: "queued", attempts: 0, createdAt: new Date().toISOString(), updatedAt: new Date().toISOString() });
    const revision = await service.runWorkerOnce(50);
    expect(revision.jobs.find(item => item.jobId === "647-shared-revision")?.status).toBe("succeeded");
    expect(repos.memories.get(otherPolicy!.id)?.properties.internal_info.policy).toMatchObject({
      support: 2, source_episode_ids: ["negative-support-episode-two", "negative-support-other-episode"],
      gain: 0.12, raw_gain: 0.12, status: "active" });
    expect(repos.memories.get(otherPolicy!.id)?.status).toBe("activated");
    expect(repos.memories.list({ memoryLayer: "L2", status: ["activated", "resolving"] }, 100)).toHaveLength(2);
    db.close();
  });

  it("skips generic negative feedback without a reusable safer behavior", async () => {
    const { db, service } = createTestService({
      config: {
        ...LEGACY_TEST_CONFIG,
        algorithm: {
          ...LEGACY_TEST_CONFIG.algorithm,
          capture: {
            ...LEGACY_TEST_CONFIG.algorithm.capture,
            embedAfterCapture: false,
            synthReflection: false
          },
          feedback: {
            ...LEGACY_TEST_CONFIG.algorithm.feedback,
            useLlm: false,
            attachToPolicy: false
          }
        }
      }
    });
    const namespace = {
      source: "codex",
      profileId: "jiang",
      userId: "negative-generic-user"
    };
    const session = service.openSession({ namespace });
    const turn = (await service.completeTurn("negative-generic-turn", {
      sessionId: session.sessionId,
      episodeId: "negative-generic-episode",
      query: "Review this implementation.",
      answer: "Reviewed."
    }));
    await service.feedback({
      sessionId: session.sessionId,
      episodeId: assignedEpisodeId(service, turn),
      l1MemoryId: turn.l1MemoryId,
      channel: "explicit",
      polarity: "negative",
      magnitude: 1,
      rationale: "Be careful."
    });

    service.closeSession(session.sessionId);
    await service.runWorkerOnce(50);
    await service.runWorkerOnce(50);
    await service.runWorkerOnce(50);

    expect(service.panelItems({ namespace, layer: "L2" }).items).toEqual([]);
    db.close();
  });

  it("recalls negative policies written under another user id", async () => {
    const { db, service } = createTestService({
      llm: createCountingLlm([]),
      skillLlm: createCountingLlm([]),
      config: {
        ...LEGACY_TEST_CONFIG,
        algorithm: {
          ...LEGACY_TEST_CONFIG.algorithm,
          enableQueryRewrite: false,
          capture: {
            ...LEGACY_TEST_CONFIG.algorithm.capture,
            embedAfterCapture: false,
            synthReflection: false
          },
          feedback: {
            ...LEGACY_TEST_CONFIG.algorithm.feedback,
            useLlm: false,
            attachToPolicy: false
          },
          l2Induction: {
            ...LEGACY_TEST_CONFIG.algorithm.l2Induction,
            useLlm: false
          }
        }
      }
    });
    let targetSessionId = "";
    for (let index = 0; index < 25; index += 1) {
      const namespace = {
        source: "codex",
        profileId: "candidate-isolation",
        userId: index === 24 ? "negative-target-user" : `negative-other-user-${index}`
      };
      const session = service.openSession({ namespace });
      const turn = (await service.completeTurn(`negative-candidate-turn-${index}`, {
        sessionId: session.sessionId,
        episodeId: `negative-candidate-episode-${index}`,
        query: "Verify TLS certificate rotation.",
        answer: "Skipped TLS certificate verification."
      }));
      await settleCaptureAssignments(service);
    await service.feedback({
        sessionId: session.sessionId,
        episodeId: assignedEpisodeId(service, turn),
        l1MemoryId: turn.l1MemoryId,
        channel: "explicit",
        polarity: "negative",
        magnitude: 1,
        rationale: `TLS_ROTATION_GUARD_${index} verify certificate rotation before completion.`
      });
      service.closeSession(session.sessionId);
      if (index === 24) targetSessionId = session.sessionId;
    }
    await service.runWorkerOnce(1000);
    await service.runWorkerOnce(1000);
    await service.runWorkerOnce(1000);
    await service.runWorkerOnce(1000);
    const crossUserPolicy = db.db.prepare(
      `SELECT id
       FROM memories
       WHERE memory_layer = 'L2'
         AND deleted_at IS NULL
       LIMIT 1`
    ).get() as { id: string } | undefined;
    expect(crossUserPolicy?.id).toBeTruthy();

    const reader = service.openSession({ namespace: {
      source: "codex",
      profileId: "candidate-isolation",
      userId: "negative-new-reader"
    } });
    const result = await service.search({
      sessionId: reader.sessionId,
      query: "TLS port verification",
      layers: ["L2"],
      limit: 5
    });
    expect(result.hits.some((hit) => hit.id === crossUserPolicy?.id)).toBe(true);
    db.close();
  });
});
