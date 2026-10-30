import { afterEach, describe, expect, it, vi } from "vitest";
import { MemoryDb } from "../../../src/index.js";
import { Repositories } from "../../../src/storage/repositories.js";
import { createMemoryServiceFixture } from "../../fixtures/memory-service-fixture.js";
import { createTurnJudgeLlm, l1For, turnJudgeConfig } from "./turn-judge-llm.js";

const fixture = createMemoryServiceFixture();
afterEach(() => { fixture.cleanup(); vi.useRealTimers(); });

const tasks = [
  "修复解析器：检查嵌套 JSON 的语法并验证错误定位，补充边界输入的处理。",
  "换个任务：设计数据库索引，分析用户查询的执行计划并验证读取性能。",
  "换个任务：完善部署回滚流程，验证旧版本恢复后健康检查和数据一致性。"
];
const answer = "已经完成实现及验证，检查了正常输入、异常输入和恢复路径，所有针对性检查通过，并记录了操作步骤和验证结果。";
const fourthTask = "换个任务：实现文件上传校验，检查文件类型和大小限制并验证拒绝非法输入。";
type Recovery = "normal" | "selection-failure" | "leased-restart";

function setup(enabled: boolean) {
  vi.useFakeTimers({ toFake: ["Date"] });
  vi.setSystemTime("2099-01-01T00:00:00Z");
  const { llm } = createTurnJudgeLlm(Object.fromEntries([...tasks, fourthTask].map(query => [query, () => ({
    relation: "new_task", feedback: "neutral", reason: "Independent task",
    l1: l1For(query), user: null
  })])));
  const complete = llm.completeJson;
  const calls: string[] = [];
  let failSelection = false;
  llm.completeJson = async <T extends Record<string, unknown>>(messages: Parameters<typeof complete>[0], options: Parameters<typeof complete>[1]): Promise<T> => {
    if (options.operation === "episode.select.v1" && failSelection && JSON.parse(messages[1]!.content).userText === tasks[2]) {
      throw new Error("Episode selection quota exhausted");
    }
    if (options.operation === "capture.reflection.batch.v13") {
      calls.push(options.operation);
      const input = JSON.parse(messages.find(m => m.role === "user")!.content) as { steps: Array<{ idx: number }> };
      return { scores: input.steps.map(step => ({ idx: step.idx, relevance: "PIVOTAL", reason: "Verified task result" })) } as unknown as T;
    }
    if (options.operation.startsWith("reward.")) {
      calls.push(options.operation);
      return { goal_achievement: 1, process_quality: 1, user_satisfaction: 1, label: "success", reason: "Verified task result" } as unknown as T;
    }
    return complete<T>(messages, options);
  };
  const config = turnJudgeConfig(enabled);
  config.algorithm = { ...config.algorithm, reward: { ...config.algorithm.reward, feedbackWindowSec: 1 } };
  const { service, db } = fixture.createTestService({ llm, config });
  return { service, db, config, llm, calls, repos: new Repositories(db.db), failSelection: (value: boolean) => { failSelection = value; } };
}

async function drain(service: ReturnType<typeof setup>["service"], rounds = 24) {
  for (let i = 0; i < rounds; i++) {
    vi.setSystemTime(Date.now() + 1_000);
    await service.runWorkerOnce(30);
  }
}

