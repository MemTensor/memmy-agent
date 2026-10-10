import { afterEach, describe, expect, it } from "vitest";
import { DEFAULT_MEMMY_CONFIG, type LlmClient } from "../../../src/index.js";
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

function createDirectSkillLlm(calls: DirectSkillCall[]): LlmClient {
  return {
    config: {
      ...DEFAULT_MEMMY_CONFIG.evolution,
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
      calls.push({ operation: options.operation, messages });
      if (options.operation.startsWith("skill.batch_evolve.meta")) {
        return {
          reasoning: "ground steps in openpyxl",
          meta_skill_content: "Keep steps on openpyxl load/save. Failures only go to anti_pattern."
        } as unknown as T;
      }
      if (options.operation.startsWith("skill.batch_evolve")) {
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
  config?: typeof DEFAULT_MEMMY_CONFIG;
}) {
  const calls: DirectSkillCall[] = [];
  const { db, service } = createTestService({ skillLlm: createDirectSkillLlm(calls), config: input.config });
  const session = service.openSession({
    namespace: { source: "codex", profileId: "jiang", userId: input.userId }
  });
  const complete = service.completeTurn(`${input.userId}-turn`, {
    sessionId: session.sessionId,
    query: input.query ?? "fill totals in report.xlsx with python openpyxl",
    answer: input.answer ?? "Opened report.xlsx with openpyxl and wrote the totals.",
    toolCalls: [{
      name: "python",
      input: { command: "openpyxl.load_workbook('report.xlsx')" },
      output: { ok: true },
      success: true
    }]
  });
  const repos = new Repositories(db.db);
  const at = new Date().toISOString();
  db.db.prepare(`UPDATE episodes SET status = 'closed', closed_at = ?, updated_at = ? WHERE id = ?`)
    .run(at, at, complete.episodeId);
  repos.runtime.updateEpisodeReward(complete.episodeId, {
    rTask: input.rTask,
    rewardDetail: { source: "test" }
  }, at);
  repos.runtime.enqueueJob({
    id: `job_${input.userId}`,
    jobType: "skill_cluster_assign",
    status: "queued",
    userId: input.userId,
    sessionId: session.sessionId,
    episodeId: complete.episodeId,
    payload: { reason: "test" },
    attempts: 0,
    maxAttempts: 3,
    createdAt: at,
    updatedAt: at
  });
  await runWorkerRounds(service, 4, 20);
  return { db, service, complete, calls, repos: new Repositories(db.db) };
}

describe("MemoryService / evolution / skill cluster", () => {
  it.each([
    { language: "zh-CN", outputLanguageMode: "follow_policy", expected: "zh" },
    { language: "en-US", outputLanguageMode: "follow_policy", expected: "en" },
    { language: "zh-CN", outputLanguageMode: "en", expected: "en" },
    { language: "en-US", outputLanguageMode: "zh", expected: "zh" }
  ] as const)("uses $expected for interface $language and skill mode $outputLanguageMode", async ({
    language, outputLanguageMode, expected
  }) => {
    const { calls } = await runDirectSkillEpisode({
      userId: `skill-language-${language}-${outputLanguageMode}`,
      rTask: 1,
      config: {
        ...DEFAULT_MEMMY_CONFIG,
        language,
        algorithm: {
          ...DEFAULT_MEMMY_CONFIG.algorithm,
          skill: { ...DEFAULT_MEMMY_CONFIG.algorithm.skill, outputLanguageMode }
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
        : "All natural-language answers MUST be in English.");
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
        ...DEFAULT_MEMMY_CONFIG,
        algorithm: {
          ...DEFAULT_MEMMY_CONFIG.algorithm,
          capture: {
            ...DEFAULT_MEMMY_CONFIG.algorithm.capture,
            synthReflection: false,
            embedAfterCapture: false,
            alphaScoring: false
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
    const complete = service.completeTurn(`${userId}-turn`, {
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
    });
    await service.feedback({
      sessionId: session.sessionId,
      episodeId: complete.episodeId,
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
    ).get(complete.episodeId) as { r_task: number | null };
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
          ...DEFAULT_MEMMY_CONFIG.embedding,
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
    const first = service.completeTurn(`${userId}-lookup`, {
      sessionId: firstSession.sessionId,
      query: "fix INDEX MATCH lookup in report.xlsx",
      answer: "Opened report.xlsx with openpyxl and rewrote the lookup.",
      toolCalls: [{
        name: "python",
        input: { command: "openpyxl.load_workbook('report.xlsx')" },
        output: { ok: true },
        success: true
      }]
    });
    const second = service.completeTurn(`${userId}-delete`, {
      sessionId: secondSession.sessionId,
      query: "delete filtered rows from report.xlsx",
      answer: "Opened report.xlsx and deleted the matching rows.",
      toolCalls: [{
        name: "python",
        input: { command: "openpyxl.load_workbook('report.xlsx')" },
        output: { ok: true },
        success: true
      }]
    });
    const repos = new Repositories(db.db);
    const at = new Date().toISOString();
    const pairs = [
      { episodeId: first.episodeId, sessionId: firstSession.sessionId },
      { episodeId: second.episodeId, sessionId: secondSession.sessionId }
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
