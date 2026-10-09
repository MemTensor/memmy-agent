import { afterEach, describe, expect, it, vi } from "vitest";
import { DEFAULT_MEMMY_CONFIG, type LlmClient, type MemoryDb, type MemoryService } from "../../src/index.js";
import {
  EpisodeTitleService,
  episodeTitleDisplayState,
  episodeTitleMeta
} from "../../src/service/episode-title/episode-title-service.js";
import { Repositories, type EvolutionJobRecord } from "../../src/storage/repositories.js";
import { createMemoryServiceFixture } from "../fixtures/memory-service-fixture.js";

const fixture = createMemoryServiceFixture();
const { createTestService } = fixture;

afterEach(() => {
  fixture.cleanup();
  vi.restoreAllMocks();
});

const FIRST_USER_TEXT = "帮我把打包脚本里的架构判断改成从 process.arch 读取，现在写死了 arm64。";
const FIRST_ASSISTANT_TEXT = "已定位到 scripts/package-mac.mjs 第 42 行的硬编码，改为读取 process.arch 后 x64 构建可以正常产出。";

function titleLlm(
  complete: LlmClient["complete"],
  model = "episode-title-test"
): LlmClient {
  return {
    config: { ...DEFAULT_MEMMY_CONFIG.summary, provider: "host", endpoint: "http://127.0.0.1/title", model },
    isConfigured: () => true,
    complete,
    completeJson: vi.fn(),
    status: () => ({ provider: "host", model, configured: true, remote: false })
  };
}

function respondWith(title: string, summary: string): {
  llm: LlmClient;
  calls: Array<{ operation: string; input: string; system: string }>;
} {
  const calls: Array<{ operation: string; input: string; system: string }> = [];
  const llm = titleLlm(async (messages, options) => {
    calls.push({
      operation: options.operation,
      input: messages.at(-1)?.content ?? "",
      system: messages.find((message) => message.role === "system")?.content ?? ""
    });
    return JSON.stringify({ title, summary });
  });
  return { llm, calls };
}

function titleJob(episodeId: string, stage: "provisional" | "final"): EvolutionJobRecord {
  return {
    id: `job_${stage}`,
    jobType: "episode_title",
    status: "leased",
    userId: "episode-title-user",
    episodeId,
    payload: { stage },
    attempts: 0,
    maxAttempts: 3,
    createdAt: "2026-01-01T00:00:00.000Z",
    updatedAt: "2026-01-01T00:00:00.000Z"
  };
}

/** One completed turn, which is what makes the episode show up in the task panel. */
function completeOneTurn(service: MemoryService, key = "episode-title"): { episodeId: string; l1MemoryIds: string[] } {
  const opened = service.openSession({ namespace: { source: "codex", profileId: "default", sessionKey: key } });
  const completed = service.completeTurn(`turn_${key}`, {
    sessionId: opened.sessionId,
    query: FIRST_USER_TEXT,
    answer: FIRST_ASSISTANT_TEXT,
    status: "succeeded"
  });
  return { episodeId: completed.episodeId, l1MemoryIds: completed.l1MemoryIds };
}

function createTitleService(db: MemoryDb, llm: LlmClient, options: {
  language?: "zh-CN" | "en-US";
  nowIso?: () => string;
} = {}): {
  repos: Repositories;
  titleService: EpisodeTitleService;
} {
  const repos = new Repositories(db.db);
  return {
    repos,
    titleService: new EpisodeTitleService({
      repos,
      llm,
      language: options.language,
      nowIso: options.nowIso ?? (() => "2026-02-02T03:04:05.000Z"),
      namespaceIdFromSession: (session) => session.id
    })
  };
}

function systemPromptOf(calls: Array<{ system: string }>): string {
  return calls[0]?.system ?? "";
}

function episodeTitleJobs(db: MemoryDb): Array<{ stage: string; status: string }> {
  return db.db.prepare(
    `SELECT json_extract(payload_json, '$.stage') AS stage, status
     FROM evolution_jobs
     WHERE job_type = 'episode_title'
     ORDER BY created_at ASC, id ASC`
  ).all() as Array<{ stage: string; status: string }>;
}

