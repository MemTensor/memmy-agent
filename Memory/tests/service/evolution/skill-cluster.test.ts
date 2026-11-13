import { assignedEpisodeId, settleCaptureAssignments } from "../../fixtures/memory-service-fixture.js";
import { LEGACY_TEST_CONFIG } from "../../fixtures/memory-service-fixture.js";
import { afterEach, describe, expect, it } from "vitest";
import { type LlmClient } from "../../../src/index.js";
import { DIRECT_SKILL_SOURCE } from "../../../src/algorithm/trace-direct-skill.js";
import { Repositories } from "../../../src/storage/repositories.js";
import { createMemoryServiceFixture, runWorkerRounds } from "../../fixtures/memory-service-fixture.js";

const {
  cleanup,
  createTestService
} = createMemoryServiceFixture();

afterEach(cleanup);

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

function createDirectSkillLlm(calls: DirectSkillCall[], skillJson: Record<string, unknown> = DIRECT_SKILL_JSON,
  displayTitle?: string, summary = String(skillJson.summary ?? DIRECT_SKILL_JSON.summary)): LlmClient {
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
        return { ...skillJson, summary, ...(displayTitle ? { display_title: displayTitle } : {}) } as unknown as T;
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
  skillJson?: Record<string, unknown>;
  displayTitle?: string;
  summary?: string;
}) {
  const calls: DirectSkillCall[] = [];
  const skillLlm = createDirectSkillLlm(calls, input.skillJson, input.displayTitle, input.summary);
  const { db, service } = createTestService({ skillLlm, config: input.config });
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
  return { db, service, complete, calls, skillLlm, repos: new Repositories(db.db) };
}