describe("resume all deferred Episode finalization after Session attribution drains", () => {
  it.each([true, false])("also resumes closed tasks in an open Session without rescoring them on the next sweep (%s)", async enabled => {
    const { service, repos, db, calls } = setup(enabled);
    const { sessionId } = service.openSession({});
    const saved = [];
    for (const [index, query] of tasks.entries()) saved.push(await service.completeTurn(`turn-${index}`, { sessionId, query, answer }));
    await drain(service);
    const firstTwoIds = saved.slice(0, 2).map(turn => repos.runtime.getRawTurn(turn.rawTurnId)!.episodeId!);
    for (const id of firstTwoIds) {
      expect(repos.runtime.getEpisode(id)).toMatchObject({ status: "closed", rTask: 1, rewardDetail: { phase: "final", source: "llm" } });
    }
    expect(repos.runtime.getSession(sessionId)?.status).toBe("open");
    const lastId = repos.runtime.getRawTurn(saved[2]!.rawTurnId)!.episodeId!;
    expect(repos.runtime.getEpisode(lastId)?.status).toBe("open");
    const completed = db.db.prepare("SELECT id,job_type,status FROM evolution_jobs WHERE job_type IN ('reflection','reward') ORDER BY id").all();
    expect(completed).toHaveLength(4);
    expect(calls).toHaveLength(4);

    // Close with one more accepted task pending. Its completion must revisit
    // the earlier tasks without rescoring them, and finish both remaining tasks.
    await service.completeTurn("fourth", { sessionId, episodeId: "fourth-task", query: fourthTask, answer });
    service.closeSession(sessionId);
    await drain(service);
    expect(db.db.prepare("SELECT id,job_type,status FROM evolution_jobs WHERE episode_id IN (?,?) AND job_type IN ('reflection','reward') ORDER BY id")
      .all(...firstTwoIds)).toEqual(completed);
    expect(repos.runtime.getEpisode(lastId)).toMatchObject({ status: "closed", rTask: 1 });
    expect(repos.runtime.getEpisode("fourth-task")).toMatchObject({ status: "closed", rTask: 1 });
    expect(calls).toHaveLength(8);
  });

  it.each([true, false].flatMap(enabled => [true, false].flatMap(explicitIds =>
    (["normal", "selection-failure", "leased-restart"] as Recovery[]).map(recovery => ({ enabled, explicitIds, recovery }))
  )))("finishes every closed Episode once ($enabled, explicitIds=$explicitIds, $recovery)", async ({ enabled, explicitIds, recovery }) => {
    const context = setup(enabled);
    const { db, repos, config, llm, calls } = context;
    let service = context.service;
    const { sessionId } = service.openSession({});
    const saved = [];
    for (const [index, query] of tasks.entries()) {
      saved.push(await service.completeTurn(`turn-${index}`, {
        sessionId, query, answer, ...(explicitIds ? { episodeId: `episode-${index}` } : {})
      }));
    }
    service.closeSession(sessionId);
    context.failSelection(recovery === "selection-failure");
    if (recovery !== "normal") {
      if (recovery === "leased-restart") db.db.prepare("UPDATE evolution_jobs SET available_at='2100-01-01T00:00:00.000Z' WHERE job_type='episode_assignment' AND json_extract(payload_json,'$.rawTurnId')=?").run(saved[2]!.rawTurnId);
      for (let i = 0; i < 12 && !repos.runtime.getRawTurn(saved[1]!.rawTurnId)?.episodeId; i++) await service.runWorkerOnce(30);
      expect(repos.runtime.getRawTurn(saved[1]!.rawTurnId)?.episodeId).toBeTruthy();
      expect(repos.runtime.getRawTurn(saved[2]!.rawTurnId)?.episodeId).toBeUndefined();
      expect(repos.runtime.listEpisodesForSession(sessionId)).toHaveLength(2);
      expect(db.db.prepare("SELECT count(*) AS n FROM evolution_jobs WHERE job_type IN ('reflection','reward')").get()).toEqual({ n: 0 });
      if (recovery === "selection-failure") {
        await drain(service);
        expect(db.db.prepare("SELECT status FROM evolution_jobs WHERE job_type='episode_assignment' AND json_extract(payload_json,'$.rawTurnId')=?")
          .get(saved[2]!.rawTurnId)).toEqual({ status: "dead_letter" });
      } else {
        db.db.prepare("UPDATE evolution_jobs SET available_at=NULL WHERE job_type='episode_assignment' AND json_extract(payload_json,'$.rawTurnId')=?").run(saved[2]!.rawTurnId);
        expect(repos.runtime.leaseQueuedJobs(30, 60).some(job => job.jobType === "episode_assignment")).toBe(true);
        // The previous process is gone; recover only once its leases expire.
        vi.setSystemTime(Date.now() + 60_001);
      }
      context.failSelection(false);
      service = fixture.createTestMemoryService({ db: new MemoryDb({ path: db.path }), llm, config });
      service.reconcileWorkerStartup();
    }
    await drain(service);
    const episodes = repos.runtime.listEpisodesForSession(sessionId);
    expect(episodes).toHaveLength(3);
    expect(repos.runtime.hasUnassignedTurns(sessionId)).toBe(false);
    expect(repos.runtime.getSession(sessionId)?.status).toBe("closed");
    for (const [index, turn] of saved.entries()) {
      const raw = repos.runtime.getRawTurn(turn.rawTurnId)!;
      expect(raw).toMatchObject({ userText: tasks[index], assistantText: answer });
      const episode = repos.runtime.getEpisode(raw.episodeId)!;
      expect(episode.status).toBe("closed");
      expect(episode.l1MemoryIds).toEqual([turn.l1MemoryId]);
      expect(repos.memories.get(turn.l1MemoryId)).toMatchObject({ status: "activated", info: { episode_id: episode.id } });
      const jobs = db.db.prepare("SELECT job_type,status FROM evolution_jobs WHERE episode_id=? AND job_type IN ('reflection','reward') ORDER BY job_type").all(episode.id);
      expect(jobs, `missing finalization for turn ${index}`).toEqual([
        { job_type: "reflection", status: "succeeded" }, { job_type: "reward", status: "succeeded" }
      ]);
      expect(episode.rewardDetail).toMatchObject({ phase: "final", source: "llm", traceIds: [turn.l1MemoryId] });
      expect(episode.rTask).toBe(1);
    }
    const completed = db.db.prepare("SELECT id,job_type,status FROM evolution_jobs WHERE job_type IN ('reflection','reward') ORDER BY id").all();
    const callCount = calls.length;
    for (let i = 0; i < 2; i++) {
      service.reconcileWorkerStartup();
      service.closeSession(sessionId);
      await drain(service, 4);
    }
    expect(db.db.prepare("SELECT id,job_type,status FROM evolution_jobs WHERE job_type IN ('reflection','reward') ORDER BY id").all()).toEqual(completed);
    expect(calls).toHaveLength(callCount);
    expect(db.db.prepare("SELECT count(*) AS n FROM raw_turns").get()).toEqual({ n: 3 });
    await expect(service.completeTurn("new-after-close", { sessionId, query: tasks[0]!, answer })).rejects.toThrow();
  });
});
