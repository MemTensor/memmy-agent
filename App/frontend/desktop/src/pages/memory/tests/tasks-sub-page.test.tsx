/** Tasks sub page tests. */
import { readFileSync } from "node:fs";
import { renderToString } from "react-dom/server";
import type { PanelTaskItem, PanelTasksOutput } from "@memmy/local-api-contracts";
import { describe, expect, it, vi } from "vitest";
import { I18nProvider } from "../../../i18n/i18n-provider.js";
import type { MemoryTask, MemoryTasksOutput } from "../tasks-sub-page.js";
import { loadTasksData, TasksSubPageView } from "../tasks-sub-page.js";
import { createMemoryRuntimeClientStub } from "./fixtures.js";

describe("TasksSubPage", () => {
  it("直接按 episode 任务接口加载，并保留服务端分页", async () => {
    const listPanelTasks = vi.fn(async () => panelTasksOutput([panelTaskFixture()], {
      page: 2,
      total: 23,
      totalPages: 2,
      hasPrev: true
    }));
    const client = createMemoryRuntimeClientStub({ listPanelTasks });

    await expect(loadTasksData(client, "记忆面板", 2)).resolves.toMatchObject({
      tasks: [{ id: "episode-memory-page", memoryCount: 2, turnCount: 1 }],
      page: 2,
      total: 23,
      totalPages: 2,
      hasPrev: true,
      hasNext: false
    });
    expect(listPanelTasks).toHaveBeenCalledWith({ q: "记忆面板", page: 2 });
  });

  it("从原始 turns 渲染思考、工具调用和回答", async () => {
    const task = panelTaskFixture();
    task.turns[0] = {
      ...task.turns[0]!,
      reasoningSummary: "先检查分页，再核对任务接口。",
      toolCalls: [{
        id: "tool-call-1",
        name: "read_file",
        input: { path: "tasks-sub-page.tsx" },
        output: "读取完成",
        success: true
      }]
    };
    const client = createMemoryRuntimeClientStub({
      listPanelTasks: vi.fn(async () => panelTasksOutput([task]))
    });

    const data = await loadTasksData(client);
    expect(data.tasks[0]?.chat.map((message) => message.role)).toEqual(["user", "thinking", "tool", "assistant"]);
    expect(data.tasks[0]).toMatchObject({
      status: "completed",
      skillStatus: "succeeded",
      toolCallCount: 1,
      rTask: 0.735
    });
  });

  it("服务端返回删除后的有效页码时使用该页码", async () => {
    const client = createMemoryRuntimeClientStub({
      listPanelTasks: vi.fn(async () => panelTasksOutput([], { page: 1, total: 0, totalPages: 1 }))
    });

    await expect(loadTasksData(client, "", 9)).resolves.toMatchObject({
      page: 1,
      totalPages: 1,
      tasks: []
    });
  });

  it("渲染 loading/error/empty/ready 和任务详情", () => {
    const task = createTaskFixture();
    const loading = renderTasks({ status: "loading" });
    const error = renderTasks({ status: "error", message: "任务接口失败" });
    const empty = renderTasks({ status: "ready", data: tasksOutput([]) });
    const html = renderTasks({ status: "ready", data: tasksOutput([task]) }, task);

    expect(loading).toContain("正在加载任务");
    expect(error).toContain("任务接口失败");
    expect(empty).toContain("暂无任务");
    expect(html).toContain("记忆管理页面接入真实数据");
    expect(html).toContain("memory-chat-item--user");
    expect(html).toContain("memory-chat-item--assistant");
    expect(html).toContain("memory-chat-item--tool");
    expect(html).toContain("memory-delete-button");
    expect(html).toContain("<strong>记忆管理</strong>");
    expect(html).toContain("<code class=\"memory-markdown__code\">listPanelTasks</code>");
  });

  it("任务历史聊天中的 Markdown 链接只保留文字不生成跳转", () => {
    const baseTask = createTaskFixture();
    const task = {
      ...baseTask,
      chat: baseTask.chat.map((message) => message.role === "assistant"
        ? { ...message, text: "测试补在 [task.test.ts](http://127.0.0.1/task.test.ts)" }
        : message)
    };
    const html = renderTasks({ status: "ready", data: tasksOutput([task]) }, task);

    expect(html).toContain("task.test.ts");
    expect(html).not.toContain("href=");
    expect(html).not.toContain("127.0.0.1");
  });

  it("任务历史聊天渲染 GFM 表格", () => {
    const baseTask = createTaskFixture();
    const task = {
      ...baseTask,
      chat: baseTask.chat.map((message) => message.role === "assistant"
        ? {
            ...message,
            text: "| | 黄瓤（β-胡萝卜素） | 红瓤（番茄红素） |\n|---|---|---|\n| 抗氧化 | ✅ 强 | ✅✅ 更强 |"
          }
        : message)
    };
    const html = renderTasks({ status: "ready", data: tasksOutput([task]) }, task);

    expect(html).toContain("memory-markdown__table-scroll");
    expect(html).toContain('<table class="memory-markdown__table">');
    expect(html).toContain('<th class="memory-markdown__th">黄瓤（β-胡萝卜素）</th>');
    expect(html).toContain('<td class="memory-markdown__td">✅✅ 更强</td>');
    expect(html).not.toContain("|---|---|---|");
  });

  it("统一展示技能沉淀状态文案", () => {
    const tasks: MemoryTask[] = [
      { ...createTaskFixture(), id: "queued", skillStatus: "queued" },
      { ...createTaskFixture(), id: "running", skillStatus: "running" },
      { ...createTaskFixture(), id: "succeeded", skillStatus: "succeeded" },
      { ...createTaskFixture(), id: "skipped", skillStatus: "skipped" },
      { ...createTaskFixture(), id: "failed", skillStatus: "failed" }
    ];
    const html = renderTasks({ status: "ready", data: tasksOutput(tasks) });

    expect(html).toContain("技能沉淀待评估");
    expect(html).toContain("正在沉淀技能");
    expect(html).toContain("已沉淀为技能");
    expect(html).toContain("无需沉淀为技能");
    expect(html).toContain("技能沉淀失败");
  });

  it("区分进行中和已完成任务状态颜色", () => {
    const css = readFileSync(new URL("../../../styles.css", import.meta.url), "utf8");
    const openRule = css.match(/\.memory-pill--task-open,[\s\S]*?\.memory-pill--task-processing\s*\{[\s\S]*?\}/)?.[0] ?? "";
    const closedRule = css.match(/\.memory-pill--task-closed,[\s\S]*?\.memory-pill--skill-succeeded,[\s\S]*?\.memory-pill--skill-generated\s*\{[\s\S]*?\}/)?.[0] ?? "";

    expect(openRule).toContain("--color-role-assistant");
    expect(closedRule).toContain("--color-status-success");
  });
});

