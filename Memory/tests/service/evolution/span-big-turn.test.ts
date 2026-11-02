import { Repositories } from "../../../src/storage/repositories.js";
import { assignedEpisodeId, settleCaptureAssignments } from "../../fixtures/memory-service-fixture.js";
import { LEGACY_TEST_CONFIG } from "../../fixtures/memory-service-fixture.js";
import { afterEach, describe, expect, it, vi } from "vitest";
import { type LlmClient, type LlmCompletionOptions, type LlmMessage } from "../../../src/index.js";
import { DEFAULT_MEMMY_CONFIG } from "../../../src/index.js";
import {
  createCapturingEmbedder,
  createMemoryServiceFixture,
  runWorkerRounds
} from "../../fixtures/memory-service-fixture.js";

const {
  cleanup,
  createTestService
} = createMemoryServiceFixture();

afterEach(() => { vi.useRealTimers(); cleanup(); });

function createSpanBigTurnLlm(
  calls: Array<{ messages: LlmMessage[]; options: LlmCompletionOptions }>,
  spanResult: Record<string, unknown> | Array<Record<string, unknown>> = {
    shouldSplit: false,
    reason: "即使 shouldSplit 冲突，也以非空 spans 为准",
    spans: [
      {
        start: 0,
        end: 3,
        spanGoal: "定位构建失败的根本原因",
        summary: "检查日志和依赖配置，确认失败来自版本冲突"
      },
      {
        start: 4,
        end: 7,
        spanGoal: "修复依赖版本冲突",
        summary: "调整依赖版本和构建配置，消除不兼容引用"
      },
      {
        start: 9,
        end: 10,
        spanGoal: "验证修复后的构建结果",
        summary: "重新执行构建与测试并确认成功"
      }
    ]
  }
): LlmClient {
  let spanCallIndex = 0;
  return {
    config: {
      ...LEGACY_TEST_CONFIG.summary,
      provider: "host",
      endpoint: "http://127.0.0.1/span-big-turn",
      model: "span-big-turn"
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
      if (options.operation === "episode.select.v1") return { episodeId: null, title: "Test task", summary: "Test task summary" } as unknown as T;
      calls.push({ messages, options });
      if (options.operation === "capture.reflection.batch.v13") {
        const payload = JSON.parse(messages.at(-1)?.content ?? "{}") as {
          steps?: Array<{ idx: number }>;
        };
        return {
          scores: (payload.steps ?? []).map(({ idx }) => ({
            idx,
            relevance: "PIVOTAL",
            reason: "complex task completed"
          }))
        } as unknown as T;
      }
      if (options.operation === "capture.summarize") {
        const payload = messages.find((message) => message.role === "user")?.content ?? "";
        const userQuote = payload.match(/\bUSER:\s*(.*?)\s+ASSISTANT:/)?.[1]?.trim() ?? "";
        return {
          l1: {
            title: "定位并修复构建失败",
            summary: "定位构建失败、修改依赖配置并验证修复结果",
            evidence: [{ quote: userQuote, role: "user", kind: "task_outcome" }]
          },
          user: null
        } as unknown as T;
      }
      if (options.operation === "reward.reward.r_human.v7") {
        return {
          goal_achievement: 1,
          process_quality: 0.9,
          user_satisfaction: 1,
          reason: "复杂开发任务已完成"
        } as unknown as T;
      }
      if (options.operation === "span.big_turn.v1") {
        const selected = Array.isArray(spanResult)
          ? spanResult[Math.min(spanCallIndex, spanResult.length - 1)] ?? {}
          : spanResult;
        spanCallIndex += 1;
        return selected as T;
      }
      return {} as T;
    },
    status() {
      return {
        provider: "host",
        model: "span-big-turn",
        configured: true,
        remote: true
      };
    }
  };
}

