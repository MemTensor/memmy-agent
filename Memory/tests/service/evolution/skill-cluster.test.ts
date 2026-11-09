import { assignedEpisodeId, settleCaptureAssignments } from "../../fixtures/memory-service-fixture.js";
import { LEGACY_TEST_CONFIG } from "../../fixtures/memory-service-fixture.js";
import { afterEach, describe, expect, it, vi } from "vitest";
import { type LlmClient } from "../../../src/index.js";
import { DIRECT_SKILL_SOURCE } from "../../../src/algorithm/trace-direct-skill.js";
import { Repositories, RuntimeRepository } from "../../../src/storage/repositories.js";
import { createMemoryServiceFixture, runWorkerRounds } from "../../fixtures/memory-service-fixture.js";

const {
  cleanup,
  createTestService
} = createMemoryServiceFixture();

afterEach(cleanup);
afterEach(() => vi.restoreAllMocks());

const DIRECT_SKILL_JSON = {
  name: "xlsx_python_transform",
  retrieval_blurb: "when the user asks to fill totals in report.xlsx with python openpyxl",
  trigger_context: "User wants a spreadsheet transform via python.",
  summary: "Load report.xlsx with openpyxl, write totals, save the workbook.",
  parameters: [{
    name: "spreadsheet_path",
    type: "string",
    required: true,
    description: "input xlsx"
  }],
  preconditions: [],
  steps: [
    { title: "Load workbook", body: "Open report.xlsx with openpyxl and read headers." },
    { title: "Write totals", body: "Write the totals and save report.xlsx." }
  ],
  examples: [{ input: "fill totals in report.xlsx", expected: "xlsx written" }],
  tools: ["python"],
  decision_guidance: {
    preference: ["Keep formulas unless the grader needs values"],
    anti_pattern: []
  },
  tags: ["xlsx", "python"]
};

interface DirectSkillCall {
  operation: string;
  messages: Array<{ role: "system" | "user" | "assistant"; content: string }>;
}

function createDirectSkillLlm(calls: DirectSkillCall[], hooks: { beforeGeneration?: () => void | Promise<void> } = {}): LlmClient {
  return {
    config: {
      ...LEGACY_TEST_CONFIG.evolution,
      provider: "host",
      endpoint: "http://127.0.0.1/direct-skill",
      model: "direct-skill"
    },
    isConfigured() {
      return true;
    },
    async complete() {
      return "{}";
    },
    async completeJson<T extends Record<string, unknown>>(
      messages: Array<{ role: "system" | "user" | "assistant"; content: string }>,
      options: { operation: string }
    ): Promise<T> {
      if (options.operation === "episode.select.v1") return { episodeId: null, title: "Test task", summary: "Test task summary" } as unknown as T;
      calls.push({ operation: options.operation, messages });
      if (options.operation.startsWith("skill.batch_evolve.meta")) {
        return {
          reasoning: "ground steps in openpyxl",
          meta_skill_content: "Keep steps on openpyxl load/save. Failures only go to anti_pattern."
        } as unknown as T;
      }
      if (options.operation.startsWith("skill.batch_evolve")) {
        await hooks.beforeGeneration?.();
        return { ...DIRECT_SKILL_JSON } as unknown as T;
      }
      if (options.operation === "capture.summarize") {
        const payload = messages.find((message) => message.role === "user")?.content ?? "";
        const turnSummary = payload.match(/\bUSER:\s*(.*?)\s+ASSISTANT:/)?.[1]?.trim()
          ?? "filled report.xlsx";
        return {
          l1: {
            title: turnSummary.slice(0, 30),
            summary: turnSummary,
            evidence: [{ quote: turnSummary, role: "user", kind: "task_outcome" }]
          },
          user: null
        } as unknown as T;
      }
      return {} as T;
    },
    status() {
      return {
        provider: "host",
        model: "direct-skill",
        configured: true,
        remote: true
      };
    }
  };
}

