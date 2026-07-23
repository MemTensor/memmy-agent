import { afterEach, describe, expect, it } from "vitest";
import {
  insertActivePolicyMemory,
  insertActiveSkillMemoryForTest,
  insertWorldModelMemoryForTest,
  upsertMemoryVectorForTest
} from "../../fixtures/evolution-fixture.js";
import {
  configWithMemoryGates,
  createMemoryServiceFixture,
  runWorkerRounds
} from "../../fixtures/memory-service-fixture.js";

const {
  cleanup,
  createTestMemoryService,
  createTestService
} = createMemoryServiceFixture();

afterEach(cleanup);

describe("MemoryService / retrieval / injected context", () => {
  it("injects repository repair protocol on turn start even without memory hits", async () => {
    const { db } = createTestService();
    const service = createTestMemoryService({
      db,
      mode: "dev",
      config: configWithMemoryGates({
        enableMemoryAdd: false,
        enableMemorySearch: true
      })
    });
    const namespace = {
      source: "codex",
      profileId: "jiang",
      userId: "user-repair-protocol-no-hits"
    };
    const prompt = [
      "COMMAND_WRAPPER run \"cd /tmp/repo && ...\"",
      "You need to fix a bug in the example repository.",
      "",
      "## Issue Description",
      "SQLite PRAGMA introspection fails for a table named select because the reserved keyword identifier is not quoted.",
      "",
      "## Hints",
      "Inspect backend metadata SQL and patch the source."
    ].join("\n");

    const start = await service.startTurn({
      namespace,
      sessionId: "repair-protocol-session",
      turnId: "repair-protocol-turn",
      query: prompt
    });

    expect(start.hits).toEqual([]);
    expect(start.sourceMemoryIds).toEqual([]);
    expect(start.injectedContext.markdown).toContain("# Current task protocol and recalled memories");
    expect(start.injectedContext.markdown).toContain("Repository repair task protocol");
    expect(start.injectedContext.markdown).toContain("backend identifier quoting boundary");
    expect(start.status).toContain("memory_add:disabled:no_turn_write");
    db.close();
  });

  it("keeps repository repair protocol when memory search is disabled", async () => {
    const { db } = createTestService();
    const service = createTestMemoryService({
      db,
      mode: "dev",
      config: configWithMemoryGates({
        enableMemoryAdd: false,
        enableMemorySearch: false
      })
    });
    const namespace = {
      source: "codex",
      profileId: "jiang",
      userId: "user-repair-protocol-search-disabled"
    };
    const prompt = [
      "COMMAND_WRAPPER run \"cd /tmp/repo && ...\"",
      "You need to fix a bug in the example repository.",
      "",
      "## Issue Description",
      "A lookup filter subquery returns too many columns because annotations leak into the select list projection.",
      "",
      "## Hints",
      "Inspect the relationship lookup and projection reset."
    ].join("\n");

    const start = await service.startTurn({
      namespace,
      sessionId: "repair-protocol-search-disabled-session",
      turnId: "repair-protocol-search-disabled-turn",
      query: prompt
    });

    expect(start.hits).toEqual([]);
    expect(start.sourceMemoryIds).toEqual([]);
    expect(start.injectedContext.markdown).toContain("Repository repair task protocol");
    expect(start.injectedContext.markdown).toContain("single-column subquery projection");
    expect(start.status).toContain("memory_search:disabled");
    db.close();
  });

  it("renders injected recall packets with plugin-style sections and tool hints", async () => {
    const { db, service } = createTestService();
    const namespace = {
      source: "codex",
      profileId: "jiang",
      userId: "user-injected-packet"
    };
    const session = service.openSession({ namespace });
    service.completeTurn("turn-injected-packet", {
      sessionId: session.sessionId,
      query: "Use the sqlite migration checklist and preserve local memory service state.",
      answer: "Applied the sqlite migration checklist and verified the local memory service state."
    });
    await service.runWorkerOnce(20);
    insertActiveSkillMemoryForTest(db, {
      id: "skill_injected_packet",
      userId: namespace.userId,
      sessionId: session.sessionId,
      agentId: namespace.source,
      appId: "memmy-test",
      profileId: namespace.profileId
    });
    insertWorldModelMemoryForTest(db, {
      id: "world_injected_packet",
      userId: namespace.userId,
      sessionId: session.sessionId,
      agentId: namespace.source,
      appId: "memmy-test",
      profileId: namespace.profileId,
      memoryKey: "world:sqlite_migration",
      domainKey: "sqlite|migration",
      domainTags: ["sqlite", "migration"],
      policyIds: []
    });

    const recall = await service.search({
      sessionId: session.sessionId,
      query: "sqlite migration checklist world model neutral reward skill",
      layers: ["Skill", "L1", "L3"],
      limit: 8,
      includeInjectedContext: true
    });

    expect(recall.hits.some((hit) => hit.memoryLayer === "Skill")).toBe(true);
    expect(recall.hits.some((hit) => hit.memoryLayer === "L1")).toBe(true);
    expect(recall.hits.some((hit) => hit.memoryLayer === "L3")).toBe(true);
    expect(recall.injectedContext.markdown).not.toContain("# Memory context");
    expect(recall.injectedContext.markdown).toContain("## Skill Memories");
    expect(recall.injectedContext.markdown).toContain("id: skill_injected_packet");
    expect(recall.injectedContext.markdown).toContain("## L1 Trace Memories");
    expect(recall.injectedContext.markdown).toContain("Historical user statement:\n   Use the sqlite migration checklist");
    expect(recall.injectedContext.markdown).toContain("Historical assistant response:\n   Applied the sqlite migration checklist");
    expect(recall.injectedContext.markdown).toContain("## L3 Environment Knowledge");
    expect(recall.injectedContext.markdown).not.toContain("kind=\"world_model\"");
    expect(recall.injectedContext.markdown).not.toContain("memmy_memory_get(id=\"skill_injected_packet\")");
    expect(recall.injectedContext.markdown).not.toContain("[user]");
    expect(recall.injectedContext.markdown).not.toContain("[assistant]");
    expect(recall.injectedContext.markdown).toContain("## Follow-up memory tools");
    expect(recall.injectedContext.markdown).toContain("memmy_memory_get(id)");
    expect(recall.injectedContext.markdown).toContain("memmy_memory_search(query)");
    expect(recall.injectedContext.markdown.indexOf("## L1 Trace Memories")).toBeLessThan(
      recall.injectedContext.markdown.indexOf("## L3 Environment Knowledge")
    );
    expect(recall.injectedContext.markdown.indexOf("## L3 Environment Knowledge")).toBeLessThan(
      recall.injectedContext.markdown.indexOf("## Skill Memories")
    );

    const latestSearchLog = service.apiLogs({ tools: ["memory_search"], limit: 1 }).logs[0];
    const logInput = JSON.parse(latestSearchLog!.inputJson) as { sessionId?: string; sourceAgent?: string };
    const output = JSON.parse(latestSearchLog!.outputJson) as {
      candidates: Array<{ refId?: string; content?: string }>;
    };
    expect(logInput.sessionId).toBe(session.sessionId);
    expect(logInput.sourceAgent).toBeUndefined();
    expect(latestSearchLog?.sourceAgent).toBe("codex");
    const traceCandidate = output.candidates.find((candidate) =>
      candidate.content?.includes("Use the sqlite migration checklist")
    );
    expect(traceCandidate?.content).toContain("Historical user statement:");
    expect(traceCandidate?.content).toContain("Historical assistant response:");
    expect(traceCandidate?.content).not.toContain("[assistant]");
    db.close();
  });

  it("renders similar past tasks with the unified episode get hint", async () => {
    const { db, service } = createTestService();
    const namespace = {
      source: "codex",
      profileId: "jiang",
      userId: "user-episode-get-hint"
    };
    const session = service.openSession({ namespace });
    const first = service.completeTurn("turn-episode-get-hint-a", {
      sessionId: session.sessionId,
      query: "sqlite migration pytest failed because migration table was missing",
      answer: "inspected the migration output and fixed the sqlite migration path"
    });
    service.completeTurn("turn-episode-get-hint-b", {
      sessionId: session.sessionId,
      episodeId: first.episodeId,
      query: "rerun the focused sqlite migration pytest after the fix",
      answer: "reran the focused pytest and verified the migration state"
    });
    await service.runWorkerOnce(20);

    const recall = await service.search({
      sessionId: session.sessionId,
      query: "sqlite migration pytest failed need rerun fix",
      layers: ["L1"],
      limit: 8,
      includeInjectedContext: true
    });

    expect(recall.hits).toEqual(expect.arrayContaining([
      expect.objectContaining({
        id: first.episodeId,
        source: "episode",
        memoryLayer: "L1"
      })
    ]));
    expect(recall.injectedContext.markdown).not.toContain("## L1 Trace Memories");
    expect(recall.injectedContext.markdown).toContain("## Similar Past Episodes");
    expect(recall.injectedContext.markdown).toContain(`id: ${first.episodeId}`);
    expect(recall.injectedContext.markdown).toContain("step 1");
    expect(recall.injectedContext.markdown).not.toContain(`memmy_memory_get(id="${first.l1MemoryId}")`);
    expect(recall.injectedContext.markdown).not.toContain("trace_id:");
    expect(recall.injectedContext.markdown).toContain("If details are needed, use `memmy_memory_get(id)`");
    db.close();
  });

  it("suppresses isolated skill injection for standalone math final-answer tasks", async () => {
    const { db, service } = createTestService();
    const namespace = {
      source: "codex",
      profileId: "jiang",
      userId: "user-standalone-math-skill"
    };
    const session = service.openSession({ namespace });
    insertActiveSkillMemoryForTest(db, {
      id: "skill_isolated_math",
      userId: namespace.userId,
      sessionId: session.sessionId,
      agentId: namespace.source,
      profileId: namespace.profileId,
      tags: ["skill", "math", "algebra"],
      name: "algebra olympiad method",
      invocationGuide: "Use this algebra method to compute a final boxed answer for prior olympiad tasks."
    });

    const recall = await service.search({
      sessionId: session.sessionId,
      query: "Solve the following math competition problem. Find the algebra value and give the final answer in \\boxed{...}.",
      layers: ["Skill"],
      limit: 4,
      includeInjectedContext: true
    });

    expect(recall.hits.some((hit) => hit.memoryLayer === "Skill")).toBe(true);
    expect(recall.injectedContext.markdown).toContain("Standalone math task guardrails");
    expect(recall.injectedContext.markdown).not.toContain("Candidate method memories");
    expect(recall.injectedContext.markdown).not.toContain("skill_isolated_math");
    db.close();
  });

  it("renders multiple standalone math skills as advisory methods without get-call hints", async () => {
    const { db, service } = createTestService();
    const namespace = {
      source: "codex",
      profileId: "jiang",
      userId: "user-standalone-math-methods"
    };
    const session = service.openSession({ namespace });
    insertActiveSkillMemoryForTest(db, {
      id: "skill_math_method_a",
      userId: namespace.userId,
      sessionId: session.sessionId,
      agentId: namespace.source,
      profileId: namespace.profileId,
      tags: ["skill", "math", "algebra"],
      name: "algebra invariant method",
      invocationGuide: "Use algebra invariants as a candidate method for competition problems."
    });
    insertActiveSkillMemoryForTest(db, {
      id: "skill_math_method_b",
      userId: namespace.userId,
      sessionId: session.sessionId,
      agentId: namespace.source,
      profileId: namespace.profileId,
      tags: ["skill", "math", "number_theory"],
      name: "modular arithmetic method",
      invocationGuide: "Use modular arithmetic as a candidate method for olympiad final-answer problems."
    });

    const recall = await service.search({
      sessionId: session.sessionId,
      query: "Solve this math olympiad algebra problem and give the final answer in \\boxed{...}.",
      layers: ["Skill"],
      limit: 4,
      includeInjectedContext: true
    });

    expect(recall.injectedContext.markdown).toContain("## Candidate method memories");
    expect(recall.injectedContext.markdown).not.toContain("algebra invariant method");
    expect(recall.injectedContext.markdown).toContain("modular arithmetic method");
    expect(recall.injectedContext.markdown).not.toContain("memmy_memory_get(id=\"skill_math_method_");
    db.close();
  });

  it("records turn.start search correlation and token-budget drops", async () => {
    const { db, service } = createTestService();
    const seedSession = service.openSession({
      namespace: {
        source: "codex",
        profileId: "jiang",
        userId: "user-prepare-recall-budget",
        sessionKey: "seed-recall-budget"
      }
    });
    for (const suffix of ["alpha", "beta", "gamma"]) {
      service.completeTurn(`turn-budget-seed-${suffix}`, {
        sessionId: seedSession.sessionId,
        episodeId: `episode-budget-seed-${suffix}`,
        query: `sqlite budget migration ${suffix}`,
        answer: `Remember sqlite budget migration ${suffix} with a deliberately long explanation ${"detail ".repeat(80)}`
      });
    }
    await runWorkerRounds(service, 2, 50);
    const activeSession = service.openSession({
      namespace: {
        source: "codex",
        profileId: "jiang",
        userId: "user-prepare-recall-budget",
        sessionKey: "active-recall-budget"
      }
    });

    const prepared = await service.startTurn({ turnId: "turn-budget-prepare",
      sessionId: activeSession.sessionId,
      query: "fix sqlite budget migration",
      contextBudget: 5
    });

    expect(prepared.hits.length).toBeGreaterThan(1);
    expect(prepared.sourceMemoryIds.length).toBeGreaterThanOrEqual(prepared.hits.length);
    expect(prepared.droppedDueToBudget).toEqual([]);

    const recallRow = db.db.prepare(
      `SELECT turn_id, episode_id, injected_memory_ids_json, dropped_json
       FROM recall_events
       WHERE id = ?`
    ).get(prepared.searchEventId) as {
      turn_id: string | null;
      episode_id: string | null;
      injected_memory_ids_json: string;
      dropped_json: string;
    };
    expect(recallRow.turn_id).toBe("turn-budget-prepare");
    expect(recallRow.episode_id).toBe(prepared.episodeId);
    expect(JSON.parse(recallRow.injected_memory_ids_json)).toEqual(prepared.sourceMemoryIds);
    expect(JSON.parse(recallRow.dropped_json)).not.toEqual(expect.arrayContaining([
      expect.objectContaining({ reason: "token_budget" })
    ]));

    await service.feedback({
      sessionId: activeSession.sessionId,
      recallEventId: prepared.searchEventId,
      channel: "explicit",
      polarity: "positive",
      magnitude: 1,
      rationale: "all returned memories were visible to the agent"
    });
    const injectedStatsRow = db.db.prepare(
      `SELECT properties_json
       FROM memories
       WHERE id = ?`
    ).get(prepared.sourceMemoryIds[0]) as { properties_json: string };
    const injectedStats = JSON.parse(injectedStatsRow.properties_json) as {
      internal_info?: { recall?: { positive?: number } };
    };
    expect(injectedStats.internal_info?.recall?.positive).toBe(1);

    db.close();
  });

  it("includes decision guidance sources in injected recall source ids", async () => {
    const { db, service } = createTestService();
    const namespace = {
      source: "codex",
      profileId: "jiang",
      userId: "user-guidance-source"
    };
    const session = service.openSession({ namespace });
    const complete = service.completeTurn("turn-guidance-source", {
      sessionId: session.sessionId,
      query: "visible alpha trace source",
      answer: "visible alpha trace result"
    });
    await service.runWorkerOnce(20);
    const at = new Date().toISOString();
    const policyId = "policy_guidance_source";
    db.db.prepare(
      `INSERT INTO memories (
        id, timeline, user_id, conversation_id, session_id, agent_id, app_id,
        memory_type, status, visibility, memory_key, memory_value,
        tags_json, info_json, properties_json, memory_layer, content_hash,
        version, created_at, updated_at, deleted_at
      ) VALUES (
        @id, @timeline, @userId, @conversationId, @sessionId, @agentId, @appId,
        @memoryType, @status, @visibility, @memoryKey, @memoryValue,
        @tagsJson, @infoJson, @propertiesJson, @memoryLayer, @contentHash,
        1, @createdAt, @updatedAt, NULL
      )`
    ).run({
      id: policyId,
      timeline: at,
      userId: namespace.userId,
      conversationId: null,
      sessionId: session.sessionId,
      agentId: namespace.source,
      appId: null,
      memoryType: "LongTermMemory",
      status: "activated",
      visibility: "private",
      memoryKey: "policy:orthogonal",
      memoryValue: "Orthogonal banana cleanup policy.",
      tagsJson: JSON.stringify(["policy"]),
      infoJson: JSON.stringify({ profile_id: namespace.profileId }),
      propertiesJson: JSON.stringify({
        memory_type: "LongTermMemory",
        status: "activated",
        tags: ["policy"],
        info: { profile_id: namespace.profileId },
        internal_info: {
          memory_layer: "L2",
          memory_kind: "policy",
          schema_version: 1,
          policy: {
            title: "Orthogonal banana cleanup",
            trigger: "banana cleanup",
            procedure: "Keep this policy out of direct lexical recall.",
            verification: "Only inject as decision guidance when linked trace is visible.",
            boundary: "source id attribution",
            support: 1,
            gain: 0.1,
            policy_confidence: 0.8,
            status: "active",
            source_trace_ids: [complete.l1MemoryId],
            source_episode_ids: [complete.episodeId],
            decision_guidance: {
              preference: ["prefer linked policy guidance when the visible trace is recalled"],
              anti_pattern: ["avoid dropping guidance source ids from injected recall packets"]
            }
          }
        }
      }),
      memoryLayer: "L2",
      contentHash: "policy-guidance-source",
      createdAt: at,
      updatedAt: at
    });
    upsertMemoryVectorForTest(db, policyId, "vec", [1, 0, 0]);

    const recall = await service.search({
      sessionId: session.sessionId,
      query: "visible alpha trace source",
      layers: ["L1", "L2"],
      includeInjectedContext: true
    });
    const guidance = recall.injectedContext.sections.find((section) => section.id === "decision-guidance");
    expect(guidance?.memoryIds).toContain(policyId);
    expect(recall.sourceMemoryIds).toEqual(expect.arrayContaining(guidance!.memoryIds));
    const recallRow = db.db.prepare(
      `SELECT injected_memory_ids_json
       FROM recall_events
       WHERE id = ?`
    ).get(recall.searchEventId) as { injected_memory_ids_json: string };
    expect(JSON.parse(recallRow.injected_memory_ids_json)).toEqual(expect.arrayContaining([policyId]));

    db.close();
  });

  it("orders and caps decision guidance like the plugin collector", async () => {
    const { db, service } = createTestService();
    const namespace = {
      source: "codex",
      profileId: "jiang",
      userId: "user-guidance-ranking"
    };
    const session = service.openSession({ namespace });
    const complete = service.completeTurn("turn-guidance-ranking", {
      sessionId: session.sessionId,
      query: "visible guidance ranking trace",
      answer: "visible guidance ranking result"
    });

    const base = {
      userId: namespace.userId,
      sessionId: session.sessionId,
      agentId: namespace.source,
      appId: "memmy-test",
      profileId: namespace.profileId,
      sourceTraceId: complete.l1MemoryId,
      sourceEpisodeId: complete.episodeId
    };
    insertActivePolicyMemory(db, {
      ...base,
      id: "policy_guidance_a",
      decisionGuidance: {
        preference: ["shared guidance", "zeta single"],
        anti_pattern: ["shared avoid"]
      }
    });
    insertActivePolicyMemory(db, {
      ...base,
      id: "policy_guidance_b",
      decisionGuidance: {
        preference: ["shared guidance", "alpha single"],
        anti_pattern: ["shared avoid", "beta avoid"]
      }
    });
    insertActivePolicyMemory(db, {
      ...base,
      id: "policy_guidance_c",
      decisionGuidance: {
        preference: ["shared guidance", "beta single"],
        anti_pattern: ["gamma avoid"]
      }
    });
    insertActivePolicyMemory(db, {
      ...base,
      id: "policy_guidance_d",
      decisionGuidance: {
        preference: ["delta single"],
        anti_pattern: ["alpha avoid"]
      }
    });

    const recall = await service.search({
      sessionId: session.sessionId,
      query: "visible guidance ranking trace",
      layers: ["L1", "L2"],
      includeInjectedContext: true
    });

    const guidance = recall.injectedContext.sections.find((section) => section.id === "decision-guidance");
    const lines = guidance?.content.split("\n") ?? [];
    expect(lines).toContain("## Decision guidance (distilled from past similar situations)");
    const preferIndex = lines.indexOf("**Prefer**");
    const avoidIndex = lines.indexOf("**Avoid**");
    expect(lines.slice(preferIndex + 1, avoidIndex).filter((line) => line.trim().match(/^\d+\./))).toEqual([
      "  1. shared guidance",
      "  2. alpha single",
      "  3. beta single"
    ]);
    expect(lines.slice(avoidIndex + 1).filter((line) => line.trim().match(/^\d+\./))).toEqual([
      "  1. shared avoid",
      "  2. alpha avoid",
      "  3. beta avoid"
    ]);
    expect(guidance?.memoryIds).toEqual(expect.arrayContaining([
      "policy_guidance_a",
      "policy_guidance_b",
      "policy_guidance_c",
      "policy_guidance_d"
    ]));

    db.close();
  });

  it("falls back to source policy decision guidance for legacy skill recall", async () => {
    const { db, service } = createTestService();
    const namespace = {
      source: "codex",
      profileId: "jiang",
      userId: "user-legacy-skill-guidance"
    };
    const session = service.openSession({ namespace });
    const at = new Date().toISOString();
    const policyId = "policy_legacy_skill_guidance";
    const skillId = "skill_legacy_guidance";

    db.db.prepare(
      `INSERT INTO memories (
        id, timeline, user_id, conversation_id, session_id, agent_id, app_id,
        memory_type, status, visibility, memory_key, memory_value,
        tags_json, info_json, properties_json, memory_layer, content_hash,
        version, created_at, updated_at, deleted_at
      ) VALUES (
        @id, @timeline, @userId, NULL, @sessionId, @agentId, NULL,
        'LongTermMemory', 'activated', 'private', @memoryKey, @memoryValue,
        @tagsJson, @infoJson, @propertiesJson, 'L2', @contentHash,
        1, @createdAt, @updatedAt, NULL
      )`
    ).run({
      id: policyId,
      timeline: at,
      userId: namespace.userId,
      sessionId: session.sessionId,
      agentId: namespace.source,
      memoryKey: "policy:legacy_skill_source",
      memoryValue: "Orthogonal source policy text that should not directly match the recall query.",
      tagsJson: JSON.stringify(["policy"]),
      infoJson: JSON.stringify({ profile_id: namespace.profileId }),
      propertiesJson: JSON.stringify({
        memory_type: "LongTermMemory",
        status: "activated",
        tags: ["policy"],
        info: { profile_id: namespace.profileId },
        internal_info: {
          memory_layer: "L2",
          memory_kind: "policy",
          schema_version: 1,
          policy: {
            title: "Legacy skill source policy",
            trigger: "orthogonal source trigger",
            procedure: "Use only as source guidance for a legacy skill.",
            verification: "The guidance source is included in recall source ids.",
            boundary: "legacy skill fallback",
            support: 1,
            gain: 0.3,
            policy_confidence: 0.8,
            status: "active",
            source_trace_ids: [],
            source_episode_ids: [],
            decision_guidance: {
              preference: ["prefer source policy guidance for legacy skills"],
              anti_pattern: ["avoid dropping legacy skill source guidance"]
            }
          }
        }
      }),
      contentHash: "policy-legacy-skill-guidance",
      createdAt: at,
      updatedAt: at
    });
    upsertMemoryVectorForTest(db, policyId, "vec", [0, 1, 0]);

    db.db.prepare(
      `INSERT INTO memories (
        id, timeline, user_id, conversation_id, session_id, agent_id, app_id,
        memory_type, status, visibility, memory_key, memory_value,
        tags_json, info_json, properties_json, memory_layer, content_hash,
        version, created_at, updated_at, deleted_at
      ) VALUES (
        @id, @timeline, @userId, NULL, @sessionId, @agentId, NULL,
        'SkillMemory', 'activated', 'private', @memoryKey, @memoryValue,
        @tagsJson, @infoJson, @propertiesJson, 'Skill', @contentHash,
        1, @createdAt, @updatedAt, NULL
      )`
    ).run({
      id: skillId,
      timeline: at,
      userId: namespace.userId,
      sessionId: session.sessionId,
      agentId: namespace.source,
      memoryKey: "skill:legacy_widget_fallback",
      memoryValue: "Legacy widget fallback skill guide",
      tagsJson: JSON.stringify(["skill", "widget"]),
      infoJson: JSON.stringify({
        profile_id: namespace.profileId,
        source_memory_ids: [policyId]
      }),
      propertiesJson: JSON.stringify({
        memory_type: "SkillMemory",
        status: "activated",
        tags: ["skill", "widget"],
        info: {
          profile_id: namespace.profileId,
          source_memory_ids: [policyId]
        },
        internal_info: {
          memory_layer: "Skill",
          memory_kind: "skill",
          schema_version: 1,
          source_memory_ids: [policyId],
          source_policy_ids: [policyId],
          name: "legacy_widget_fallback",
          invocation_guide: "Legacy widget fallback skill guide",
          procedure_json: { summary: "Legacy skill has no embedded decision guidance." },
          eta: 0.8,
          support: 1,
          gain: 0.3,
          skill: {
            name: "legacy_widget_fallback",
            eta: 0.8,
            status: "active",
            support: 1,
            gain: 0.3,
            source_policy_ids: [policyId],
            source_world_model_ids: [],
            evidence_anchor_ids: [],
            invocation_guide: "Legacy widget fallback skill guide",
            procedure_json: { summary: "Legacy skill has no embedded decision guidance." },
            trials_attempted: 1,
            trials_passed: 1,
            success_rate: 1,
            beta_posterior: { alpha: 2, beta: 1, mean: 2 / 3 }
          }
        }
      }),
      contentHash: "skill-legacy-guidance",
      createdAt: at,
      updatedAt: at
    });
    upsertMemoryVectorForTest(db, skillId, "vec", [1, 0, 0]);

    const recall = await service.search({
      sessionId: session.sessionId,
      query: "legacy widget fallback skill guide",
      layers: ["Skill", "L2"],
      includeInjectedContext: true
    });

    expect(recall.hits.map((hit) => hit.id)).toContain(skillId);
    const guidance = recall.injectedContext.sections.find((section) => section.id === "decision-guidance");
    expect(guidance?.content).toContain("prefer source policy guidance for legacy skills");
    expect(guidance?.memoryIds).toContain(policyId);
    expect(recall.sourceMemoryIds).toEqual(expect.arrayContaining([skillId, policyId]));
    const recallRow = db.db.prepare(
      `SELECT injected_memory_ids_json
       FROM recall_events
       WHERE id = ?`
    ).get(recall.searchEventId) as { injected_memory_ids_json: string };
    expect(JSON.parse(recallRow.injected_memory_ids_json)).toEqual(expect.arrayContaining([policyId]));

    db.close();
  });

  it("applies plugin intent retrieval gates on the first turn of an episode", async () => {
    const { db, service } = createTestService();
    const session = service.openSession({
      namespace: {
        source: "codex",
        profileId: "jiang",
        userId: "user-intent-gate"
      }
    });

    const chitchat = await service.startTurn({ turnId: "turn-intent-chitchat",
      sessionId: session.sessionId,
      query: "谢谢"
    });
    expect(chitchat.sourceMemoryIds).toEqual([]);
    expect(chitchat.status).toContain("intent:chitchat:retrieval_skipped");

    let recallRow = db.db.prepare(
      `SELECT layers_json, candidate_memory_ids_json
       FROM recall_events
       WHERE id = ?`
    ).get(chitchat.searchEventId) as { layers_json: string; candidate_memory_ids_json: string };
    expect(JSON.parse(recallRow.layers_json)).toEqual([]);
    expect(JSON.parse(recallRow.candidate_memory_ids_json)).toEqual([]);

    service.closeSession(session.sessionId);
    const memoryProbeSession = service.openSession({
      namespace: {
        source: "codex",
        profileId: "jiang",
        userId: "user-intent-gate",
        sessionKey: "memory-probe"
      }
    });
    const memoryProbe = await service.startTurn({ turnId: "turn-intent-memory-probe",
      sessionId: memoryProbeSession.sessionId,
      query: "你还记得我们之前讨论过 sqlite migration 吗"
    });

    recallRow = db.db.prepare(
      `SELECT layers_json
       FROM recall_events
       WHERE id = ?`
    ).get(memoryProbe.searchEventId) as { layers_json: string; candidate_memory_ids_json: string };
    expect(JSON.parse(recallRow.layers_json)).toEqual(["Skill", "L2", "L1"]);

    const episode = db.db.prepare(
      `SELECT meta_json
       FROM episodes
       WHERE id = ?`
    ).get(memoryProbe.episodeId) as { meta_json: string };
    expect(JSON.parse(episode.meta_json)).toMatchObject({
      intentDecision: {
        kind: "memory_probe",
        retrieval: {
          tier1: true,
          tier2: true,
          tier3: false
        }
      }
    });

    service.closeSession(memoryProbeSession.sessionId);
    const unknownSession = service.openSession({
      namespace: {
        source: "codex",
        profileId: "jiang",
        userId: "user-intent-gate",
        sessionKey: "personal-memory-query"
      }
    });
    const unknown = await service.startTurn({
      turnId: "turn-intent-unknown",
      sessionId: unknownSession.sessionId,
      query: "我喜欢吃什么"
    });

    recallRow = db.db.prepare(
      `SELECT layers_json, candidate_memory_ids_json
       FROM recall_events
       WHERE id = ?`
    ).get(unknown.searchEventId) as {
      layers_json: string;
      candidate_memory_ids_json: string;
    };
    expect(JSON.parse(recallRow.layers_json)).toEqual(["Skill", "L2", "L1", "L3"]);

    const unknownEpisode = db.db.prepare(
      `SELECT meta_json
       FROM episodes
       WHERE id = ?`
    ).get(unknown.episodeId) as { meta_json: string };
    expect(JSON.parse(unknownEpisode.meta_json)).toMatchObject({
      intentDecision: {
        kind: "unknown",
        retrieval: {
          tier1: true,
          tier2: true,
          tier3: true
        }
      }
    });
    db.close();
  });
});