describe("MemoryService / evolution / skill cluster", () => {
  it("stores a separate localized title without changing the invocation name or key", async () => {
    const { db, repos } = await runDirectSkillEpisode({
      userId: "localized-skill", rTask: 1, displayTitle: "使用 Python 填写表格汇总",
      config: { ...LEGACY_TEST_CONFIG, language: "zh-CN" }
    });
    const row = db.db.prepare("SELECT id FROM memories WHERE memory_layer = 'Skill'").get() as { id: string };
    const memory = repos.memories.get(row.id)!;
    expect(memory.info.title).toBe("使用 Python 填写表格汇总");
    expect(memory.info.name).toBe("xlsx_python_transform");
    expect(memory.memoryKey).toMatch(/^skill:direct:/);
    expect(memory.memoryValue.split("\n")[0]).toBe("# 使用 Python 填写表格汇总");
  });

  it.each(["Spreadsheet Transformation", "xlsx_python_transform", undefined])(
    "uses the localized summary on the card and in the guide when the draft title is %s", async displayTitle => {
      const summary = "用 openpyxl 写入合计并保存工作簿。";
      const { service, repos } = await runDirectSkillEpisode({ userId: "skill-title-fallback", rTask: 1,
        config: { ...LEGACY_TEST_CONFIG, language: "zh-CN" }, displayTitle, summary });
      const [card] = service.panelItems({ layer: "Skill" }).items;
      expect(card?.title).toBe(summary);
      expect(service.getSkill(card!.id)).toMatchObject({ title: summary, name: "xlsx_python_transform" });
      const stored = repos.memories.get(card!.id)!;
      expect(stored.info.name).toBe("xlsx_python_transform");
      expect(stored.memoryValue.split("\n")[0]).toBe(`# ${summary}`);
      expect(stored.memoryValue).toContain("**When to use**");
    }
  );

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
    expect(skill!.memory_value.split("\n")[0]).toBe(`# ${DIRECT_SKILL_JSON.summary}`);
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

  it("records a failed api log when a direct Skill draft fails verification", async () => {
    const { db } = await runDirectSkillEpisode({
      userId: "direct-verification-failed",
      rTask: 1,
      skillJson: { ...DIRECT_SKILL_JSON, tools: ["python", "kubectl"] }
    });
    const skillCount = db.db.prepare(`SELECT COUNT(*) AS count FROM memories WHERE memory_layer = 'Skill'`).get() as { count: number };
    expect(skillCount.count).toBe(0);
    const failureLog = db.db.prepare(
      `SELECT tool_name, success, input_json, output_json FROM api_logs
       WHERE tool_name IN ('skill_generate', 'skill_evolve') ORDER BY id DESC LIMIT 1`
    ).get() as { tool_name: string; success: number; input_json: string; output_json: string } | undefined;
    expect(failureLog).toMatchObject({ tool_name: "skill_generate", success: 0 });
    expect(JSON.parse(failureLog!.input_json)).toMatchObject({ phase: "failed", failureKind: "verification" });
    expect(JSON.parse(failureLog!.input_json).skillId).toBeUndefined();
    expect(JSON.parse(failureLog!.output_json)).toMatchObject({
      kind: "skill.direct.failed",
      reason: "tools_outside_evidence:kubectl",
      source: DIRECT_SKILL_SOURCE
    });
  });

  it("does not mark rejected direct-skill evidence as successfully processed", async () => {
    const { db, repos, complete, service } = await runDirectSkillEpisode({
      userId: "647-rejected-evidence", rTask: 1,
      skillJson: { ...DIRECT_SKILL_JSON, tools: ["python", "kubectl"] }
    });
    expect(db.db.prepare("SELECT COUNT(*) AS count FROM memories WHERE memory_layer = 'Skill'").get())
      .toEqual({ count: 0 });
    const episodeId = assignedEpisodeId(service, complete);
    const cluster = repos.runtime.getSkillClusterForEpisode(episodeId)!;
    expect(cluster.processedEpisodeIds).not.toContain(episodeId);
  });

  it("includes the final raw turn beyond 1000 turns when rebuilding revised evidence", async () => {
    const { repos, service, complete, calls } = await runDirectSkillEpisode({ userId: "647-long-task", rTask: 1 });
    const episodeId = assignedEpisodeId(service, complete);
    const template = repos.runtime.listRawTurnsByEpisode(episodeId)[0]!;
    repos.transaction(() => {
      for (let i = 0; i < 1001; i++) repos.runtime.insertRawTurn({ ...template, id: `647-extra-${i}`, turnId: `647-extra-${i}`,
        userText: i === 1000 ? "FINAL_CORRECTION_647: preserve formulas" : "continue checking workbook", createdAt: new Date(Date.parse(template.createdAt) + i + 1).toISOString() });
    });
    const cluster = repos.runtime.getSkillClusterForEpisode(episodeId)!;
    const at = new Date().toISOString();
    repos.runtime.enqueueJob({ id: "647-long-rebuild", jobType: "skill_batch_evolve", userId: cluster.userId, episodeId,
      payload: { clusterId: cluster.id }, status: "queued", attempts: 0, maxAttempts: 3, createdAt: at, updatedAt: at });
    await service.runWorkerOnce(30);
    expect(repos.runtime.getJob("647-long-rebuild")).toMatchObject({ status: "succeeded" });
    const rebuild = calls.filter(call => call.operation.startsWith("skill.batch_evolve.") && call.operation !== "skill.batch_evolve.meta").at(-1)!;
    expect(rebuild).toBeDefined();
    expect(rebuild.messages.find(message => message.role === "user")!.content).toContain("FINAL_CORRECTION_647");
  });
  it("retries a rejected draft and does not regenerate successfully processed inputs", async () => {
    const draft = { ...DIRECT_SKILL_JSON, tools: ["python", "kubectl"] };
    const { repos, complete, service, calls } = await runDirectSkillEpisode({
      userId: "647-retry-to-success", rTask: 1, skillJson: draft
    });
    const episodeId = assignedEpisodeId(service, complete);
    const cluster = repos.runtime.getSkillClusterForEpisode(episodeId)!;
    expect(cluster.processedEpisodeIds).not.toContain(episodeId);
    draft.tools = ["python"];
    async function retry(id: string) {
      const at = new Date().toISOString();
      repos.runtime.enqueueJob({ id, jobType: "skill_batch_evolve", userId: cluster.userId,
        episodeId, payload: { clusterId: cluster.id }, status: "queued", attempts: 0, maxAttempts: 3,
        createdAt: at, updatedAt: at });
      await service.runWorkerOnce(50);
      expect(repos.runtime.getJob(id)?.status).toBe("succeeded");
    }
    await retry("647-accepted-retry");
    const savedCluster = repos.runtime.getSkillCluster(cluster.id)!;
    expect(savedCluster.processedEpisodeIds).toContain(episodeId);
    expect(savedCluster.skillMemoryId).toBeTruthy();
    const savedSkill = repos.memories.get(savedCluster.skillMemoryId!)!;
    const modelCalls = calls.filter(call => call.operation.startsWith("skill.batch_evolve")).length;
    await retry("647-successful-input-repeat");
    expect(calls.filter(call => call.operation.startsWith("skill.batch_evolve"))).toHaveLength(modelCalls);
    expect(repos.memories.get(savedSkill.id)).toEqual(savedSkill);
  });

  it("suspends an outdated procedure on rejected rebuild and restores it only after a successful retry", async () => {
    const draft = { ...DIRECT_SKILL_JSON };
    const { repos, service, complete } = await runDirectSkillEpisode({ userId: "647-rebuild-suspension", rTask: 1, skillJson: draft });
    const episodeId = assignedEpisodeId(service, complete);
    const cluster = repos.runtime.getSkillClusterForEpisode(episodeId)!;
    const before = repos.memories.get(cluster.skillMemoryId!)!;
    const key = `skill-evolution:v1:${cluster.id}`;
    const completed = repos.runtime.getKv(key);
    const raw = repos.runtime.listRawTurnsByEpisode(episodeId)[0]!;
    repos.runtime.updateRawTurn({ ...raw, assistantText: "Corrected workbook procedure with openpyxl." });
    const run = async (id: string) => {
      const at = new Date().toISOString();
      repos.runtime.enqueueJob({ id, jobType: "skill_batch_evolve", userId: cluster.userId, episodeId,
        payload: { clusterId: cluster.id }, status: "queued", attempts: 0, maxAttempts: 3, createdAt: at, updatedAt: at });
      await service.runWorkerOnce(50);
      return repos.runtime.getJob(id)?.status;
    };
    draft.steps = [];
    expect(await run("647-suspended-rejected")).toBe("failed");
    expect(repos.memories.get(before.id)?.status).toBe("archived");
    expect(repos.memories.get(before.id)?.memoryValue).toBe(before.memoryValue);
    expect(repos.runtime.getKv(key)).toEqual(completed);
    draft.steps = DIRECT_SKILL_JSON.steps;
    expect(await run("647-suspended-retry")).toBe("succeeded");
    expect(repos.memories.get(before.id)?.status).toBe(before.status);
    expect(repos.memories.list({ memoryLayer: "Skill" }, 100)).toHaveLength(1);
  });

  it.each(["edit", "reclose", "write_failure"] as const)("commits direct skill and completion atomically across %s", async scenario => {
    const { db, repos, service, complete, skillLlm } = await runDirectSkillEpisode({ userId: `647-skill-${scenario}`, rTask: 1 });
    const episodeId = assignedEpisodeId(service, complete);
    const cluster = repos.runtime.getSkillClusterForEpisode(episodeId)!;
    const skill = repos.memories.get(cluster.skillMemoryId!)!;
    const completionKey = `skill-evolution:v1:${cluster.id}`;
    const completedBefore = repos.runtime.getKv(completionKey);
    const raw = repos.runtime.listRawTurnsByEpisode(episodeId)[0]!;
    repos.runtime.updateRawTurn({ ...raw, assistantText: "Updated workbook totals and checked the saved report.xlsx." });
    let enter!: () => void;
    let release!: () => void;
    const entered = new Promise<void>(resolve => { enter = resolve; });
    const gate = new Promise<void>(resolve => { release = resolve; });
    const completeJson = skillLlm.completeJson.bind(skillLlm);
    skillLlm.completeJson = async (messages, options) => {
      if (options.operation.startsWith("skill.batch_evolve") && !options.operation.endsWith(".meta")) {
        enter(); await gate;
      }
      return completeJson(messages, options);
    };
    const at = new Date().toISOString();
    const id = `647-skill-commit-${scenario}`;
    repos.runtime.enqueueJob({ id, jobType: "skill_batch_evolve", userId: cluster.userId,
      episodeId, payload: { clusterId: cluster.id }, status: "queued", attempts: 0, maxAttempts: 3,
      createdAt: at, updatedAt: at });
    const pending = service.runWorkerOnce(50);
    await Promise.race([entered, pending.then(() => { throw new Error("skill returned before model"); })]);
    const suspended = repos.memories.get(skill.id)!;
    expect(suspended.status).toBe("archived");
    expect(suspended.memoryValue).toBe(skill.memoryValue);
    if (scenario === "edit") repos.runtime.updateRawTurn({ ...raw, assistantText: "Evidence changed again during generation." });
    if (scenario === "reclose") { repos.runtime.reopenEpisode(episodeId); repos.runtime.closeEpisode(episodeId); }
    if (scenario === "write_failure") db.db.exec("CREATE TEMP TRIGGER reject_647_cluster BEFORE UPDATE ON skill_clusters BEGIN SELECT RAISE(ABORT, '647 injected cluster write failure'); END");
    release();
    await pending;
    expect(repos.runtime.getJob(id)?.status).toBe("failed");
    expect(repos.memories.get(skill.id)).toEqual(suspended);
    const { source_retirement: marker, ...unchangedStats } = suspended.properties.internal_info.skill as Record<string, unknown>;
    expect(marker).toMatchObject({ reason: "source_revision", clusterId: cluster.id });
    expect(unchangedStats).toEqual(skill.properties.internal_info.skill);
    expect(repos.runtime.getKv(completionKey)).toEqual(completedBefore);
    expect(repos.runtime.getSkillCluster(cluster.id)?.processedEpisodeIds).toEqual(cluster.processedEpisodeIds);
  });

  it.each(["archive", "trial", "new_body", "workflow", "procedure_edit"] as const)("preserves independent skill %s state during source reprocessing", async scenario => {
    const draft = { ...DIRECT_SKILL_JSON };
    const { repos, service, complete, calls } = await runDirectSkillEpisode({ userId: `647-preserve-${scenario}`, rTask: 1, skillJson: draft });
    const episodeId = assignedEpisodeId(service, complete);
    const cluster = repos.runtime.getSkillClusterForEpisode(episodeId)!;
    const skill = repos.memories.get(cluster.skillMemoryId!)!;
    const rawSkill = skill.properties.internal_info.skill as Record<string, unknown>;
    const status = scenario === "archive" ? "archived" : skill.status;
    repos.memories.update({ ...skill, status, properties: { ...skill.properties, status,
      internal_info: { ...skill.properties.internal_info,
        skill: { ...rawSkill, eta: 0.83, trials_attempted: 7, trials_passed: 6,
          ...(scenario === "procedure_edit" ? { procedure_json: { ...(rawSkill.procedure_json as Record<string, unknown>),
            summary: "User edited structured procedure" } } : {}) } } } });
    const saved = repos.memories.get(skill.id)!;
    const raw = repos.runtime.listRawTurnsByEpisode(episodeId)[0]!;
    repos.runtime.updateRawTurn({ ...raw, assistantText: "Rechecked workbook totals with openpyxl and saved report.xlsx." });
    if (scenario === "new_body") draft.trigger_context = "When filling totals in report.xlsx, verify the final saved workbook.";
    if (scenario === "workflow") draft.steps = [{ title: "Validate workbook", body: "Recheck workbook totals with openpyxl before saving report.xlsx." }];
    const beforeCalls = calls.length;
    const at = new Date().toISOString();
    const id = `647-preserve-${scenario}-job`;
    repos.runtime.enqueueJob({ id, jobType: "skill_batch_evolve", userId: cluster.userId, episodeId,
      payload: { clusterId: cluster.id }, status: "queued", attempts: 0, maxAttempts: 3, createdAt: at, updatedAt: at });
    await service.runWorkerOnce(50);
    expect(repos.runtime.getJob(id)?.status).toBe(scenario === "procedure_edit" ? "failed" : "succeeded");
    expect(repos.memories.list({ memoryLayer: "Skill" }, 100)).toHaveLength(1);
    if (scenario === "archive" || scenario === "procedure_edit") {
      expect(calls).toHaveLength(beforeCalls);
      expect(repos.memories.get(skill.id)).toEqual(saved);
    } else if (scenario === "new_body" || scenario === "workflow") {
      const revised = repos.memories.get(skill.id)!;
      expect(revised.memoryValue).not.toBe(saved.memoryValue);
      if (scenario === "workflow") {
        expect(revised.memoryValue).toContain("Recheck workbook totals");
        expect(revised.memoryValue).not.toContain("Write the totals and save");
      }
      expect(revised.properties.internal_info.skill).toMatchObject({ eta: 0.6, trials_attempted: 0, trials_passed: 0 });
      expect((revised.properties.internal_info.skill as Record<string, unknown>).content_revised_at).toBeTruthy();
      expect((revised.properties.internal_info.skill as Record<string, unknown>).eta_contributions).toMatchObject({
        bodyRevision: "direct:2", baseline: { eta: 0.6, attempts: 0, passes: 0 }, order: []
      });
    } else {
      expect(repos.memories.get(skill.id)?.properties.internal_info.skill).toMatchObject({ eta: 0.83, trials_attempted: 7, trials_passed: 6 });
    }
  });

  it("rebuilds from previously used sources beyond the selection window and removes failed anchors", async () => {
    const { repos, service, complete, calls } = await runDirectSkillEpisode({ userId: "647-full-dependencies", rTask: 0.8 });
    const episodeId = assignedEpisodeId(service, complete);
    const episode = repos.runtime.getEpisode(episodeId)!;
    const raw = repos.runtime.listRawTurnsByEpisode(episodeId)[0]!;
    const cluster = repos.runtime.getSkillClusterForEpisode(episodeId)!;
    const run = async (suffix: string) => {
      const at = new Date().toISOString();
      const id = `647-full-${suffix}`;
      repos.runtime.enqueueJob({ id, jobType: "skill_batch_evolve", userId: cluster.userId, episodeId,
        payload: { clusterId: cluster.id }, status: "queued", attempts: 0, maxAttempts: 3, createdAt: at, updatedAt: at });
      await service.runWorkerOnce(50);
      expect(repos.runtime.getJob(id)?.status).toBe("succeeded");
    };
    for (let index = 0; index < 6; index++) {
      const id = `647-other-${index}`;
      const turnId = `647-other-turn-${index}`;
      const at = new Date(Date.now() + index + 1).toISOString();
      repos.runtime.createEpisode({ ...episode, id, rTask: 1, rawTurnIds: [turnId], l1MemoryIds: [],
        skillMemoryIds: [], updatedAt: at });
      repos.runtime.insertRawTurn({ ...raw, id: turnId, turnId, episodeId: id });
      repos.runtime.upsertSkillClusterMember({ clusterId: cluster.id, episodeId: id, outcome: "success", rTask: 1, assignedAt: at });
      await run(`add-${index}`);
    }
    repos.runtime.updateRawTurn({ ...raw, assistantText: "Rechecked workbook totals with openpyxl before saving report.xlsx." });
    await run("revision");
    const generation = calls.filter(call => call.operation.startsWith("skill.batch_evolve") && !call.operation.includes("meta")).at(-1)!;
    const payload = JSON.parse(generation.messages.find(message => message.role === "user")!.content);
    expect(payload.EXISTING_SKILL_SNAPSHOT).toBeNull();
    expect(payload.EVIDENCE).toHaveLength(7);
    expect(payload.EVIDENCE.map((item: { episode_id: string }) => item.episode_id)).toContain(episodeId);
    const beforeRepeat = calls.length;
    await run("repeat");
    expect(calls).toHaveLength(beforeRepeat);
    repos.runtime.updateEpisodeReward(episodeId, { rTask: -1, rewardDetail: { source: "test" } }, new Date().toISOString());
    await run("withdraw");
    const skill = repos.memories.get(cluster.skillMemoryId!)!;
    const anchors = (skill.properties.internal_info.skill as Record<string, unknown>).evidence_anchor_ids as string[];
    expect(anchors).toHaveLength(6);
    expect(anchors).not.toContain(episodeId);
  });

  it.each(["failure", "reopen", "manual_edit"] as const)("MEMMY-647 retires the last success anchor and restores only its own retirement: %s", async scenario => {
    const { repos, service, complete, calls } = await runDirectSkillEpisode({ userId: `647-last-${scenario}`, rTask: 1 });
    const episodeId = assignedEpisodeId(service, complete);
    const cluster = repos.runtime.getSkillClusterForEpisode(episodeId)!;
    const skill = repos.memories.get(cluster.skillMemoryId!)!;
    repos.memories.update({ ...skill, properties: { ...skill.properties, internal_info: { ...skill.properties.internal_info,
      skill: { ...(skill.properties.internal_info.skill as Record<string, unknown>), eta: 0.83, trials_attempted: 7, trials_passed: 6 } } } });
    const enqueue = async (suffix: string) => {
      const at = new Date().toISOString();
      const id = `647-last-${scenario}-${suffix}`;
      repos.runtime.enqueueJob({ id, jobType: "skill_batch_evolve", userId: cluster.userId, episodeId, payload: { clusterId: cluster.id },
        status: "queued", attempts: 0, maxAttempts: 3, createdAt: at, updatedAt: at });
      await service.runWorkerOnce(50);
      expect(repos.runtime.getJob(id)?.status).toBe("succeeded");
    };
    const callCount = calls.length;
    if (scenario === "reopen") {
      const reopened = repos.runtime.reopenEpisode(episodeId)!;
      const queued = repos.runtime.getJobByDedupeKey(`skill-revalidate:${cluster.id}:${episodeId}:${reopened.meta.processingGeneration}`);
      expect(queued?.payload.reason).toBe("episode.reopened");
      await service.runWorkerOnce(50);
      expect(repos.memories.get(skill.id)?.status).toBe("archived");
    } else repos.runtime.updateEpisodeReward(episodeId, { rTask: -1, rewardDetail: { source: "647 revision" } }, new Date().toISOString());
    await enqueue("withdraw");
    const retired = repos.memories.get(skill.id)!;
    expect(retired.status).toBe("archived");
    expect(retired.memoryValue).toBe(skill.memoryValue);
    expect(retired.properties.internal_info.skill).toMatchObject({ eta: 0.83, trials_attempted: 7, trials_passed: 6 });
    expect(calls).toHaveLength(callCount);
    await enqueue("repeat-withdraw");
    expect(repos.memories.get(skill.id)).toEqual(retired);
    if (scenario === "manual_edit") repos.memories.update({ ...retired, memoryValue: "User edited the retired guide." });
    const beforeRestore = repos.memories.get(skill.id)!;
    if (scenario === "reopen") repos.runtime.closeEpisode(episodeId);
    repos.runtime.updateEpisodeReward(episodeId, { rTask: 1, rewardDetail: { source: "647 restored" } }, new Date().toISOString());
    await enqueue("restore");
    expect(repos.memories.list({ memoryLayer: "Skill" }, 100)).toHaveLength(1);
    if (scenario === "manual_edit") expect(repos.memories.get(skill.id)).toEqual(beforeRestore);
    else {
      expect(repos.memories.get(skill.id)?.status).toBe("activated");
      expect(repos.memories.get(skill.id)?.id).toBe(skill.id);
      expect(repos.memories.get(skill.id)?.properties.internal_info.skill).toMatchObject({ eta: 0.83, trials_attempted: 7, trials_passed: 6 });
    }
  });

  it("MEMMY-647 rolls back reopening when its direct skill revalidation job cannot be queued", async () => {
    const { db, repos, service, complete } = await runDirectSkillEpisode({ userId: "647-reopen-queue-failure", rTask: 1 });
    const episodeId = assignedEpisodeId(service, complete);
    const before = repos.runtime.getEpisode(episodeId);
    db.db.exec("CREATE TEMP TRIGGER reject_647_reopen_job BEFORE INSERT ON evolution_jobs WHEN NEW.job_type = 'skill_batch_evolve' BEGIN SELECT RAISE(ABORT, '647 reopen queue failure'); END");
    expect(() => repos.runtime.reopenEpisode(episodeId)).toThrow("647 reopen queue failure");
    expect(repos.runtime.getEpisode(episodeId)).toEqual(before);
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