async function runDirectSkillEpisode(input: {
  userId: string;
  rTask: number;
  query?: string;
  answer?: string;
  config?: typeof LEGACY_TEST_CONFIG;
}) {
  const calls: DirectSkillCall[] = [];
  const hooks: { beforeGeneration?: () => void | Promise<void> } = {};
  const { db, service } = createTestService({ skillLlm: createDirectSkillLlm(calls, hooks), config: input.config });
  const session = service.openSession({
    namespace: { source: "codex", profileId: "jiang", userId: input.userId }
  });
  const complete = (await service.completeTurn(`${input.userId}-turn`, {
    sessionId: session.sessionId,
    query: input.query ?? "fill totals in report.xlsx with python openpyxl",
    answer: input.answer ?? "Opened report.xlsx with openpyxl and wrote the totals.",
    toolCalls: [{
      name: "python",
      input: { command: "openpyxl.load_workbook('report.xlsx')" },
      output: { ok: true },
      success: true
    }]
  }));
  const repos = new Repositories(db.db);
  const at = new Date().toISOString();
  db.db.prepare(`UPDATE episodes SET status = 'closed', closed_at = ?, updated_at = ? WHERE id = ?`)
    .run(at, at, assignedEpisodeId(service, complete));
  repos.runtime.updateEpisodeReward(assignedEpisodeId(service, complete), {
    rTask: input.rTask,
    rewardDetail: { source: "test" }
  }, at);
  repos.runtime.enqueueJob({
    id: `job_${input.userId}`,
    jobType: "skill_cluster_assign",
    status: "queued",
    userId: input.userId,
    sessionId: session.sessionId,
    episodeId: assignedEpisodeId(service, complete),
    payload: { reason: "test" },
    attempts: 0,
    maxAttempts: 3,
    createdAt: at,
    updatedAt: at
  });
  await runWorkerRounds(service, 4, 20);
  return { db, service, complete, calls, hooks, repos: new Repositories(db.db) };
}

async function reprocess(context: Awaited<ReturnType<typeof runDirectSkillEpisode>>, episodeId: string, rTask: number) {
  const at = new Date().toISOString();
  const episode = context.repos.runtime.getEpisode(episodeId)!;
  context.repos.runtime.updateEpisodeReward(episodeId, { rTask, rewardDetail: { source: "test-reclassification" } }, at);
  context.repos.runtime.enqueueJob({ id: `revision-${episodeId}-${rTask}-${context.calls.length}`, jobType: "skill_cluster_assign",
    status: "queued", userId: episode.userId, sessionId: episode.sessionId, episodeId,
    payload: { reason: "test-reclassification" }, attempts: 0, maxAttempts: 3, createdAt: at, updatedAt: at });
  await runWorkerRounds(context.service, 4, 20);
}

