import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
  DEFAULT_MEMMY_CONFIG,
  MemoryDb,
  type LlmClient
} from "../../../src/index.js";
import {
  createCapturingEmbedder,
  createMemoryServiceFixture
} from "../../fixtures/memory-service-fixture.js";

const {
  cleanup,
  createTestMemoryService,
  createTestRoot,
  createTestService
} = createMemoryServiceFixture();

afterEach(cleanup);

function createFeedbackRefinerLlm(calls: Array<{
  messages: Array<{ role: string; content: string }>;
  options: { operation: string; thinkingMode?: "inherit" | "enabled" | "disabled" };
}>): LlmClient {
  return {
    config: {
      ...DEFAULT_MEMMY_CONFIG.evolution,
      provider: "host",
      endpoint: "http://127.0.0.1/feedback-refiner",
      model: "feedback-refiner"
    },
    isConfigured() {
      return true;
    },
    async complete() {
      return "{}";
    },
    async completeJson<T extends Record<string, unknown>>(
      messages: Array<{ role: "system" | "user" | "assistant"; content: string }>,
      options: { operation: string; thinkingMode?: "inherit" | "enabled" | "disabled" }
    ): Promise<T> {
      calls.push({ messages, options });
      if (options.operation === "failure.experience.sink.v5") {
        return {
          title: "Validate SEC 13F issuer fields",
          trigger: "When the user asks to parse SEC 13F holdings or issuer/CUSIP data.",
          procedure: "Extract issuer and CUSIP values from the filing fields, not from the filename.",
          verification: "Check that each CUSIP is paired with the issuer field from the filing table.",
          boundary: "Use for SEC 13F parsing tasks with issuer/CUSIP extraction.",
          experience_type: "repair_instruction",
          decision_guidance: {
            prefer: ["Extract issuer and CUSIP values from the filing fields."],
            avoid: ["Do not use the filename as the issuer name."]
          },
          support_trace_ids: []
        } as unknown as T;
      }
      return {} as T;
    },
    status() {
      return {
        provider: "host",
        model: "feedback-refiner",
        configured: true,
        remote: true
      };
    }
  };
}