describe("MemoryService / evolution / span big turn", () => {
  it("stores, recalls, and deletes subtask spans with their task", async () => {
    const calls: Array<{ messages: LlmMessage[]; options: LlmCompletionOptions }> = [];
    const embeddedTexts: string[] = [];
    const embeddedRoles: Array<"query" | "document" | undefined> = [];
    const llm = createSpanBigTurnLlm(calls);
    const config = {
      ...LEGACY_TEST_CONFIG,
      algorithm: {
        ...LEGACY_TEST_CONFIG.algorithm,
        retrieval: {
          ...LEGACY_TEST_CONFIG.algorithm.retrieval,
          relativeThresholdFloor: 0,
          smartSeed: false,
          llmFilterEnabled: false
        }
      }
    };
    const { db, service } = createTestService({
      config,
      llm,
      skillLlm: llm,
      embedder: createCapturingEmbedder(embeddedTexts, embeddedRoles)
    });
    const namespace = {
      source: "codex",
      profileId: "jiang",
      userId: "span-big-turn-user"
    };
    const session = service.openSession({ namespace });
    const toolCalls = Array.from({ length: 11 }, (_, index) => ({
      id: `tool-${index}`,
      name: index < 4 ? "read_file" : index < 8 ? "apply_patch" : "run_tests",
      input: index === 0
        ? {
            index,
            apiKey: "sk-supersecret123456",
            token: "private-token-value",
            password: "private-password-value",
            note: "password: \"quoted-password-value\""
          }
        : { index }
    }));
    const toolResults = toolCalls.map((call, index) => ({
      toolCallId: call.id,
      name: call.name,
      output: index === 0
        ? {
            ok: true,
            index,
            authorization: "Bearer private-bearer-token",
            secret: "private-secret-value"
          }
        : { ok: true, index }
    }));
    const completed = (await service.completeTurn("span-big-turn", {
      namespace,
      sessionId: session.sessionId,
      query: "修复项目构建失败并完成测试验证",
      answer: "已经定位依赖冲突，完成修复并通过构建与测试。",
      toolCalls,
      toolResults
    }));
    const invalidToolCall = `invalid-${"x".repeat(140)}`;
    const rawToolCalls: unknown[] = [...toolCalls];
    rawToolCalls[5] = invalidToolCall;
    db.db.prepare(
      `UPDATE raw_turns
       SET tool_calls_json = ?
       WHERE id = ?`
    ).run(JSON.stringify(rawToolCalls), completed.rawTurnId);

    service.closeSession(session.sessionId);
    await settleCaptureAssignments(service);
    await service.feedback({
      namespace,
      sessionId: session.sessionId,
      episodeId: assignedEpisodeId(service, completed),
      l1MemoryId: completed.l1MemoryId,
      channel: "explicit",
      polarity: "positive",
      magnitude: 1,
      rationale: "复杂任务已经正确完成"
    });
    vi.useFakeTimers({ toFake: ["Date"] });
    vi.setSystemTime(Date.now() + 31_000);
    await runWorkerRounds(service, 8);

    const spanCall = calls.find((call) => call.options.operation === "span.big_turn.v1");
    expect(JSON.stringify(service.panelJobs({ userId: namespace.userId }).items)).toContain(
      '"jobType":"span_big_turn","status":"succeeded"'
    );
    expect(JSON.stringify(calls.map((call) => call.options.operation))).toContain("span.big_turn.v1");
    expect(spanCall?.options).toMatchObject({
      thinkingMode: "disabled",
      temperature: 0.6,
      maxTokens: 4096
    });
    expect(spanCall?.messages[0]?.content).toContain("Spans must not overlap");
    expect(spanCall?.messages[0]?.content).toContain("may remain outside all spans");
    expect(spanCall?.messages[0]?.content).toContain("Use that one language for both fields");
    expect(spanCall?.messages[0]?.content).not.toContain("same language as the user's request");
    expect(spanCall?.messages[1]?.content).toContain("Simplified Chinese");
    const spanPayload = JSON.parse(
      spanCall?.messages.find((message) => message.role === "user")?.content ?? "{}"
    ) as {
      userRequest?: string;
      assistantFinalAnswer?: string;
      traceSummary?: string;
      reflection?: string;
      reward?: { rTask?: number; reason?: string };
      toolCalls?: Array<{ index: number; name?: string; raw?: string }>;
    };
    expect(spanPayload).toMatchObject({
      userRequest: "修复项目构建失败并完成测试验证",
      assistantFinalAnswer: "已经定位依赖冲突，完成修复并通过构建与测试。",
      traceSummary: "定位构建失败、修改依赖配置并验证修复结果",
      reward: {
        rTask: 0.97,
        reason: "复杂开发任务已完成"
      }
    });
    expect(spanPayload.reflection).toBeTruthy();
    expect(spanPayload.toolCalls).toHaveLength(11);
    expect(spanPayload.toolCalls?.map((call) => call.index)).toEqual(
      Array.from({ length: 11 }, (_, index) => index)
    );
    expect(spanPayload.toolCalls?.[5]?.raw).toHaveLength(100);
    expect(spanPayload.toolCalls?.[5]?.raw).toMatch(/^"invalid-/);
    expect(spanPayload.toolCalls?.[5]?.raw).toMatch(/\.\.\.$/);
    const serializedSpanPrompt =
      spanCall?.messages.find((message) => message.role === "user")?.content ?? "";
    expect(serializedSpanPrompt).toContain("[redacted]");
    expect(serializedSpanPrompt).not.toContain("sk-supersecret123456");
    expect(serializedSpanPrompt).not.toContain("private-token-value");
    expect(serializedSpanPrompt).not.toContain("private-password-value");
    expect(serializedSpanPrompt).not.toContain("quoted-password-value");
    expect(serializedSpanPrompt).not.toContain("private-bearer-token");
    expect(serializedSpanPrompt).not.toContain("private-secret-value");
    const recall = await service.search({
      namespace,
      query: "定位构建失败的根本原因",
      layers: ["L1"],
      includeInjectedContext: true
    });
    expect(recall.hits).toEqual(expect.arrayContaining([
      expect.objectContaining({
        kind: "span",
        title: "定位构建失败的根本原因",
        snippet: expect.stringContaining("确认失败来自版本冲突")
      })
    ]));
    expect(recall.injectedContext.markdown).toContain("定位构建失败的根本原因");
    expect(recall.injectedContext.markdown).toContain("确认失败来自版本冲突");
    const semanticRecall = await service.search({
      namespace,
      query: "zebra orchard moonlight",
      layers: ["L1"]
    });
    expect(semanticRecall.hits).toEqual(expect.arrayContaining([
      expect.objectContaining({
        kind: "span",
        title: "定位构建失败的根本原因"
      })
    ]));
    expect(semanticRecall.hits.map((hit) => hit.id)).not.toContain(completed.l1MemoryId);
    expect(semanticRecall.hits.filter((hit) => hit.kind === "span").length).toBeLessThanOrEqual(2);
    expect(embeddedTexts.some((text, index) =>
      embeddedRoles[index] === "document" &&
      text.includes("定位构建失败的根本原因") &&
      text.includes("确认失败来自版本冲突")
    )).toBe(true);
    expect(service.panelItems({ namespace, layer: "L1" }).items.some(item => item.kind === "span")).toBe(false);
    const l1Items = storedL1Items(db);
    expect(l1Items).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ title: "定位构建失败的根本原因" }),
        expect.objectContaining({ title: "修复依赖版本冲突" }),
        expect.objectContaining({ title: "验证修复后的构建结果" })
      ])
    );
    expect(l1Items.filter((item) => item.kind === "span")).toHaveLength(3);
    const parentRow = db.db.prepare(
      `SELECT properties_json FROM memories WHERE id = ?`
    ).get(completed.l1MemoryId) as { properties_json: string };
    const parentProperties = JSON.parse(parentRow.properties_json) as {
      internal_info: {
        trace: {
          span_ids?: string[];
        };
      };
    };
    const storedSpanIds = l1Items
      .filter((item) => item.kind === "span")
      .map((item) => item.id);
    expect(parentProperties.internal_info.trace.span_ids).toHaveLength(3);
    expect(parentProperties.internal_info.trace.span_ids).toEqual(
      expect.arrayContaining(storedSpanIds)
    );
    const firstSpanId = l1Items.find((item) => item.title === "定位构建失败的根本原因")?.id;
    const spanDetail = service.getMemory(firstSpanId!, { namespace }) as {
      item: { metadata: { spanDetail?: { toolCallStart?: number; toolCallEnd?: number; toolCalls?: Array<{ id?: string }> } } };
    };
    expect(spanDetail.item.metadata.spanDetail).toMatchObject({
      toolCallStart: 0,
      toolCallEnd: 3,
      toolCalls: toolCalls.slice(0, 4).map(({ id, name, input }) => ({ id, name, input }))
    });
    expect(completed.l1MemoryIds).toHaveLength(1);

    const deleted = service.deletePanelTask(assignedEpisodeId(service, completed), { namespace });
    expect(new Set(deleted.deletedMemoryIds)).toEqual(new Set([
      completed.l1MemoryId,
      ...storedSpanIds
    ]));
    expect(service.panelTasks({ namespace, page: 1 }).tasks).toHaveLength(0);
    expect(service.panelItems({ namespace, layer: "L1" }).items).toHaveLength(0);
    expect(() => service.getMemory(firstSpanId!, { namespace })).toThrow(/not found/i);
    db.close();
  });

  it.each([
    { name: "after the parent trace was deleted", deleteParent: true, splitAgain: false },
    { name: "after a second successful split with different ranges", deleteParent: false, splitAgain: true },
    { name: "after both re-splitting and deleting the parent", deleteParent: true, splitAgain: true }
  ])("deletes all task spans $name", async ({ deleteParent, splitAgain }) => {
    const calls: Array<{ messages: LlmMessage[]; options: LlmCompletionOptions }> = [];
    const firstSplit = {
      spans: [
        { start: 0, end: 3, spanGoal: "分析构建问题", summary: "检查构建日志" },
        { start: 4, end: 7, spanGoal: "修改构建配置", summary: "修复依赖冲突" },
        { start: 8, end: 10, spanGoal: "验证构建结果", summary: "执行测试验证" }
      ]
    };
    const secondSplit = {
      spans: [
        { start: 0, end: 6, spanGoal: "分析并修改构建配置", summary: "定位并修复问题" },
        { start: 7, end: 10, spanGoal: "重新验证构建结果", summary: "完成测试验证" }
      ]
    };
    const llm = createSpanBigTurnLlm(calls, [firstSplit, secondSplit, firstSplit]);
    const config = {
      ...LEGACY_TEST_CONFIG,
      algorithm: {
        ...LEGACY_TEST_CONFIG.algorithm,
        retrieval: {
          ...LEGACY_TEST_CONFIG.algorithm.retrieval,
          relativeThresholdFloor: 0,
          smartSeed: false,
          llmFilterEnabled: false
        }
      }
    };
    const { db, service } = createTestService({ config, llm, skillLlm: llm });
    const namespace = { source: "codex", profileId: "cascade", userId: "cascade-review" };
    async function createTask(requestId: string) {
      const session = service.openSession({ namespace });
      const toolCalls = Array.from({ length: 11 }, (_, index) => ({
        id: `${requestId}-${index}`, name: "task_step", input: { index }
      }));
      const completed = await service.completeTurn(requestId, {
        namespace, sessionId: session.sessionId,
        query: "分析构建问题、修改配置并验证结果",
        answer: "已完成分析、修复和验证。",
        toolCalls,
        toolResults: toolCalls.map((call) => ({
          toolCallId: call.id, name: call.name, output: { ok: true }
        }))
      });
      service.closeSession(session.sessionId);
      return { ...completed, sessionId: session.sessionId };
    }
    async function reward(task: Awaited<ReturnType<typeof createTask>>) {
      await service.feedback({
        namespace, sessionId: task.sessionId, episodeId: task.episodeId,
        l1MemoryId: task.l1MemoryId, channel: "explicit", polarity: "positive",
        magnitude: 1, rationale: "构建修复正确"
      });
      vi.useFakeTimers({ toFake: ["Date"] });
    vi.setSystemTime(Date.now() + 31_000);
    await runWorkerRounds(service, 8);
    }
    function spanIds(episodeId: string): string[] {
      return (db.db.prepare(`SELECT id FROM memories
        WHERE json_extract(properties_json, '$.internal_info.memory_kind') = 'span'
          AND json_extract(properties_json, '$.internal_info.span.episode_id') = ?
          AND deleted_at IS NULL`).all(episodeId) as Array<{ id: string }>).map((row) => row.id);
    }
    const task = await createTask("cascade-target");
    await reward(task);
    const originalSpans = spanIds(assignedEpisodeId(service, task));
    expect(originalSpans).toHaveLength(3);
    if (splitAgain) {
      await reward(task);
      expect(calls.filter((call) => call.options.operation === "span.big_turn.v1")).toHaveLength(2);
      const parent = db.db.prepare("SELECT properties_json FROM memories WHERE id = ?")
        .get(task.l1MemoryId) as { properties_json: string };
      const latestIds = JSON.parse(parent.properties_json).internal_info.trace.span_ids as string[];
      expect(latestIds).toHaveLength(2);
      expect(latestIds.every((id) => !originalSpans.includes(id))).toBe(true);
    }
    const targetIds = spanIds(assignedEpisodeId(service, task));
    expect(targetIds).toHaveLength(splitAgain ? 5 : 3);
    const control = await createTask("cascade-control");
    await reward(control);
    const controlIds = spanIds(assignedEpisodeId(service, control));
    expect(controlIds.length).toBeGreaterThan(0);
    const controlBefore = db.db.prepare("SELECT * FROM memories WHERE id IN (SELECT value FROM json_each(?))")
      .all(JSON.stringify(controlIds));
    const countVectors = (ids: string[]) => (db.db.prepare(
      "SELECT count(*) AS count FROM memory_vector_entries WHERE memory_id IN (SELECT value FROM json_each(?))"
    ).get(JSON.stringify(ids)) as { count: number }).count;
    expect(countVectors(targetIds)).toBeGreaterThan(0);
    const controlVectorCount = countVectors(controlIds);
    if (deleteParent) service.deleteMemory(task.l1MemoryId!, { namespace });

    const deleted = service.deletePanelTask(assignedEpisodeId(service, task), { namespace });
    expect(new Set(deleted.deletedMemoryIds)).toEqual(new Set([
      ...targetIds, ...(deleteParent ? [] : [task.l1MemoryId])
    ]));
    expect(db.db.prepare("SELECT id FROM episodes WHERE id = ?").get(task.episodeId)).toBeUndefined();
    expect(db.db.prepare("SELECT id FROM raw_turns WHERE id = ?").get(task.rawTurnId)).toBeUndefined();
    for (const id of [...targetIds, task.l1MemoryId!]) {
      expect(db.db.prepare("SELECT status, deleted_at FROM memories WHERE id = ?").get(id))
        .toEqual({ status: "deleted", deleted_at: expect.any(String) });
      expect(() => service.getMemory(id, { namespace })).toThrow(/not found/i);
      expect(db.db.prepare("SELECT count(*) AS count FROM audit_logs WHERE action = 'delete' AND target_id = ?").get(id))
        .toEqual({ count: 1 });
    }
    expect(countVectors(targetIds)).toBe(0);
    const remaining = service.panelItems({ namespace, layer: "L1" }).items.map((item) => item.id);
    expect(targetIds.every((id) => !remaining.includes(id))).toBe(true);
    const recalled = await service.search({ namespace, query: "分析构建问题 修改配置 验证结果", layers: ["L1"] });
    expect(recalled.hits.some((hit) => targetIds.includes(hit.id) || hit.id === task.l1MemoryId)).toBe(false);
    expect(db.db.prepare("SELECT * FROM memories WHERE id IN (SELECT value FROM json_each(?))")
      .all(JSON.stringify(controlIds))).toEqual(controlBefore);
    expect(countVectors(controlIds)).toBe(controlVectorCount);
    for (const id of controlIds) expect(() => service.getMemory(id, { namespace })).not.toThrow();
    expect(service.panelTasks({ namespace, page: 1 }).tasks.map((item) => item.id)).toContain(assignedEpisodeId(service, control));
    db.close();
  });

  it("keeps the parent trace only when the complex turn has one coherent goal", async () => {
    const calls: Array<{ messages: LlmMessage[]; options: LlmCompletionOptions }> = [];
    const llm = createSpanBigTurnLlm(calls, {
      shouldSplit: false,
      reason: "所有工具调用都服务于同一个迁移目标",
      spans: []
    });
    const { db, service } = createTestService({ llm, skillLlm: llm });
    const namespace = {
      source: "codex",
      profileId: "jiang",
      userId: "span-big-turn-no-split"
    };
    const session = service.openSession({ namespace });
    const toolCalls = Array.from({ length: 11 }, (_, index) => ({
      id: `single-goal-tool-${index}`,
      name: "apply_migration_step",
      input: { index }
    }));
    const completed = (await service.completeTurn("span-big-turn-no-split", {
      namespace,
      sessionId: session.sessionId,
      query: "完成这一个数据库迁移目标",
      answer: "数据库迁移已经完成。",
      toolCalls,
      toolResults: toolCalls.map((call, index) => ({
        toolCallId: call.id,
        name: call.name,
        output: { ok: true, index }
      }))
    }));

    service.closeSession(session.sessionId);
    await settleCaptureAssignments(service);
    await service.feedback({
      namespace,
      sessionId: session.sessionId,
      episodeId: assignedEpisodeId(service, completed),
      l1MemoryId: completed.l1MemoryId,
      channel: "explicit",
      polarity: "positive",
      magnitude: 1,
      rationale: "迁移结果正确"
    });
    vi.useFakeTimers({ toFake: ["Date"] });
    vi.setSystemTime(Date.now() + 31_000);
    await runWorkerRounds(service, 8);

    expect(calls.filter((call) => call.options.operation === "span.big_turn.v1")).toHaveLength(1);
    expect(storedL1Items(db).filter(
      (item) => item.kind === "span"
    )).toEqual([]);
    db.close();
  });

  it("stores only the successful model result after a failed attempt", async () => {
    vi.useFakeTimers({ toFake: ["Date"] });
    const calls: Array<{ messages: LlmMessage[]; options: LlmCompletionOptions }> = [];
    const llm = createSpanBigTurnLlm(calls, [
      {
        shouldSplit: true,
        reason: "invalid overlapping draft",
        spans: [
          { start: 0, end: 6, spanGoal: "无效的第一次分析", summary: "范围发生重叠" },
          { start: 6, end: 10, spanGoal: "无效的第一次修复", summary: "范围发生重叠" }
        ]
      },
      {
        shouldSplit: true,
        reason: "valid retry",
        spans: [
          { start: 0, end: 2, spanGoal: "分析问题", summary: "完成问题分析" },
          { start: 3, end: 7, spanGoal: "实施修复", summary: "完成问题修复" },
          { start: 8, end: 10, spanGoal: "验证结果", summary: "完成结果验证" }
        ]
      }
    ]);
    const { db, service } = createTestService({ llm, skillLlm: llm });
    const namespace = {
      source: "codex",
      profileId: "jiang",
      userId: "span-big-turn-replace"
    };
    const session = service.openSession({ namespace });
    const toolCalls = Array.from({ length: 11 }, (_, index) => ({
      id: `replace-tool-${index}`,
      name: "task_step",
      input: { index }
    }));
    const completed = (await service.completeTurn("span-big-turn-replace", {
      namespace,
      sessionId: session.sessionId,
      query: "完成需要多步处理的复杂任务",
      answer: "复杂任务已完成。",
      toolCalls,
      toolResults: toolCalls.map((call, index) => ({
        toolCallId: call.id,
        name: call.name,
        output: { ok: true, index }
      }))
    }));
    service.closeSession(session.sessionId);

    await settleCaptureAssignments(service);
    await service.feedback({
      namespace,
      sessionId: session.sessionId,
      episodeId: assignedEpisodeId(service, completed),
      l1MemoryId: completed.l1MemoryId,
      channel: "explicit",
      polarity: "positive",
      magnitude: 1,
      rationale: "任务结果正确"
    });
    vi.useFakeTimers({ toFake: ["Date"] });
    vi.setSystemTime(Date.now() + 31_000);
    await runWorkerRounds(service, 8);

    const retry = db.db.prepare(`SELECT available_at FROM evolution_jobs
      WHERE job_type = 'span_big_turn' AND status = 'failed'`).get() as { available_at: string };
    expect(Date.parse(retry.available_at)).toBeGreaterThan(Date.now());
    vi.setSystemTime(Date.parse(retry.available_at));
    await runWorkerRounds(service, 8);

    const spans = storedL1Items(db).filter(
      (item) => item.kind === "span"
    );
    expect(calls.filter((call) => call.options.operation === "span.big_turn.v1")).toHaveLength(2);
    expect(spans).toHaveLength(3);
    expect(spans.map((item) => item.title)).toEqual(expect.arrayContaining([
      "分析问题",
      "实施修复",
      "验证结果"
    ]));
    expect(spans.some((item) => item.title.startsWith("无效的第一次"))).toBe(false);
    db.close();
  });

  it("requires both a positive reward and more than ten tool calls", async () => {
    for (const scenario of [
      { userId: "span-big-turn-ten-tools", toolCount: 10, polarity: "positive" as const },
      { userId: "span-big-turn-negative", toolCount: 11, polarity: "negative" as const }
    ]) {
      const calls: Array<{ messages: LlmMessage[]; options: LlmCompletionOptions }> = [];
      const llm = createSpanBigTurnLlm(calls);
      const config = {
        ...LEGACY_TEST_CONFIG,
        algorithm: {
          ...LEGACY_TEST_CONFIG.algorithm,
          reward: {
            ...LEGACY_TEST_CONFIG.algorithm.reward,
            llmScoring: false
          }
        }
      };
      const { db, service } = createTestService({ config, llm, skillLlm: llm });
      const namespace = {
        source: "codex",
        profileId: "jiang",
        userId: scenario.userId
      };
      const session = service.openSession({ namespace });
      const toolCalls = Array.from({ length: scenario.toolCount }, (_, index) => ({
        id: `${scenario.userId}-tool-${index}`,
        name: "task_step",
        input: { index }
      }));
      const completed = (await service.completeTurn(`${scenario.userId}-turn`, {
        namespace,
        sessionId: session.sessionId,
        query: "执行复杂任务",
        answer: "任务执行结束。",
        toolCalls,
        toolResults: toolCalls.map((call, index) => ({
          toolCallId: call.id,
          name: call.name,
          output: { ok: scenario.polarity === "positive", index }
        }))
      }));
      service.closeSession(session.sessionId);
      await settleCaptureAssignments(service);
    await service.feedback({
        namespace,
        sessionId: session.sessionId,
        episodeId: assignedEpisodeId(service, completed),
        l1MemoryId: completed.l1MemoryId,
        channel: "explicit",
        polarity: scenario.polarity,
        magnitude: 1,
        rationale: scenario.polarity === "positive" ? "结果正确" : "任务没有正确完成"
      });
      vi.useFakeTimers({ toFake: ["Date"] });
    vi.setSystemTime(Date.now() + 31_000);
    await runWorkerRounds(service, 8);

      expect(calls.some((call) => call.options.operation === "span.big_turn.v1")).toBe(false);
      expect(storedL1Items(db).some(
        (item) => item.kind === "span"
      )).toBe(false);
      db.close();
    }
  });

  it("rejects overlapping spans without storing partial results", async () => {
    vi.useFakeTimers({ toFake: ["Date"] });
    const calls: Array<{ messages: LlmMessage[]; options: LlmCompletionOptions }> = [];
    const llm = createSpanBigTurnLlm(calls, {
      shouldSplit: true,
      reason: "invalid overlapping draft",
      spans: [
        {
          start: 0,
          end: 6,
          spanGoal: "分析失败原因",
          summary: "分析构建失败"
        },
        {
          start: 6,
          end: 10,
          spanGoal: "修复失败原因",
          summary: "修改配置并验证"
        }
      ]
    });
    const { db, service } = createTestService({ llm, skillLlm: llm });
    const namespace = {
      source: "codex",
      profileId: "jiang",
      userId: "span-big-turn-overlap"
    };
    const session = service.openSession({ namespace });
    const toolCalls = Array.from({ length: 11 }, (_, index) => ({
      id: `overlap-tool-${index}`,
      name: "task_step",
      input: { index }
    }));
    const completed = (await service.completeTurn("span-big-turn-overlap", {
      namespace,
      sessionId: session.sessionId,
      query: "分析并修复构建失败",
      answer: "已经完成分析和修复。",
      toolCalls,
      toolResults: toolCalls.map((call, index) => ({
        toolCallId: call.id,
        name: call.name,
        output: { ok: true, index }
      }))
    }));
    service.closeSession(session.sessionId);
    await settleCaptureAssignments(service);
    await service.feedback({
      namespace,
      sessionId: session.sessionId,
      episodeId: assignedEpisodeId(service, completed),
      l1MemoryId: completed.l1MemoryId,
      channel: "explicit",
      polarity: "positive",
      magnitude: 1,
      rationale: "任务结果正确"
    });
    vi.useFakeTimers({ toFake: ["Date"] });
    vi.setSystemTime(Date.now() + 31_000);
    for (let attempt = 0; attempt < 3; attempt++) {
      await runWorkerRounds(service, 8);
      if (attempt < 2) {
        const retry = db.db.prepare(`SELECT available_at FROM evolution_jobs
          WHERE job_type = 'span_big_turn' AND status = 'failed'`).get() as { available_at: string };
        expect(Date.parse(retry.available_at)).toBeGreaterThan(Date.now());
        vi.setSystemTime(Date.parse(retry.available_at));
      }
    }

    expect(calls.filter((call) => call.options.operation === "span.big_turn.v1")).toHaveLength(3);
    expect(storedL1Items(db).some(
      (item) => item.kind === "span"
    )).toBe(false);
    expect(service.panelJobs({ userId: namespace.userId }).items).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          jobType: "span_big_turn",
          status: "dead_letter",
          lastError: "span.big_turn returned overlapping or unordered spans"
        })
      ])
    );
    db.close();
  });
});

function storedL1Items(db: { db: ConstructorParameters<typeof Repositories>[0] }) {
  const repos = new Repositories(db.db);
  return repos.memories.list({ memoryLayer: "L1" }).map(memory => repos.memories.toListItem(memory));
}