describe("MemoryService / evolution / skill cluster", () => {
  it.each([
    { language: "zh-CN", outputLanguageMode: "follow_policy", expected: "zh" },
    { language: "en-US", outputLanguageMode: "follow_policy", expected: "en" },
    { language: "ja-JP", outputLanguageMode: "follow_policy", expected: "ja-JP" },
    { language: "fr-FR", outputLanguageMode: "follow_policy", expected: "fr-FR" },
    { language: "zh-Hant-TW", outputLanguageMode: "follow_policy", expected: "zh-Hant-TW" },
    { language: "zh-CN", outputLanguageMode: "en", expected: "en" },
    { language: "en-US", outputLanguageMode: "zh", expected: "zh" }
  ] as const)("uses $expected for interface $language and skill mode $outputLanguageMode", async ({
    language, outputLanguageMode, expected
  }) => {
    const { calls } = await runDirectSkillEpisode({
      userId: `skill-language-${language}-${outputLanguageMode}`,
      rTask: 1,
      config: {
        ...LEGACY_TEST_CONFIG,
        language,
        algorithm: {
          ...LEGACY_TEST_CONFIG.algorithm,
          skill: { ...LEGACY_TEST_CONFIG.algorithm.skill, outputLanguageMode }
        }
      }
    });
    const generation = calls.find((call) => call.operation === "skill.batch_evolve.crystallize");
    expect(generation).toBeDefined();
    const userMessage = generation!.messages.find((message) => message.role === "user");
    expect(JSON.parse(userMessage!.content).OUTPUT_LANGUAGE).toBe(expected);
    expect(generation!.messages.filter((message) => message.role === "system").map((message) => message.content))
      .toContain(expected === "zh"
        ? "All natural-language answers MUST be in Simplified Chinese (zh-CN)."
        : expected === "en" ? "All natural-language answers MUST be in English."
          : `All natural-language answers MUST use the language, script, and regional conventions of BCP 47 locale ${expected}. Preserve JSON keys and machine identifiers.`);
  });

  it("crystallizes a Skill from RawTurns when the cluster has a success anchor", async () => {
    const { db, complete, calls } = await runDirectSkillEpisode({
      userId: "direct-success",
      rTask: 1
    });
    const skill = db.db.prepare(
      `SELECT id, memory_value, properties_json
       FROM memories
       WHERE memory_layer = 'Skill'`
    ).get() as { id: string; memory_value: string; properties_json: string } | undefined;
    expect(skill).toBeTruthy();
    const properties = JSON.parse(skill!.properties_json) as {
      internal_info?: { source?: string; evidence_anchor_ids?: string[]; skill?: { source?: string; evidence_anchor_ids?: string[] } };
    };
    expect(properties.internal_info?.source).toBe(DIRECT_SKILL_SOURCE);
    expect(properties.internal_info?.evidence_anchor_ids).toEqual([complete.episodeId]);
    expect(skill!.memory_value).toContain("openpyxl");
    expect(calls.map((item) => item.operation)).toContain("skill.batch_evolve.crystallize");
    expect(calls.map((item) => item.operation)).toContain("skill.batch_evolve.meta");
    const cluster = db.db.prepare(`SELECT skill_memory_id, meta_skill_md FROM skill_clusters`).get() as {
      skill_memory_id: string;
      meta_skill_md: string;
    };
    expect(cluster.skill_memory_id).toBe(skill!.id);
    expect(cluster.meta_skill_md).toContain("anti_pattern");
  });

  it("enqueues assign/evolve after episode reward without a manual skill job", async () => {
    const calls: DirectSkillCall[] = [];
    const { db, service } = createTestService({
      llm: createDirectSkillLlm(calls),
      config: {
        ...LEGACY_TEST_CONFIG,
        algorithm: {
          ...LEGACY_TEST_CONFIG.algorithm,
          capture: {
            ...LEGACY_TEST_CONFIG.algorithm.capture,
            synthReflection: false,
            embedAfterCapture: false,
            alphaScoring: false
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
            useLlm: true,
            directFromTrace: true
          }
        }
      }
    });
    const userId = "direct-from-reward";
    const session = service.openSession({
      namespace: { source: "codex", profileId: "jiang", userId }
    });
    const complete = (await service.completeTurn(`${userId}-turn`, {
      sessionId: session.sessionId,
      episodeId: `${userId}-episode`,
      query: "fill totals in report.xlsx with python openpyxl",
      answer: "Opened report.xlsx with openpyxl and wrote the totals.",
      toolCalls: [{
        name: "python",
        input: { command: "openpyxl.load_workbook('report.xlsx')" },
        output: { ok: true },
        success: true
      }]
    }));
    await settleCaptureAssignments(service);
    await service.feedback({
      sessionId: session.sessionId,
      episodeId: assignedEpisodeId(service, complete),
      l1MemoryId: complete.l1MemoryId,
      channel: "explicit",
      polarity: "positive",
      magnitude: 1,
      rationale: "accepted"
    });
    service.closeSession(session.sessionId);
    expect(db.db.prepare(
      `SELECT COUNT(*) AS count
       FROM evolution_jobs
       WHERE job_type IN ('skill_cluster_assign', 'skill_batch_evolve')`
    ).get()).toEqual({ count: 0 });
    await runWorkerRounds(service, 8, 50);
    const jobs = db.db.prepare(
      `SELECT job_type, status
       FROM evolution_jobs
       WHERE job_type IN ('skill_cluster_assign', 'skill_batch_evolve')
       ORDER BY created_at`
    ).all() as Array<{ job_type: string; status: string }>;
    const rewarded = db.db.prepare(
      `SELECT r_task FROM episodes WHERE id = ?`
    ).get(assignedEpisodeId(service, complete)) as { r_task: number | null };
    expect(rewarded.r_task).toBe(1);
    expect(jobs.map((job) => job.job_type)).toEqual([
      "skill_cluster_assign",
      "skill_batch_evolve"
    ]);
    expect(jobs.every((job) => job.status === "succeeded")).toBe(true);
    const skill = db.db.prepare(
      `SELECT id, properties_json
       FROM memories
       WHERE memory_layer = 'Skill'`
    ).get() as { id: string; properties_json: string } | undefined;
    expect(skill).toBeTruthy();
    const properties = JSON.parse(skill!.properties_json) as {
      internal_info?: { source?: string };
    };
    expect(properties.internal_info?.source).toBe(DIRECT_SKILL_SOURCE);
    expect(calls.map((item) => item.operation)).toContain("skill.batch_evolve.crystallize");
  });

  it("does not create a Skill from failure-only evidence", async () => {
    const { db, calls } = await runDirectSkillEpisode({
      userId: "direct-failure",
      rTask: -1
    });
    const skillCount = db.db.prepare(
      `SELECT COUNT(*) AS count FROM memories WHERE memory_layer = 'Skill'`
    ).get() as { count: number };
    expect(skillCount.count).toBe(0);
    expect(calls.map((item) => item.operation)).not.toContain("skill.batch_evolve.crystallize");
    expect(calls.map((item) => item.operation)).toContain("skill.batch_evolve.meta");
    const cluster = db.db.prepare(`SELECT skill_memory_id FROM skill_clusters`).get() as {
      skill_memory_id: string | null;
    };
    expect(cluster.skill_memory_id).toBeNull();
  });

  it("withdraws the last direct Skill success anchor when its episode is reclassified as failure", async () => {
    const context = await runDirectSkillEpisode({ userId: "direct-reclassified", rTask: 1 });
    const episodeId = assignedEpisodeId(context.service, context.complete);
    const cluster = context.repos.runtime.getSkillClusterForEpisode(episodeId)!;
    const original = context.repos.memories.get(cluster.skillMemoryId!)!;
    const at = new Date().toISOString();
    context.repos.runtime.updateEpisodeReward(episodeId, { rTask: -0.55, rewardDetail: { source: "test-reclassification" } }, at);
    context.repos.runtime.enqueueJob({ id: "direct-reclassified-assignment", jobType: "skill_cluster_assign",
      status: "queued", userId: original.userId, sessionId: original.sessionId, episodeId,
      payload: { reason: "test-reclassification" }, attempts: 0, maxAttempts: 3, createdAt: at, updatedAt: at });
    await runWorkerRounds(context.service, 4, 20);
    const withdrawn = context.repos.memories.get(original.id)!;
    expect(withdrawn.status).toBe("archived");
    expect(withdrawn.properties.internal_info.evidence_anchor_ids).toEqual([]);
    expect(withdrawn.properties.internal_info.support).toBe(0);
    expect(context.repos.runtime.listSkillClusterMembers(cluster.id)).toHaveLength(1);
  });

  it("does not rewrite a direct Skill or call the model again for identical processed episode inputs", async () => {
    const context = await runDirectSkillEpisode({ userId: "direct-repeated", rTask: 1 });
    const episodeId = assignedEpisodeId(context.service, context.complete);
    const cluster = context.repos.runtime.getSkillClusterForEpisode(episodeId)!;
    const original = context.repos.memories.get(cluster.skillMemoryId!)!;
    const callsBefore = context.calls.filter(call => call.operation.startsWith("skill.batch_evolve"));
    const at = new Date().toISOString();
    context.repos.runtime.enqueueJob({ id: "direct-repeated-assignment", jobType: "skill_cluster_assign",
      status: "queued", userId: original.userId, sessionId: original.sessionId, episodeId,
      payload: { reason: "test-repeated" }, attempts: 0, maxAttempts: 3, createdAt: at, updatedAt: at });
    await runWorkerRounds(context.service, 4, 20);
    expect(context.repos.memories.get(original.id)?.version).toBe(original.version);
    expect(context.calls.filter(call => call.operation.startsWith("skill.batch_evolve"))).toEqual(callsBefore);
  });

  it("restores the same Skill after success -> failure -> success without duplicating support or eta", async () => {
    const context = await runDirectSkillEpisode({ userId: "direct-restored", rTask: 1 });
    const episodeId = assignedEpisodeId(context.service, context.complete);
    const cluster = context.repos.runtime.getSkillClusterForEpisode(episodeId)!;
    const original = context.repos.memories.get(cluster.skillMemoryId!)!;
    await reprocess(context, episodeId, -1);
    expect(context.repos.memories.get(original.id)?.status).toBe("archived");
    await reprocess(context, episodeId, 1);
    const restored = context.repos.memories.get(original.id)!;
    expect(restored.status).toBe("activated");
    expect(restored.properties.internal_info.evidence_anchor_ids).toEqual([episodeId]);
    expect(restored.properties.internal_info.support).toBe(1);
    expect(restored.properties.internal_info.eta).toBe(original.properties.internal_info.eta);
    expect(context.db.db.prepare("SELECT COUNT(*) AS count FROM memories WHERE memory_layer = 'Skill'").get()).toEqual({ count: 1 });
    expect(context.repos.runtime.getSkillCluster(cluster.id)?.skillMemoryId).toBe(original.id);
    const version = restored.version;
    await reprocess(context, episodeId, 1);
    expect(context.repos.memories.get(original.id)?.version).toBe(version);
  });

  it("keeps another task's success evidence when one of two supporting tasks fails", async () => {
    const context = await runDirectSkillEpisode({ userId: "direct-multiple", rTask: 1 });
    const firstId = assignedEpisodeId(context.service, context.complete);
    const cluster = context.repos.runtime.getSkillClusterForEpisode(firstId)!;
    const session = context.service.openSession({ namespace: { source: "codex", profileId: "jiang", userId: "direct-multiple" } });
    const second = await context.service.completeTurn("direct-second", { sessionId: session.sessionId,
      query: "fill totals in report.xlsx with python openpyxl", answer: "Opened report.xlsx with openpyxl and wrote the totals.",
      toolCalls: [{ name: "python", input: { command: "openpyxl.load_workbook('report.xlsx')" }, output: { ok: true }, success: true }] });
    const secondId = assignedEpisodeId(context.service, second);
    context.db.db.prepare("UPDATE episodes SET status = 'closed' WHERE id = ?").run(secondId);
    await reprocess(context, secondId, 1);
    expect(context.repos.runtime.getSkillClusterForEpisode(secondId)?.id).toBe(cluster.id);
    expect(context.repos.memories.get(cluster.skillMemoryId!)?.properties.internal_info.support).toBe(2);
    await reprocess(context, firstId, -1);
    const remaining = context.repos.memories.get(cluster.skillMemoryId!)!;
    expect(remaining.status).toBe("activated");
    expect(remaining.properties.internal_info.evidence_anchor_ids).toEqual([secondId]);
    expect(remaining.properties.internal_info.support).toBe(1);
    expect(context.repos.runtime.getSkillCluster(cluster.id)?.memberCount).toBe(2);
    await reprocess(context, firstId, 1);
    expect(context.repos.memories.get(cluster.skillMemoryId!)?.properties.internal_info.evidence_anchor_ids).toEqual([firstId, secondId].sort());
    expect(context.repos.runtime.getSkillCluster(cluster.id)?.memberCount).toBe(2);
  });

  it("does not restore a manually archived Skill when its source becomes successful again", async () => {
    const context = await runDirectSkillEpisode({ userId: "direct-manual-archive", rTask: 1 });
    const episodeId = assignedEpisodeId(context.service, context.complete);
    const cluster = context.repos.runtime.getSkillClusterForEpisode(episodeId)!;
    await reprocess(context, episodeId, -1);
    context.repos.memories.archive(cluster.skillMemoryId!);
    await reprocess(context, episodeId, 1);
    expect(context.repos.memories.get(cluster.skillMemoryId!)?.status).toBe("archived");
    expect(context.db.db.prepare("SELECT COUNT(*) AS count FROM memories WHERE memory_layer = 'Skill'").get()).toEqual({ count: 1 });
  });

  it("preserves independent trials and edited eta when withdrawing task evidence", async () => {
    const context = await runDirectSkillEpisode({ userId: "direct-trials", rTask: 1 });
    const episodeId = assignedEpisodeId(context.service, context.complete);
    const cluster = context.repos.runtime.getSkillClusterForEpisode(episodeId)!;
    const original = context.repos.memories.get(cluster.skillMemoryId!)!;
    const fields = { eta: 0.83, trials_attempted: 4, trials_passed: 3 };
    context.repos.memories.update({ ...original, info: { ...original.info, eta: 0.83 },
      properties: { ...original.properties, internal_info: { ...original.properties.internal_info, ...fields,
        skill: { ...(original.properties.internal_info.skill as Record<string, unknown>), ...fields } } } });
    await reprocess(context, episodeId, -1);
    const retained = context.repos.memories.get(original.id)!;
    expect(retained.status).toBe("activated");
    expect(retained.properties.internal_info.evidence_anchor_ids).toEqual([]);
    expect(retained.properties.internal_info).toMatchObject(fields);
    await reprocess(context, episodeId, 1);
    expect(context.repos.memories.get(original.id)?.properties.internal_info).toMatchObject(fields);
  });

  it.each(["edit", "archive"] as const)("does not overwrite a concurrent manual %s while the model runs", async action => {
    const context = await runDirectSkillEpisode({ userId: `direct-concurrent-${action}`, rTask: 1 });
    const episodeId = assignedEpisodeId(context.service, context.complete);
    const skillId = context.repos.runtime.getSkillClusterForEpisode(episodeId)!.skillMemoryId!;
    context.hooks.beforeGeneration = () => {
      if (action === "archive") context.repos.memories.archive(skillId);
      else {
        const current = context.repos.memories.get(skillId)!;
        context.repos.memories.update({ ...current, memoryValue: "My manually edited workflow" });
      }
    };
    await reprocess(context, episodeId, 0.9);
    const current = context.repos.memories.get(skillId)!;
    if (action === "archive") expect(current.status).toBe("archived");
    else expect(current.memoryValue).toBe("My manually edited workflow");
  });

  it("replaces obsolete failure text instead of merging it back after a source is corrected", async () => {
    const context = await runDirectSkillEpisode({ userId: "direct-text-replacement", rTask: -1 });
    const episodeId = assignedEpisodeId(context.service, context.complete);
    await reprocess(context, episodeId, 1);
    const cluster = context.repos.runtime.getSkillClusterForEpisode(episodeId)!;
    const original = context.repos.memories.get(cluster.skillMemoryId!)!;
    const oldProcedure = { ...DIRECT_SKILL_JSON, decision_guidance: { preference: [], anti_pattern: ["Obsolete failure conclusion"] } };
    // Represents a formerly generated failure constraint, not a manual UI edit.
    context.repos.memories.update({ ...original, properties: { ...original.properties,
      internal_info: { ...original.properties.internal_info, procedure_json: oldProcedure,
        skill: { ...(original.properties.internal_info.skill as Record<string, unknown>), procedure_json: oldProcedure } } } });
    await reprocess(context, episodeId, 0.9);
    const generation = context.calls.filter(call => call.operation === "skill.batch_evolve.crystallize").at(-1)!;
    expect(JSON.parse(generation.messages.find(message => message.role === "user")!.content).EXISTING_SKILL_SNAPSHOT).toBeNull();
    expect(context.repos.memories.get(original.id)?.memoryValue).not.toContain("Obsolete failure conclusion");
    expect(context.repos.memories.get(original.id)?.properties.internal_info.procedure_json).not.toEqual(oldProcedure);
  });

  it("continues maintaining an existing direct Skill after direct generation is disabled", async () => {
    const config = structuredClone(LEGACY_TEST_CONFIG);
    config.algorithm.skill.directFromTrace = false;
    config.algorithm.reward.llmScoring = false;
    const context = await runDirectSkillEpisode({ userId: "direct-mode-switch", rTask: 1, config });
    const episodeId = assignedEpisodeId(context.service, context.complete);
    const skillId = context.repos.runtime.getSkillClusterForEpisode(episodeId)!.skillMemoryId!;
    const episode = context.repos.runtime.getEpisode(episodeId)!;
    await context.service.feedback({ episodeId, sessionId: episode.sessionId, l1MemoryId: context.complete.l1MemoryId,
      channel: "explicit", polarity: "negative", magnitude: 1, rationale: "Final validation failed" });
    await runWorkerRounds(context.service, 8, 50);
    expect(context.repos.runtime.getEpisode(episodeId)?.rTask).toBeLessThan(0);
    expect(context.repos.memories.get(skillId)?.status).toBe("archived");
  });

  it("withdraws existing success evidence when a later reward is skipped", async () => {
    const config = structuredClone(LEGACY_TEST_CONFIG);
    config.algorithm.reward.minExchangesForCompletion = 20;
    const context = await runDirectSkillEpisode({ userId: "direct-skipped", rTask: 1, config });
    const episodeId = assignedEpisodeId(context.service, context.complete);
    const skillId = context.repos.runtime.getSkillClusterForEpisode(episodeId)!.skillMemoryId!;
    const episode = context.repos.runtime.getEpisode(episodeId)!;
    const at = new Date().toISOString();
    context.repos.runtime.enqueueJob({ id: "skip-reward", jobType: "reward", status: "queued", userId: episode.userId,
      episodeId, sessionId: episode.sessionId, targetMemoryId: context.complete.l1MemoryId,
      payload: {}, attempts: 0, maxAttempts: 3, createdAt: at, updatedAt: at });
    await runWorkerRounds(context.service, 8, 50);
    expect(context.repos.runtime.getEpisode(episodeId)?.rewardDetail.skipped).toBe(true);
    expect(context.repos.memories.get(skillId)?.status).toBe("archived");
  });

  it("rolls back Skill content and processed markers together if saving the cluster fails", async () => {
    const context = await runDirectSkillEpisode({ userId: "direct-atomic", rTask: 1 });
    const episodeId = assignedEpisodeId(context.service, context.complete);
    const cluster = context.repos.runtime.getSkillClusterForEpisode(episodeId)!;
    const original = context.repos.memories.get(cluster.skillMemoryId!)!;
    const processed = context.repos.runtime.getEpisode(episodeId)!.meta.clusterProcessedFeatures;
    const saveCluster = RuntimeRepository.prototype.updateSkillCluster;
    context.hooks.beforeGeneration = () => {
      vi.spyOn(RuntimeRepository.prototype, "updateSkillCluster").mockImplementation(function (this: RuntimeRepository, next) {
        if (next.id === cluster.id && next.processedEpisodeIds.includes(episodeId)) throw new Error("synthetic cluster write failure");
        return saveCluster.call(this, next);
      });
    };
    await reprocess(context, episodeId, 0.9);
    expect(context.repos.memories.get(original.id)?.version).toBe(original.version);
    expect(context.repos.memories.get(original.id)?.memoryValue).toBe(original.memoryValue);
    expect(context.repos.runtime.getEpisode(episodeId)?.meta.clusterProcessedFeatures).toBe(processed);
    expect(context.repos.runtime.getSkillCluster(cluster.id)?.processedEpisodeIds).not.toContain(episodeId);
  });

  it("includes evidence changed beyond the first thousand turns in reprocessing", async () => {
    const context = await runDirectSkillEpisode({ userId: "direct-long", rTask: 1 });
    const episodeId = assignedEpisodeId(context.service, context.complete);
    const first = context.repos.runtime.listRawTurnsByEpisode(episodeId, -1)[0]!;
    for (let index = 1; index <= 1000; index++) {
      context.repos.runtime.insertRawTurn({ ...first, id: `long-${index}`, turnId: `long-${index}`,
        userText: `Verify spreadsheet row ${index}`, createdAt: new Date(Date.parse(first.createdAt) + index).toISOString() });
    }
    await reprocess(context, episodeId, 1);
    const before = context.calls.filter(call => call.operation === "skill.batch_evolve.crystallize").length;
    const last = context.repos.runtime.listRawTurnsByEpisode(episodeId, -1).at(-1)!;
    context.repos.runtime.updateRawTurn({ ...last, userText: "TAIL_CORRECTION: preserve the report.xlsx formulas" });
    await reprocess(context, episodeId, 1);
    const generations = context.calls.filter(call => call.operation === "skill.batch_evolve.crystallize");
    expect(generations).toHaveLength(before + 1);
    expect(generations.at(-1)!.messages.find(message => message.role === "user")!.content).toContain("TAIL_CORRECTION");
  });

  it("does not let an old-generation assignment update a reopened task", async () => {
    const context = await runDirectSkillEpisode({ userId: "direct-old-generation", rTask: 1 });
    const episodeId = assignedEpisodeId(context.service, context.complete);
    const episode = context.repos.runtime.getEpisode(episodeId)!;
    const cluster = context.repos.runtime.getSkillClusterForEpisode(episodeId)!;
    const original = context.repos.memories.get(cluster.skillMemoryId!)!;
    const at = new Date().toISOString();
    context.repos.runtime.updateEpisodeMeta(episodeId, { processingGeneration: 1 }, at);
    context.repos.runtime.updateEpisodeReward(episodeId, { rTask: -1, rewardDetail: {} }, at);
    context.repos.runtime.enqueueJob({ id: "obsolete-assignment", jobType: "skill_cluster_assign", status: "queued",
      userId: episode.userId, episodeId, sessionId: episode.sessionId,
      payload: { episodeGeneration: 0, episodeRevision: "obsolete" }, attempts: 0, maxAttempts: 3, createdAt: at, updatedAt: at });
    await runWorkerRounds(context.service, 4, 20);
    expect(context.repos.memories.get(original.id)?.version).toBe(original.version);
    await reprocess(context, episodeId, -1);
    expect(context.repos.memories.get(original.id)?.status).toBe("archived");
  });

  it("splits the same tool family into two fine clusters when query vectors differ", async () => {
    const calls: DirectSkillCall[] = [];
    const { db, service } = createTestService({
      skillLlm: createDirectSkillLlm(calls),
      embedder: {
        config: {
          ...LEGACY_TEST_CONFIG.embedding,
          provider: "local",
          model: "scene-split"
        },
        isRemote() {
          return false;
        },
        async embed(texts: string[]) {
          return texts.map((text) => text.includes("lookup") ? [1, 0] : [0, 1]);
        },
        async embedOne(text: string) {
          return text.includes("lookup") ? [1, 0] : [0, 1];
        },
        status() {
          return {
            provider: "local",
            model: "scene-split",
            configured: true,
            remote: false
          };
        }
      }
    });
    const userId = "direct-fine-split";
    const firstSession = service.openSession({
      namespace: { source: "codex", profileId: "jiang", userId }
    });
    const secondSession = service.openSession({
      namespace: { source: "codex", profileId: "jiang", userId }
    });
    const first = (await service.completeTurn(`${userId}-lookup`, {
      sessionId: firstSession.sessionId,
      query: "fix INDEX MATCH lookup in report.xlsx",
      answer: "Opened report.xlsx with openpyxl and rewrote the lookup.",
      toolCalls: [{
        name: "python",
        input: { command: "openpyxl.load_workbook('report.xlsx')" },
        output: { ok: true },
        success: true
      }]
    }));
    const second = (await service.completeTurn(`${userId}-delete`, {
      sessionId: secondSession.sessionId,
      query: "delete filtered rows from report.xlsx",
      answer: "Opened report.xlsx and deleted the matching rows.",
      toolCalls: [{
        name: "python",
        input: { command: "openpyxl.load_workbook('report.xlsx')" },
        output: { ok: true },
        success: true
      }]
    }));
    const repos = new Repositories(db.db);
    const at = new Date().toISOString();
    const pairs = [
      { episodeId: assignedEpisodeId(service, first), sessionId: firstSession.sessionId },
      { episodeId: assignedEpisodeId(service, second), sessionId: secondSession.sessionId }
    ];
    for (const [index, pair] of pairs.entries()) {
      db.db.prepare(`UPDATE episodes SET status = 'closed', closed_at = ?, updated_at = ? WHERE id = ?`)
        .run(at, at, pair.episodeId);
      repos.runtime.updateEpisodeReward(pair.episodeId, {
        rTask: 1,
        rewardDetail: { source: "test" }
      }, at);
      repos.runtime.enqueueJob({
        id: `job_${userId}_${index}`,
        jobType: "skill_cluster_assign",
        status: "queued",
        userId,
        sessionId: pair.sessionId,
        episodeId: pair.episodeId,
        payload: { reason: "test" },
        attempts: 0,
        maxAttempts: 3,
        createdAt: at,
        updatedAt: at
      });
    }
    await runWorkerRounds(service, 8, 20);
    const clusters = db.db.prepare(`SELECT id FROM skill_clusters`).all() as Array<{ id: string }>;
    expect(clusters).toHaveLength(2);
    const skills = db.db.prepare(
      `SELECT COUNT(*) AS count FROM memories WHERE memory_layer = 'Skill'`
    ).get() as { count: number };
    expect(skills.count).toBe(2);
  });

  it("does not treat an L2-crystallized Skill as the cluster skill", async () => {
    const { db, complete } = await runDirectSkillEpisode({
      userId: "direct-ignore-l2",
      rTask: 1
    });
    const l2SkillId = "skill_from_old_chain";
    db.db.prepare(
      `INSERT INTO memories (
        id, timeline, user_id, memory_type, status, memory_value, tags_json, info_json,
        properties_json, memory_layer, version, created_at, updated_at
      ) VALUES (?, ?, ?, 'SkillMemory', 'activated', 'old l2 skill', '[]', '{}', ?, 'Skill', 1, ?, ?)`
    ).run(
      l2SkillId,
      new Date().toISOString(),
      "direct-ignore-l2",
      JSON.stringify({
        internal_info: {
          source: "worker.skill_crystallization.v7",
          skill: { name: "old_l2", status: "active", procedure_json: {}, evidence_anchor_ids: [complete.episodeId] }
        }
      }),
      new Date().toISOString(),
      new Date().toISOString()
    );
    const cluster = db.db.prepare(`SELECT skill_memory_id FROM skill_clusters`).get() as {
      skill_memory_id: string;
    };
    expect(cluster.skill_memory_id).not.toBe(l2SkillId);
  });
});
