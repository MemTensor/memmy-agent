import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
  DEFAULT_MEMMY_CONFIG,
  MemoryDb,
  type LlmClient,
  type LlmCompletionOptions,
  type LlmMessage
} from "../../../src/index.js";
import { makeTraceEligibleForL2 } from "../../fixtures/evolution-fixture.js";
import {
  createCapturingEmbedder,
  createMemoryServiceFixture
} from "../../fixtures/memory-service-fixture.js";
import { createDecisionRepairEvolutionLlm } from "./decision-repair-llm-stub.js";

const {
  cleanup,
  createTestMemoryService,
  createTestRoot,
  createTestService
} = createMemoryServiceFixture();

afterEach(cleanup);

function createDecisionRepairLlm(
  calls: Array<{ messages: LlmMessage[]; options: LlmCompletionOptions }>
): LlmClient {
  return {
    config: {
      ...DEFAULT_MEMMY_CONFIG.evolution,
      provider: "host",
      endpoint: "http://127.0.0.1/decision-repair",
      model: "decision-repair"
    },
    isConfigured() {
      return true;
    },
    async complete() {
      return "{}";
    },
    async completeJson<T extends Record<string, unknown>>(
      messages: LlmMessage[],
      options: LlmCompletionOptions
    ): Promise<T> {
      calls.push({ messages, options });
      if (options.operation === "decision.repair.v1") {
        return {
          preference: "Inspect migration output before retrying the sqlite query.",
          anti_pattern: "Avoid blind query retries after a migration failure.",
          severity: "warn",
          confidence: 0.88
        } as unknown as T;
      }
      return {} as T;
    },
    status() {
      return {
        provider: "host",
        model: "decision-repair",
        configured: true,
        remote: true
      };
    }
  };
}