describe("episode title generation", () => {
  it("queues a provisional title job when the first turn of an episode completes", () => {
    const { db, service } = createTestService();
    completeOneTurn(service);
    expect(episodeTitleJobs(db)).toEqual([{ stage: "provisional", status: "queued" }]);
  });

  it("writes a title that describes the task instead of echoing the first user message", async () => {
    const { db, service } = createTestService();
    const { episodeId } = completeOneTurn(service);
    const { llm, calls } = respondWith("修复打包脚本架构硬编码", "将 package-mac.mjs 中写死的 arm64 改为读取 process.arch，x64 构建恢复正常。");
    const { repos, titleService } = createTitleService(db, llm);

    await titleService.generate(titleJob(episodeId, "provisional"));

    const episode = repos.runtime.getEpisode(episodeId)!;
    expect(episode.title).toBe("修复打包脚本架构硬编码");
    expect(episode.summary).toContain("process.arch");
    expect(episode.title).not.toBe(FIRST_USER_TEXT);
    expect(FIRST_USER_TEXT.startsWith(episode.title!)).toBe(false);
    expect(calls).toHaveLength(1);
    expect(calls[0]!.operation).toBe("episode_title.provisional");
    expect(episodeTitleMeta(episode)).toMatchObject({ stage: "provisional", model: "episode-title-test" });
  });

  it("still titles an episode whose L1 memories were all soft-deleted", async () => {
    const { db, service } = createTestService();
    const { episodeId, l1MemoryIds } = completeOneTurn(service);
    const { repos, titleService } = createTitleService(db, respondWith("清理墓碑 L1 的任务", "全部 L1 被拒绝捕获后仍然依据原文生成标题。").llm);
    for (const memoryId of l1MemoryIds) repos.memories.softDelete(memoryId, "2026-02-02T00:00:00.000Z");
    expect(l1MemoryIds.length).toBeGreaterThan(0);
    expect(repos.memories.get(l1MemoryIds[0]!)).toBeUndefined();

    await titleService.generate(titleJob(episodeId, "provisional"));

    expect(repos.runtime.getEpisode(episodeId)!.title).toBe("清理墓碑 L1 的任务");
  });

  it("never pulls text from memories injected into the turn by retrieval", async () => {
    const { db, service } = createTestService();
    const earlier = completeOneTurn(service, "earlier-task");
    const opened = service.openSession({ namespace: { source: "codex", profileId: "default", sessionKey: "later-task" } });
    const later = service.completeTurn("turn_later-task", {
      sessionId: opened.sessionId,
      query: "顺便帮我看看 Memory 的检索注入有没有把旧任务带进来。",
      answer: "检索注入只用于上下文，不应参与任务命名。",
      status: "succeeded",
      // Retrieval injects the earlier task's L1 here; it must not reach the title input.
      sourceMemoryIds: earlier.l1MemoryIds
    });
    const { llm, calls } = respondWith("核对检索注入边界", "确认注入记忆不参与命名。");
    const { repos, titleService } = createTitleService(db, llm);
    expect(later.episodeId).not.toBe(earlier.episodeId);
    expect(repos.runtime.getRawTurn(later.rawTurnId)!.sourceMemoryIds).toEqual(earlier.l1MemoryIds);

    await titleService.generate(titleJob(later.episodeId, "provisional"));

    const sent = calls[0]!.input;
    expect(sent).toContain("检索注入");
    expect(sent).not.toContain(FIRST_USER_TEXT);
    expect(sent).not.toContain("package-mac.mjs");
  });

  it("sends the raw turn text and omits tool payloads", async () => {
    const { db, service } = createTestService();
    const opened = service.openSession({ namespace: { source: "codex", profileId: "default", sessionKey: "tooling" } });
    const completed = service.completeTurn("turn_tooling", {
      sessionId: opened.sessionId,
      query: FIRST_USER_TEXT,
      answer: FIRST_ASSISTANT_TEXT,
      status: "succeeded",
      toolCalls: [{ id: "call-a", name: "read_file", input: { path: "scripts/package-mac.mjs" } }],
      toolResults: [{ id: "call-a", output: "const arch = \"arm64\";" }]
    });
    const { llm, calls } = respondWith("架构判断改为运行时读取", "摘要");
    const { titleService } = createTitleService(db, llm);

    await titleService.generate(titleJob(completed.episodeId, "provisional"));

    const sent = calls[0]!.input;
    expect(sent).toContain("process.arch");
    expect(sent).not.toContain("read_file");
    expect(sent).not.toContain("const arch");
  });

  it("keeps an existing title when a second provisional pass runs, and lets the final pass replace it", async () => {
    const { db, service } = createTestService();
    const { episodeId } = completeOneTurn(service);
    const provisional = respondWith("临时标题", "临时摘要");
    const { repos, titleService } = createTitleService(db, provisional.llm);
    await titleService.generate(titleJob(episodeId, "provisional"));

    await titleService.generate(titleJob(episodeId, "provisional"));
    expect(repos.runtime.getEpisode(episodeId)!.title).toBe("临时标题");
    expect(provisional.calls).toHaveLength(1);

    const final = respondWith("终版标题", "终版摘要");
    const { titleService: finalService } = createTitleService(db, final.llm);
    await finalService.generate(titleJob(episodeId, "final"));

    const episode = repos.runtime.getEpisode(episodeId)!;
    expect(episode.title).toBe("终版标题");
    expect(episodeTitleMeta(episode)?.stage).toBe("final");
    expect(final.calls).toHaveLength(1);
  });

  it("skips the model when the input fingerprint has not changed", async () => {
    const { db, service } = createTestService();
    const { episodeId } = completeOneTurn(service);
    const { llm, calls } = respondWith("单轮任务标题", "单轮任务摘要");
    const { repos, titleService } = createTitleService(db, llm);
    await titleService.generate(titleJob(episodeId, "final"));
    expect(calls).toHaveLength(1);

    await titleService.generate(titleJob(episodeId, "final"));

    expect(calls).toHaveLength(1);
    expect(repos.runtime.getEpisode(episodeId)!.title).toBe("单轮任务标题");
  });

  it("leaves the columns empty and marks the episode waiting when no model is configured", async () => {
    const { db, service } = createTestService();
    const { episodeId } = completeOneTurn(service);
    const unconfigured: LlmClient = {
      ...titleLlm(async () => { throw new Error("must not be called"); }),
      isConfigured: () => false
    };
    const { repos, titleService } = createTitleService(db, unconfigured);

    await expect(titleService.generate(titleJob(episodeId, "final"))).rejects.toThrow("summary model is not configured");

    const episode = repos.runtime.getEpisode(episodeId)!;
    expect(episode.title ?? "").toBe("");
    expect(episode.summary ?? "").toBe("");
    expect(episodeTitleMeta(episode)).toMatchObject({ stage: "skipped", reason: "unconfigured" });
    expect(episodeTitleDisplayState(episode, false)).toEqual({ titleGenerated: false, titlePending: true });
  });

  it("does not replace a generated episode title when the summary model is removed", async () => {
    const { db, service } = createTestService();
    const { episodeId } = completeOneTurn(service, "keep-generated");
    const unconfigured: LlmClient = {
      ...titleLlm(async () => { throw new Error("must not be called"); }),
      isConfigured: () => false
    };
    let now = "2026-09-22T01:00:00.000Z";
    const { repos, titleService } = createTitleService(db, unconfigured, { nowIso: () => now });
    const provisional = {
      stage: "provisional" as const,
      generatedAt: now,
      model: "mock",
      sourceTurnCount: 1,
      sourceHash: "existing-provisional"
    };
    repos.runtime.updateEpisodeTitle(episodeId, {
      title: "已生成任务标题",
      summary: "已有摘要",
      meta: { episodeTitle: provisional }
    }, now);

    await expect(titleService.generate(titleJob(episodeId, "final"))).rejects.toThrow("summary model is not configured");
    now = "2026-09-22T02:00:00.000Z";
    await expect(titleService.generate(titleJob(episodeId, "final"))).rejects.toThrow("summary model is not configured");

    const kept = repos.runtime.getEpisode(episodeId)!;
    expect(kept.title).toBe("已生成任务标题");
    expect(kept.summary).toBe("已有摘要");
    expect(episodeTitleMeta(kept)).toMatchObject(provisional);
    expect(episodeTitleDisplayState(kept, false)).toEqual({ titleGenerated: true, titlePending: false });

    const finalMeta = {
      ...provisional,
      stage: "final" as const,
      sourceHash: "existing-final"
    };
    repos.runtime.updateEpisodeTitle(episodeId, {
      title: "终版任务标题",
      summary: "终版摘要",
      meta: { episodeTitle: finalMeta }
    }, now);
    now = "2026-09-22T03:00:00.000Z";
    await expect(titleService.generate(titleJob(episodeId, "final"))).rejects.toThrow("summary model is not configured");
    const finalEpisode = repos.runtime.getEpisode(episodeId)!;
    expect(finalEpisode.title).toBe("终版任务标题");
    expect(finalEpisode.summary).toBe("终版摘要");
    expect(episodeTitleMeta(finalEpisode)).toMatchObject(finalMeta);
    expect(episodeTitleDisplayState(finalEpisode, false)).toEqual({ titleGenerated: true, titlePending: false });

    const bare = completeOneTurn(service, "repeat-unconfigured");
    await expect(titleService.generate(titleJob(bare.episodeId, "final"))).rejects.toThrow("summary model is not configured");
    const skipped = episodeTitleMeta(repos.runtime.getEpisode(bare.episodeId)!);
    now = "2026-09-22T04:00:00.000Z";
    await expect(titleService.generate(titleJob(bare.episodeId, "final"))).rejects.toThrow("summary model is not configured");
    const repeated = repos.runtime.getEpisode(bare.episodeId)!;
    expect(episodeTitleMeta(repeated)).toEqual(skipped);
    expect(repeated.title ?? "").toBe("");
    expect(episodeTitleDisplayState(repeated, false)).toEqual({ titleGenerated: false, titlePending: true });
  });

  it("rejects a model response that is missing a field instead of writing a partial row", async () => {
    const { db, service } = createTestService();
    const { episodeId } = completeOneTurn(service);
    const { repos, titleService } = createTitleService(db, titleLlm(async () => JSON.stringify({ title: "只有标题" })));

    await expect(titleService.generate(titleJob(episodeId, "final"))).rejects.toThrow();

    expect(repos.runtime.getEpisode(episodeId)!.title).toBeUndefined();
  });

  it("discards the model result when the episode gained a turn while the call was in flight", async () => {
    const { db, service } = createTestService();
    const opened = service.openSession({ namespace: { source: "codex", profileId: "default", sessionKey: "racing" } });
    const first = service.completeTurn("turn_racing_1", {
      sessionId: opened.sessionId, query: FIRST_USER_TEXT, answer: FIRST_ASSISTANT_TEXT, status: "succeeded"
    });
    const slowLlm = titleLlm(async () => {
      service.completeTurn("turn_racing_2", {
        sessionId: opened.sessionId,
        query: "再顺手把 x64 的构建也验证一遍。",
        answer: "x64 构建同样通过，两种架构都已确认。",
        status: "succeeded",
        episodeId: first.episodeId
      });
      return JSON.stringify({ title: "过期标题", summary: "只覆盖了第一轮的结论。" });
    });
    const { repos, titleService } = createTitleService(db, slowLlm);

    await expect(titleService.generate(titleJob(first.episodeId, "final")))
      .rejects.toThrow(/input changed during generation/u);

    expect(repos.runtime.getEpisode(first.episodeId)!.title).toBeUndefined();
  });

  it("keeps the real ending of an episode longer than the input window", async () => {
    const { db, service } = createTestService();
    const opened = service.openSession({ namespace: { source: "codex", profileId: "default", sessionKey: "long" } });
    let episodeId = "";
    for (let turn = 1; turn <= 34; turn += 1) {
      const completed = service.completeTurn(`turn_long_${turn}`, {
        sessionId: opened.sessionId,
        query: `第 ${turn} 轮的问题`,
        answer: turn === 34 ? "最后一轮的结论：迁移已全部完成。" : `第 ${turn} 轮的回答`,
        status: "succeeded",
        ...(episodeId ? { episodeId } : {})
      });
      episodeId = completed.episodeId;
    }
    const { llm, calls } = respondWith("长任务标题", "长任务摘要");
    const { repos, titleService } = createTitleService(db, llm);
    expect(repos.runtime.countRawTurnsByEpisode(episodeId)).toBe(34);

    await titleService.generate(titleJob(episodeId, "final"));

    const sent = calls[0]!.input;
    // Head keeps turns 1-15, tail keeps 20-34, so the four middle turns drop out.
    expect(sent).toContain("最后一轮的结论");
    expect(sent).toContain("第 1 轮的问题");
    expect(sent).toContain("第 20 轮的问题");
    expect(sent).not.toContain("第 17 轮的问题");
    expect(sent).toContain("\"omittedTurnCount\":4");
    // Recorded against the episode's real length, so the re-enqueue guard stays exact.
    expect(episodeTitleMeta(repos.runtime.getEpisode(episodeId)!)?.sourceTurnCount).toBe(34);
  });

  it("does not queue another final job once one succeeded over the same turns", () => {
    const { db, service } = createTestService();
    const opened = service.openSession({ namespace: { source: "codex", profileId: "default", sessionKey: "requeue" } });
    const completed = service.completeTurn("turn_requeue", {
      sessionId: opened.sessionId, query: FIRST_USER_TEXT, answer: FIRST_ASSISTANT_TEXT, status: "succeeded"
    });
    const repos = new Repositories(db.db);
    repos.runtime.updateEpisodeTitle(completed.episodeId, {
      title: "已生成的终版标题",
      summary: "已生成的终版摘要",
      meta: {
        episodeTitle: {
          stage: "final",
          generatedAt: "2026-02-02T03:04:05.000Z",
          model: "episode-title-test",
          sourceTurnCount: repos.runtime.countRawTurnsByEpisode(completed.episodeId),
          sourceHash: "hash"
        }
      }
    });
    const before = episodeTitleJobs(db).length;

    service.closeSession(opened.sessionId, {});

    expect(episodeTitleJobs(db)).toHaveLength(before);
  });

  it("is queued ahead of background evolution work", () => {
    const { db, service } = createTestService();
    const { episodeId } = completeOneTurn(service);
    // The worker leases a single priority cohort per round, so a title ranked below
    // a stalled background job would never get its turn while that job keeps failing.
    db.db.prepare(
      `INSERT INTO evolution_jobs (
        id, job_type, status, user_id, episode_id, payload_json,
        attempts, max_attempts, created_at, updated_at
      ) VALUES (?, 'project_environment_profile', 'queued', ?, ?, '{}', 2, 3, ?, ?)`
    ).run("job_stalled_profile", "episode-title-user", episodeId, "2026-01-01T00:00:00.000Z", "2026-01-01T00:00:00.000Z");

    const ordered = new Repositories(db.db).runtime.leaseQueuedJobs(50, 60).map((job) => job.jobType);

    expect(ordered.indexOf("episode_title")).toBeGreaterThanOrEqual(0);
    expect(ordered.indexOf("episode_title")).toBeLessThan(ordered.indexOf("project_environment_profile"));
  });

  it("steers the model to Chinese for a Chinese task that quotes code", async () => {
    const { db, service } = createTestService();
    const { episodeId } = completeOneTurn(service);
    const { llm, calls } = respondWith("修复架构硬编码", "改为读取 process.arch。");
    const { titleService } = createTitleService(db, llm);

    await titleService.generate(titleJob(episodeId, "provisional"));

    expect(systemPromptOf(calls)).toContain("Simplified Chinese");
  });

  it("follows the interface language the host app is set to, over the language of the turns", async () => {
    const { db, service } = createTestService();
    const { episodeId } = completeOneTurn(service);
    const { llm, calls } = respondWith("Fix packaging arch", "Read process.arch instead.");
    const { titleService } = createTitleService(db, llm, { language: "en-US" });

    await titleService.generate(titleJob(episodeId, "provisional"));

    // The turns are Chinese, but the user reads the app in English.
    expect(systemPromptOf(calls)).toContain("English");
    expect(systemPromptOf(calls)).not.toContain("Simplified Chinese");
  });

  it("falls back to the language of the turns when the host pins none", async () => {
    const { db, service } = createTestService();
    const { episodeId } = completeOneTurn(service);
    const { llm, calls } = respondWith("修复架构硬编码", "改为读取 process.arch。");
    const { titleService } = createTitleService(db, llm, { language: undefined });

    await titleService.generate(titleJob(episodeId, "provisional"));

    expect(systemPromptOf(calls)).toContain("Simplified Chinese");
  });

  it("queues the final title job even when the closing episode also schedules reflection or reward", () => {
    const { db, service } = createTestService();
    const opened = service.openSession({ namespace: { source: "codex", profileId: "default", sessionKey: "closing" } });
    service.completeTurn("turn_closing", {
      sessionId: opened.sessionId,
      query: FIRST_USER_TEXT,
      answer: FIRST_ASSISTANT_TEXT,
      status: "succeeded"
    });
    service.closeSession(opened.sessionId, {});

    const stages = episodeTitleJobs(db).map((job) => job.stage);
    expect(stages).toContain("provisional");
    expect(stages).toContain("final");
    const followUps = db.db.prepare(
      `SELECT COUNT(*) AS count FROM evolution_jobs WHERE job_type IN ('reflection', 'reward')`
    ).get() as { count: number };
    expect(followUps.count).toBeGreaterThan(0);
  });

  it("generates a held title job after the summary model is configured", async () => {
    let configured = false;
    const llm = titleLlm(async () => JSON.stringify({ title: "恢复后的标题", summary: "恢复后的摘要" }));
    llm.isConfigured = () => configured;
    const { service } = createTestService({ llm });
    const opened = service.openSession({ namespace: { source: "codex", profileId: "default", sessionKey: "recover-title" } });
    const completed = service.completeTurn("turn_recover-title", {
      sessionId: opened.sessionId,
      query: FIRST_USER_TEXT,
      answer: FIRST_ASSISTANT_TEXT,
      status: "succeeded"
    });
    service.closeSession(opened.sessionId, {});
    await service.runWorkerOnce(20);
    const waiting = service.panelTasks({}).tasks.find((task) => task.id === completed.episodeId);
    expect(waiting?.episode.titlePending).toBe(true);
    expect(waiting?.episode.title ?? "").toBe("");

    configured = true;
    await service.runWorkerOnce(20);
    const ready = service.panelTasks({}).tasks.find((task) => task.id === completed.episodeId);
    expect(ready?.episode.title).toBe("恢复后的标题");
    expect(ready?.episode.summary).toBe("恢复后的摘要");
    expect(ready?.episode.titlePending).toBe(false);
    await service.runWorkerOnce(20);
    const jobs = service.panelJobs({}).items.filter((job) => job.jobType === "episode_title" && job.status === "queued");
    expect(jobs).toEqual([]);
  });

  it("treats a queued title job as waiting and an old episode without meta as ready fallback", () => {
    const oldEpisode = {
      title: undefined,
      summary: undefined,
      meta: {}
    } as Parameters<typeof episodeTitleDisplayState>[0];
    expect(episodeTitleDisplayState(oldEpisode, false)).toEqual({ titleGenerated: false, titlePending: false });
    expect(episodeTitleDisplayState(oldEpisode, true)).toEqual({ titleGenerated: false, titlePending: true });
    expect(episodeTitleDisplayState({
      ...oldEpisode,
      meta: { episodeTitle: { stage: "final", generatedAt: "", model: "x", sourceTurnCount: 1, sourceHash: "abc" } }
    } as Parameters<typeof episodeTitleDisplayState>[0], true)).toEqual({ titleGenerated: true, titlePending: false });
  });
});
