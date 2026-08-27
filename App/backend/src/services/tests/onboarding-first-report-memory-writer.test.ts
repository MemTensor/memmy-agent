import { describe, expect, it, vi } from "vitest";
import type { MemoryClient } from "../../adapters/outbound/memory-client/index.js";
import { createOnboardingFirstReportMemoryWriter } from "../onboarding-first-report-memory-writer.js";

type FirstReportMemoryClient = Pick<
  MemoryClient,
  "addMemory" | "enqueueImportSummaries" | "getMemoryProcessingStatus" | "runWorker" | "search"
>;

describe("onboarding first-report memory writer", () => {
  it("stores a bilingual cross-Agent memory and waits for summary and index readiness", async () => {
    const addMemory = vi.fn(async () => ({ id: "memory-first-report" }) as Awaited<ReturnType<MemoryClient["addMemory"]>>);
    const enqueueImportSummaries = vi.fn(async () => ({
      enqueued: 1,
      memoryIds: ["memory-first-report"]
    }) as Awaited<ReturnType<MemoryClient["enqueueImportSummaries"]>>);
    const states: Array<"summary_pending" | "embedding_pending" | "ready"> = [
      "summary_pending",
      "embedding_pending",
      "ready"
    ];
    const getMemoryProcessingStatus = vi.fn(async () => ({
      items: [{
        memoryId: "memory-first-report",
        state: states.shift() ?? "ready",
        attemptCount: 0,
        manualRetryCount: 0,
        retryAction: "none",
        updatedAt: "2026-08-05T10:00:00.000Z"
      }]
    }) as Awaited<ReturnType<MemoryClient["getMemoryProcessingStatus"]>>);
    const runWorker = vi.fn(async () => ({
      leased: 1,
      succeeded: 1,
      failed: 0,
      jobs: [],
      embeddingRetries: { leased: 0, succeeded: 0, failed: 0, items: [] }
    }) as Awaited<ReturnType<MemoryClient["runWorker"]>>);
    const search = vi.fn(async () => ({
      injectedContext: ""
    }) as Awaited<ReturnType<MemoryClient["search"]>>);
    const memoryClient = {
      addMemory,
      enqueueImportSummaries,
      getMemoryProcessingStatus,
      runWorker,
      search
    } satisfies FirstReportMemoryClient;
    const writer = createOnboardingFirstReportMemoryWriter(memoryClient);

    await writer.write({
      locale: "zh-CN",
      reportMarkdown: "## 你的偏好\n- 喜欢中文回答。\n\n## 接下来可以做\n1. 运行测试。",
      projects: ["Memmy"],
      keywords: ["onboarding", "Memory"],
      taskContext: {
        topic: "Memmy 初见报告接续",
        userGoal: "让其他 Agent 准确接续最近任务。",
        latestRequest: "把任务历史整理成通用轨迹摘要后写入记忆。",
        status: "active",
        currentState: "存储结构已确定，正在修改生成链路。",
        agentActions: ["已调整初见报告 prompt 和记忆格式。"],
        verifiedResults: ["初见报告记忆会在写入后立即完成摘要和索引。"],
        unresolvedItems: ["需要验证跨 Agent 召回效果。"],
        continuationPoint: "运行相关测试后模拟一次 Hermes 接续。",
        trajectorySummary: "用户从原始对话接续方案转向通用轨迹摘要；Agent 已开始调整生成和存储，下一步是验证召回。"
      },
      latestConversation: {
        agentSource: "Codex",
        conversationId: "conversation-123",
        workspacePath: "/Users/jiang/MyProject/memmy-agent-jiang"
      }
    });

    const added = addMemory.mock.calls[0]?.[0];
    expect(added).toMatchObject({
      adapterId: "agent-source:memmy-onboarding",
      source: "memmy-onboarding",
      layer: "L1",
      title: "Memmy 初见报告 — Memmy 初见报告接续",
      deferProcessing: true,
      tags: expect.arrayContaining([
        "agent-source",
        "memmy",
        "初见报告",
        "first-encounter-report",
        "cross-agent-handoff",
        "Memmy",
        "onboarding",
        "Memory"
      ])
    });
    expect(added?.content).toContain("## user\n\nMemmy 初见报告：跨 Agent 任务接续记忆");
    expect(added?.content).toContain("语言：中文");
    expect(added?.content).toContain("检索关键词：Memmy、初见报告、首次登录报告");
    expect(added?.content).toContain("请接着我刚才在 Memmy 里的初见报告继续聊天");
    expect(added?.content).toContain("任务上下文（由最近会话轨迹归纳，不含原始对话流水）");
    expect(added?.content).toContain("用户目标：让其他 Agent 准确接续最近任务。");
    expect(added?.content).toContain("任务状态：进行中");
    expect(added?.content).toContain("Agent 已执行：\n- 已调整初见报告 prompt 和记忆格式。");
    expect(added?.content).toContain("已验证结果：\n- 初见报告记忆会在写入后立即完成摘要和索引。");
    expect(added?.content).toContain("轨迹总结：");
    expect(added?.content).not.toContain("First Encounter Report");
    expect(added?.content).not.toContain("User goal");
    expect(added?.content).not.toContain("【User query / 用户请求");
    expect(added?.content).not.toContain("【Agent reply / Agent 回复");
    expect(added?.content).not.toContain("【Tool call or result / 简略工具调用");
    expect(added?.content).toContain("## assistant\n\nMemmy 初见报告");
    expect(added?.content).toContain("## 接下来可以做\n1. 运行测试。");
    expect(enqueueImportSummaries).toHaveBeenCalledWith(["memory-first-report"]);
    expect(runWorker).toHaveBeenCalledTimes(2);
    expect(runWorker).toHaveBeenCalledWith({
      limit: 4,
      targetMemoryIds: ["memory-first-report"],
      priorityCohortOnly: true,
      timeoutMs: 180_000
    });
    expect(search).toHaveBeenCalledWith({
      requestId: expect.stringMatching(/^first-report-search-log:/),
      adapterId: "agent-source:memmy-onboarding",
      source: "memmy-onboarding",
      query: "请接着我刚才在 Memmy 里的初见报告继续聊天。最近任务的项目路径是：/Users/jiang/MyProject/memmy-agent-jiang。请先在这个路径下查看项目，再告诉我我们已经确定了什么，并给出一个最合适的下一步。",
      layers: ["L1"]
    });
    expect(addMemory.mock.invocationCallOrder[0]).toBeLessThan(enqueueImportSummaries.mock.invocationCallOrder[0] ?? 0);
    expect(enqueueImportSummaries.mock.invocationCallOrder[0]).toBeLessThan(runWorker.mock.invocationCallOrder[0] ?? 0);
    expect(runWorker.mock.invocationCallOrder.at(-1) ?? 0).toBeLessThan(search.mock.invocationCallOrder[0] ?? 0);
  });
});
