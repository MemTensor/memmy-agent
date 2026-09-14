import { describe, expect, it } from "vitest";
import { deriveEpisodeStatus } from "../agent-contract/episode-status.js";
import { adaptViewerResponse } from "../viewer/src/api/memmy-adapter.js";

describe("Memmy Viewer response adapter", () => {
  it("uses the Memory service version for the Viewer version", () => {
    const result = adaptViewerResponse("GET", "/api/v1/health", undefined, {
      ok: true,
      serviceVersion: "2.1.0",
      version: "1.1.1",
      models: {},
    });

    expect(result).toMatchObject({
      instanceId: "memmy-memory-2.1.0",
      version: "2.1.0",
    });
  });

  it("keeps trace and user-memory counts separate and exposes daily activity", () => {
    const result = adaptViewerResponse("GET", "/api/v1/overview", undefined, {
      stats: {
        byLayer: { L1: 7, L2: 3, L3: 2, Skill: 4 },
        episodes: { open: 1, closed: 5 },
      },
      summary: {
        counts: { userMemories: 6 },
        dailyActivity: [
          { date: "2026-08-24", count: 2 },
          { date: "2026-08-25", count: 5 },
        ],
      },
    });

    expect(result).toMatchObject({
      traces: 7,
      userMemories: 6,
      episodes: 6,
      worldModels: 2,
      dailyActivity: [
        { date: "2026-08-24", count: 2 },
        { date: "2026-08-25", count: 5 },
      ],
    });
  });

  it("preserves the source agent on API logs", () => {
    const result = adaptViewerResponse("GET", "/api/v1/api-logs", undefined, {
      logs: [
        {
          id: 7,
          toolName: "memory_add",
          sourceAgent: "hermes",
          inputJson: { query: "我之前做过什么职业" },
          outputJson: { stored: 1 },
          durationMs: 12,
          success: true,
          calledAt: 1_788_100_000_000,
        },
      ],
      total: 1,
    }) as { logs: Array<{ sourceAgent?: string }> };

    expect(result.logs[0]?.sourceAgent).toBe("hermes");
  });

  it("preserves Memmy's episode reward skip reason and status", () => {
    const result = adaptViewerResponse("GET", "/api/v1/episodes", undefined, {
      tasks: [{
        id: "episode_7054c9fabfdae2c5330d",
        episode: {
          id: "episode_7054c9fabfdae2c5330d",
          sessionId: "session_d3f55a531fb46db00562",
          status: "closed",
          startedAt: "2026-08-31T04:15:22.647Z",
          endedAt: "2026-08-31T06:14:00.736Z",
          turnCount: 1,
          rTask: 0,
          rewardSkipped: true,
          rewardReason: "对话内容过短（35 字符），信息量不足以生成有意义的摘要。",
          closeReason: "abandoned",
          abandonReason: "对话内容过短（35 字符），信息量不足以生成有意义的摘要。",
          skillStatus: "skipped",
          skillReason: "对话轮次不足，需要至少 2 轮完整问答才能生成摘要或技能。",
        },
        turns: [{
          rawTurnId: "raw_1c3009414c9906d8517d",
          userText: "我不是程序员，我是产品经理",
          assistantText: "收到，已更新记录：你是产品经理，不是程序员。",
          createdAt: "2026-08-31T04:15:22.646Z",
        }],
        updatedAt: "2026-08-31T06:14:34.597Z",
      }],
      page: 1,
      pageSize: 20,
      total: 1,
      hasNext: false,
    }) as { episodes: Array<Record<string, unknown>> };

    expect(result.episodes[0]).toMatchObject({
      id: "episode_7054c9fabfdae2c5330d",
      rTask: 0,
      turnCount: 1,
      rewardSkipped: true,
      rewardReason: "对话内容过短（35 字符），信息量不足以生成有意义的摘要。",
      closeReason: "abandoned",
      abandonReason: "对话内容过短（35 字符），信息量不足以生成有意义的摘要。",
      skillStatus: "skipped",
      preview: "我不是程序员，我是产品经理",
      summary: "收到，已更新记录：你是产品经理，不是程序员。",
    });
    expect(deriveEpisodeStatus(result.episodes[0] as never, Date.parse("2026-08-31T07:00:00.000Z"))).toBe("skipped");
  });
});