function panelTaskFixture(): PanelTaskItem {
  return {
    id: "episode-memory-page",
    episode: {
      id: "episode-memory-page",
      sessionId: "session-memory-page",
      title: "记忆管理页面接入真实数据",
      summary: "按照规范补齐任务列表。",
      status: "closed",
      startedAt: "2026-06-03T09:00:00.000Z",
      endedAt: "2026-06-03T09:45:00.000Z",
      turnCount: 1,
      rTask: 0.735,
      pipelineStatus: "succeeded",
      skillMemoryIds: ["skill-memory-1"],
      skillStatus: "succeeded"
    },
    memoryIds: ["memory-trace-1", "memory-trace-2"],
    turns: [{
      rawTurnId: "raw-turn-1",
      episodeId: "episode-memory-page",
      turnId: "turn-1",
      userText: "请把 **记忆管理** 页面接入真实数据。",
      assistantText: "已完成：接入 `listPanelTasks`。",
      toolCalls: [],
      toolResults: [],
      createdAt: "2026-06-03T09:00:00.000Z"
    }],
    updatedAt: "2026-06-03T09:45:00.000Z"
  };
}

function panelTasksOutput(tasks: PanelTaskItem[], overrides: Partial<PanelTasksOutput> = {}): PanelTasksOutput {
  return {
    tasks,
    page: 1,
    pageSize: 20,
    total: tasks.length,
    totalPages: 1,
    hasNext: false,
    hasPrev: false,
    serverTime: "2026-06-03T10:00:00.000Z",
    ...overrides
  };
}

function createTaskFixture(): MemoryTask {
  return {
    id: "episode-memory-page",
    memoryIds: ["memory-trace-1"],
    title: "记忆管理页面接入真实数据",
    summary: "按照规范补齐任务列表。",
    source: "Memmy",
    status: "completed",
    startedAt: "2026-06-03T09:00:00.000Z",
    endedAt: "2026-06-03T09:45:00.000Z",
    updatedAt: "2026-06-03T09:45:00.000Z",
    turnCount: 1,
    memoryCount: 1,
    toolCallCount: 1,
    rTask: 0.735,
    skillStatus: "queued",
    chat: [
      { id: "turn-1:user", role: "user", text: "请把 **记忆管理** 页面接入真实数据。" },
      {
        id: "turn-1:tool",
        role: "tool",
        tool: { name: "read_file", input: { path: "tasks-sub-page.tsx" }, output: "读取完成", success: true }
      },
      { id: "turn-1:assistant", role: "assistant", text: "已接入 `listPanelTasks`。" }
    ]
  };
}

function renderTasks(state: Parameters<typeof TasksSubPageView>[0]["state"], selectedTask: MemoryTask | null = null): string {
  return renderToString(
    <I18nProvider language="zh-CN">
      <TasksSubPageView
        state={state}
        query=""
        selectedTask={selectedTask}
        onQueryChange={vi.fn()}
        onSearch={vi.fn()}
        onPageChange={vi.fn()}
        onRefresh={vi.fn()}
        onOpenTask={vi.fn()}
        onDeleteTask={vi.fn(async () => undefined)}
        onCloseTask={vi.fn()}
      />
    </I18nProvider>
  );
}

function tasksOutput(tasks: MemoryTask[]): MemoryTasksOutput {
  return {
    tasks,
    page: 1,
    pageSize: 20,
    total: tasks.length,
    totalPages: 1,
    hasNext: false,
    hasPrev: false
  };
}