describe("MemoryService / feedback / experience", () => {
  it("creates feedback-derived experience policies with hydrated trace context and merge semantics", async () => {
    const embeddedTexts: string[] = [];
    const embeddingRoles: Array<"query" | "document" | undefined> = [];
    const { db, service } = createTestService({
      embedder: createCapturingEmbedder(embeddedTexts, embeddingRoles)
    });
    const session = service.openSession({
      namespace: {
        source: "codex",
        profileId: "jiang",
        userId: "user-feedback-experience"
      }
    });
    const complete = service.completeTurn("turn-feedback-experience", {
      sessionId: session.sessionId,
      episodeId: "episode-feedback-experience",
      query: "Parse a SEC 13F filing and extract issuer CUSIP holdings.",
      answer: "Parsed the filing and validated the issuer field."
    });

    const ok = await service.feedback({
      sessionId: session.sessionId,
      episodeId: complete.episodeId,
      l1MemoryId: complete.l1MemoryId,
      channel: "explicit",
      polarity: "positive",
      magnitude: 1,
      rationale: "Verifier feedback: passed. The SEC 13F parsing result is correct.",
      rawPayload: { source: "verifier", score: 1 }
    });
    expect(ok.jobs.map((job) => job.jobType)).toEqual(expect.arrayContaining([
      "skill_crystallization",
      "l3_abstraction"
    ]));

    const created = db.db.prepare(
      `SELECT id, memory_value, properties_json
       FROM memories
       WHERE user_id = 'user-feedback-experience'
         AND memory_layer = 'L2'`
    ).all() as Array<{ id: string; memory_value: string; properties_json: string }>;
    expect(created).toHaveLength(1);
    expect(created[0]!.memory_value).toContain("Source user request: Parse a SEC 13F filing");
    const createdPolicy = (JSON.parse(created[0]!.properties_json) as {
      internal_info: { policy: Record<string, unknown> };
    }).internal_info.policy;
    expect(createdPolicy.experience_type).toBe("success_pattern");
    expect(createdPolicy.evidence_polarity).toBe("positive");
    expect(createdPolicy.skill_eligible).toBe(true);
    expect(createdPolicy.source_feedback_ids).toEqual([ok.feedbackId]);
    expect(embeddedTexts).toEqual([[
      createdPolicy.title,
      createdPolicy.trigger,
      createdPolicy.procedure,
      createdPolicy.verification,
      createdPolicy.boundary
    ].join("\n")]);
    expect(embeddingRoles).toEqual(["query"]);
    expect(ok.jobs).not.toEqual(expect.arrayContaining([
      expect.objectContaining({ jobType: "embedding", targetMemoryId: created[0]!.id })
    ]));

    const avoid = await service.feedback({
      sessionId: session.sessionId,
      episodeId: complete.episodeId,
      l1MemoryId: complete.l1MemoryId,
      channel: "explicit",
      polarity: "negative",
      magnitude: 1,
      rationale: "Verifier feedback: failed. Avoid using the filename as the issuer name.",
      rawPayload: { source: "verifier", score: -1 }
    });

    const merged = db.db.prepare(
      `SELECT id, properties_json
       FROM memories
       WHERE user_id = 'user-feedback-experience'
         AND memory_layer = 'L2'`
    ).all() as Array<{ id: string; properties_json: string }>;
    expect(merged).toHaveLength(1);
    expect(merged[0]!.id).toBe(created[0]!.id);
    const mergedPolicy = (JSON.parse(merged[0]!.properties_json) as {
      internal_info: {
        policy: {
          support?: number;
          experience_type?: string;
          evidence_polarity?: string;
          skill_eligible?: boolean;
          source_feedback_ids?: string[];
          decision_guidance?: { anti_pattern?: string[] };
        };
      };
    }).internal_info.policy;
    expect(mergedPolicy.support).toBe(2);
    expect(mergedPolicy.experience_type).toBe("repair_validated");
    expect(mergedPolicy.evidence_polarity).toBe("mixed");
    expect(mergedPolicy.skill_eligible).toBe(true);
    expect(mergedPolicy.source_feedback_ids?.sort()).toEqual([avoid.feedbackId, ok.feedbackId].sort());
    expect(mergedPolicy.decision_guidance?.anti_pattern?.join("\n")).toContain("filename");
    db.close();
  });

  it("uses configured model feedback refiner for feedback-derived experience policies", async () => {
    const root = createTestRoot("mindock-memory-");
    const db = new MemoryDb({
      path: join(root, "memory.sqlite")
    });
    const calls: Array<{
      messages: Array<{ role: string; content: string }>;
      options: { operation: string; thinkingMode?: "inherit" | "enabled" | "disabled" };
    }> = [];
    const service = createTestMemoryService({
      db,
      mode: "dev",
      skillLlm: createFeedbackRefinerLlm(calls),
      embedder: createCapturingEmbedder([]),
      config: {
        ...DEFAULT_MEMMY_CONFIG,
        algorithm: {
          ...DEFAULT_MEMMY_CONFIG.algorithm,
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
    const session = service.openSession({
      namespace: {
        source: "codex",
        profileId: "jiang",
        userId: "user-feedback-refiner"
      }
    });
    const complete = service.completeTurn("turn-feedback-refiner", {
      sessionId: session.sessionId,
      episodeId: "episode-feedback-refiner",
      query: "Parse a SEC 13F filing and extract issuer CUSIP holdings.",
      answer: "I parsed the filename as the issuer name."
    });

    const feedbackResponse = await service.feedback({
      sessionId: session.sessionId,
      episodeId: complete.episodeId,
      l1MemoryId: complete.l1MemoryId,
      channel: "explicit",
      polarity: "negative",
      magnitude: 1,
      rationale: "Verifier feedback: failed. Avoid using the filename as the issuer name.",
      rawPayload: { source: "verifier", score: -1 }
    });

    const refineCall = calls.find((call) => call.options.operation === "failure.experience.sink.v5");
    expect(refineCall).toBeTruthy();
    expect(refineCall!.options.thinkingMode).toBe("enabled");
    expect(refineCall!.messages[0]!.content).toContain("corrective_signals");
    expect(refineCall!.messages[0]!.content).toContain("repair_instruction");
    expect(refineCall!.messages[1]!.content).toContain("corrective_signals");
    expect(refineCall!.messages[1]!.content).toContain("SEC 13F filing");

    const row = db.db.prepare(
      `SELECT properties_json
       FROM memories
       WHERE user_id = 'user-feedback-refiner'
         AND memory_layer = 'L2'
       LIMIT 1`
    ).get() as { properties_json: string } | undefined;
    expect(row).toBeTruthy();
    const policy = (JSON.parse(row!.properties_json) as {
      internal_info: {
        policy: {
          trigger?: string;
          procedure?: string;
          verification?: string;
          decision_guidance?: { anti_pattern?: string[] };
          policy_confidence?: number;
        };
      };
    }).internal_info.policy;
    expect(policy.trigger).toContain("SEC 13F holdings");
    expect(policy.procedure).toContain("issuer and CUSIP");
    expect(policy.verification).toContain("CUSIP");
    expect(policy.decision_guidance?.anti_pattern?.join("\n")).toContain("filename");
    expect(policy.policy_confidence).toBeGreaterThanOrEqual(0.91);

    const skillRow = db.db.prepare(
      `SELECT id, properties_json
       FROM memories
       WHERE user_id = 'user-feedback-refiner'
         AND memory_layer = 'Skill'
       LIMIT 1`
    ).get() as { id: string; properties_json: string } | undefined;
    expect(skillRow).toBeTruthy();
    const skill = (JSON.parse(skillRow!.properties_json) as {
      internal_info: {
        skill: {
          repair_origin?: boolean;
          strict_trial?: boolean;
          status?: string;
          eta?: number;
        };
      };
    }).internal_info.skill;
    expect(skill.repair_origin).toBe(true);
    expect(skill.strict_trial).toBe(true);
    expect(skill.status).toBe("candidate");
    expect(skill.eta).toBe(0.1);
    expect(feedbackResponse.jobs).toEqual(expect.arrayContaining([
      expect.objectContaining({ jobType: "embedding", targetMemoryId: skillRow!.id })
    ]));
    db.close();
  });
});