describe("MemoryService / feedback / decision repair", () => {
  it("creates decision repairs from actionable feedback and throttles repeat context", async () => {
    const { db, service } = createTestService({ skillLlm: createDecisionRepairEvolutionLlm() });
    const session = service.openSession({
      namespace: {
        source: "codex",
        profileId: "jiang",
        userId: "user-repair"
      },
      workspaceId: "workspace-repair"
    });
    const completes = [
      service.completeTurn("turn-repair-a", {
        sessionId: session.sessionId,
        episodeId: "episode-repair-a",
        query: "sqlite migration repair workflow should inspect schema first",
        answer: "Use deterministic sqlite schema repair and verify with tests."
      }),
      service.completeTurn("turn-repair-b", {
        sessionId: session.sessionId,
        episodeId: "episode-repair-b",
        query: "sqlite schema repair workflow should inspect migrations first",
        answer: "Use deterministic sqlite schema repair and verify with tests."
      })
    ];
    for (const complete of completes) {
      await service.feedback({
        sessionId: session.sessionId,
        l1MemoryId: complete.l1MemoryId,
        channel: "explicit",
        polarity: "positive",
        magnitude: 1,
        rationale: "the sqlite repair workflow was useful"
      });
      makeTraceEligibleForL2(db, complete.l1MemoryId);
    }
    for (let i = 0; i < 20; i += 1) {
      await service.runWorkerOnce(100);
    }

    const link = db.db.prepare(
      `SELECT l1_memory_id, l2_memory_id
       FROM trace_policy_links
       LIMIT 1`
    ).get() as { l1_memory_id: string; l2_memory_id: string } | undefined;
    expect(link).toBeTruthy();

    const repairFeedback = await service.feedback({
      sessionId: session.sessionId,
      l1MemoryId: link!.l1_memory_id,
      channel: "explicit",
      polarity: "negative",
      magnitude: 1,
      rationale: "wrong, next time use deterministic sqlite repair instead of repeating the failing query",
      rawPayload: {
        contextHash: "ctx-feedback-repair"
      }
    });
    expect(repairFeedback.repair?.skipped).toBe(false);
    expect(repairFeedback.repair?.repairId).toMatch(/^repair_/);
    expect(repairFeedback.repair?.attachedPolicyIds).toContain(link!.l2_memory_id);

    const repairRow = db.db.prepare(
      `SELECT context_hash, preference, anti_pattern, low_value_memory_ids_json, attached_policy_memory_ids_json
       FROM decision_repairs
       WHERE id = ?`
    ).get(repairFeedback.repair!.repairId) as {
      context_hash: string;
      preference: string;
      anti_pattern: string;
      low_value_memory_ids_json: string;
      attached_policy_memory_ids_json: string;
    } | undefined;
    expect(repairRow?.context_hash).toBe("ctx-feedback-repair");
    expect(repairRow?.preference).toContain("deterministic sqlite repair");
    expect(repairRow?.anti_pattern).toContain("repeating the failing query");
    expect(JSON.parse(repairRow!.low_value_memory_ids_json)).toContain(link!.l1_memory_id);
    expect(JSON.parse(repairRow!.attached_policy_memory_ids_json)).toContain(link!.l2_memory_id);

    const policyRow = db.db.prepare(
      `SELECT properties_json
       FROM memories
       WHERE id = ?`
    ).get(link!.l2_memory_id) as { properties_json: string } | undefined;
    const policyProperties = JSON.parse(policyRow!.properties_json) as {
      internal_info?: {
        policy?: {
          decision_guidance?: {
            preference?: string[];
            anti_pattern?: string[];
          };
        };
      };
    };
    expect(policyProperties.internal_info?.policy?.decision_guidance?.preference?.join("\n"))
      .toContain("deterministic sqlite repair");
    expect(policyProperties.internal_info?.policy?.decision_guidance?.anti_pattern?.join("\n"))
      .toContain("repeating the failing query");
    const recallWithGuidance = await service.search({
      sessionId: session.sessionId,
      query: "deterministic sqlite repair failing query",
      layers: ["L2"],
      includeInjectedContext: true
    });
    expect(recallWithGuidance.injectedContext.markdown).toContain("Decision guidance");
    expect(recallWithGuidance.injectedContext.markdown).toContain("deterministic sqlite repair");
    expect(recallWithGuidance.injectedContext.markdown).toContain("repeating the failing query");

    const cooldownFeedback = await service.feedback({
      sessionId: session.sessionId,
      l1MemoryId: link!.l1_memory_id,
      channel: "explicit",
      polarity: "negative",
      magnitude: 1,
      rationale: "wrong, next time use deterministic sqlite repair instead of repeating the failing query",
      rawPayload: {
        contextHash: "ctx-feedback-repair"
      }
    });
    expect(cooldownFeedback.repair?.skipped).toBe(true);
    expect(cooldownFeedback.repair?.reason).toBe("cooldown");
    const repairCount = db.db.prepare(
      `SELECT COUNT(*) AS count
       FROM decision_repairs
       WHERE context_hash = ?`
    ).get("ctx-feedback-repair") as { count: number };
    expect(repairCount.count).toBe(1);
    db.close();
  });

  it("uses failure-like zero-value traces as low-value decision repair evidence", async () => {
    const { db, service } = createTestService();
    const session = service.openSession({
      namespace: {
        source: "codex",
        profileId: "jiang",
        userId: "user-repair-zero-failure"
      }
    });
    const failed = service.completeTurn("turn-repair-zero-failure", {
      sessionId: session.sessionId,
      query: "install package through unstable network timeout path",
      answer: "The command failed with timeout while retrying the same network path."
    });

    const feedback = await service.feedback({
      sessionId: session.sessionId,
      channel: "explicit",
      polarity: "neutral",
      magnitude: 1,
      rationale: "use stable network fallback instead of timeout path",
      rawPayload: {
        contextHash: "ctx-zero-failure-evidence"
      }
    });

    expect(feedback.repair?.repairId).toMatch(/^repair_/);
    const repairRow = db.db.prepare(
      `SELECT low_value_memory_ids_json
       FROM decision_repairs
       WHERE id = ?`
    ).get(feedback.repair!.repairId) as { low_value_memory_ids_json: string };
    expect(JSON.parse(repairRow.low_value_memory_ids_json)).toContain(failed.l1MemoryId);

    db.close();
  });

  it("relaxes same-session decision repair evidence when the feedback keyword misses", async () => {
    const { db, service } = createTestService();
    const session = service.openSession({
      namespace: {
        source: "codex",
        profileId: "jiang",
        userId: "user-repair-relaxed-session"
      }
    });
    const success = service.completeTurn("turn-repair-relaxed-success", {
      sessionId: session.sessionId,
      query: "recover the local sqlite migration",
      answer: "Read the migration output first, then apply the deterministic fallback path."
    });
    makeTraceEligibleForL2(db, success.l1MemoryId);
    const failure = service.completeTurn("turn-repair-relaxed-failure", {
      sessionId: session.sessionId,
      query: "recover the same local migration",
      answer: "The command failed with timeout while retrying the same path."
    });

    const feedback = await service.feedback({
      sessionId: session.sessionId,
      channel: "explicit",
      polarity: "negative",
      magnitude: 1,
      rationale: "wrong, next time use pip.install",
      rawPayload: {
        contextHash: "ctx-relaxed-session-evidence"
      }
    });

    const repairRow = db.db.prepare(
      `SELECT high_value_memory_ids_json, low_value_memory_ids_json
       FROM decision_repairs
       WHERE id = ?`
    ).get(feedback.repair!.repairId) as {
      high_value_memory_ids_json: string;
      low_value_memory_ids_json: string;
    };
    expect(JSON.parse(repairRow.high_value_memory_ids_json)).toContain(success.l1MemoryId);
    expect(JSON.parse(repairRow.low_value_memory_ids_json)).toContain(failure.l1MemoryId);

    db.close();
  });

  it("uses configured model decision repair synthesis for actionable feedback", async () => {
    const root = createTestRoot("mindock-memory-");
    const db = new MemoryDb({
      path: join(root, "memory.sqlite")
    });
    const calls: Array<{ messages: LlmMessage[]; options: LlmCompletionOptions }> = [];
    const service = createTestMemoryService({
      db,
      mode: "dev",
      skillLlm: createDecisionRepairLlm(calls),
      embedder: createCapturingEmbedder([])
    });
    const session = service.openSession({
      namespace: {
        source: "codex",
        profileId: "jiang",
        userId: "user-decision-repair-llm"
      }
    });
    const complete = service.completeTurn("turn-decision-repair-llm", {
      sessionId: session.sessionId,
      episodeId: "episode-decision-repair-llm",
      query: "Fix a sqlite migration failure",
      answer: "Retry the same failing query without reading the migration output."
    });

    const feedback = await service.feedback({
      sessionId: session.sessionId,
      l1MemoryId: complete.l1MemoryId,
      channel: "explicit",
      polarity: "negative",
      magnitude: 1,
      rationale: "wrong, next time inspect migration output before retrying the query",
      rawPayload: {
        contextHash: "ctx-decision-repair-llm"
      }
    });

    const repairCall = calls.find((call) => call.options.operation === "decision.repair.v1");
    expect(repairCall).toBeTruthy();
    expect(repairCall!.options).toMatchObject({
      operation: "decision.repair.v1",
      thinkingMode: "enabled",
      temperature: DEFAULT_MEMMY_CONFIG.evolution.temperature,
      maxTokens: 800
    });
    expect(repairCall!.messages[0]!.content).toContain("just-in-time guidance");
    expect(repairCall!.messages[0]!.content).toContain("retry loop");
    expect(repairCall!.messages[0]!.content).toContain("Never invent a tool name");
    expect(repairCall!.messages[0]!.content).toContain("USER_FEEDBACK may be provided");
    expect(repairCall!.messages[1]!.content).toContain("USER_FEEDBACK");
    expect(repairCall!.messages[1]!.content).toContain("inspect migration output");

    const repair = db.db.prepare(
      `SELECT preference, anti_pattern, source_json, meta_json
       FROM decision_repairs
       WHERE id = ?`
    ).get(feedback.repair!.repairId) as {
      preference: string;
      anti_pattern: string;
      source_json: string;
      meta_json: string;
    };
    expect(repair.preference).toContain("Inspect migration output before retrying");
    expect(repair.anti_pattern).toContain("blind query retries");
    expect(JSON.parse(repair.source_json)).toMatchObject({
      synthesis: "llm"
    });
    expect(JSON.parse(repair.meta_json)).toMatchObject({
      severity: "warn",
      confidence: 0.88
    });
    db.close();
  });

  it("preserves raw trace tails in decision repair model evidence", async () => {
    const root = createTestRoot("mindock-memory-");
    const db = new MemoryDb({
      path: join(root, "memory.sqlite")
    });
    const calls: Array<{ messages: LlmMessage[]; options: LlmCompletionOptions }> = [];
    const service = createTestMemoryService({
      db,
      mode: "dev",
      skillLlm: createDecisionRepairLlm(calls),
      embedder: createCapturingEmbedder([])
    });
    const session = service.openSession({
      namespace: {
        source: "codex",
        profileId: "jiang",
        userId: "user-decision-repair-tail"
      }
    });
    const tailMarker = "TAIL_TIMEOUT_MARKER";
    const longAssistantText = `${"blind retry without reading logs ".repeat(120)}final error ${tailMarker}`;
    const complete = service.completeTurn("turn-decision-repair-tail", {
      sessionId: session.sessionId,
      episodeId: "episode-decision-repair-tail",
      query: "Fix a long sqlite migration failure",
      answer: longAssistantText
    });

    await service.feedback({
      sessionId: session.sessionId,
      l1MemoryId: complete.l1MemoryId,
      channel: "explicit",
      polarity: "negative",
      magnitude: 1,
      rationale: "wrong, next time inspect the final error before retrying",
      rawPayload: {
        contextHash: "ctx-decision-repair-tail"
      }
    });

    const repairCall = calls.find((call) => call.options.operation === "decision.repair.v1");
    expect(repairCall).toBeTruthy();
    expect(repairCall!.messages[1]!.content).toContain(tailMarker);
    expect(repairCall!.messages[1]!.content).toContain("agent: ...");

    db.close();
  });

  it("classifies plugin-style correction and constraint feedback as decision repairs", async () => {
    const { db, service } = createTestService();
    const correction = await service.feedback({
      namespace: {
        source: "codex",
        profileId: "jiang",
        userId: "feedback-classifier-user"
      },
      channel: "explicit",
      polarity: "neutral",
      magnitude: 0,
      rationale: "not random retry, actually deterministic sqlite migration",
      rawPayload: {
        contextHash: "ctx-feedback-correction"
      }
    });
    expect(correction.repair?.repairId).toMatch(/^repair_/);
    const correctionRepair = db.db.prepare(
      `SELECT issue, preference, meta_json
       FROM decision_repairs
       WHERE id = ?`
    ).get(correction.repair!.repairId) as {
      issue: string;
      preference: string;
      meta_json: string;
    };
    expect(correctionRepair.issue).toContain("deterministic sqlite migration");
    expect(correctionRepair.preference).toContain("deterministic sqlite migration");
    expect(JSON.parse(correctionRepair.meta_json).confidence).toBe(0.75);

    const constraint = await service.feedback({
      namespace: {
        source: "codex",
        profileId: "jiang",
        userId: "feedback-classifier-user"
      },
      channel: "explicit",
      polarity: "neutral",
      magnitude: 0,
      rationale: "the migration has to keep raw turn payloads",
      rawPayload: {
        contextHash: "ctx-feedback-constraint"
      }
    });
    expect(constraint.repair?.repairId).toMatch(/^repair_/);
    const constraintRepair = db.db.prepare(
      `SELECT issue, preference
       FROM decision_repairs
       WHERE id = ?`
    ).get(constraint.repair!.repairId) as { issue: string; preference: string };
    expect(constraintRepair.issue).toContain("raw turn payloads");
    expect(constraintRepair.preference).toContain("raw turn payloads");
    db.close();
  });

  it("turns repeated observed tool failures into a cooldown-guarded decision repair", async () => {
    const { db, service } = createTestService();
    const session = service.openSession({
      namespace: {
        source: "codex",
        profileId: "jiang",
        userId: "user-tool-repair"
      },
      workspaceId: "workspace-tool-repair"
    });

    const first = await service.observeTool({
      sessionId: session.sessionId,
      episodeId: "episode-tool-repair",
      turnId: "tool-failure-1",
      toolName: "shell",
      error: "exit code 2: missing sqlite migration"
    });
    const second = await service.observeTool({
      sessionId: session.sessionId,
      episodeId: "episode-tool-repair",
      turnId: "tool-failure-2",
      toolName: "shell",
      error: "exit code 2: missing sqlite migration"
    });
    const third = await service.observeTool({
      sessionId: session.sessionId,
      episodeId: "episode-tool-repair",
      turnId: "tool-failure-3",
      toolName: "shell",
      error: "exit code 2: missing sqlite migration"
    });

    expect(first.repair).toBeUndefined();
    expect(second.repair).toBeUndefined();
    expect(third.repair?.skipped).toBe(false);
    expect(third.repair?.repairId).toMatch(/^repair_/);

    const repair = db.db.prepare(
      `SELECT context_hash, issue, preference, anti_pattern, source_json, meta_json
       FROM decision_repairs
       WHERE id = ?`
    ).get(third.repair!.repairId) as {
      context_hash: string;
      issue: string;
      preference: string;
      anti_pattern: string;
      source_json: string;
      meta_json: string;
    } | undefined;
    expect(repair?.issue).toContain("Repeated shell failure");
    expect(repair?.preference).toContain("switch strategy");
    expect(repair?.anti_pattern).toContain("missing sqlite migration");
    expect((JSON.parse(repair!.source_json) as { trigger?: string }).trigger).toBe("failure-burst");
    expect((JSON.parse(repair!.meta_json) as { severity?: string }).severity).toBe("warn");

    const change = db.db.prepare(
      `SELECT seq, kind, op
       FROM memory_change_log
       WHERE entity_id = ?`
    ).get(third.repair!.repairId) as { seq: number; kind: string; op: string } | undefined;
    expect(change).toMatchObject({
      kind: "repair",
      op: "created"
    });
    expect(third.changeSeq).toBe(change?.seq);

    const suggestion = await service.repairSuggestion({
      sessionId: session.sessionId,
      toolName: "shell",
      issue: "shell failed with missing sqlite migration"
    });
    expect(suggestion.suggestedAction).toBe("append_hint");
    expect(suggestion.reason).toBe("matched decision repair guidance");
    expect(suggestion.appendHint?.content).toContain("missing sqlite migration");

    const cooldown = await service.observeTool({
      sessionId: session.sessionId,
      episodeId: "episode-tool-repair",
      turnId: "tool-failure-4",
      toolName: "shell",
      error: "exit code 2: missing sqlite migration"
    });
    expect(cooldown.repair?.skipped).toBe(true);
    expect(cooldown.repair?.reason).toBe("cooldown");
    const repairCount = db.db.prepare(
      `SELECT COUNT(*) AS count
       FROM decision_repairs
       WHERE context_hash = ?`
    ).get(repair!.context_hash) as { count: number };
    expect(repairCount.count).toBe(1);
    db.close();
  });

  it("uses configured model decision repair synthesis for observed tool failure bursts", async () => {
    const root = createTestRoot("mindock-memory-");
    const db = new MemoryDb({
      path: join(root, "memory.sqlite")
    });
    const calls: Array<{ messages: LlmMessage[]; options: LlmCompletionOptions }> = [];
    const service = createTestMemoryService({
      db,
      mode: "dev",
      skillLlm: createDecisionRepairLlm(calls)
    });
    const session = service.openSession({
      namespace: {
        source: "codex",
        profileId: "jiang",
        userId: "user-tool-repair-llm"
      }
    });

    await service.observeTool({
      sessionId: session.sessionId,
      episodeId: "episode-tool-repair-llm",
      turnId: "tool-llm-1",
      toolName: "shell",
      error: "missing sqlite migration"
    });
    await service.observeTool({
      sessionId: session.sessionId,
      episodeId: "episode-tool-repair-llm",
      turnId: "tool-llm-2",
      toolName: "shell",
      error: "missing sqlite migration"
    });
    const third = await service.observeTool({
      sessionId: session.sessionId,
      episodeId: "episode-tool-repair-llm",
      turnId: "tool-llm-3",
      toolName: "shell",
      error: "missing sqlite migration"
    });

    const repairCall = calls.find((call) => call.options.operation === "decision.repair.v1");
    expect(repairCall).toBeTruthy();
    expect(repairCall!.options).toMatchObject({
      operation: "decision.repair.v1",
      thinkingMode: "enabled",
      temperature: DEFAULT_MEMMY_CONFIG.evolution.temperature,
      maxTokens: 800
    });
    expect(repairCall!.messages[1]!.content).toContain("failure-burst");
    expect(repairCall!.messages[1]!.content).toContain("missing sqlite migration");

    const repair = db.db.prepare(
      `SELECT preference, anti_pattern, source_json, meta_json
       FROM decision_repairs
       WHERE id = ?`
    ).get(third.repair!.repairId) as {
      preference: string;
      anti_pattern: string;
      source_json: string;
      meta_json: string;
    };
    expect(repair.preference).toContain("Inspect migration output before retrying");
    expect(repair.anti_pattern).toContain("blind query retries");
    expect(JSON.parse(repair.source_json)).toMatchObject({
      synthesis: "llm",
      trigger: "failure-burst"
    });
    expect(JSON.parse(repair.meta_json)).toMatchObject({
      severity: "warn",
      confidence: 0.88
    });
    db.close();
  });

  it("creates decision repairs when same-context reward values diverge", async () => {
    const calls: Array<{ messages: LlmMessage[]; options: LlmCompletionOptions }> = [];
    const { db, service } = createTestService({
      skillLlm: createDecisionRepairLlm(calls)
    });
    const session = service.openSession({
      namespace: {
        source: "codex",
        profileId: "jiang",
        userId: "user-value-distribution-repair"
      }
    });
    const positive = service.completeTurn("turn-value-distribution-positive", {
      sessionId: session.sessionId,
      episodeId: "episode-value-distribution-positive",
      query: "sqlite database sql migration workflow should inspect schema first",
      answer: "Inspect schema output before retrying the sqlite SQL migration."
    });
    await service.feedback({
      sessionId: session.sessionId,
      episodeId: positive.episodeId,
      l1MemoryId: positive.l1MemoryId,
      channel: "explicit",
      polarity: "positive",
      magnitude: 1,
      rationale: "this sqlite migration workflow succeeded"
    });
    await service.runWorkerOnce(100);

    const negative = service.completeTurn("turn-value-distribution-negative", {
      sessionId: session.sessionId,
      episodeId: "episode-value-distribution-negative",
      query: "sqlite database sql migration workflow should inspect schema first",
      answer: "Repeated the same SQL query without reading the migration output."
    });
    await service.feedback({
      sessionId: session.sessionId,
      episodeId: negative.episodeId,
      l1MemoryId: negative.l1MemoryId,
      channel: "explicit",
      polarity: "negative",
      magnitude: 1,
      rationale: "wrong, do not repeat the SQL query before inspecting the migration output"
    });
    await service.runWorkerOnce(100);

    const repair = db.db.prepare(
      `SELECT id, context_hash, high_value_memory_ids_json, low_value_memory_ids_json, source_json
       FROM decision_repairs
       WHERE source_json LIKE '%value-distribution%'
       LIMIT 1`
    ).get() as {
      id: string;
      context_hash: string;
      high_value_memory_ids_json: string;
      low_value_memory_ids_json: string;
      source_json: string;
    } | undefined;
    expect(repair).toBeTruthy();
    expect(JSON.parse(repair!.high_value_memory_ids_json)).toContain(positive.l1MemoryId);
    expect(JSON.parse(repair!.low_value_memory_ids_json)).toContain(negative.l1MemoryId);
    expect(JSON.parse(repair!.source_json)).toMatchObject({
      trigger: "value-distribution",
      synthesis: "llm"
    });
    const repairCall = calls.find((call) =>
      call.options.operation === "decision.repair.v1"
      && call.messages[1]?.content.includes("TRIGGER: value-distribution")
    );
    expect(repairCall).toBeTruthy();
    expect(repairCall!.options).toMatchObject({
      operation: "decision.repair.v1",
      thinkingMode: "enabled",
      temperature: DEFAULT_MEMMY_CONFIG.evolution.temperature,
      maxTokens: 800
    });
    expect(repairCall!.messages[1]!.content).toContain("TRIGGER: value-distribution");

    const episode = db.db.prepare(
      `SELECT decision_repair_ids_json
       FROM episodes
       WHERE id = ?`
    ).get(negative.episodeId) as { decision_repair_ids_json: string };
    expect(JSON.parse(episode.decision_repair_ids_json)).toContain(repair!.id);
    const change = db.db.prepare(
      `SELECT kind, op
       FROM memory_change_log
       WHERE entity_id = ?`
    ).get(repair!.id) as { kind: string; op: string };
    expect(change).toMatchObject({
      kind: "repair",
      op: "created"
    });
    db.close();
  });

  it("uses decision_repair retrieval for repair suggestions without creating repairs", async () => {
    const { db, service } = createTestService({
      config: DEFAULT_MEMMY_CONFIG,
      embedder: createCapturingEmbedder([])
    });
    const session = service.openSession({
      namespace: {
        source: "codex",
        profileId: "jiang",
        userId: "user-repair-retrieval"
      },
      workspaceId: "workspace-repair-retrieval"
    });
    const complete = service.completeTurn("turn-repair-retrieval", {
      sessionId: session.sessionId,
      query: "sqlite migration command failed",
      answer: "Need a repair hint for missing sqlite migration.",
      toolCalls: [{
        name: "shell",
        input: "npm run migrate",
        output: "error: missing sqlite migration 003",
        success: false
      }]
    });
    makeTraceEligibleForL2(db, complete.l1MemoryId);

    const suggestion = await service.repairSuggestion({
      sessionId: session.sessionId,
      issue: "shell failed with missing sqlite migration 003",
      toolName: "shell"
    });

    expect(suggestion.suggestedAction).toBe("append_hint");
    expect(suggestion.reason).toBe("matched decision repair retrieval");
    expect(suggestion.sourceMemoryIds).toContain(complete.l1MemoryId);
    expect(suggestion.appendHint?.content).toContain("missing sqlite migration");
    const repairCount = db.db.prepare(
      `SELECT COUNT(*) AS count FROM decision_repairs`
    ).get() as { count: number };
    expect(repairCount.count).toBe(0);
    db.close();
  });

  it("uses plugin-style failure metadata for repair suggestion retrieval", async () => {
    const { db, service } = createTestService({ config: DEFAULT_MEMMY_CONFIG });
    const session = service.openSession({
      namespace: {
        source: "codex",
        profileId: "jiang",
        userId: "user-repair-plugin-query"
      }
    });
    const complete = service.completeTurn("turn-repair-plugin-query", {
      sessionId: session.sessionId,
      query: "dependency install failed during setup",
      answer: "The installer could not reach the package index.",
      toolCalls: [{
        name: "pip.install",
        input: { package: "uvloop" },
        output: "NETWORK_REFUSED",
        errorCode: "NETWORK_REFUSED",
        success: false
      }]
    });
    await service.runWorkerOnce(20);

    const suggestion = await service.repairSuggestion({
      sessionId: session.sessionId,
      issue: "need an unblock hint",
      toolName: "pip.install",
      error: "NETWORK_REFUSED",
      context: "dependency install failed during setup"
    });

    expect(suggestion.suggestedAction).toBe("append_hint");
    expect(suggestion.reason).toBe("matched decision repair retrieval");
    expect(suggestion.sourceMemoryIds).toContain(complete.l1MemoryId);
    expect(suggestion.appendHint?.content).toContain("Relevant trace");
    const repairCount = db.db.prepare(
      `SELECT COUNT(*) AS count FROM decision_repairs`
    ).get() as { count: number };
    expect(repairCount.count).toBe(0);
    db.close();
  });
});
