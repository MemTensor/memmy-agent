import { afterEach, describe, expect, it } from "vitest";
import {
  DEFAULT_MEMMY_CONFIG,
  type LlmClient
} from "../../../src/index.js";
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
      ...DEFAULT_MEMMY_CONFIG.summary,
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
      _messages: Array<{ role: "system" | "user" | "assistant"; content: string }>,
      options: { operation: string }
    ): Promise<T> {
      operations.push(options.operation);
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
  it("materializes explicit negative feedback as an independent avoidance policy without another LLM call", async () => {
    const operations: string[] = [];
    const embeddedTexts: string[] = [];
    const embeddingRoles: Array<"query" | "document" | undefined> = [];
    const llm = createCountingLlm(operations);
    const { db, service } = createTestService({
      llm,
      skillLlm: llm,
      embedder: createCapturingEmbedder(embeddedTexts, embeddingRoles),
      config: {
        ...DEFAULT_MEMMY_CONFIG,
        algorithm: {
          ...DEFAULT_MEMMY_CONFIG.algorithm,
          capture: {
            ...DEFAULT_MEMMY_CONFIG.algorithm.capture,
            embedAfterCapture: true,
            synthReflection: false
          },
          feedback: {
            ...DEFAULT_MEMMY_CONFIG.algorithm.feedback,
            useLlm: false,
            attachToPolicy: false
          },
          l2Induction: {
            ...DEFAULT_MEMMY_CONFIG.algorithm.l2Induction,
            useLlm: false
          },
          l3Abstraction: {
            ...DEFAULT_MEMMY_CONFIG.algorithm.l3Abstraction,
            useLlm: false
          },
          skill: {
            ...DEFAULT_MEMMY_CONFIG.algorithm.skill,
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
    const turn = service.completeTurn("negative-experience-turn", {
      sessionId: session.sessionId,
      episodeId: "negative-experience-episode",
      query: "Configure TLS and verify the service port.",
      answer: "I configured port 80 and skipped TLS verification."
    });

    const feedback = await service.feedback({
      sessionId: session.sessionId,
      episodeId: turn.episodeId,
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
    await service.runWorkerOnce(50);
    expect(service.panelItems({ namespace, layer: "L2" }).items).toEqual([]);
    expect(service.panelJobs({ namespace, status: "queued" }).items).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ jobType: "reward" })
      ])
    );

    await service.runWorkerOnce(50);
    expect(service.panelJobs({ namespace, status: "queued" }).items).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ jobType: "negative_experience" })
      ])
    );
    const negativeJobCount = db.db.prepare(
      `SELECT COUNT(*) AS count
       FROM evolution_jobs
       WHERE job_type = 'negative_experience'
         AND user_id = ?`
    ).get(namespace.userId) as { count: number };
    expect(negativeJobCount.count).toBe(1);

    await service.runWorkerOnce(50);
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
    expect(detail.body).toContain("Wrong port");
    expect(detail.body).toContain("443");
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
    expect(avoidance?.content).toContain("Wrong port");
    expect(recall.injectedContext.sections.find(
      (section) => section.id === "decision-guidance"
    )?.memoryIds ?? []).not.toContain(policies[0]!.id);
    db.close();
  });

  it("does not turn a weak negative score at the boundary into a policy", async () => {
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
        ...DEFAULT_MEMMY_CONFIG,
        algorithm: {
          ...DEFAULT_MEMMY_CONFIG.algorithm,
          capture: {
            ...DEFAULT_MEMMY_CONFIG.algorithm.capture,
            embedAfterCapture: false,
            synthReflection: false
          },
          feedback: {
            ...DEFAULT_MEMMY_CONFIG.algorithm.feedback,
            useLlm: false,
            attachToPolicy: false
          },
          l2Induction: {
            ...DEFAULT_MEMMY_CONFIG.algorithm.l2Induction,
            useLlm: false
          },
          l3Abstraction: {
            ...DEFAULT_MEMMY_CONFIG.algorithm.l3Abstraction,
            useLlm: false
          },
          skill: {
            ...DEFAULT_MEMMY_CONFIG.algorithm.skill,
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
    const turn = service.completeTurn("negative-boundary-turn", {
      sessionId: session.sessionId,
      episodeId: "negative-boundary-episode",
      query: "Configure TLS on the correct port and verify it.",
      answer: "Configured port 80 without verification."
    });
    await service.feedback({
      sessionId: session.sessionId,
      episodeId: turn.episodeId,
      l1MemoryId: turn.l1MemoryId,
      channel: "explicit",
      polarity: "neutral",
      magnitude: 1
    });

    service.closeSession(session.sessionId);
    await service.runWorkerOnce(50);
    expect(service.panelJobs({ namespace, status: "queued" }).items).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ jobType: "reward" })
      ])
    );
    await service.runWorkerOnce(50);
    expect(service.panelJobs({ namespace, status: "queued" }).items).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ jobType: "negative_experience" })
      ])
    );
    await service.runWorkerOnce(50);

    const policies = service.panelItems({ namespace, layer: "L2" }).items;
    expect(policies).toEqual([]);
    expect(operations[0]).toBe("capture.summarize");
    expect(operations.filter((operation) => operation === "reward.reward.r_human.v7")).toHaveLength(1);
    db.close();
  });

  it("merges the same avoidance across episodes and user ids", async () => {
    const { db, service } = createTestService({
      config: {
        ...DEFAULT_MEMMY_CONFIG,
        algorithm: {
          ...DEFAULT_MEMMY_CONFIG.algorithm,
          capture: {
            ...DEFAULT_MEMMY_CONFIG.algorithm.capture,
            embedAfterCapture: false,
            synthReflection: false
          },
          feedback: {
            ...DEFAULT_MEMMY_CONFIG.algorithm.feedback,
            useLlm: false,
            attachToPolicy: false
          },
          l2Induction: {
            ...DEFAULT_MEMMY_CONFIG.algorithm.l2Induction,
            useLlm: false
          },
          l3Abstraction: {
            ...DEFAULT_MEMMY_CONFIG.algorithm.l3Abstraction,
            useLlm: false
          },
          skill: {
            ...DEFAULT_MEMMY_CONFIG.algorithm.skill,
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
      const turn = service.completeTurn(`negative-support-turn-${suffix}`, {
        sessionId: session.sessionId,
        episodeId: `negative-support-episode-${suffix}`,
        query: "Configure TLS and verify the service port.",
        answer: "I configured port 80 and skipped TLS verification."
      });
      await service.feedback({
        sessionId: session.sessionId,
        episodeId: turn.episodeId,
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
    const otherTurn = service.completeTurn("negative-support-other-turn", {
      sessionId: otherSession.sessionId,
      episodeId: "negative-support-other-episode",
      query: "Configure TLS and verify the service port.",
      answer: "I configured port 80 and skipped TLS verification."
    });
    await service.feedback({
      sessionId: otherSession.sessionId,
      episodeId: otherTurn.episodeId,
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
    db.close();
  });

  it("skips generic negative feedback without a reusable safer behavior", async () => {
    const { db, service } = createTestService({
      config: {
        ...DEFAULT_MEMMY_CONFIG,
        algorithm: {
          ...DEFAULT_MEMMY_CONFIG.algorithm,
          capture: {
            ...DEFAULT_MEMMY_CONFIG.algorithm.capture,
            embedAfterCapture: false,
            synthReflection: false
          },
          feedback: {
            ...DEFAULT_MEMMY_CONFIG.algorithm.feedback,
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
    const turn = service.completeTurn("negative-generic-turn", {
      sessionId: session.sessionId,
      episodeId: "negative-generic-episode",
      query: "Review this implementation.",
      answer: "Reviewed."
    });
    await service.feedback({
      sessionId: session.sessionId,
      episodeId: turn.episodeId,
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
      config: {
        ...DEFAULT_MEMMY_CONFIG,
        algorithm: {
          ...DEFAULT_MEMMY_CONFIG.algorithm,
          enableQueryRewrite: false,
          capture: {
            ...DEFAULT_MEMMY_CONFIG.algorithm.capture,
            embedAfterCapture: false,
            synthReflection: false
          },
          feedback: {
            ...DEFAULT_MEMMY_CONFIG.algorithm.feedback,
            useLlm: false,
            attachToPolicy: false
          },
          l2Induction: {
            ...DEFAULT_MEMMY_CONFIG.algorithm.l2Induction,
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
      const turn = service.completeTurn(`negative-candidate-turn-${index}`, {
        sessionId: session.sessionId,
        episodeId: `negative-candidate-episode-${index}`,
        query: "Verify TLS certificate rotation.",
        answer: "Skipped TLS certificate verification."
      });
      await service.feedback({
        sessionId: session.sessionId,
        episodeId: turn.episodeId,
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
    const crossUserPolicy = db.db.prepare(
      `SELECT id
       FROM memories
       WHERE user_id = ?
         AND memory_layer = 'L2'
         AND deleted_at IS NULL
       LIMIT 1`
    ).get("negative-other-user-0") as { id: string } | undefined;
    expect(crossUserPolicy?.id).toBeTruthy();

    const result = await service.search({
      sessionId: targetSessionId,
      query: "TLS_ROTATION_GUARD_0",
      layers: ["L2"],
      limit: 5
    });
    expect(result.hits.some((hit) => hit.id === crossUserPolicy?.id)).toBe(true);
    db.close();
  });
});
