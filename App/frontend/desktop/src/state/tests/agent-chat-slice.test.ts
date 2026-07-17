/** Agent chat slice tests. */
import { afterEach, describe, expect, it, vi } from "vitest";
import type { MemmyAgentSessionSummary, MemmyAgentSidebarState } from "../../api/memmy-agent-client.js";
import type { PendingAttachment } from "../agent-composer-state.js";
import {
  agentReducer,
  buildAgentTasks,
  defaultAgentSidebarState,
  initialAgentState,
  type AgentState,
  updateSidebarStateForTask
} from "../agent-chat-slice.js";

const WINDOWS_COMMAND_ERROR = "'node' 不是内部或外部命令，也不是可运行的程序\r\n或批处理文件。";

const sessions: MemmyAgentSessionSummary[] = [
  {
    key: "websocket:chat-1",
    title: "客户需求分析与软件功能需求拆解",
    preview: "继续确认范围",
    updatedAt: "2026-06-06T09:00:00.000Z"
  },
  {
    key: "websocket:chat-2",
    title: "Memmy PRD 整理",
    preview: "补充首期接口",
    updatedAt: "2026-06-06T10:00:00.000Z"
  }
];

afterEach(() => {
  vi.restoreAllMocks();
});

describe("agent chat slice", () => {
  it("starts with the chat view marked invisible until routing bootstrap resolves", () => {
    expect(initialAgentState.chatViewVisible).toBe(false);
  });

  it("dismisses only the matching transient error without changing connection status", () => {
    const errored = agentReducer(initialAgentState, { type: "agent/error", message: "语音识别失败" });

    const staleDismiss = agentReducer(errored, { type: "agent/errorDismissed", message: "旧错误" });
    expect(staleDismiss.error).toBe("语音识别失败");
    expect(staleDismiss.connectionStatus).toBe("error");

    const dismissed = agentReducer(errored, { type: "agent/errorDismissed", message: "语音识别失败" });
    expect(dismissed.error).toBeNull();
    expect(dismissed.connectionStatus).toBe("error");
  });

  it("clears sessions loading failures without showing a connection error", () => {
    let state = agentReducer(initialAgentState, { type: "agent/sessionsLoading", requestId: "sessions-1" });
    expect(state.isLoadingSessions).toBe(true);
    expect(state.currentSessionsRequestRunStatusVersionByChatId).not.toBeNull();

    const stale = agentReducer(state, { type: "agent/sessionsLoadFailed", requestId: "sessions-stale" });
    expect(stale.isLoadingSessions).toBe(true);

    state = agentReducer(state, { type: "agent/sessionsLoadFailed", requestId: "sessions-1" });
    expect(state.isLoadingSessions).toBe(false);
    expect(state.currentSessionsRequestId).toBeNull();
    expect(state.currentSessionsRequestRunStatusVersionByChatId).toBeNull();
    expect(state.connectionStatus).toBe("idle");
    expect(state.error).toBeNull();
  });

  it("marks the current chat unseen when completion arrives outside the visible chat view", () => {
    vi.spyOn(Date, "now").mockReturnValue(1781240000000);
    let state = agentReducer(initialAgentState, { type: "agent/sessionsLoaded", sessions });
    state = agentReducer(state, { type: "agent/newChatCreated", chatId: "chat-1" });
    state = agentReducer(state, {
      type: "agent/wsEvent",
      event: { event: "goal_status", chat_id: "chat-1", status: "running", started_at: 1780732800 }
    });

    state = agentReducer(state, { type: "agent/wsEvent", event: { event: "turn_end", chat_id: "chat-1" } });

    expect(state.chatViewVisible).toBe(false);
    expect(state.runStartedAtByChatId["chat-1"]).toBeNull();
    expect(state.completedUnseenByChatId["chat-1"]).toBe(1781240000000);
    expect(state.tasks.find((task) => task.chatId === "chat-1")?.completedUnseen).toBe(true);
  });

  it("does not mark the current chat unseen when the chat view is visible", () => {
    vi.spyOn(Date, "now").mockReturnValue(1781240000000);
    let state = agentReducer(initialAgentState, { type: "agent/chatViewVisibilityChanged", visible: true });
    state = agentReducer(state, { type: "agent/sessionsLoaded", sessions });
    state = agentReducer(state, { type: "agent/newChatCreated", chatId: "chat-1" });
    state = agentReducer(state, {
      type: "agent/wsEvent",
      event: { event: "goal_status", chat_id: "chat-1", status: "running", started_at: 1780732800 }
    });

    state = agentReducer(state, { type: "agent/wsEvent", event: { event: "turn_end", chat_id: "chat-1" } });

    expect(state.chatViewVisible).toBe(true);
    expect(state.runStartedAtByChatId["chat-1"]).toBeNull();
    expect(state.completedUnseenByChatId["chat-1"]).toBeUndefined();
    expect(state.tasks.find((task) => task.chatId === "chat-1")?.completedUnseen).toBe(false);
  });

  it("clears only the currently visible chat completion dot when chat view becomes visible", () => {
    let state: AgentState = {
      ...initialAgentState,
      currentChatId: "chat-1",
      currentSessionKey: "websocket:chat-1",
      sessions,
      completedUnseenByChatId: {
        "chat-1": 1781240000000,
        "chat-2": 1781240000001
      }
    };

    state = agentReducer(state, { type: "agent/chatViewVisibilityChanged", visible: true });

    expect(state.chatViewVisible).toBe(true);
    expect(state.completedUnseenByChatId["chat-1"]).toBeUndefined();
    expect(state.completedUnseenByChatId["chat-2"]).toBe(1781240000001);
    expect(state.tasks.find((task) => task.chatId === "chat-1")?.completedUnseen).toBe(false);
    expect(state.tasks.find((task) => task.chatId === "chat-2")?.completedUnseen).toBe(true);
  });

  it("does not clear completion dots when a blank draft is visible", () => {
    let state: AgentState = {
      ...initialAgentState,
      currentChatId: "chat-1",
      currentSessionKey: "websocket:chat-1",
      blankDraftActive: true,
      sessions,
      completedUnseenByChatId: {
        "chat-1": 1781240000000
      }
    };

    state = agentReducer(state, { type: "agent/chatViewVisibilityChanged", visible: true });

    expect(state.chatViewVisible).toBe(true);
    expect(state.completedUnseenByChatId["chat-1"]).toBe(1781240000000);
    expect(state.tasks.find((task) => task.chatId === "chat-1")?.completedUnseen).toBe(true);
  });

  it("goal status idle clears running without creating a completion dot", () => {
    let state = agentReducer(initialAgentState, { type: "agent/sessionsLoaded", sessions });
    state = agentReducer(state, { type: "agent/newChatCreated", chatId: "chat-1" });
    state = agentReducer(state, {
      type: "agent/wsEvent",
      event: { event: "goal_status", chat_id: "chat-1", status: "running", started_at: 1780732800 }
    });

    state = agentReducer(state, { type: "agent/wsEvent", event: { event: "goal_status", chat_id: "chat-1", status: "idle" } });

    expect(state.runStartedAtByChatId["chat-1"]).toBeNull();
    expect(state.completedUnseenByChatId["chat-1"]).toBeUndefined();
    expect(state.tasks.find((task) => task.chatId === "chat-1")?.completedUnseen).toBe(false);
  });

  it("merges sessions with sidebar-state into task rows", () => {
    const sidebarState = sidebar({
      pinned_keys: ["websocket:chat-1"],
      archived_keys: ["websocket:chat-2"],
      title_overrides: { "websocket:chat-1": "置顶任务" },
      tags_by_key: { "websocket:chat-1": ["需求", "首期"] }
    });

    expect(buildAgentTasks(sessions, sidebarState)).toEqual([
      {
        sessionKey: "websocket:chat-1",
        chatId: "chat-1",
        title: "置顶任务",
        preview: "继续确认范围",
        updatedAt: "2026-06-06T09:00:00.000Z",
        runStartedAt: null,
        completedUnseen: false,
        pinned: true,
        archived: false,
        tags: ["需求", "首期"]
      },
      {
        sessionKey: "websocket:chat-2",
        chatId: "chat-2",
        title: "Memmy PRD 整理",
        preview: "补充首期接口",
        updatedAt: "2026-06-06T10:00:00.000Z",
        runStartedAt: null,
        completedUnseen: false,
        pinned: false,
        archived: true,
        tags: []
      }
    ]);

    const withArchived = buildAgentTasks(sessions, {
      ...sidebarState,
      view: { ...sidebarState.view, show_archived: true, sort: "title_asc" }
    });
    expect(withArchived.map((task) => task.sessionKey)).toEqual(["websocket:chat-1", "websocket:chat-2"]);
    expect(withArchived[1]?.archived).toBe(true);
  });

  it("uses session preview as the title while backend metadata title is still empty", () => {
    const tasks = buildAgentTasks([
      {
        key: "websocket:chat-preview",
        title: "",
        preview: "请帮我总结这个用户问题",
        updatedAt: "2026-06-06T12:00:00.000Z"
      }
    ], defaultAgentSidebarState);

    expect(tasks[0]?.title).toBe("请帮我总结这个用户问题");
  });

  it("updates complete sidebar-state fields used by task operations", () => {
    const nextState = updateSidebarStateForTask(defaultAgentSidebarState, "websocket:chat-1", {
      title: "创建 AI 电商助手",
      pinned: true,
      archived: true,
      tags: ["电商", " AI "],
      collapsed: true,
      sort: "title_asc",
      showArchived: true
    });

    expect(nextState.title_overrides).toEqual({ "websocket:chat-1": "创建 AI 电商助手" });
    expect(nextState.pinned_keys).toEqual(["websocket:chat-1"]);
    expect(nextState.archived_keys).toEqual(["websocket:chat-1"]);
    expect(nextState.tags_by_key).toEqual({ "websocket:chat-1": ["电商", "AI"] });
    expect(nextState.collapsed_groups).toEqual({ "websocket:chat-1": true });
    expect(nextState.view).toMatchObject({ sort: "title_asc", show_archived: true });
  });

  it("reduces websocket events into streaming messages without requesting history refresh on turn end", () => {
    let state = agentReducer(initialAgentState, { type: "agent/wsEvent", event: { event: "ready", chat_id: "chat-1" } });
    state = agentReducer(state, {
      type: "agent/userMessageQueued",
      chatId: "chat-1",
      content: "整理最近任务"
    });
    state = agentReducer(state, { type: "agent/wsEvent", event: { event: "reasoning_delta", text: "先拆任务。" } });
    state = agentReducer(state, { type: "agent/wsEvent", event: { event: "delta", text: "已整理" } });
    state = agentReducer(state, { type: "agent/wsEvent", event: { event: "stream_end", text: "已整理完成" } });
    state = agentReducer(state, { type: "agent/wsEvent", event: { event: "file_edit", edits: [{ path: "README.md" }] } });
    state = agentReducer(state, { type: "agent/wsEvent", event: { event: "message", text: "最终完成" } });
    state = agentReducer(state, { type: "agent/wsEvent", event: { event: "turn_end", chat_id: "chat-1", latency_ms: 42 } });

    expect(state.currentChatId).toBe("chat-1");
    expect(state.currentSessionKey).toBe("websocket:chat-1");
    expect(state.isSending).toBe(false);
    expect(state.refreshRequested).toBe(false);
    // Agent chat slice tests.
    // a normal (closed-out) assistant answer instead of being folded into a
    // gray `kind: "trace"` activity row once the file-edit event arrives.
    expect(state.messages.map((message) => message.role)).toEqual(["user", "assistant", "assistant", "tool", "assistant"]);
    expect(state.messages[1]).toMatchObject({
      role: "assistant",
      content: "",
      reasoning: "先拆任务。",
      isStreaming: false
    });
    const activitySegmentId = state.messages[1]?.activitySegmentId;
    expect(activitySegmentId).toBeTruthy();
    expect(state.messages[2]).toMatchObject({
      role: "assistant",
      content: "已整理完成",
      isStreaming: false
    });
    expect(state.messages[3]).toMatchObject({
      role: "tool",
      kind: "trace",
      fileEdits: [{ path: "README.md", phase: "end", status: "done" }]
    });
    expect(state.messages[4]).toMatchObject({
      role: "assistant",
      content: "最终完成",
      latencyMs: 42
    });
    expect(state.messages[4]?.isStreaming).not.toBe(true);
  });

  it("finalizes pending activity tool and file-edit progress only on turn_end", () => {
    let state = agentReducer(initialAgentState, { type: "agent/wsEvent", event: { event: "ready", chat_id: "chat-1" } });
    state = agentReducer(state, {
      type: "agent/userMessageQueued",
      chatId: "chat-1",
      content: "读文件"
    });
    state = agentReducer(state, {
      type: "agent/wsEvent",
      event: {
        event: "message",
        chat_id: "chat-1",
        kind: "progress",
        tool_events: [{ phase: "start", call_id: "call-read", name: "read_file", arguments: { path: "README.md" } }]
      }
    });
    state = agentReducer(state, {
      type: "agent/wsEvent",
      event: {
        event: "file_edit",
        chat_id: "chat-1",
        edits: [{ call_id: "call-edit", tool: "edit_file", path: "README.md", phase: "start", status: "editing" }]
      }
    });
    state = agentReducer(state, { type: "agent/wsEvent", event: { event: "turn_end", chat_id: "chat-1" } });

    const toolTrace = state.messages.find((message) => message.toolEvents);
    const fileEditTrace = state.messages.find((message) => message.fileEdits);
    expect(toolTrace?.toolEvents?.[0]).toMatchObject({ call_id: "call-read", phase: "end" });
    expect(toolTrace?.isStreaming).toBe(false);
    expect(fileEditTrace?.fileEdits?.[0]).toMatchObject({ call_id: "call-edit", phase: "end", status: "done" });
    expect(fileEditTrace?.isStreaming).toBe(false);
  });

  it("preserves decoded Windows errors in live progress and restored history", () => {
    let live = agentReducer(initialAgentState, { type: "agent/wsEvent", event: { event: "ready", chat_id: "chat-windows" } });
    live = agentReducer(live, {
      type: "agent/wsEvent",
      event: {
        event: "message",
        chat_id: "chat-windows",
        kind: "progress",
        tool_events: [{ phase: "error", call_id: "call-windows", name: "exec", error: WINDOWS_COMMAND_ERROR }]
      }
    });

    const liveTrace = live.messages.find((message) => message.toolEvents);
    expect(liveTrace?.toolEvents?.[0]?.error).toBe(WINDOWS_COMMAND_ERROR);

    const restored = loadHistory(initialAgentState, "websocket:chat-windows", [
      {
        role: "tool",
        kind: "trace",
        content: "exec()",
        traces: ["exec()"],
        toolEvents: [{ phase: "error", call_id: "call-windows", name: "exec", error: WINDOWS_COMMAND_ERROR }]
      }
    ]);
    expect(restored.messages[0]?.toolEvents?.[0]?.error).toBe(WINDOWS_COMMAND_ERROR);
  });

  it("ignores empty complete assistant messages when only activity was produced", () => {
    let state = agentReducer(initialAgentState, { type: "agent/wsEvent", event: { event: "ready", chat_id: "chat-1" } });
    state = agentReducer(state, {
      type: "agent/userMessageQueued",
      chatId: "chat-1",
      content: "帮我看下图片"
    });
    state = agentReducer(state, {
      type: "agent/wsEvent",
      event: {
        event: "message",
        chat_id: "chat-1",
        kind: "progress",
        tool_events: [
          { phase: "end", call_id: "call-read", name: "read_file", arguments: { path: "/tmp/image.png" } }
        ]
      }
    });
    state = agentReducer(state, { type: "agent/wsEvent", event: { event: "message", chat_id: "chat-1", text: "" } });
    state = agentReducer(state, { type: "agent/wsEvent", event: { event: "turn_end", chat_id: "chat-1" } });

    expect(state.isSending).toBe(false);
    expect(state.messages.map((message) => [message.role, message.kind ?? "message"])).toEqual([
      ["user", "message"],
      ["tool", "trace"]
    ]);
    const assistantAnswers = state.messages.filter((message) => message.role === "assistant" && message.kind !== "trace" && message.kind !== "narration");
    expect(assistantAnswers).toHaveLength(0);
    expect(state.messages[1]).toMatchObject({ role: "tool", kind: "trace", isStreaming: false });
  });

  it("upserts context compaction events without creating activity traces or sending state", () => {
    let state = agentReducer(initialAgentState, { type: "agent/wsEvent", event: { event: "ready", chat_id: "chat-1" } });

    state = agentReducer(state, {
      type: "agent/wsEvent",
      event: {
        event: "context_compaction",
        chat_id: "chat-1",
        compaction_id: "context-compaction:turn-1",
        status: "running",
        text: "会话压缩中"
      }
    });

    expect(state.isSending).toBe(false);
    expect(state.messages).toHaveLength(1);
    expect(state.messages[0]).toMatchObject({
      role: "tool",
      kind: "context_compaction",
      content: "会话压缩中",
      compactionId: "context-compaction:turn-1",
      compactionStatus: "running",
      isStreaming: true
    });
    expect(state.messages[0]).not.toHaveProperty("traces");
    expect(state.messages[0]).not.toHaveProperty("activitySegmentId");

    state = agentReducer(state, {
      type: "agent/wsEvent",
      event: {
        event: "context_compaction",
        chat_id: "chat-1",
        compaction_id: "context-compaction:turn-1",
        status: "done",
        text: "压缩已完成"
      }
    });

    expect(state.isSending).toBe(false);
    expect(state.messages).toHaveLength(1);
    expect(state.messages[0]).toMatchObject({
      role: "tool",
      kind: "context_compaction",
      content: "压缩已完成",
      compactionId: "context-compaction:turn-1",
      compactionStatus: "done",
      isStreaming: false
    });
  });

  it("keeps stream-end assistant content streaming until turn end", () => {
    let state = agentReducer(initialAgentState, { type: "agent/wsEvent", event: { event: "ready", chat_id: "chat-1" } });

    state = agentReducer(state, { type: "agent/wsEvent", event: { event: "delta", chat_id: "chat-1", text: "hel" } });
    state = agentReducer(state, { type: "agent/wsEvent", event: { event: "stream_end", chat_id: "chat-1", text: "hello" } });

    const assistantMessages = state.messages.filter((message) => message.role === "assistant" && message.kind !== "trace");
    expect(assistantMessages).toHaveLength(1);
    expect(assistantMessages[0]).toMatchObject({ content: "hello", isStreaming: true });

    state = agentReducer(state, { type: "agent/wsEvent", event: { event: "turn_end", chat_id: "chat-1" } });
    expect(state.messages.filter((message) => message.role === "assistant" && message.kind !== "trace")).toHaveLength(1);
    expect(state.messages[0]).toMatchObject({ content: "hello", isStreaming: false });
  });

  it("absorbs a complete assistant message after stream end into the streamed answer", () => {
    let state = agentReducer(initialAgentState, { type: "agent/wsEvent", event: { event: "ready", chat_id: "chat-1" } });

    state = agentReducer(state, { type: "agent/wsEvent", event: { event: "delta", chat_id: "chat-1", text: "hel" } });
    state = agentReducer(state, { type: "agent/wsEvent", event: { event: "stream_end", chat_id: "chat-1", text: "hello" } });
    state = agentReducer(state, { type: "agent/wsEvent", event: { event: "message", chat_id: "chat-1", text: "hello" } });

    const assistantMessages = state.messages.filter((message) => message.role === "assistant" && message.kind !== "trace");
    expect(assistantMessages).toHaveLength(1);
    expect(assistantMessages[0]).toMatchObject({ content: "hello", isStreaming: true });
  });

  it("reclassifies a resuming stream-end draft as narration activity", () => {
    // `stream_end` with `resuming: true` is the runtime saying "this text is a
    // mid-turn draft, the loop continues". The draft stays verbatim in the
    // timeline as `kind: "narration"` (activity prose) and the turn's answer
    // channel only ever holds the final answer — this is the semantic rule
    // that prevents cumulative drafts from stacking up as repeated bubbles.
    let state = agentReducer(initialAgentState, { type: "agent/wsEvent", event: { event: "ready", chat_id: "chat-1" } });

    state = agentReducer(state, { type: "agent/wsEvent", event: { event: "delta", chat_id: "chat-1", text: "工具前说明" } });
    state = agentReducer(state, { type: "agent/wsEvent", event: { event: "stream_end", chat_id: "chat-1", text: "工具前说明", resuming: true } });
    state = agentReducer(state, { type: "agent/wsEvent", event: { event: "message", chat_id: "chat-1", kind: "progress", text: "执行工具" } });
    state = agentReducer(state, { type: "agent/wsEvent", event: { event: "message", chat_id: "chat-1", text: "最终回答" } });

    const answerMessages = state.messages.filter((message) => message.role === "assistant" && message.kind !== "trace" && message.kind !== "narration");
    const narrationMessages = state.messages.filter((message) => message.kind === "narration");
    const activityMessages = state.messages.filter((message) => message.kind === "trace");
    expect(answerMessages.map((message) => message.content)).toEqual(["最终回答"]);
    expect(narrationMessages).toHaveLength(1);
    expect(narrationMessages[0]).toMatchObject({ role: "assistant", kind: "narration", content: "工具前说明", isStreaming: false });
    expect(narrationMessages[0]?.activitySegmentId).toBeTruthy();
    expect(activityMessages.flatMap((message) => message.traces ?? [])).toEqual(["执行工具"]);
  });

  it("keeps an intermediate assistant answer visible alongside later activity and a final answer", () => {
    let state = agentReducer(initialAgentState, { type: "agent/wsEvent", event: { event: "ready", chat_id: "chat-1" } });

    state = agentReducer(state, { type: "agent/wsEvent", event: { event: "delta", chat_id: "chat-1", text: "初稿" } });
    state = agentReducer(state, { type: "agent/wsEvent", event: { event: "stream_end", chat_id: "chat-1", text: "初稿" } });
    state = agentReducer(state, { type: "agent/wsEvent", event: { event: "message", chat_id: "chat-1", kind: "progress", text: "整理检索结果" } });
    state = agentReducer(state, { type: "agent/wsEvent", event: { event: "message", chat_id: "chat-1", text: "最终稿" } });

    const assistantMessages = state.messages.filter((message) => message.role === "assistant" && message.kind !== "trace");
    const activityMessages = state.messages.filter((message) => message.kind === "trace");
    expect(assistantMessages.map((message) => message.content)).toEqual(["初稿", "最终稿"]);
    expect(assistantMessages[0]).toMatchObject({ content: "初稿", isStreaming: false });
    expect(activityMessages).toHaveLength(1);
    expect(activityMessages[0]).toMatchObject({ role: "tool", kind: "trace", content: "整理检索结果" });
  });

  it("keeps every resuming draft verbatim as narration while the answer stays single", () => {
    // The agent may rewrite its progress report each loop round (cumulative
    // drafts). Drafts are never deleted or content-matched — each one lands in
    // the activity timeline as narration, and only the final non-resuming text
    // renders as the answer.
    let state = agentReducer(initialAgentState, { type: "agent/wsEvent", event: { event: "ready", chat_id: "chat-1" } });
    const first = [
      "好的！这次我给自己设计的任务是：**「Memmy RPG 冒险者档案」**",
      "",
      "## 第 1 轮 — 全量数据采集",
      "",
      "先扫描技能。"
    ].join("\n");
    const second = [
      "好的！这次我给自己设计的任务是：**「Memmy RPG 冒险者档案」**",
      "",
      "## 第 1 轮 — 全量数据采集",
      "",
      "已扫描技能。",
      "",
      "## 第 2 轮 — 角色设计",
      "",
      "生成角色卡。"
    ].join("\n");

    state = agentReducer(state, { type: "agent/wsEvent", event: { event: "delta", chat_id: "chat-1", text: first } });
    state = agentReducer(state, { type: "agent/wsEvent", event: { event: "stream_end", chat_id: "chat-1", text: first, resuming: true } });
    state = agentReducer(state, {
      type: "agent/wsEvent",
      event: {
        event: "message",
        chat_id: "chat-1",
        kind: "progress",
        text: "",
        tool_events: [{ phase: "end", call_id: "call-read", name: "read_file", arguments: { path: "skills/cron/SKILL.md" } }]
      }
    });
    state = agentReducer(state, { type: "agent/wsEvent", event: { event: "delta", chat_id: "chat-1", text: second } });
    state = agentReducer(state, { type: "agent/wsEvent", event: { event: "stream_end", chat_id: "chat-1", text: second, resuming: true } });
    state = agentReducer(state, { type: "agent/wsEvent", event: { event: "message", chat_id: "chat-1", text: "最终交付完成。" } });

    const narrationMessages = state.messages.filter((message) => message.kind === "narration");
    const answerMessages = state.messages.filter((message) => message.role === "assistant" && message.kind !== "trace" && message.kind !== "narration");
    expect(narrationMessages.map((message) => message.content)).toEqual([first, second]);
    expect(answerMessages.map((message) => message.content)).toEqual(["最终交付完成。"]);
    expect(state.messages.filter((message) => message.kind === "trace")).toHaveLength(1);
  });

  it("streams loop text in answer form and only folds it when the runtime resumes", () => {
    // While text streams it always reads as a normal answer (full typography,
    // like Cursor). The classification happens at segment close: `resuming`
    // folds it into the timeline as narration; a final close leaves it
    // exactly as it streamed — the real answer never restyles at turn end.
    let state = agentReducer(initialAgentState, { type: "agent/wsEvent", event: { event: "ready", chat_id: "chat-1" } });

    state = agentReducer(state, {
      type: "agent/wsEvent",
      event: {
        event: "message",
        chat_id: "chat-1",
        kind: "progress",
        text: "",
        tool_events: [{ phase: "end", call_id: "call-read", name: "read_file", arguments: { path: "README.md" } }]
      }
    });
    state = agentReducer(state, { type: "agent/wsEvent", event: { event: "delta", chat_id: "chat-1", text: "阶段草稿" } });

    // Streaming text is an answer block while it flows — never pre-muted.
    expect(state.messages.at(-1)).toMatchObject({ role: "assistant", content: "阶段草稿", isStreaming: true });
    expect(state.messages.at(-1)?.kind).toBeUndefined();

    state = agentReducer(state, { type: "agent/wsEvent", event: { event: "stream_end", chat_id: "chat-1", text: "阶段草稿", resuming: true } });
    expect(state.messages.at(-1)).toMatchObject({ role: "assistant", kind: "narration", content: "阶段草稿", isStreaming: false });

    state = agentReducer(state, { type: "agent/wsEvent", event: { event: "delta", chat_id: "chat-1", text: "最终报告正文" } });
    expect(state.messages.at(-1)?.kind).toBeUndefined();

    state = agentReducer(state, { type: "agent/wsEvent", event: { event: "stream_end", chat_id: "chat-1", text: "最终报告正文" } });
    state = agentReducer(state, { type: "agent/wsEvent", event: { event: "turn_end", chat_id: "chat-1" } });

    const answers = state.messages.filter((message) => message.role === "assistant" && message.kind !== "trace" && message.kind !== "narration");
    expect(answers.map((message) => message.content)).toEqual(["最终报告正文"]);
    expect(state.messages.filter((message) => message.kind === "narration").map((message) => message.content)).toEqual(["阶段草稿"]);
  });

  it("keeps interleaved reasoning chunks attached to the preceding thought without splitting the answer", () => {
    // Some providers interleave reasoning and content chunks inside one
    // Agent chat slice tests.
    // reasoning chunk must join the thought block above, and the answer must
    // keep streaming as ONE bubble — no orphan "Thinking" cluster holding half
    // a sentence, no fractured answer.
    let state = agentReducer(initialAgentState, { type: "agent/wsEvent", event: { event: "ready", chat_id: "chat-1" } });

    state = agentReducer(state, { type: "agent/wsEvent", event: { event: "reasoning_delta", chat_id: "chat-1", text: "Let me provide the plan with all" } });
    state = agentReducer(state, { type: "agent/wsEvent", event: { event: "delta", chat_id: "chat-1", text: "两张图已经生成好了" } });
    state = agentReducer(state, { type: "agent/wsEvent", event: { event: "reasoning_delta", chat_id: "chat-1", text: " the details." } });
    state = agentReducer(state, { type: "agent/wsEvent", event: { event: "delta", chat_id: "chat-1", text: "！下面是完整的规划" } });
    state = agentReducer(state, { type: "agent/wsEvent", event: { event: "stream_end", chat_id: "chat-1", text: "两张图已经生成好了！下面是完整的规划" } });
    state = agentReducer(state, { type: "agent/wsEvent", event: { event: "turn_end", chat_id: "chat-1" } });

    const reasoningMessages = state.messages.filter((message) => message.reasoning);
    const answers = state.messages.filter((message) => message.role === "assistant" && !message.reasoning && message.kind !== "trace" && message.kind !== "narration");
    expect(reasoningMessages).toHaveLength(1);
    expect(reasoningMessages[0]?.reasoning).toBe("Let me provide the plan with all the details.");
    expect(answers).toHaveLength(1);
    expect(answers[0]?.content).toBe("两张图已经生成好了！下面是完整的规划");
    expect(state.messages.indexOf(reasoningMessages[0]!)).toBeLessThan(state.messages.indexOf(answers[0]!));
  });

  it("inserts a thought block above the streaming answer when interleaved reasoning has no prior thought", () => {
    let state = agentReducer(initialAgentState, { type: "agent/wsEvent", event: { event: "ready", chat_id: "chat-1" } });

    state = agentReducer(state, { type: "agent/wsEvent", event: { event: "delta", chat_id: "chat-1", text: "正文开始" } });
    state = agentReducer(state, { type: "agent/wsEvent", event: { event: "reasoning_delta", chat_id: "chat-1", text: "midway thought" } });
    state = agentReducer(state, { type: "agent/wsEvent", event: { event: "delta", chat_id: "chat-1", text: "，正文继续" } });
    state = agentReducer(state, { type: "agent/wsEvent", event: { event: "stream_end", chat_id: "chat-1", text: "正文开始，正文继续" } });

    const answers = state.messages.filter((message) => message.role === "assistant" && !message.reasoning && message.kind !== "trace");
    expect(answers).toHaveLength(1);
    expect(answers[0]?.content).toBe("正文开始，正文继续");
    const thought = state.messages.find((message) => message.reasoning === "midway thought");
    expect(thought).toBeTruthy();
    expect(state.messages.indexOf(thought!)).toBeLessThan(state.messages.indexOf(answers[0]!));
  });

  it("suppresses redundant final stream after assistant media delivery", () => {
    let state = agentReducer(initialAgentState, { type: "agent/wsEvent", event: { event: "ready", chat_id: "chat-1" } });
    const mediaSummary = "🏔️ **Memmy 🍚 技能山水图 — 水墨赛博 · 十境全卷**\n\n两张配图已生成！";
    const finalText = "完成！全部三轮循环结束，图鉴交付。";

    state = agentReducer(state, {
      type: "agent/wsEvent",
      event: { event: "goal_status", chat_id: "chat-1", status: "running", started_at: 1780732800 }
    });
    state = agentReducer(state, {
      type: "agent/wsEvent",
      event: {
        event: "message",
        chat_id: "chat-1",
        text: mediaSummary,
        media_urls: [{ kind: "image", url: "/api/media/image", name: "skill-map.png" }]
      }
    });
    state = agentReducer(state, { type: "agent/wsEvent", event: { event: "delta", chat_id: "chat-1", text: finalText } });
    state = agentReducer(state, { type: "agent/wsEvent", event: { event: "stream_end", chat_id: "chat-1", text: finalText } });

    const assistantMessages = state.messages.filter((message) => message.role === "assistant" && message.kind !== "trace" && message.kind !== "narration");
    expect(assistantMessages.map((message) => message.content)).toEqual([mediaSummary]);
    expect(assistantMessages[0]?.media).toEqual([{ kind: "image", url: "/api/media/image", name: "skill-map.png" }]);
    expect(state.messages.map((message) => message.content)).not.toContain(finalText);

    state = agentReducer(state, { type: "agent/wsEvent", event: { event: "turn_end", chat_id: "chat-1" } });
    expect(state.isSending).toBe(false);
    expect(state.suppressAssistantStreamUntilTurnEndByChatId["chat-1"]).toBeUndefined();
  });

  it("suppresses assistant media follow-up hints and reasoning until turn end", () => {
    let state = agentReducer(initialAgentState, { type: "agent/wsEvent", event: { event: "ready", chat_id: "chat-1" } });

    state = agentReducer(state, {
      type: "agent/wsEvent",
      event: {
        event: "message",
        chat_id: "chat-1",
        text: "图片已生成",
        media_urls: [{ kind: "image", url: "/api/media/image", name: "skill-map.png" }]
      }
    });
    state = agentReducer(state, { type: "agent/wsEvent", event: { event: "message", chat_id: "chat-1", kind: "tool_hint", text: "message()" } });
    state = agentReducer(state, { type: "agent/wsEvent", event: { event: "message", chat_id: "chat-1", kind: "progress", text: "发送成功" } });
    state = agentReducer(state, { type: "agent/wsEvent", event: { event: "reasoning_delta", chat_id: "chat-1", text: "I should confirm" } });
    state = agentReducer(state, { type: "agent/wsEvent", event: { event: "reasoning_end", chat_id: "chat-1" } });
    state = agentReducer(state, { type: "agent/wsEvent", event: { event: "turn_end", chat_id: "chat-1" } });

    expect(state.messages).toHaveLength(1);
    expect(state.messages[0]).toMatchObject({ role: "assistant", content: "图片已生成" });
    expect(state.messages[0]?.media).toEqual([{ kind: "image", url: "/api/media/image", name: "skill-map.png" }]);
    expect(state.messages.some((message) => message.kind === "trace")).toBe(false);
    expect(state.messages.some((message) => message.reasoning)).toBe(false);
  });

  it("resumes normal streaming after assistant media suppression reaches turn end", () => {
    let state = agentReducer(initialAgentState, { type: "agent/wsEvent", event: { event: "ready", chat_id: "chat-1" } });

    state = agentReducer(state, {
      type: "agent/wsEvent",
      event: {
        event: "message",
        chat_id: "chat-1",
        text: "图片已生成",
        media_urls: [{ kind: "image", url: "/api/media/image", name: "skill-map.png" }]
      }
    });
    state = agentReducer(state, { type: "agent/wsEvent", event: { event: "delta", chat_id: "chat-1", text: "冗余" } });
    state = agentReducer(state, { type: "agent/wsEvent", event: { event: "turn_end", chat_id: "chat-1" } });
    state = agentReducer(state, { type: "agent/wsEvent", event: { event: "delta", chat_id: "chat-1", text: "下一轮正常回答" } });
    state = agentReducer(state, { type: "agent/wsEvent", event: { event: "stream_end", chat_id: "chat-1", text: "下一轮正常回答" } });
    state = agentReducer(state, { type: "agent/wsEvent", event: { event: "turn_end", chat_id: "chat-1" } });

    const assistantMessages = state.messages.filter((message) => message.role === "assistant" && message.kind !== "trace" && message.kind !== "narration");
    expect(assistantMessages.map((message) => message.content)).toEqual(["图片已生成", "下一轮正常回答"]);
    expect(state.messages.map((message) => message.content)).not.toContain("冗余");
  });

  it("does not suppress streams after a non-media complete assistant message", () => {
    let state = agentReducer(initialAgentState, { type: "agent/wsEvent", event: { event: "ready", chat_id: "chat-1" } });

    state = agentReducer(state, { type: "agent/wsEvent", event: { event: "message", chat_id: "chat-1", text: "中间完整消息" } });
    state = agentReducer(state, { type: "agent/wsEvent", event: { event: "delta", chat_id: "chat-1", text: "后续正常 stream" } });
    state = agentReducer(state, { type: "agent/wsEvent", event: { event: "stream_end", chat_id: "chat-1", text: "后续正常 stream" } });
    state = agentReducer(state, { type: "agent/wsEvent", event: { event: "turn_end", chat_id: "chat-1" } });

    const assistantMessages = state.messages.filter((message) => message.role === "assistant" && message.kind !== "trace" && message.kind !== "narration");
    expect(assistantMessages.map((message) => message.content)).toEqual(["中间完整消息", "后续正常 stream"]);
  });

  it("keeps assistant media stream suppression isolated per chat", () => {
    let state = agentReducer(initialAgentState, { type: "agent/wsEvent", event: { event: "ready", chat_id: "chat-1" } });

    state = agentReducer(state, {
      type: "agent/wsEvent",
      event: {
        event: "message",
        chat_id: "chat-1",
        text: "chat1 图片已生成",
        media_urls: [{ kind: "image", url: "/api/media/chat-1-image", name: "chat-1.png" }]
      }
    });
    state = agentReducer(state, { type: "agent/wsEvent", event: { event: "delta", chat_id: "chat-2", text: "chat2 正常回答" } });
    state = agentReducer(state, { type: "agent/wsEvent", event: { event: "delta", chat_id: "chat-1", text: "chat1 冗余" } });

    expect(state.messages.map((message) => message.content)).toEqual(["chat1 图片已生成"]);
    expect(state.messagesByChatId["chat-1"]?.map((message) => message.content)).toEqual(["chat1 图片已生成"]);
    expect(state.messagesByChatId["chat-2"]?.map((message) => message.content)).toEqual(["chat2 正常回答"]);
  });

  it("restores assistant media stream suppression from an open hydrated turn", () => {
    let state = loadHistory(initialAgentState, "websocket:chat-1", [
      { id: "user-1", role: "user", content: "画图" },
      {
        id: "assistant-media",
        role: "assistant",
        content: "图片已生成",
        media: [{ kind: "image", url: "/api/media/image", name: "skill-map.png" }]
      }
    ]);

    state = agentReducer(state, { type: "agent/wsEvent", event: { event: "delta", chat_id: "chat-1", text: "冗余" } });
    expect(state.suppressAssistantStreamUntilTurnEndByChatId["chat-1"]).toBe(true);
    expect(state.messages.filter((message) => message.role === "assistant").map((message) => message.content)).toEqual(["图片已生成"]);

    state = agentReducer(state, { type: "agent/userMessageQueued", chatId: "chat-1", content: "继续" });
    state = agentReducer(state, { type: "agent/wsEvent", event: { event: "delta", chat_id: "chat-1", text: "正常回答" } });

    expect(state.suppressAssistantStreamUntilTurnEndByChatId["chat-1"]).toBeUndefined();
    expect(state.messages.filter((message) => message.role === "assistant").map((message) => message.content)).toEqual(["图片已生成", "正常回答"]);
  });

  it("folds reasoning-only activity on reasoning_end without ending the turn", () => {
    let state = agentReducer(initialAgentState, { type: "agent/wsEvent", event: { event: "ready", chat_id: "chat-1" } });
    state = agentReducer(state, {
      type: "agent/wsEvent",
      event: { event: "goal_status", chat_id: "chat-1", status: "running", started_at: 1780732800 }
    });
    state = agentReducer(state, { type: "agent/wsEvent", event: { event: "reasoning_delta", chat_id: "chat-1", text: "先分析。" } });

    expect(state.isSending).toBe(true);
    expect(state.messages).toHaveLength(1);
    expect(state.messages[0]).toMatchObject({
      role: "assistant",
      content: "",
      reasoning: "先分析。",
      reasoningStreaming: true,
      isStreaming: true
    });

    state = agentReducer(state, { type: "agent/wsEvent", event: { event: "reasoning_end", chat_id: "chat-1" } });
    expect(state.isSending).toBe(true);
    expect(state.messages[0]).toMatchObject({
      reasoningStreaming: false,
      isStreaming: false
    });

    state = agentReducer(state, { type: "agent/wsEvent", event: { event: "delta", chat_id: "chat-1", text: "最终回答" } });
    expect(state.messages).toHaveLength(2);
    expect(state.messages[0]).toMatchObject({ content: "", reasoning: "先分析。", isStreaming: false });
    expect(state.messages[1]).toMatchObject({ role: "assistant", content: "最终回答", isStreaming: true });
  });

  it("does not let websocket ready replace an explicitly selected chat", () => {
    let state = agentReducer(initialAgentState, {
      type: "agent/historyLoading",
      sessionKey: "websocket:pet-chat",
      chatId: "pet-chat",
      requestId: "pet-request"
    });

    state = agentReducer(state, { type: "agent/wsEvent", event: { event: "ready", chat_id: "new-chat" } });

    expect(state.connectionStatus).toBe("connected");
    expect(state.currentChatId).toBe("pet-chat");
    expect(state.currentSessionKey).toBe("websocket:pet-chat");
  });

  it("preserves persisted trace activity from webui-thread history", () => {
    const state = loadHistory(initialAgentState, "websocket:chat-1", [
          {
            id: "trace-1",
            role: "tool",
            kind: "trace",
            content: "web_fetch({\"url\":\"https://example.com\"})",
            traces: [
              "read_file({\"path\":\"README.md\"})",
              "web_search({\"query\":\"Memmy\"})",
              "web_fetch({\"url\":\"https://example.com\"})"
            ],
            toolEvents: [
              { phase: "end", call_id: "1", name: "read_file", arguments: { path: "README.md" } },
              { phase: "end", call_id: "2", name: "web_search", arguments: { query: "Memmy" } },
              { phase: "end", call_id: "3", name: "web_fetch", arguments: { url: "https://example.com" } }
            ],
            fileEdits: [{ call_id: "edit-1", tool: "edit", path: "README.md", phase: "end", added: 2, deleted: 1 }],
            activitySegmentId: "activity-1",
            createdAt: 1780732800000
          }
        ]);

    expect(state.messages[0]).toMatchObject({
      role: "tool",
      kind: "trace",
      content: "web_fetch({\"url\":\"https://example.com\"})",
      traces: [
        "read_file({\"path\":\"README.md\"})",
        "web_search({\"query\":\"Memmy\"})",
        "web_fetch({\"url\":\"https://example.com\"})"
      ],
      toolEvents: [
        { phase: "end", call_id: "1", name: "read_file" },
        { phase: "end", call_id: "2", name: "web_search" },
        { phase: "end", call_id: "3", name: "web_fetch" }
      ],
      fileEdits: [{ call_id: "edit-1", tool: "edit", path: "README.md", status: "done", added: 2, deleted: 1 }],
      activitySegmentId: "activity-1",
      createdAt: 1780732800000
    });
  });

  it("splits legacy polluted narrative traces into narration messages during history hydrate", () => {
    const state = loadHistory(initialAgentState, "websocket:chat-polluted-trace", [
      {
        id: "trace-polluted",
        role: "tool",
        kind: "trace",
        content: 'read_file({"path":"README.md"})',
        traces: [
          "好的！这次我给自己设计的任务是：\n\n## 第 1 轮 — 数据采集\n\n先扫描所有技能的详细信息。",
          'read_file({"path":"README.md"})'
        ],
        toolEvents: [
          { phase: "end", call_id: "call-read", name: "read_file", arguments: { path: "README.md" } }
        ],
        activitySegmentId: "activity-1",
        createdAt: 1780732800000
      }
    ]);

    expect(state.messages).toHaveLength(2);
    expect(state.messages[0]).toMatchObject({
      role: "assistant",
      kind: "narration",
      content: "好的！这次我给自己设计的任务是：\n\n## 第 1 轮 — 数据采集\n\n先扫描所有技能的详细信息。",
      activitySegmentId: "activity-1",
      createdAt: 1780732800000
    });
    expect(state.messages[1]).toMatchObject({
      role: "tool",
      kind: "trace",
      content: 'read_file({"path":"README.md"})',
      traces: ['read_file({"path":"README.md"})'],
      toolEvents: [{ phase: "end", call_id: "call-read", name: "read_file" }],
      activitySegmentId: "activity-1"
    });
  });

  it("keeps every legacy polluted narrative verbatim instead of content-matching them away", () => {
    const state = loadHistory(initialAgentState, "websocket:chat-repeated-narrative", [
      {
        id: "trace-round-1",
        role: "tool",
        kind: "trace",
        content: 'read_file({"path":"A.md"})',
        traces: [
          "好的！这次我给自己设计的任务是：**「Memmy 技能炼金术」**\n\n## 第 1 轮：扫描技能\n\n读取技能。",
          'read_file({"path":"A.md"})'
        ],
        toolEvents: [{ phase: "end", call_id: "call-a", name: "read_file", arguments: { path: "A.md" } }],
        activitySegmentId: "activity-1"
      },
      {
        id: "trace-round-2",
        role: "tool",
        kind: "trace",
        content: 'generate_image({"prompt":"alchemy"})',
        traces: [
          "好的！这次我给自己设计的任务是：\n\n# Memmy 技能炼金术\n\n第 1 轮：扫描技能。\n\n第 2 轮：生成图谱。",
          'generate_image({"prompt":"alchemy"})'
        ],
        toolEvents: [{ phase: "end", call_id: "call-img", name: "generate_image", arguments: { prompt: "alchemy" } }],
        activitySegmentId: "activity-1"
      }
    ]);

    // No signature/dedupe heuristics: both drafts survive as narration inside
    // the activity timeline (never rendered as answer bubbles), and the tool
    // traces keep only real tool lines.
    const narrationMessages = state.messages.filter((message) => message.kind === "narration");
    expect(narrationMessages).toHaveLength(2);
    expect(narrationMessages[0]?.content).toContain("读取技能。");
    expect(narrationMessages[1]?.content).toContain("第 2 轮：生成图谱。");
    expect(state.messages.filter((message) => message.kind === "trace")).toHaveLength(2);
  });

  it("finalizes pending activity progress during closed history hydrate without overwriting errors", () => {
    let state = agentReducer(initialAgentState, {
      type: "agent/historyLoading",
      sessionKey: "websocket:chat-hydrate",
      chatId: "chat-hydrate",
      requestId: "hydrate-closed"
    });
    state = agentReducer(state, {
      type: "agent/historyLoaded",
      requestId: "hydrate-closed",
      thread: {
        schemaVersion: 3,
        sessionKey: "websocket:chat-hydrate",
        last_turn_closed: true,
        messages: [
          {
            role: "tool",
            kind: "trace",
            content: 'read_file({"path":"README.md"})',
            traces: ['read_file({"path":"README.md"})'],
            toolEvents: [{ phase: "start", call_id: "call-read", name: "read_file", arguments: { path: "README.md" } }],
            fileEdits: [{ call_id: "call-edit", tool: "edit_file", path: "README.md", status: "editing", phase: "start" }],
            isStreaming: true
          },
          {
            role: "tool",
            kind: "trace",
            content: "failing_tool()",
            traces: ["failing_tool()"],
            toolEvents: [{ phase: "error", call_id: "call-error", name: "failing_tool", error: "failed" }],
            fileEdits: [{ call_id: "call-edit-error", tool: "edit_file", path: "BROKEN.md", status: "error", phase: "error" }],
            isStreaming: true
          }
        ]
      }
    });

    expect(state.messages[0]?.toolEvents?.[0]).toMatchObject({ call_id: "call-read", phase: "end" });
    expect(state.messages[0]?.fileEdits?.[0]).toMatchObject({ call_id: "call-edit", status: "done", phase: "end" });
    expect(state.messages[0]?.isStreaming).toBe(false);
    expect(state.messages[1]?.toolEvents?.[0]).toMatchObject({ call_id: "call-error", phase: "error" });
    expect(state.messages[1]?.fileEdits?.[0]).toMatchObject({ call_id: "call-edit-error", status: "error", phase: "error" });
  });

  it("preserves persisted context compaction dividers from webui-thread history", () => {
    const state = loadHistory(initialAgentState, "websocket:chat-1", [
      {
        id: "context-compaction:context-compaction:turn-1",
        role: "tool",
        kind: "context_compaction",
        content: "压缩已完成",
        compactionId: "context-compaction:turn-1",
        compactionStatus: "done",
        isStreaming: false,
        traces: ["should not be rendered as activity"],
        activitySegmentId: "activity-old"
      }
    ]);

    expect(state.messages).toHaveLength(1);
    expect(state.messages[0]).toMatchObject({
      role: "tool",
      kind: "context_compaction",
      content: "压缩已完成",
      compactionId: "context-compaction:turn-1",
      compactionStatus: "done",
      isStreaming: false
    });
    expect(state.messages[0]).not.toHaveProperty("traces");
    expect(state.messages[0]).not.toHaveProperty("activitySegmentId");
  });

  it("ignores late history responses for chats that are no longer current", () => {
    let state = agentReducer(initialAgentState, {
      type: "agent/historyLoading",
      sessionKey: "websocket:chat-a",
      chatId: "chat-a",
      requestId: "req-a"
    });
    state = agentReducer(state, {
      type: "agent/historyLoading",
      sessionKey: "websocket:chat-b",
      chatId: "chat-b",
      requestId: "req-b"
    });
    state = agentReducer(state, {
      type: "agent/historyLoaded",
      requestId: "req-a",
      thread: {
        schemaVersion: 1,
        sessionKey: "websocket:chat-a",
        messages: [{ role: "user", content: "A 的旧历史" }]
      }
    });

    expect(state.currentChatId).toBe("chat-b");
    expect(state.messages).toEqual([]);
  });

  it("keeps live cached messages when an older snapshot is a prefix", () => {
    let state = loadHistory(initialAgentState, "websocket:chat-1", [{ role: "user", content: "问题" }]);
    state = agentReducer(state, { type: "agent/wsEvent", event: { event: "delta", chat_id: "chat-1", text: "正在回答" } });
    expect(state.messages.map((message) => message.content)).toEqual(["问题", "正在回答"]);

    state = agentReducer(state, {
      type: "agent/historyLoading",
      sessionKey: "websocket:chat-1",
      chatId: "chat-1",
      requestId: "stale"
    });
    state = agentReducer(state, {
      type: "agent/historyLoaded",
      requestId: "stale",
      thread: {
        schemaVersion: 1,
        sessionKey: "websocket:chat-1",
        messages: [{ role: "user", content: "问题" }]
      }
    });

    expect(state.messages.map((message) => message.content)).toEqual(["问题", "正在回答"]);
    expect(state.messagesByChatId["chat-1"]?.map((message) => message.content)).toEqual(["问题", "正在回答"]);
  });

  it("keeps completed structured tool activity and later progress in one turn activity segment", () => {
    let state = agentReducer(initialAgentState, { type: "agent/wsEvent", event: { event: "ready", chat_id: "chat-1" } });
    state = agentReducer(state, {
      type: "agent/wsEvent",
      event: { event: "goal_status", chat_id: "chat-1", status: "running", started_at: 1780732800 }
    });
    state = agentReducer(state, {
      type: "agent/wsEvent",
      event: {
        event: "message",
        chat_id: "chat-1",
        kind: "progress",
        tool_events: [{ phase: "start", call_id: "call-1", name: "web_search", arguments: { query: "Memmy" } }]
      }
    });
    expect(state.isSending).toBe(true);
    expect(state.messages).toHaveLength(1);
    expect(state.messages[0]).toMatchObject({ isStreaming: true });

    state = agentReducer(state, {
      type: "agent/wsEvent",
      event: {
        event: "message",
        chat_id: "chat-1",
        kind: "tool_hint",
        tool_events: [{ phase: "end", call_id: "call-1", name: "web_search", arguments: { query: "Memmy" }, result: { count: 3 } }]
      }
    });

    expect(state.isSending).toBe(true);
    expect(state.messages).toHaveLength(1);
    expect(state.messages[0]).toMatchObject({
      role: "tool",
      kind: "trace",
      // toolTraceLinesFromEvents now emits Cursor-style one-liners derived from
      // the tool name and arguments instead of leaking the raw JSON blob into
      // the persisted trace. See the humanization contract in
      // agent-tool-traces.ts's summarizeToolCall for the full alias table.
      traces: ["Searched web for Memmy"],
      toolEvents: [{ phase: "end", call_id: "call-1", name: "web_search" }],
      activitySegmentId: "activity-1",
      isStreaming: false
    });

    state = agentReducer(state, {
      type: "agent/wsEvent",
      event: {
        event: "message",
        chat_id: "chat-1",
        kind: "progress",
        text: "整理检索结果"
      }
    });
    state = agentReducer(state, { type: "agent/wsEvent", event: { event: "stream_end", chat_id: "chat-1", text: "阶段结束" } });

    expect(state.isSending).toBe(true);
    expect(state.messages).toHaveLength(2);
    expect(state.messages[0]).toMatchObject({
      role: "tool",
      kind: "trace",
      traces: ["Searched web for Memmy"],
      toolEvents: [{ phase: "end", call_id: "call-1", name: "web_search" }],
      activitySegmentId: "activity-1",
      isStreaming: false
    });
    expect(state.messages[1]).toMatchObject({
      role: "tool",
      kind: "trace",
      traces: ["整理检索结果"],
      activitySegmentId: "activity-1",
      isStreaming: true
    });

    state = agentReducer(state, { type: "agent/wsEvent", event: { event: "turn_end", chat_id: "chat-1", latency_ms: 120 } });
    expect(state.isSending).toBe(false);
    expect(state.refreshRequested).toBe(false);
    expect(state.messages.every((message) => !message.isStreaming && !message.reasoningStreaming)).toBe(true);
  });

  it("keeps tracked file edit tool trace and file edit rows in one activity segment", () => {
    let state = agentReducer(initialAgentState, { type: "agent/wsEvent", event: { event: "ready", chat_id: "chat-1" } });
    state = agentReducer(state, {
      type: "agent/wsEvent",
      event: {
        event: "file_edit",
        chat_id: "chat-1",
        edits: [{ call_id: "call-write", tool: "write_file", path: "", pending: true, phase: "start" }]
      }
    });
    state = agentReducer(state, {
      type: "agent/wsEvent",
      event: {
        event: "file_edit",
        chat_id: "chat-1",
        edits: [{ call_id: "call-write", tool: "write_file", path: "/tmp/a.txt", phase: "start", added: 1, deleted: 0 }]
      }
    });
    state = agentReducer(state, {
      type: "agent/wsEvent",
      event: {
        event: "file_edit",
        chat_id: "chat-1",
        edits: [{ call_id: "call-write", tool: "write_file", path: "/tmp/a.txt", phase: "end", added: 1, deleted: 0 }]
      }
    });
    state = agentReducer(state, {
      type: "agent/wsEvent",
      event: {
        event: "message",
        chat_id: "chat-1",
        kind: "progress",
        tool_events: [
          { phase: "end", call_id: "call-write", name: "write_file", arguments: { path: "/tmp/a.txt", content: "草泥马" } }
        ]
      }
    });

    const fileEditMessage = state.messages.find((message) => message.fileEdits);
    const toolTraceMessage = state.messages.find((message) => message.toolEvents);
    const traceTexts = state.messages.flatMap((message) => [message.content, ...(message.traces ?? [])]);

    expect(fileEditMessage).toMatchObject({
      role: "tool",
      kind: "trace",
      content: "",
      traces: [],
      fileEdits: [{ call_id: "call-write", tool: "write_file", path: "/tmp/a.txt", status: "done", added: 1, deleted: 0 }]
    });
    expect(toolTraceMessage).toMatchObject({
      role: "tool",
      kind: "trace",
      traces: ["Wrote a.txt"],
      toolEvents: [{ phase: "end", call_id: "call-write", name: "write_file" }],
      isStreaming: false
    });
    expect(fileEditMessage).toMatchObject({ isStreaming: false });
    expect(fileEditMessage?.activitySegmentId).toBe(toolTraceMessage?.activitySegmentId);
    expect(traceTexts).not.toContain("write_file(/tmp/a.txt)");
    expect(traceTexts).not.toContain('write_file({"path": "/tmp/a.txt", "content": "草泥马"})');
  });

  it("keeps a shared activity segment running until both file edit and tool trace complete", () => {
    let state = agentReducer(initialAgentState, { type: "agent/wsEvent", event: { event: "ready", chat_id: "chat-1" } });
    state = agentReducer(state, {
      type: "agent/wsEvent",
      event: {
        event: "message",
        chat_id: "chat-1",
        kind: "progress",
        tool_events: [{ phase: "start", call_id: "call-edit", name: "edit_file", arguments: { path: "/tmp/a.txt" } }]
      }
    });
    state = agentReducer(state, {
      type: "agent/wsEvent",
      event: {
        event: "file_edit",
        chat_id: "chat-1",
        edits: [{ call_id: "call-edit", tool: "edit_file", path: "/tmp/a.txt", phase: "end", added: 2, deleted: 1 }]
      }
    });

    const activeToolTrace = state.messages.find((message) => message.toolEvents);
    const completedFileEdit = state.messages.find((message) => message.fileEdits);
    expect(activeToolTrace).toMatchObject({ isStreaming: true });
    expect(completedFileEdit).toMatchObject({ isStreaming: false });
    expect(activeToolTrace?.activitySegmentId).toBe(completedFileEdit?.activitySegmentId);

    state = agentReducer(state, {
      type: "agent/wsEvent",
      event: {
        event: "message",
        chat_id: "chat-1",
        kind: "progress",
        tool_events: [{ phase: "end", call_id: "call-edit", name: "edit_file", arguments: { path: "/tmp/a.txt" } }]
      }
    });

    expect(state.messages.filter((message) => message.kind === "trace")).toHaveLength(2);
    expect(state.messages.every((message) => !message.isStreaming)).toBe(true);
  });

  it("links file edit rows to an earlier tracked tool trace by call id", () => {
    let state = agentReducer(initialAgentState, { type: "agent/wsEvent", event: { event: "ready", chat_id: "chat-1" } });
    state = agentReducer(state, {
      type: "agent/wsEvent",
      event: {
        event: "message",
        chat_id: "chat-1",
        kind: "progress",
        tool_events: [{ phase: "start", call_id: "call-edit", name: "edit_file", arguments: { path: "/tmp/a.txt" } }]
      }
    });
    state = agentReducer(state, {
      type: "agent/wsEvent",
      event: {
        event: "file_edit",
        chat_id: "chat-1",
        edits: [{ call_id: "call-edit", tool: "edit_file", path: "/tmp/a.txt", phase: "start", added: 2, deleted: 1 }]
      }
    });
    state = agentReducer(state, {
      type: "agent/wsEvent",
      event: {
        event: "file_edit",
        chat_id: "chat-1",
        edits: [{ call_id: "call-edit", tool: "edit_file", path: "/tmp/a.txt", phase: "end", added: 2, deleted: 1 }]
      }
    });
    state = agentReducer(state, {
      type: "agent/wsEvent",
      event: {
        event: "message",
        chat_id: "chat-1",
        kind: "progress",
        tool_events: [{ phase: "end", call_id: "call-edit", name: "edit_file", arguments: { path: "/tmp/a.txt" } }]
      }
    });

    const toolTraceMessages = state.messages.filter((message) => message.toolEvents);
    const fileEditMessages = state.messages.filter((message) => message.fileEdits);

    expect(toolTraceMessages).toHaveLength(1);
    expect(fileEditMessages).toHaveLength(1);
    expect(toolTraceMessages[0]).toMatchObject({
      traces: ["Edited a.txt"],
      toolEvents: [{ phase: "end", call_id: "call-edit", name: "edit_file" }],
      isStreaming: false
    });
    expect(fileEditMessages[0]).toMatchObject({
      content: "",
      traces: [],
      fileEdits: [{ call_id: "call-edit", tool: "edit_file", path: "/tmp/a.txt", status: "done", added: 2, deleted: 1 }],
      isStreaming: false
    });
    expect(fileEditMessages[0]?.activitySegmentId).toBe(toolTraceMessages[0]?.activitySegmentId);
  });

  it.each(["write_file", "edit_file", "apply_patch"] as const)("keeps %s file edit activity data-only without summary traces", (toolName) => {
    const callId = `call-${toolName}`;
    let state = agentReducer(initialAgentState, { type: "agent/wsEvent", event: { event: "ready", chat_id: "chat-1" } });
    state = agentReducer(state, {
      type: "agent/wsEvent",
      event: {
        event: "file_edit",
        chat_id: "chat-1",
        edits: [{ call_id: callId, tool: toolName, path: "/tmp/a.txt", phase: "end", added: 1, deleted: 0 }]
      }
    });
    state = agentReducer(state, {
      type: "agent/wsEvent",
      event: {
        event: "message",
        chat_id: "chat-1",
        kind: "progress",
        tool_events: [{ phase: "end", call_id: callId, name: toolName, arguments: { path: "/tmp/a.txt" } }]
      }
    });

    const fileEditMessage = state.messages.find((message) => message.fileEdits);
    const toolTraceMessage = state.messages.find((message) => message.toolEvents);
    const traceTexts = state.messages.flatMap((message) => [message.content, ...(message.traces ?? [])]);

    expect(fileEditMessage).toMatchObject({ content: "", traces: [] });
    // write_file / edit_file / apply_patch all resolve to the "edit" canonical
    // action → the trace line reads "Wrote a.txt" for write_file and
    // "Edited a.txt" for edit_file / apply_patch. The important invariant is
    // that we never leak the raw JSON payload for the file edit tool call.
    const expectedTrace = toolName === "write_file" ? "Wrote a.txt" : "Edited a.txt";
    expect(toolTraceMessage?.traces).toEqual([expectedTrace]);
    expect(fileEditMessage).toMatchObject({ isStreaming: false });
    expect(toolTraceMessage).toMatchObject({ isStreaming: false });
    expect(fileEditMessage?.activitySegmentId).toBe(toolTraceMessage?.activitySegmentId);
    expect(traceTexts).not.toContain(`${toolName}(/tmp/a.txt)`);
    expect(traceTexts).not.toContain(`${toolName}({"path": "/tmp/a.txt"})`);
  });

  it("keeps intermediate assistant text visible between non-contiguous tool activity in the same turn segment", () => {
    // First-principles regression test: Cursor alternates reasoning/tool/body blocks
    // in chronological order, and every body block stays visible permanently.
    // The previous "fold everything into one activity segment" behavior turned
    // the intermediate answer gray and merged it into the trace list, which is the exact bug
    // reported: an intermediate answer retroactively re-styled as a thought.
    vi.spyOn(Date, "now").mockReturnValue(1781240000000);
    let state = agentReducer(initialAgentState, { type: "agent/wsEvent", event: { event: "ready", chat_id: "chat-1" } });
    state = agentReducer(state, {
      type: "agent/wsEvent",
      event: { event: "message", chat_id: "chat-1", kind: "progress", text: "第一段工具活动" }
    });
    state = agentReducer(state, {
      type: "agent/wsEvent",
      event: { event: "message", chat_id: "chat-1", text: "中间回答" }
    });
    state = agentReducer(state, {
      type: "agent/wsEvent",
      event: { event: "message", chat_id: "chat-1", kind: "progress", text: "第二段工具活动" }
    });

    const assistantMessages = state.messages.filter((message) => message.role === "assistant" && message.kind !== "trace");
    const activityMessages = state.messages.filter((message) => message.kind === "trace");
    expect(assistantMessages.map((message) => message.content)).toEqual(["中间回答"]);
    expect(activityMessages.map((message) => message.activitySegmentId)).toEqual(["activity-1", "activity-1"]);
    expect(activityMessages.flatMap((message) => message.traces ?? [])).toEqual([
      "第一段工具活动",
      "第二段工具活动"
    ]);
    // Chronological order is preserved: tool → answer → tool, not answer swallowed into activity.
    expect(state.messages.map((message) => message.kind === "trace" ? "trace" : message.role)).toEqual([
      "trace",
      "assistant",
      "trace"
    ]);
  });

  it("keeps unrelated file edit traces as separate rows in the same turn activity segment", () => {
    vi.spyOn(Date, "now").mockReturnValue(1781240000000);
    let state = agentReducer(initialAgentState, { type: "agent/wsEvent", event: { event: "ready", chat_id: "chat-1" } });
    state = agentReducer(state, {
      type: "agent/wsEvent",
      event: { event: "file_edit", chat_id: "chat-1", edits: [{ path: "README.md" }] }
    });
    state = agentReducer(state, {
      type: "agent/wsEvent",
      event: { event: "file_edit", chat_id: "chat-1", edits: [{ path: "CHANGELOG.md" }] }
    });

    expect(state.messages).toHaveLength(2);
    expect(state.messages.map((message) => message.activitySegmentId)).toEqual(["activity-1", "activity-1"]);
    expect(state.messages.map((message) => message.fileEdits?.[0]?.path)).toEqual(["README.md", "CHANGELOG.md"]);
  });

  it("normalizes live structured media by kind and filename fallback", () => {
    let state = agentReducer(initialAgentState, { type: "agent/wsEvent", event: { event: "ready", chat_id: "chat-1" } });

    state = agentReducer(state, {
      type: "agent/wsEvent",
      event: {
        event: "message",
        chat_id: "chat-1",
        text: "attachments",
        media_urls: [
          { url: "/api/media/sig/deck", name: "deck.pptx" },
          { url: "/api/media/sig/image", name: "result.png" },
          { url: "/api/media/sig/clip", name: "clip.mp4" },
          { url: "/api/media/sig/explicit", name: "archive.bin", kind: "file", path: "/Users/yuan/archive.bin" }
        ]
      }
    });

    expect(state.messages[0]).toMatchObject({
      role: "assistant",
      media: [
        { kind: "file", url: "/api/media/sig/deck", name: "deck.pptx" },
        { kind: "image", url: "/api/media/sig/image", name: "result.png" },
        { kind: "video", url: "/api/media/sig/clip", name: "clip.mp4" },
        { kind: "file", url: "/api/media/sig/explicit", name: "archive.bin", path: "/Users/yuan/archive.bin" }
      ]
    });
  });

  it("handles media rejection as a turn error without marking the websocket connection failed", () => {
    let state = agentReducer(initialAgentState, { type: "agent/wsEvent", event: { event: "ready", chat_id: "chat-1" } });
    state = agentReducer(state, {
      type: "agent/userMessageQueued",
      chatId: "chat-1",
      content: "描述图片",
      media: [{ kind: "image", url: "data:image/svg+xml;base64,AAAA", name: "vector.svg" }]
    });
    expect(state.isSending).toBe(true);
    expect(state.optimisticSendingByChatId["chat-1"]).toBe(true);

    state = agentReducer(state, {
      type: "agent/wsEvent",
      event: { event: "error", chat_id: "chat-1", detail: "attachment_rejected", reason: "mime" }
    });

    expect(state.connectionStatus).toBe("connected");
    expect(state.isSending).toBe(false);
    expect(state.optimisticSendingByChatId["chat-1"]).toBeUndefined();
    expect(state.error).toBe("home.media.error.sendUnsupported");
    expect(state.messages).toHaveLength(1);
    expect(state.messages[0]).toMatchObject({ role: "user", content: "描述图片" });
  });

  it("uses the current chat as a fallback for media rejection events without chat ids", () => {
    let state = agentReducer(initialAgentState, { type: "agent/wsEvent", event: { event: "ready", chat_id: "chat-1" } });
    state = agentReducer(state, {
      type: "agent/userMessageQueued",
      chatId: "chat-1",
      content: "描述图片"
    });

    state = agentReducer(state, {
      type: "agent/wsEvent",
      event: { event: "error", detail: "attachment_rejected", reason: "too_many_attachments" }
    });

    expect(state.connectionStatus).toBe("connected");
    expect(state.isSending).toBe(false);
    expect(state.optimisticSendingByChatId["chat-1"]).toBeUndefined();
    expect(state.error).toBe("home.media.error.sendTooManyAttachments");
  });

  it("restores blank draft state after a transient pre-send failure", () => {
    let state = agentReducer(initialAgentState, { type: "agent/sessionsLoaded", sessions });
    state = agentReducer(state, { type: "agent/newChatCreated", chatId: "chat-transient" });
    state = agentReducer(state, { type: "agent/transientSendFailed", chatId: "chat-transient" });

    expect(state.currentChatId).toBeNull();
    expect(state.currentSessionKey).toBeNull();
    expect(state.blankDraftActive).toBe(true);
    expect(state.isSending).toBe(false);
    expect(state.tasks.some((task) => task.chatId === "chat-transient")).toBe(false);
  });

  it("clears a stale transient task without replacing the active canonical chat", () => {
    let state = agentReducer(initialAgentState, { type: "agent/sessionsLoaded", sessions });
    state = loadHistory(state, "websocket:chat-1", [{ role: "user", content: "当前会话" }]);
    state = {
      ...state,
      optimisticTasksByChatId: {
        ...state.optimisticTasksByChatId,
        "chat-transient": { content: "未保存消息", createdAt: "2026-06-18T00:00:00.000Z" }
      }
    };

    state = agentReducer(state, { type: "agent/transientSendFailed", chatId: "chat-transient" });

    expect(state.currentChatId).toBe("chat-1");
    expect(state.currentSessionKey).toBe("websocket:chat-1");
    expect(state.blankDraftActive).toBe(false);
    expect(state.messages).toEqual([{ id: "user-0", role: "user", content: "当前会话" }]);
    expect(state.tasks.some((task) => task.chatId === "chat-transient")).toBe(false);
  });

  it("historyOpenMissing preserves live optimistic send state", () => {
    let state = agentReducer(initialAgentState, {
      type: "agent/userMessageQueued",
      chatId: "chat-1",
      content: "确认是这个吗？"
    });
    state = agentReducer(state, {
      type: "agent/historyLoading",
      sessionKey: "websocket:chat-1",
      chatId: "chat-1",
      requestId: "req-1"
    });

    state = agentReducer(state, {
      type: "agent/historyOpenMissing",
      sessionKey: "websocket:chat-1",
      chatId: "chat-1",
      requestId: "req-1"
    });

    expect(state.isLoadingHistory).toBe(false);
    expect(state.currentChatId).toBe("chat-1");
    expect(state.currentSessionKey).toBe("websocket:chat-1");
    expect(state.messages).toHaveLength(1);
    expect(state.messages[0]).toMatchObject({ role: "user", content: "确认是这个吗？" });
    expect(state.optimisticSendingByChatId["chat-1"]).toBe(true);
    expect(state.optimisticTasksByChatId["chat-1"]).toMatchObject({ content: "确认是这个吗？" });
    expect(state.pendingCanonicalHydrateByChatId["chat-1"]).toBeUndefined();
    expect(state.currentHistoryRequestIdByChatId["chat-1"]).toBeUndefined();
    expect(state.blankDraftActive).toBe(false);
    expect(state.isSending).toBe(true);
    expect(state.refreshRequested).toBe(true);
  });

  it("handles message_too_big as a scoped transport error", () => {
    let state = agentReducer(initialAgentState, { type: "agent/wsEvent", event: { event: "ready", chat_id: "chat-big" } });
    state = agentReducer(state, {
      type: "agent/userMessageQueued",
      chatId: "chat-big",
      content: "大消息"
    });

    state = agentReducer(state, {
      type: "agent/wsEvent",
      event: { event: "transport_error", detail: "message_too_big" }
    });

    expect(state.connectionStatus).toBe("connected");
    expect(state.isSending).toBe(false);
    expect(state.optimisticSendingByChatId["chat-big"]).toBeUndefined();
    expect(state.error).toBe("home.media.error.messageTooBig");
  });

  it("preserves structured media path and kind from webui-thread history", () => {
    const state = loadHistory(initialAgentState, "websocket:chat-media", [
      {
        role: "assistant",
        content: "deck ready",
        media: [
          { kind: "file", name: "deck.pptx", path: "/Users/yuan/deck.pptx" },
          { url: "/api/media/sig/image", name: "result.png" }
        ]
      }
    ]);

    expect(state.messages[0]).toMatchObject({
      role: "assistant",
      media: [
        { kind: "file", name: "deck.pptx", path: "/Users/yuan/deck.pptx" },
        { kind: "image", url: "/api/media/sig/image", name: "result.png" }
      ]
    });
  });

  it("stops the current turn without adding a /stop user message", () => {
    let state = agentReducer(initialAgentState, { type: "agent/wsEvent", event: { event: "ready", chat_id: "chat-1" } });
    state = agentReducer(state, {
      type: "agent/userMessageQueued",
      chatId: "chat-1",
      content: "执行一个长任务"
    });
    state = agentReducer(state, { type: "agent/wsEvent", event: { event: "delta", chat_id: "chat-1", text: "处理中" } });
    expect(state.isSending).toBe(true);

    state = agentReducer(state, { type: "agent/stopRequested", chatId: "chat-1" });

    expect(state.isSending).toBe(false);
    expect(state.messages.map((message) => message.content)).toEqual(["执行一个长任务", "处理中"]);
    expect(state.messages.some((message) => message.content === "/stop")).toBe(false);
    expect(state.messages[1]).toMatchObject({ isStreaming: false });
  });

  it("marks loaded activity as user-stopped so the UI can keep it visible", () => {
    let state = agentReducer(initialAgentState, { type: "agent/sessionsLoaded", sessions });
    state = agentReducer(state, { type: "agent/wsEvent", event: { event: "ready", chat_id: "chat-1" } });
    state = agentReducer(state, {
      type: "agent/userMessageQueued",
      chatId: "chat-1",
      content: "先读一下项目"
    });
    state = agentReducer(state, {
      type: "agent/wsEvent",
      event: { event: "goal_status", chat_id: "chat-1", status: "running", started_at: 1780732800 }
    });
    state = agentReducer(state, {
      type: "agent/wsEvent",
      event: { event: "message", chat_id: "chat-1", kind: "progress", text: "读取文件中" }
    });

    state = agentReducer(state, { type: "agent/stopRequested", chatId: "chat-1" });

    expect(state.isSending).toBe(false);
    expect(state.messages.at(-1)).toMatchObject({
      role: "tool",
      kind: "trace",
      content: "读取文件中",
      isStreaming: false,
      stoppedByUser: true
    });

    state = agentReducer(state, {
      type: "agent/historyHydrateLoading",
      sessionKey: "websocket:chat-1",
      chatId: "chat-1",
      requestId: "hydrate-stopped"
    });
    state = agentReducer(state, {
      type: "agent/historyHydrateLoaded",
      requestId: "hydrate-stopped",
      thread: {
        schemaVersion: 3,
        sessionKey: "websocket:chat-1",
        messages: [
          { role: "user", content: "先读一下项目" },
          { role: "tool", kind: "trace", content: "读取文件中", traces: ["读取文件中"] }
        ]
      }
    });

    expect(state.messages.at(-1)).toMatchObject({ content: "读取文件中", stoppedByUser: true });
  });

  it("tracks restart lifecycle across websocket disconnect and reconnect", () => {
    vi.spyOn(Date, "now").mockReturnValue(1781240000500);
    let state = agentReducer(initialAgentState, { type: "agent/restartRequested", startedAt: 1781240000000 });

    expect(state).toMatchObject({
      isRestarting: true,
      restartStartedAt: 1781240000000,
      restartSawDisconnect: false,
      restartCompletedAt: null,
      restartError: null
    });

    state = agentReducer(state, { type: "agent/wsEvent", event: { event: "ready", chat_id: "chat-1" } });
    expect(state.isRestarting).toBe(true);
    expect(state.restartCompletedAt).toBeNull();

    state = agentReducer(state, { type: "agent/wsEvent", event: { event: "connection_closed" } });
    expect(state.restartSawDisconnect).toBe(true);
    expect(state.connectionStatus).toBe("reconnecting");

    state = agentReducer(state, { type: "agent/wsEvent", event: { event: "ready", chat_id: "chat-1" } });
    expect(state.isRestarting).toBe(false);
    expect(state.restartCompletedAt).toBe(1781240000500);
    expect(state.restartError).toBeNull();
  });

  it("restores and fails restart state explicitly", () => {
    let state = agentReducer(initialAgentState, {
      type: "agent/restartRestored",
      chatId: "chat-9",
      startedAt: 1781240000000,
      sawDisconnect: true
    });

    expect(state).toMatchObject({
      currentChatId: "chat-9",
      currentSessionKey: "websocket:chat-9",
      isRestarting: true,
      restartStartedAt: 1781240000000,
      restartSawDisconnect: true
    });

    state = agentReducer(state, { type: "agent/restartFailed", message: "restart unavailable" });
    expect(state.isRestarting).toBe(false);
    expect(state.restartSawDisconnect).toBe(false);
    expect(state.restartError).toBe("restart unavailable");
  });

  it("turns off sending when goal status becomes idle", () => {
    let state = agentReducer(initialAgentState, { type: "agent/sessionsLoaded", sessions });
    state = agentReducer(state, { type: "agent/wsEvent", event: { event: "ready", chat_id: "chat-1" } });
    state = agentReducer(state, {
      type: "agent/userMessageQueued",
      chatId: "chat-1",
      content: "执行一个长任务"
    });
    state = agentReducer(state, {
      type: "agent/wsEvent",
      event: { event: "goal_status", chat_id: "chat-1", status: "running", started_at: 1780732800 }
    });
    expect(state.isSending).toBe(true);

    state = agentReducer(state, { type: "agent/wsEvent", event: { event: "goal_status", chat_id: "chat-1", status: "idle" } });

    expect(state.isSending).toBe(false);
    expect(state.tasks.find((task) => task.chatId === "chat-1")?.runStartedAt).toBeNull();
  });

  it("ignores goal status idle while the content stream is still open", () => {
    // The send/stop button must not flicker mid-turn: an open inbound stream
    // is authoritative proof the turn is running, and racing status signals
    // (goal idle, stale session snapshots) may not end the busy state. Only
    // turn_end / stop_result — which settle the streaming flags — close it.
    let state = agentReducer(initialAgentState, { type: "agent/sessionsLoaded", sessions });
    state = agentReducer(state, { type: "agent/wsEvent", event: { event: "ready", chat_id: "chat-1" } });
    state = agentReducer(state, {
      type: "agent/wsEvent",
      event: { event: "goal_status", chat_id: "chat-1", status: "running", started_at: 1780732800 }
    });
    state = agentReducer(state, { type: "agent/wsEvent", event: { event: "delta", chat_id: "chat-1", text: "最终回答" } });
    expect(state.messages[0]).toMatchObject({ content: "最终回答", isStreaming: true });

    state = agentReducer(state, { type: "agent/wsEvent", event: { event: "goal_status", chat_id: "chat-1", status: "idle" } });

    expect(state.isSending).toBe(true);
    expect(state.messages[0]).toMatchObject({ content: "最终回答", isStreaming: true });
    expect(state.messagesByChatId["chat-1"]?.[0]).toMatchObject({ content: "最终回答", isStreaming: true });

    state = agentReducer(state, { type: "agent/wsEvent", event: { event: "turn_end", chat_id: "chat-1" } });
    expect(state.isSending).toBe(false);
    expect(state.messages[0]).toMatchObject({ content: "最终回答", isStreaming: false });
  });

  it("reconciles a disconnected finished turn from an authoritative idle snapshot", () => {
    let state = agentReducer(initialAgentState, { type: "agent/chatViewVisibilityChanged", visible: true });
    state = agentReducer(state, { type: "agent/sessionsLoaded", sessions });
    state = agentReducer(state, { type: "agent/wsEvent", event: { event: "ready", chat_id: "chat-1" } });
    state = agentReducer(state, {
      type: "agent/wsEvent",
      event: { event: "goal_status", chat_id: "chat-1", status: "running", started_at: 1780732800, turn_id: "turn-1" }
    });
    state = agentReducer(state, { type: "agent/wsEvent", event: { event: "reasoning_delta", chat_id: "chat-1", text: "先分析" } });
    state = agentReducer(state, { type: "agent/wsEvent", event: { event: "delta", chat_id: "chat-1", text: "最终回答" } });
    state = agentReducer(state, {
      type: "agent/wsEvent",
      event: { event: "retry_wait", chat_id: "chat-1", turn_id: "turn-1", text: "等待重试" }
    });
    state = agentReducer(state, { type: "agent/wsEvent", event: { event: "connection_closed" } });
    state = agentReducer(state, { type: "agent/wsEvent", event: { event: "ready", chat_id: "chat-1" } });
    state = agentReducer(state, { type: "agent/wsEvent", event: { event: "attached", chat_id: "chat-1" } });

    state = agentReducer(state, {
      type: "agent/wsEvent",
      event: { event: "run_status_snapshot", chat_id: "chat-1", status: "idle", turn_id: "turn-1" }
    });

    expect(state.runStartedAtByChatId["chat-1"]).toBeNull();
    expect(state.isSending).toBe(false);
    expect(state.messages.every((message) => !message.isStreaming && !message.reasoningStreaming)).toBe(true);
    expect(state.messages.every((message) => message.stoppedByUser !== true)).toBe(true);
    expect(state.messagesByChatId["chat-1"]?.every((message) => !message.isStreaming && !message.reasoningStreaming)).toBe(true);
    expect(state.retryWaitStatusByChatId["chat-1"]?.isRunning).toBe(false);
    expect(state.tasks.find((task) => task.chatId === "chat-1")?.runStartedAt).toBeNull();
    expect(state.lastTaskCompletion).toBeNull();
    expect(state.completedUnseenByChatId["chat-1"]).toBeUndefined();
    expect(state.closedTurnIdsByChatId["chat-1"]?.["turn-1"]).toBe("ended");
  });

  it("keeps optimistic sending when an idle snapshot precedes server running", () => {
    let state = agentReducer(initialAgentState, { type: "agent/wsEvent", event: { event: "ready", chat_id: "chat-1" } });
    state = agentReducer(state, { type: "agent/userMessageQueued", chatId: "chat-1", content: "新请求" });

    state = agentReducer(state, {
      type: "agent/wsEvent",
      event: { event: "run_status_snapshot", chat_id: "chat-1", status: "idle" }
    });

    expect(state.runStartedAtByChatId["chat-1"]).toBeNull();
    expect(state.optimisticSendingByChatId["chat-1"]).toBe(true);
    expect(state.isSending).toBe(true);

    state = agentReducer(state, {
      type: "agent/wsEvent",
      event: { event: "run_status_snapshot", chat_id: "chat-1", status: "running", started_at: 1780732800, turn_id: "turn-new" }
    });

    expect(state.runStartedAtByChatId["chat-1"]).toBe(1780732800);
    expect(state.optimisticSendingByChatId["chat-1"]).toBeUndefined();
    expect(state.isSending).toBe(true);
  });

  it("does not revive a closed turn from a late running snapshot", () => {
    let state = agentReducer(initialAgentState, { type: "agent/wsEvent", event: { event: "ready", chat_id: "chat-1" } });
    state = agentReducer(state, {
      type: "agent/wsEvent",
      event: { event: "goal_status", chat_id: "chat-1", status: "running", started_at: 1780732800, turn_id: "turn-closed" }
    });
    state = agentReducer(state, {
      type: "agent/wsEvent",
      event: { event: "turn_end", chat_id: "chat-1", turn_id: "turn-closed" }
    });
    const closed = state;

    state = agentReducer(state, {
      type: "agent/wsEvent",
      event: { event: "run_status_snapshot", chat_id: "chat-1", status: "running", started_at: 1780732900, turn_id: "turn-closed" }
    });

    expect(state).toBe(closed);
    expect(state.runStartedAtByChatId["chat-1"]).toBeNull();
    expect(state.isSending).toBe(false);
  });

  it("updates only the matching background chat from a run snapshot", () => {
    let state = agentReducer(initialAgentState, { type: "agent/sessionsLoaded", sessions });
    state = agentReducer(state, { type: "agent/newChatCreated", chatId: "chat-2" });
    state = agentReducer(state, {
      type: "agent/wsEvent",
      event: { event: "run_status_snapshot", chat_id: "chat-1", status: "running", started_at: 1780732800, turn_id: "turn-bg" }
    });

    expect(state.currentChatId).toBe("chat-2");
    expect(state.isSending).toBe(false);
    expect(state.runStartedAtByChatId["chat-1"]).toBe(1780732800);
    expect(state.tasks.find((task) => task.chatId === "chat-1")?.runStartedAt).toBe(1780732800);

    state = agentReducer(state, {
      type: "agent/wsEvent",
      event: { event: "run_status_snapshot", chat_id: "chat-1", status: "idle", turn_id: "turn-bg" }
    });

    expect(state.currentChatId).toBe("chat-2");
    expect(state.isSending).toBe(false);
    expect(state.tasks.find((task) => task.chatId === "chat-1")?.runStartedAt).toBeNull();
    expect(state.completedUnseenByChatId["chat-1"]).toBeUndefined();
  });

  it("clears a pending stop lock when an idle snapshot confirms no active run", () => {
    let state = agentReducer(initialAgentState, { type: "agent/wsEvent", event: { event: "ready", chat_id: "chat-1" } });
    state = agentReducer(state, { type: "agent/userMessageQueued", chatId: "chat-1", content: "停止这轮" });
    state = agentReducer(state, {
      type: "agent/wsEvent",
      event: { event: "goal_status", chat_id: "chat-1", status: "running", started_at: 1780732800, turn_id: "turn-stop" }
    });
    state = agentReducer(state, { type: "agent/stopRequested", chatId: "chat-1" });
    expect(state.stopInFlightByChatId["chat-1"]).toBe(true);

    state = agentReducer(state, {
      type: "agent/wsEvent",
      event: { event: "run_status_snapshot", chat_id: "chat-1", status: "idle", turn_id: "turn-stop" }
    });

    expect(state.stopInFlightByChatId["chat-1"]).toBeUndefined();
    expect(state.runStartedAtByChatId["chat-1"]).toBeNull();
    expect(state.isSending).toBe(false);
    expect(state.lastTaskCompletion).toBeNull();
  });

  it("ignores malformed run snapshots without changing reducer state", () => {
    const missingStartedAt = agentReducer(initialAgentState, {
      type: "agent/wsEvent",
      event: { event: "run_status_snapshot", chat_id: "chat-1", status: "running" }
    });
    const invalidStatus = agentReducer(initialAgentState, {
      type: "agent/wsEvent",
      event: { event: "run_status_snapshot", chat_id: "chat-1", status: "unknown" }
    });
    const missingChat = agentReducer(initialAgentState, {
      type: "agent/wsEvent",
      event: { event: "run_status_snapshot", status: "idle" }
    });

    expect(missingStartedAt).toBe(initialAgentState);
    expect(invalidStatus).toBe(initialAgentState);
    expect(missingChat).toBe(initialAgentState);
  });

  it("keeps repeated run snapshots user-state idempotent", () => {
    let state = agentReducer(initialAgentState, { type: "agent/wsEvent", event: { event: "ready", chat_id: "chat-1" } });
    state = agentReducer(state, {
      type: "agent/wsEvent",
      event: { event: "run_status_snapshot", chat_id: "chat-1", status: "running", started_at: 1780732800, turn_id: "turn-1" }
    });
    state = agentReducer(state, {
      type: "agent/wsEvent",
      event: { event: "run_status_snapshot", chat_id: "chat-1", status: "running", started_at: 1780732800, turn_id: "turn-1" }
    });
    expect(state.messages).toEqual([]);
    expect(state.runStartedAtByChatId["chat-1"]).toBe(1780732800);

    state = agentReducer(state, {
      type: "agent/wsEvent",
      event: { event: "run_status_snapshot", chat_id: "chat-1", status: "idle", turn_id: "turn-1" }
    });
    state = agentReducer(state, {
      type: "agent/wsEvent",
      event: { event: "run_status_snapshot", chat_id: "chat-1", status: "idle", turn_id: "turn-1" }
    });

    expect(state.messages).toEqual([]);
    expect(state.runStartedAtByChatId["chat-1"]).toBeNull();
    expect(state.lastTaskCompletion).toBeNull();
    expect(state.completedUnseenByChatId["chat-1"]).toBeUndefined();
  });

  it("keeps sending while streaming when a session refresh reports the chat as idle", () => {
    let state = agentReducer(initialAgentState, { type: "agent/sessionsLoaded", sessions });
    state = agentReducer(state, { type: "agent/wsEvent", event: { event: "ready", chat_id: "chat-1" } });
    state = agentReducer(state, {
      type: "agent/wsEvent",
      event: { event: "goal_status", chat_id: "chat-1", status: "running", started_at: 1780732800 }
    });
    state = agentReducer(state, { type: "agent/wsEvent", event: { event: "delta", chat_id: "chat-1", text: "处理中" } });
    expect(state.isSending).toBe(true);

    // A stale sessions snapshot without run_started_at lands mid-stream.
    state = agentReducer(state, { type: "agent/sessionsLoaded", sessions });

    expect(state.isSending).toBe(true);

    state = agentReducer(state, { type: "agent/wsEvent", event: { event: "turn_end", chat_id: "chat-1" } });
    expect(state.isSending).toBe(false);
  });

  it("keeps current sessions list when an older sessions response arrives late", () => {
    let state = agentReducer(initialAgentState, { type: "agent/sessionsLoading", requestId: "old" });
    state = agentReducer(state, { type: "agent/sessionsLoading", requestId: "new" });
    state = agentReducer(state, {
      type: "agent/sessionsLoaded",
      requestId: "new",
      sessions: [{ ...sessions[0]!, title: "最新任务" }]
    });
    state = agentReducer(state, {
      type: "agent/sessionsLoaded",
      requestId: "old",
      sessions: [{ ...sessions[1]!, title: "旧响应" }]
    });

    expect(state.sessions.map((item) => item.key)).toEqual(["websocket:chat-1"]);
    expect(state.tasks.map((task) => task.title)).toEqual(["最新任务"]);
    expect(state.isLoadingSessions).toBe(false);
  });

  it("session list refresh clears stale local running when backend no longer reports run_started_at", () => {
    let state = agentReducer(initialAgentState, {
      type: "agent/sessionsLoaded",
      sessions: [{ ...sessions[0]!, run_started_at: 1780732800 }]
    });
    expect(state.tasks.find((task) => task.chatId === "chat-1")?.runStartedAt).toBe(1780732800);

    state = agentReducer(state, {
      type: "agent/sessionsLoaded",
      sessions: [{ ...sessions[0]!, run_started_at: undefined }]
    });

    expect(state.runStartedAtByChatId["chat-1"]).toBeNull();
    expect(state.tasks.find((task) => task.chatId === "chat-1")?.runStartedAt).toBeNull();
  });

  it("does not let a pre-terminal session response restore stale running", () => {
    let state = agentReducer(initialAgentState, { type: "agent/sessionsLoaded", sessions });
    state = agentReducer(state, { type: "agent/wsEvent", event: { event: "ready", chat_id: "chat-1" } });
    state = agentReducer(state, {
      type: "agent/wsEvent",
      event: { event: "goal_status", chat_id: "chat-1", status: "running", started_at: 100, turn_id: "turn-1" }
    });
    state = agentReducer(state, { type: "agent/sessionsLoading", requestId: "req-stale-running" });
    const requestVersion = state.currentSessionsRequestRunStatusVersionByChatId?.["chat-1"];
    state = agentReducer(state, {
      type: "agent/wsEvent",
      event: { event: "turn_end", chat_id: "chat-1", turn_id: "turn-1" }
    });
    expect(state.runStatusVersionByChatId["chat-1"]).toBeGreaterThan(requestVersion ?? 0);

    state = agentReducer(state, {
      type: "agent/sessionsLoaded",
      requestId: "req-stale-running",
      sessions: [{ ...sessions[0]!, run_started_at: 100 }]
    });

    expect(state.runStartedAtByChatId["chat-1"]).toBeNull();
    expect(state.isSending).toBe(false);
    expect(state.tasks.find((task) => task.chatId === "chat-1")?.runStartedAt).toBeNull();
    expect(state.currentSessionsRequestRunStatusVersionByChatId).toBeNull();
  });

  it("does not let a pre-snapshot idle session response clear newer running", () => {
    let state = agentReducer(initialAgentState, { type: "agent/sessionsLoaded", sessions });
    state = agentReducer(state, { type: "agent/wsEvent", event: { event: "ready", chat_id: "chat-1" } });
    state = agentReducer(state, { type: "agent/sessionsLoading", requestId: "req-stale-idle" });
    state = agentReducer(state, {
      type: "agent/wsEvent",
      event: { event: "run_status_snapshot", chat_id: "chat-1", status: "running", started_at: 1780732800, turn_id: "turn-1" }
    });

    state = agentReducer(state, {
      type: "agent/sessionsLoaded",
      requestId: "req-stale-idle",
      sessions
    });

    expect(state.runStartedAtByChatId["chat-1"]).toBe(1780732800);
    expect(state.isSending).toBe(true);
  });

  it("allows a later session request to reconcile run status after a snapshot", () => {
    let state = agentReducer(initialAgentState, { type: "agent/sessionsLoaded", sessions });
    state = agentReducer(state, { type: "agent/wsEvent", event: { event: "ready", chat_id: "chat-1" } });
    state = agentReducer(state, {
      type: "agent/wsEvent",
      event: { event: "run_status_snapshot", chat_id: "chat-1", status: "running", started_at: 1780732800 }
    });
    state = agentReducer(state, { type: "agent/sessionsLoading", requestId: "req-fresh" });

    state = agentReducer(state, {
      type: "agent/sessionsLoaded",
      requestId: "req-fresh",
      sessions
    });

    expect(state.runStartedAtByChatId["chat-1"]).toBeNull();
    expect(state.isSending).toBe(false);
  });

  it("limits session run-version conflicts to the affected chat", () => {
    let state = agentReducer(initialAgentState, { type: "agent/sessionsLoaded", sessions });
    state = agentReducer(state, { type: "agent/newChatCreated", chatId: "chat-1" });
    state = agentReducer(state, {
      type: "agent/wsEvent",
      event: { event: "goal_status", chat_id: "chat-1", status: "running", started_at: 100, turn_id: "turn-1" }
    });
    state = agentReducer(state, { type: "agent/sessionsLoading", requestId: "req-two-chats" });
    state = agentReducer(state, {
      type: "agent/wsEvent",
      event: { event: "run_status_snapshot", chat_id: "chat-1", status: "idle", turn_id: "turn-1" }
    });

    state = agentReducer(state, {
      type: "agent/sessionsLoaded",
      requestId: "req-two-chats",
      sessions: [
        { ...sessions[0]!, title: "chat one updated", run_started_at: 100 },
        { ...sessions[1]!, title: "chat two updated", run_started_at: 200 }
      ]
    });

    expect(state.runStartedAtByChatId["chat-1"]).toBeNull();
    expect(state.runStartedAtByChatId["chat-2"]).toBe(200);
    expect(state.sessions.map((session) => session.title)).toEqual(["chat one updated", "chat two updated"]);
  });

  it("keeps a new-chat task visible before the backend session list includes it", () => {
    vi.spyOn(Date, "now").mockReturnValue(1781240000000);
    let state = agentReducer(initialAgentState, { type: "agent/sessionsLoaded", sessions });
    state = agentReducer(state, { type: "agent/newChatCreated", chatId: "chat-new" });
    state = agentReducer(state, {
      type: "agent/userMessageQueued",
      chatId: "chat-new",
      content: "整理今天的 PPT",
      media: [{ kind: "file", name: "deck.pptx", path: "/Users/yuan/deck.pptx" }]
    });

    const optimisticTask = state.tasks.find((task) => task.chatId === "chat-new");
    expect(optimisticTask).toMatchObject({
      sessionKey: "websocket:chat-new",
      title: "整理今天的 PPT",
      preview: "整理今天的 PPT",
      runStartedAt: null,
      completedUnseen: false
    });
    expect(state.isSending).toBe(true);

    state = agentReducer(state, { type: "agent/sessionsLoading", requestId: "refresh-new" });
    state = agentReducer(state, { type: "agent/sessionsLoaded", requestId: "refresh-new", sessions });
    expect(state.tasks.some((task) => task.chatId === "chat-new")).toBe(true);

    state = agentReducer(state, {
      type: "agent/sessionsLoaded",
      sessions: [...sessions, { key: "websocket:chat-new", title: "后端标题", preview: "已保存", updatedAt: "2026-06-06T11:00:00.000Z" }]
    });
    expect(state.tasks.find((task) => task.chatId === "chat-new")).toMatchObject({
      title: "后端标题",
      preview: "已保存"
    });
    expect(state.optimisticTasksByChatId["chat-new"]).toBeUndefined();
  });

  it("marks background completed tasks as unseen and clears the dot when opened", () => {
    vi.spyOn(Date, "now").mockReturnValue(1781240000000);
    let state = agentReducer(initialAgentState, { type: "agent/sessionsLoaded", sessions });
    state = agentReducer(state, { type: "agent/wsEvent", event: { event: "ready", chat_id: "chat-1" } });
    state = agentReducer(state, {
      type: "agent/wsEvent",
      event: { event: "goal_status", chat_id: "chat-1", status: "running", started_at: 1780732800 }
    });
    state = agentReducer(state, {
      type: "agent/historyLoading",
      sessionKey: "websocket:chat-2",
      chatId: "chat-2",
      requestId: "chat-2-request"
    });

    state = agentReducer(state, { type: "agent/wsEvent", event: { event: "turn_end", chat_id: "chat-1" } });

    expect(state.currentChatId).toBe("chat-2");
    expect(state.tasks.find((task) => task.chatId === "chat-1")).toMatchObject({
      runStartedAt: null,
      completedUnseen: true
    });

    state = agentReducer(state, {
      type: "agent/historyLoading",
      sessionKey: "websocket:chat-1",
      chatId: "chat-1",
      requestId: "chat-1-request"
    });

    expect(state.tasks.find((task) => task.chatId === "chat-1")?.completedUnseen).toBe(false);
  });

  it("records lastTaskCompletion only when a busy chat truly finishes via turn_end", () => {
    vi.spyOn(Date, "now").mockReturnValue(1781240000000);
    expect(initialAgentState.lastTaskCompletion).toBeNull();

    let state = agentReducer(initialAgentState, { type: "agent/sessionsLoaded", sessions });
    state = agentReducer(state, { type: "agent/wsEvent", event: { event: "ready", chat_id: "chat-1" } });
    state = agentReducer(state, {
      type: "agent/wsEvent",
      event: { event: "goal_status", chat_id: "chat-1", status: "running", started_at: 1780732800 }
    });

    // There should be no completion signal before the task has ended.
    expect(state.lastTaskCompletion).toBeNull();

    state = agentReducer(state, { type: "agent/wsEvent", event: { event: "turn_end", chat_id: "chat-1" } });

    expect(state.lastTaskCompletion).toEqual({ chatId: "chat-1", at: 1781240000000 });
  });

  it("does not record lastTaskCompletion when turn_end arrives for a chat that was not busy", () => {
    vi.spyOn(Date, "now").mockReturnValue(1781240000000);
    let state = agentReducer(initialAgentState, { type: "agent/sessionsLoaded", sessions });
    state = agentReducer(state, { type: "agent/wsEvent", event: { event: "ready", chat_id: "chat-1" } });

    state = agentReducer(state, { type: "agent/wsEvent", event: { event: "turn_end", chat_id: "chat-1" } });

    expect(state.lastTaskCompletion).toBeNull();
  });

  it("updates task run status and current goal state from websocket events", () => {
    let state = agentReducer(initialAgentState, { type: "agent/sessionsLoaded", sessions });
    state = agentReducer(state, { type: "agent/wsEvent", event: { event: "ready", chat_id: "chat-1" } });
    state = agentReducer(state, {
      type: "agent/wsEvent",
      event: { event: "goal_status", chat_id: "chat-1", status: "running", started_at: 1780732800 }
    });
    state = agentReducer(state, {
      type: "agent/wsEvent",
      event: { event: "goal_state", chat_id: "chat-1", goal_state: { active: true, objective: "整理 PRD" } }
    });

    expect(state.tasks.find((task) => task.chatId === "chat-1")?.runStartedAt).toBe(1780732800);
    expect(state.goalState).toEqual({ active: true, objective: "整理 PRD" });

    state = agentReducer(state, { type: "agent/wsEvent", event: { event: "turn_end", chat_id: "chat-1" } });
    expect(state.tasks.find((task) => task.chatId === "chat-1")?.runStartedAt).toBeNull();
  });

  it("tracks stop in-flight and clears local busy on stop_result without appending messages", () => {
    let state = agentReducer(initialAgentState, { type: "agent/sessionsLoaded", sessions });
    state = agentReducer(state, { type: "agent/wsEvent", event: { event: "ready", chat_id: "chat-1" } });
    state = agentReducer(state, {
      type: "agent/userMessageQueued",
      chatId: "chat-1",
      content: "停止这轮"
    });
    state = agentReducer(state, {
      type: "agent/wsEvent",
      event: { event: "goal_status", chat_id: "chat-1", status: "running", started_at: 1780732800 }
    });
    state = agentReducer(state, { type: "agent/wsEvent", event: { event: "delta", chat_id: "chat-1", text: "处理中" } });

    state = agentReducer(state, { type: "agent/stopRequested", chatId: "chat-1" });
    expect(state.stopInFlightByChatId["chat-1"]).toBe(true);
    expect(state.isSending).toBe(false);
    expect(state.messages.at(-1)).toMatchObject({ role: "assistant", content: "处理中", isStreaming: false });
    expect(state.tasks.find((task) => task.chatId === "chat-1")?.runStartedAt).toBe(1780732800);

    state = agentReducer(state, { type: "agent/wsEvent", event: { event: "stop_result", chat_id: "chat-1", stopped: 1 } });
    expect(state.stopInFlightByChatId["chat-1"]).toBeUndefined();
    expect(state.tasks.find((task) => task.chatId === "chat-1")?.runStartedAt).toBeNull();
    expect(state.messages.map((message) => message.content)).toEqual(["停止这轮", "处理中"]);
    expect(state.messages.some((message) => message.content.includes("Stopped"))).toBe(false);
  });

  it("releases an unconfirmed stop so the composer never stays locked", () => {
    let state = agentReducer(initialAgentState, { type: "agent/sessionsLoaded", sessions });
    state = agentReducer(state, { type: "agent/wsEvent", event: { event: "ready", chat_id: "chat-1" } });
    state = agentReducer(state, { type: "agent/userMessageQueued", chatId: "chat-1", content: "停止这轮" });
    state = agentReducer(state, {
      type: "agent/wsEvent",
      event: { event: "goal_status", chat_id: "chat-1", status: "running", started_at: 1780732800 }
    });
    state = agentReducer(state, { type: "agent/stopRequested", chatId: "chat-1" });
    expect(state.stopInFlightByChatId["chat-1"]).toBe(true);

    // stop_result / turn_end never arrive (socket died mid-interrupt). The
    // grace-period action must return the chat to an idle, sendable state.
    state = agentReducer(state, { type: "agent/stopUnconfirmed", chatId: "chat-1" });
    expect(state.stopInFlightByChatId["chat-1"]).toBeUndefined();
    expect(state.isSending).toBe(false);
    expect(state.tasks.find((task) => task.chatId === "chat-1")?.runStartedAt).toBeNull();

    // Releasing an already-confirmed stop is a no-op.
    const unchanged = agentReducer(state, { type: "agent/stopUnconfirmed", chatId: "chat-1" });
    expect(unchanged).toBe(state);
  });

  it("does not let a stale session response restore running after an unconfirmed stop releases", () => {
    let state = agentReducer(initialAgentState, { type: "agent/sessionsLoaded", sessions });
    state = agentReducer(state, { type: "agent/wsEvent", event: { event: "ready", chat_id: "chat-1" } });
    state = agentReducer(state, { type: "agent/userMessageQueued", chatId: "chat-1", content: "停止这轮" });
    state = agentReducer(state, {
      type: "agent/wsEvent",
      event: { event: "goal_status", chat_id: "chat-1", status: "running", started_at: 1780732800 }
    });
    state = agentReducer(state, { type: "agent/sessionsLoading", requestId: "req-before-stop-timeout" });
    state = agentReducer(state, { type: "agent/stopRequested", chatId: "chat-1" });
    state = agentReducer(state, { type: "agent/stopUnconfirmed", chatId: "chat-1" });

    state = agentReducer(state, {
      type: "agent/sessionsLoaded",
      requestId: "req-before-stop-timeout",
      sessions: [{ ...sessions[0]!, run_started_at: 1780732800 }]
    });

    expect(state.runStartedAtByChatId["chat-1"]).toBeNull();
    expect(state.stopInFlightByChatId["chat-1"]).toBeUndefined();
    expect(state.isSending).toBe(false);
  });

  it("clears pending stop locks when the connection closes", () => {
    let state = agentReducer(initialAgentState, { type: "agent/sessionsLoaded", sessions });
    state = agentReducer(state, { type: "agent/wsEvent", event: { event: "ready", chat_id: "chat-1" } });
    state = agentReducer(state, { type: "agent/userMessageQueued", chatId: "chat-1", content: "断线停止" });
    state = agentReducer(state, { type: "agent/stopRequested", chatId: "chat-1" });
    expect(state.stopInFlightByChatId["chat-1"]).toBe(true);

    state = agentReducer(state, { type: "agent/wsEvent", event: { event: "connection_closed" } });
    expect(state.stopInFlightByChatId).toEqual({});
    expect(state.isSending).toBe(false);
  });

  it("does not finalize pending activity progress when a turn is stopped", () => {
    let state = agentReducer(initialAgentState, { type: "agent/sessionsLoaded", sessions });
    state = agentReducer(state, { type: "agent/wsEvent", event: { event: "ready", chat_id: "chat-1" } });
    state = agentReducer(state, {
      type: "agent/userMessageQueued",
      chatId: "chat-1",
      content: "停止工具"
    });
    state = agentReducer(state, {
      type: "agent/wsEvent",
      event: {
        event: "message",
        chat_id: "chat-1",
        kind: "progress",
        tool_events: [{ phase: "start", call_id: "call-read", name: "read_file", arguments: { path: "README.md" } }]
      }
    });
    state = agentReducer(state, {
      type: "agent/wsEvent",
      event: {
        event: "file_edit",
        chat_id: "chat-1",
        edits: [{ call_id: "call-edit", tool: "edit_file", path: "README.md", phase: "start", status: "editing" }]
      }
    });

    state = agentReducer(state, { type: "agent/stopRequested", chatId: "chat-1" });
    state = agentReducer(state, { type: "agent/wsEvent", event: { event: "stop_result", chat_id: "chat-1", stopped: 1 } });

    const toolTrace = state.messages.find((message) => message.toolEvents);
    const fileEditTrace = state.messages.find((message) => message.fileEdits);
    expect(toolTrace?.toolEvents?.[0]).toMatchObject({ call_id: "call-read", phase: "start" });
    expect(toolTrace?.stoppedByUser).toBe(true);
    expect(fileEditTrace?.fileEdits?.[0]).toMatchObject({ call_id: "call-edit", phase: "start", status: "editing" });
    expect(fileEditTrace?.stoppedByUser).toBe(true);
  });

  it("does not let late live events after stopRequested revive the active sending state", () => {
    let state = agentReducer(initialAgentState, { type: "agent/sessionsLoaded", sessions });
    state = agentReducer(state, { type: "agent/wsEvent", event: { event: "ready", chat_id: "chat-1" } });
    state = agentReducer(state, {
      type: "agent/userMessageQueued",
      chatId: "chat-1",
      content: "停止后仍有晚到事件"
    });
    state = agentReducer(state, {
      type: "agent/wsEvent",
      event: { event: "goal_status", chat_id: "chat-1", status: "running", started_at: 1780732800 }
    });
    state = agentReducer(state, { type: "agent/stopRequested", chatId: "chat-1" });

    state = agentReducer(state, {
      type: "agent/wsEvent",
      event: {
        event: "file_edit",
        chat_id: "chat-1",
        edits: [{ call_id: "call-edit", tool: "edit_file", path: "README.md", phase: "start", status: "editing" }]
      }
    });
    state = agentReducer(state, {
      type: "agent/wsEvent",
      event: { event: "message", chat_id: "chat-1", kind: "progress", text: "晚到工具进度" }
    });
    state = agentReducer(state, {
      type: "agent/wsEvent",
      event: { event: "reasoning_delta", chat_id: "chat-1", text: "晚到 reasoning" }
    });
    state = agentReducer(state, {
      type: "agent/wsEvent",
      event: { event: "delta", chat_id: "chat-1", text: "晚到回答" }
    });

    expect(state.isSending).toBe(false);
    expect(state.messages.slice(1).every((message) => message.isStreaming !== true)).toBe(true);
    expect(state.messages.slice(1).every((message) => message.reasoningStreaming !== true)).toBe(true);
    expect(state.messages.slice(1).every((message) => message.stoppedByUser === true)).toBe(true);
  });

  it("does not let late file edits after stop_result revive the active sending state", () => {
    let state = agentReducer(initialAgentState, { type: "agent/sessionsLoaded", sessions });
    state = agentReducer(state, { type: "agent/wsEvent", event: { event: "ready", chat_id: "chat-1" } });
    state = agentReducer(state, {
      type: "agent/userMessageQueued",
      chatId: "chat-1",
      content: "stop_result 后的晚到文件事件"
    });
    state = agentReducer(state, {
      type: "agent/wsEvent",
      event: { event: "goal_status", chat_id: "chat-1", status: "running", started_at: 1780732800 }
    });
    state = agentReducer(state, { type: "agent/stopRequested", chatId: "chat-1" });
    state = agentReducer(state, { type: "agent/wsEvent", event: { event: "stop_result", chat_id: "chat-1", stopped: 1 } });

    state = agentReducer(state, {
      type: "agent/wsEvent",
      event: {
        event: "file_edit",
        chat_id: "chat-1",
        edits: [{ call_id: "call-edit", tool: "edit_file", path: "README.md", phase: "start", status: "editing" }]
      }
    });

    const fileEditTrace = state.messages.find((message) => message.fileEdits);
    expect(state.isSending).toBe(false);
    expect(fileEditTrace).toMatchObject({ isStreaming: false, stoppedByUser: true });
  });

  it("stores retry_wait as live status without appending chat messages", () => {
    let state = agentReducer(initialAgentState, { type: "agent/sessionsLoaded", sessions });
    state = agentReducer(state, { type: "agent/wsEvent", event: { event: "ready", chat_id: "chat-1" } });
    state = agentReducer(state, {
      type: "agent/userMessageQueued",
      chatId: "chat-1",
      content: "触发模型重试"
    });
    const userMessageId = state.messages[0]?.id;

    state = agentReducer(state, {
      type: "agent/wsEvent",
      event: {
        event: "retry_wait",
        chat_id: "chat-1",
        turn_id: "turn-retry",
        text: "Model request failed, retrying attempt 1 in 1s..."
      }
    });

    expect(state.messages).toHaveLength(1);
    expect(state.messages[0]).toMatchObject({ role: "user", content: "触发模型重试" });
    expect(state.messages.some((message) => message.content.includes("Model request failed"))).toBe(false);
    expect(state.retryWaitStatusByChatId["chat-1"]).toMatchObject({
      chatId: "chat-1",
      turnId: "turn-retry",
      anchorMessageId: userMessageId,
      text: "Model request failed, retrying attempt 1 in 1s...",
      isRunning: true
    });
    expect(state.isSending).toBe(true);
  });

  it("clears retry_wait status when stopRequested is dispatched", () => {
    let state = agentReducer(initialAgentState, { type: "agent/sessionsLoaded", sessions });
    state = agentReducer(state, { type: "agent/wsEvent", event: { event: "ready", chat_id: "chat-1" } });
    state = agentReducer(state, {
      type: "agent/userMessageQueued",
      chatId: "chat-1",
      content: "重试中主动停止"
    });
    state = agentReducer(state, {
      type: "agent/wsEvent",
      event: { event: "goal_status", chat_id: "chat-1", status: "running", started_at: 1780732800, turn_id: "turn-retry" }
    });
    state = agentReducer(state, {
      type: "agent/wsEvent",
      event: { event: "retry_wait", chat_id: "chat-1", turn_id: "turn-retry", text: "Model request failed, retrying attempt 1 in 1s..." }
    });

    expect(state.retryWaitStatusByChatId["chat-1"]).toBeDefined();

    state = agentReducer(state, { type: "agent/stopRequested", chatId: "chat-1" });

    expect(state.retryWaitStatusByChatId["chat-1"]).toBeUndefined();
    expect(state.stopInFlightByChatId["chat-1"]).toBe(true);
    expect(state.isSending).toBe(false);
  });

  it("ignores retry_wait while stop is in flight before stop_result arrives", () => {
    let state = agentReducer(initialAgentState, { type: "agent/sessionsLoaded", sessions });
    state = agentReducer(state, { type: "agent/wsEvent", event: { event: "ready", chat_id: "chat-1" } });
    state = agentReducer(state, {
      type: "agent/userMessageQueued",
      chatId: "chat-1",
      content: "停止窗口里的晚到重试"
    });
    state = agentReducer(state, {
      type: "agent/wsEvent",
      event: { event: "goal_status", chat_id: "chat-1", status: "running", started_at: 1780732800, turn_id: "turn-stop" }
    });
    state = agentReducer(state, { type: "agent/stopRequested", chatId: "chat-1" });

    state = agentReducer(state, {
      type: "agent/wsEvent",
      event: { event: "retry_wait", chat_id: "chat-1", turn_id: "turn-stop", text: "Model request failed, retrying attempt 1 in 1s..." }
    });

    expect(state.retryWaitStatusByChatId["chat-1"]).toBeUndefined();
    expect(state.messages).toHaveLength(1);
    expect(state.messages.some((message) => message.content.includes("Model request failed"))).toBe(false);
    expect(state.stopInFlightByChatId["chat-1"]).toBe(true);
    expect(state.isSending).toBe(false);
  });

  it("updates consecutive same-turn retry_wait events in one live status", () => {
    let state = agentReducer(initialAgentState, { type: "agent/sessionsLoaded", sessions });
    state = agentReducer(state, { type: "agent/wsEvent", event: { event: "ready", chat_id: "chat-1" } });
    state = agentReducer(state, {
      type: "agent/userMessageQueued",
      chatId: "chat-1",
      content: "持续等待"
    });
    state = agentReducer(state, {
      type: "agent/wsEvent",
      event: { event: "retry_wait", chat_id: "chat-1", turn_id: "turn-retry", text: "Model request failed, retrying attempt 1 in 1s..." }
    });
    const firstStatus = state.retryWaitStatusByChatId["chat-1"];

    state = agentReducer(state, {
      type: "agent/wsEvent",
      event: { event: "retry_wait", chat_id: "chat-1", turn_id: "turn-retry", text: "Retry attempt 1: Model request still waiting to retry in 31s..." }
    });

    expect(state.messages).toHaveLength(1);
    expect(state.retryWaitStatusByChatId["chat-1"]?.id).toBe(firstStatus?.id);
    expect(state.retryWaitStatusByChatId["chat-1"]?.text).toBe("Retry attempt 1: Model request still waiting to retry in 31s...");
    expect(state.retryWaitStatusByChatId["chat-1"]?.isRunning).toBe(true);
  });

  it("stops retry_wait running when answer text starts without merging content", () => {
    let state = agentReducer(initialAgentState, { type: "agent/sessionsLoaded", sessions });
    state = agentReducer(state, { type: "agent/wsEvent", event: { event: "ready", chat_id: "chat-1" } });
    state = agentReducer(state, {
      type: "agent/userMessageQueued",
      chatId: "chat-1",
      content: "开始回答"
    });
    state = agentReducer(state, {
      type: "agent/wsEvent",
      event: { event: "retry_wait", chat_id: "chat-1", turn_id: "turn-retry", text: "Model request failed, retrying attempt 2 in 2s..." }
    });

    state = agentReducer(state, {
      type: "agent/wsEvent",
      event: { event: "delta", chat_id: "chat-1", turn_id: "turn-retry", text: "真正正文" }
    });

    expect(state.retryWaitStatusByChatId["chat-1"]).toMatchObject({
      text: "Model request failed, retrying attempt 2 in 2s...",
      isRunning: false
    });
    expect(state.messages.map((message) => message.role)).toEqual(["user", "assistant"]);
    expect(state.messages[1]).toMatchObject({ role: "assistant", content: "真正正文", isStreaming: true });
    expect(state.messages[1]?.content).not.toContain("Model request failed");
  });

  it("keeps retry_wait out of activity traces when tool progress starts", () => {
    let state = agentReducer(initialAgentState, { type: "agent/sessionsLoaded", sessions });
    state = agentReducer(state, { type: "agent/wsEvent", event: { event: "ready", chat_id: "chat-1" } });
    state = agentReducer(state, {
      type: "agent/userMessageQueued",
      chatId: "chat-1",
      content: "先重试再执行工具"
    });
    state = agentReducer(state, {
      type: "agent/wsEvent",
      event: { event: "retry_wait", chat_id: "chat-1", turn_id: "turn-retry", text: "Model request failed, retrying attempt 1 in 1s..." }
    });

    state = agentReducer(state, {
      type: "agent/wsEvent",
      event: {
        event: "message",
        chat_id: "chat-1",
        turn_id: "turn-retry",
        kind: "progress",
        text: "读取文件中"
      }
    });

    expect(state.retryWaitStatusByChatId["chat-1"]?.isRunning).toBe(false);
    expect(state.messages.map((message) => message.role)).toEqual(["user", "tool"]);
    expect(state.messages[1]).toMatchObject({
      role: "tool",
      kind: "trace",
      content: "读取文件中"
    });
    expect(state.messages.some((message) => message.content.includes("Model request failed"))).toBe(false);
  });

  it("stops retry_wait running on turn_end and stop_result", () => {
    let ended = agentReducer(initialAgentState, { type: "agent/sessionsLoaded", sessions });
    ended = agentReducer(ended, { type: "agent/wsEvent", event: { event: "ready", chat_id: "chat-1" } });
    ended = agentReducer(ended, { type: "agent/userMessageQueued", chatId: "chat-1", content: "turn end" });
    ended = agentReducer(ended, {
      type: "agent/wsEvent",
      event: { event: "retry_wait", chat_id: "chat-1", turn_id: "turn-end", text: "Model request failed, retrying attempt 1 in 1s..." }
    });
    ended = agentReducer(ended, { type: "agent/wsEvent", event: { event: "turn_end", chat_id: "chat-1", turn_id: "turn-end" } });

    expect(ended.retryWaitStatusByChatId["chat-1"]?.isRunning).toBe(false);
    expect(ended.isSending).toBe(false);

    let stopped = agentReducer(initialAgentState, { type: "agent/sessionsLoaded", sessions });
    stopped = agentReducer(stopped, { type: "agent/wsEvent", event: { event: "ready", chat_id: "chat-1" } });
    stopped = agentReducer(stopped, { type: "agent/userMessageQueued", chatId: "chat-1", content: "stop" });
    stopped = agentReducer(stopped, {
      type: "agent/wsEvent",
      event: { event: "retry_wait", chat_id: "chat-1", turn_id: "turn-stop", text: "Model request failed, retrying attempt 1 in 1s..." }
    });
    stopped = agentReducer(stopped, { type: "agent/wsEvent", event: { event: "stop_result", chat_id: "chat-1", stopped: 1, turn_id: "turn-stop" } });

    expect(stopped.retryWaitStatusByChatId["chat-1"]?.isRunning).toBe(false);
    expect(stopped.isSending).toBe(false);
  });

  it("drops late live events for a stopped turn_id while keeping its cancellation terminal file edit", () => {
    let state = agentReducer(initialAgentState, { type: "agent/sessionsLoaded", sessions });
    state = agentReducer(state, { type: "agent/wsEvent", event: { event: "ready", chat_id: "chat-1" } });
    state = agentReducer(state, {
      type: "agent/userMessageQueued",
      chatId: "chat-1",
      content: "带 turn_id 的停止"
    });
    state = agentReducer(state, {
      type: "agent/wsEvent",
      event: { event: "goal_status", chat_id: "chat-1", status: "running", started_at: 1780732800, turn_id: "turn-old" }
    });
    state = agentReducer(state, {
      type: "agent/wsEvent",
      event: {
        event: "file_edit",
        chat_id: "chat-1",
        turn_id: "turn-old",
        edits: [{ call_id: "call-edit", tool: "edit_file", path: "README.md", phase: "start", status: "editing" }]
      }
    });
    state = agentReducer(state, { type: "agent/stopRequested", chatId: "chat-1" });
    state = agentReducer(state, { type: "agent/wsEvent", event: { event: "stop_result", chat_id: "chat-1", stopped: 1, turn_id: "turn-old" } });

    const afterStop = state;
    expect(afterStop.activeTurnIdByChatId["chat-1"]).toBeNull();
    expect(afterStop.closedTurnIdsByChatId["chat-1"]).toMatchObject({ "turn-old": "stopped" });

    state = agentReducer(state, {
      type: "agent/wsEvent",
      event: { event: "delta", chat_id: "chat-1", text: "旧 turn 晚到回答", turn_id: "turn-old" }
    });
    expect(state).toBe(afterStop);

    state = agentReducer(state, {
      type: "agent/wsEvent",
      event: { event: "retry_wait", chat_id: "chat-1", text: "Model request failed, retrying attempt 1 in 1s...", turn_id: "turn-old" }
    });
    expect(state).toBe(afterStop);

    state = agentReducer(state, {
      type: "agent/wsEvent",
      event: {
        event: "file_edit",
        chat_id: "chat-1",
        turn_id: "turn-old",
        edits: [{ call_id: "call-edit", tool: "edit_file", path: "README.md", phase: "start", status: "editing", added: 20 }]
      }
    });
    expect(state).toBe(afterStop);

    state = agentReducer(state, {
      type: "agent/wsEvent",
      event: {
        event: "file_edit",
        chat_id: "chat-1",
        turn_id: "turn-old",
        cancellation_terminal: true,
        edits: [{
          call_id: "call-edit",
          tool: "edit_file",
          path: "README.md",
          phase: "error",
          status: "error",
          cancellation_terminal: true
        }]
      }
    });

    const fileEditTrace = state.messages.find((message) => message.fileEdits);
    expect(state.isSending).toBe(false);
    expect(fileEditTrace).toMatchObject({
      turnId: "turn-old",
      isStreaming: false,
      stoppedByUser: true,
      fileEdits: [{ call_id: "call-edit", status: "error", cancellation_terminal: true }]
    });
  });

  it("allows a new running turn to keep live events busy after a stopped turn has settled", () => {
    let state = agentReducer(initialAgentState, { type: "agent/sessionsLoaded", sessions });
    state = agentReducer(state, { type: "agent/wsEvent", event: { event: "ready", chat_id: "chat-1" } });
    state = agentReducer(state, {
      type: "agent/userMessageQueued",
      chatId: "chat-1",
      content: "第一轮"
    });
    state = agentReducer(state, {
      type: "agent/wsEvent",
      event: { event: "goal_status", chat_id: "chat-1", status: "running", started_at: 1780732800 }
    });
    state = agentReducer(state, { type: "agent/stopRequested", chatId: "chat-1" });
    state = agentReducer(state, { type: "agent/wsEvent", event: { event: "stop_result", chat_id: "chat-1", stopped: 1 } });
    state = agentReducer(state, {
      type: "agent/wsEvent",
      event: { event: "goal_status", chat_id: "chat-1", status: "running", started_at: 1780732900 }
    });
    state = agentReducer(state, { type: "agent/wsEvent", event: { event: "delta", chat_id: "chat-1", text: "新一轮回答" } });

    expect(state.isSending).toBe(true);
    expect(state.messages.at(-1)).toMatchObject({ content: "新一轮回答", isStreaming: true });
    expect(state.messages.at(-1)?.stoppedByUser).not.toBe(true);
  });

  it("keeps loaded history when attach confirms the same chat", () => {
    const loaded = loadHistory(initialAgentState, "websocket:chat-1", [{ role: "user", content: "已有历史" }]);
    const sameChat = agentReducer(loaded, { type: "agent/wsEvent", event: { event: "attached", chat_id: "chat-1" } });
    const otherChat = agentReducer(sameChat, { type: "agent/wsEvent", event: { event: "attached", chat_id: "chat-2" } });

    expect(sameChat.messages).toHaveLength(1);
    expect(otherChat.messages).toHaveLength(1);
    expect(otherChat.currentSessionKey).toBe("websocket:chat-1");
  });

  it("does not hydrate retry_wait into live retry status from history", () => {
    const state = loadHistory(initialAgentState, "websocket:chat-1", [
      { role: "user", content: "历史问题" },
      { role: "assistant", content: "Model request failed, retrying attempt 1 in 1s..." }
    ]);

    expect(state.messages).toHaveLength(2);
    expect(state.retryWaitStatusByChatId["chat-1"]).toBeUndefined();
  });

  it("newChatRequested enters blank draft without clearing old run status", () => {
    let state = agentReducer(initialAgentState, { type: "agent/sessionsLoaded", sessions });
    state = agentReducer(state, { type: "agent/wsEvent", event: { event: "ready", chat_id: "chat-1" } });
    state = agentReducer(state, {
      type: "agent/wsEvent",
      event: { event: "goal_status", chat_id: "chat-1", status: "running", started_at: 1780732800 }
    });
    state = agentReducer(state, { type: "agent/newChatRequested" });

    expect(state.currentChatId).toBeNull();
    expect(state.currentSessionKey).toBeNull();
    expect(state.messages).toEqual([]);
    expect(state.isSending).toBe(false);
    expect(state.blankDraftActive).toBe(true);
    expect(state.runStartedAtByChatId["chat-1"]).toBe(1780732800);
    expect(state.tasks.find((task) => task.chatId === "chat-1")?.runStartedAt).toBe(1780732800);
  });

  it("keeps composer drafts and pending attachments isolated by scope", () => {
    const attachment = readyPendingFile("report.pdf");
    let state = agentReducer(initialAgentState, { type: "agent/composerDraftUpdated", scopeKey: "chat-a", value: "A 草稿" });
    state = agentReducer(state, { type: "agent/composerDraftUpdated", scopeKey: "chat-b", value: "B 草稿" });
    state = agentReducer(state, { type: "agent/composerPendingAttachmentsUpdated", scopeKey: "chat-a", attachments: [attachment] });
    state = agentReducer(state, { type: "agent/composerMediaErrorUpdated", scopeKey: "chat-a", message: "home.media.error.sendFailed" });

    expect(state.composerDraftsByScope).toEqual({ "chat-a": "A 草稿", "chat-b": "B 草稿" });
    expect(state.composerPendingAttachmentsByScope["chat-a"]).toEqual([attachment]);
    expect(state.composerMediaErrorByScope["chat-a"]).toBe("home.media.error.sendFailed");

    state = agentReducer(state, { type: "agent/composerScopeCleared", scopeKey: "chat-a" });

    expect(state.composerDraftsByScope).toEqual({ "chat-b": "B 草稿" });
    expect(state.composerPendingAttachmentsByScope["chat-a"]).toBeUndefined();
    expect(state.composerMediaErrorByScope["chat-a"]).toBeUndefined();
  });

  it("newChatRequested does not clear composer scopes", () => {
    let state = agentReducer(initialAgentState, { type: "agent/composerDraftUpdated", scopeKey: "chat-a", value: "未发送" });
    state = agentReducer(state, { type: "agent/composerPendingAttachmentsUpdated", scopeKey: "draft-1", attachments: [readyPendingFile("brief.txt")] });

    state = agentReducer(state, { type: "agent/newChatRequested" });

    expect(state.blankDraftActive).toBe(true);
    expect(state.composerDraftsByScope["chat-a"]).toBe("未发送");
    expect(state.composerPendingAttachmentsByScope["draft-1"]).toHaveLength(1);
  });

  it("blankDraftReopened restores the current New Agent draft scope without creating a new one", () => {
    let state = agentReducer(initialAgentState, { type: "agent/newChatRequested" });
    const draftScope = `draft-${state.newChatRequestId}`;
    state = agentReducer(state, { type: "agent/composerDraftUpdated", scopeKey: draftScope, value: "New Agent 草稿" });
    state = agentReducer(state, { type: "agent/composerPendingAttachmentsUpdated", scopeKey: draftScope, attachments: [readyPendingFile("brief.txt")] });
    state = agentReducer(state, {
      type: "agent/historyLoading",
      sessionKey: "websocket:chat-1",
      chatId: "chat-1",
      requestId: "chat-1-request"
    });

    state = agentReducer(state, { type: "agent/blankDraftReopened" });

    expect(state.currentChatId).toBeNull();
    expect(state.currentSessionKey).toBeNull();
    expect(state.messages).toEqual([]);
    expect(state.blankDraftActive).toBe(true);
    expect(state.newChatRequestId).toBe(1);
    expect(state.composerDraftsByScope[draftScope]).toBe("New Agent 草稿");
    expect(state.composerPendingAttachmentsByScope[draftScope]).toHaveLength(1);
  });

  it("background hydrate updates cached messages without switching the current chat", () => {
    let state = loadHistory(initialAgentState, "websocket:chat-1", [{ role: "user", content: "已有历史" }]);
    state = agentReducer(state, {
      type: "agent/historyLoading",
      sessionKey: "websocket:chat-2",
      chatId: "chat-2",
      requestId: "chat-2-request"
    });
    state = agentReducer(state, {
      type: "agent/historyHydrateLoading",
      sessionKey: "websocket:chat-1",
      chatId: "chat-1",
      requestId: "hydrate-1"
    });
    state = agentReducer(state, {
      type: "agent/historyHydrateLoaded",
      requestId: "hydrate-1",
      thread: { schemaVersion: 1, sessionKey: "websocket:chat-1", last_turn_closed: false, messages: [{ role: "assistant", content: "后台结果" }] }
    });

    expect(state.currentChatId).toBe("chat-2");
    expect(state.currentSessionKey).toBe("websocket:chat-2");
    expect(state.messages).toEqual([]);
    expect(state.messagesByChatId["chat-1"]?.map((message) => message.content)).toEqual(["后台结果"]);
    expect(state.pendingCanonicalHydrateByChatId["chat-1"]).toBeUndefined();
    expect(state.currentHistoryHydrateRequestIdByChatId["chat-1"]).toBeUndefined();
  });

  it("keeps live streamed assistant when an unclosed background hydrate returns an equal partial snapshot", () => {
    const prompt = "再给我讲个300字的故事";
    const partial = "老钟表匠林叔在巷尾开店，店里挂满停走的钟。一天，一个小男孩抱来一只旧怀表，说那是爷爷留下的，只要它重新响起，爷爷就会回家。林叔没有拆穿他，只点灯修了一整夜。怀表其实早已锈死，林叔便把自己珍藏多年的机芯换了进去。第二天，滴答声响起，男孩笑得像春天。几年后，林叔病倒，店";
    const fullText = "老钟表匠林叔在巷尾开店，店里挂满停走的钟。一天，一个小男孩抱来一只旧怀表，说那是爷爷留下的，只要它重新响起，爷爷就会回家。林叔没有拆穿他，只点灯修了一整夜。怀表其实早已锈死，林叔便把自己珍藏多年的机芯换了进去。第二天，滴答声响起，男孩笑得像春天。几年后，林叔病倒，店门紧闭。已经长大的男孩推门进来，把那只怀表放在床边。清脆的滴答声里，林叔听见男孩说：“您修好的不是表，是我等人的勇气。”窗外雪停了，第一缕阳光落在表盘上，像时间终于温柔地回头。";
    let state = agentReducer(initialAgentState, { type: "agent/wsEvent", event: { event: "ready", chat_id: "chat-1" } });
    state = agentReducer(state, {
      type: "agent/userMessageQueued",
      chatId: "chat-1",
      content: prompt
    });
    state = agentReducer(state, { type: "agent/wsEvent", event: { event: "delta", chat_id: "chat-1", text: partial } });
    state = agentReducer(state, {
      type: "agent/historyHydrateLoading",
      sessionKey: "websocket:chat-1",
      chatId: "chat-1",
      requestId: "hydrate-live"
    });
    state = agentReducer(state, {
      type: "agent/historyHydrateLoaded",
      requestId: "hydrate-live",
      thread: {
        schemaVersion: 3,
        sessionKey: "websocket:chat-1",
        last_turn_closed: false,
        messages: [
          { role: "user", content: prompt },
          { role: "assistant", content: partial }
        ]
      }
    });

    state = agentReducer(state, { type: "agent/wsEvent", event: { event: "delta", chat_id: "chat-1", text: "门" } });
    state = agentReducer(state, { type: "agent/wsEvent", event: { event: "stream_end", chat_id: "chat-1", text: fullText } });
    state = agentReducer(state, { type: "agent/wsEvent", event: { event: "turn_end", chat_id: "chat-1" } });

    const assistantMessages = state.messages.filter((message) => message.role === "assistant" && message.kind !== "trace");
    const cachedAssistantMessages = state.messagesByChatId["chat-1"]?.filter((message) => message.role === "assistant" && message.kind !== "trace");
    expect(assistantMessages).toHaveLength(1);
    expect(cachedAssistantMessages).toHaveLength(1);
    expect(assistantMessages[0]).toMatchObject({ content: fullText, isStreaming: false });
    expect(cachedAssistantMessages?.[0]).toMatchObject({ content: fullText, isStreaming: false });
    expect(state.pendingCanonicalHydrateByChatId["chat-1"]).toBeUndefined();
    expect(state.currentHistoryHydrateRequestIdByChatId["chat-1"]).toBeUndefined();
  });

  it("keeps the queued user query when active hydrate omits user messages", () => {
    const prompt = "测试 query";
    let state = agentReducer(initialAgentState, { type: "agent/newChatCreated", chatId: "chat-new" });
    state = agentReducer(state, {
      type: "agent/userMessageQueued",
      chatId: "chat-new",
      content: prompt
    });
    state = agentReducer(state, {
      type: "agent/historyHydrateLoading",
      sessionKey: "websocket:chat-new",
      chatId: "chat-new",
      requestId: "hydrate-missing-user"
    });
    state = agentReducer(state, {
      type: "agent/historyHydrateLoaded",
      requestId: "hydrate-missing-user",
      thread: {
        schemaVersion: 3,
        sessionKey: "websocket:chat-new",
        last_turn_closed: false,
        messages: [{ role: "assistant", content: "只返回了助手内容" }]
      }
    });

    expect(state.messages.map((message) => [message.role, message.content])).toEqual([["user", prompt]]);
    expect(state.messagesByChatId["chat-new"]?.map((message) => [message.role, message.content])).toEqual([["user", prompt]]);
  });

  it("preserves a streaming assistant restored by foreground history load", () => {
    const prompt = "王力宏今年开了多少场演唱会";
    const partial = "我先查一下今年（按当前时间为 2026 年）的公开演唱会排期/巡演记录，再给你";
    const fullText = "我先查一下今年（按当前时间为 2026 年）的公开演唱会排期/巡演记录，再给你统计口径和数量。";
    let state = agentReducer(initialAgentState, {
      type: "agent/historyLoading",
      sessionKey: "websocket:chat-1",
      chatId: "chat-1",
      requestId: "foreground-streaming"
    });
    state = agentReducer(state, {
      type: "agent/historyLoaded",
      requestId: "foreground-streaming",
      thread: {
        schemaVersion: 3,
        sessionKey: "websocket:chat-1",
        last_turn_closed: false,
        messages: [
          { role: "user", content: prompt },
          { role: "assistant", content: partial, isStreaming: true }
        ]
      }
    });

    expect(state.messages[1]).toMatchObject({ role: "assistant", content: partial, isStreaming: true });

    state = agentReducer(state, { type: "agent/wsEvent", event: { event: "delta", chat_id: "chat-1", text: "统计" } });
    state = agentReducer(state, { type: "agent/wsEvent", event: { event: "stream_end", chat_id: "chat-1", text: fullText } });
    state = agentReducer(state, { type: "agent/wsEvent", event: { event: "turn_end", chat_id: "chat-1" } });

    const assistantMessages = state.messages.filter((message) => message.role === "assistant" && message.kind !== "trace");
    expect(assistantMessages).toHaveLength(1);
    expect(assistantMessages[0]).toMatchObject({ content: fullText, isStreaming: false });
  });

  it("keeps current live stream when foreground history returns an unclosed older snapshot", () => {
    const prompt = "王力宏今年开了多少场演唱会";
    const snapshotPartial = "我先查一下今年（按当前时间为 2026 年）的公开演唱会排期/巡演记录，再给你";
    const livePartial = `${snapshotPartial}统计`;
    let state = agentReducer(initialAgentState, { type: "agent/wsEvent", event: { event: "ready", chat_id: "chat-1" } });
    state = agentReducer(state, {
      type: "agent/userMessageQueued",
      chatId: "chat-1",
      content: prompt
    });
    state = agentReducer(state, { type: "agent/wsEvent", event: { event: "delta", chat_id: "chat-1", text: livePartial } });
    state = agentReducer(state, {
      type: "agent/historyLoading",
      sessionKey: "websocket:chat-1",
      chatId: "chat-1",
      requestId: "foreground-live"
    });
    state = agentReducer(state, {
      type: "agent/historyLoaded",
      requestId: "foreground-live",
      thread: {
        schemaVersion: 3,
        sessionKey: "websocket:chat-1",
        last_turn_closed: false,
        messages: [
          { role: "user", content: prompt },
          { role: "assistant", content: snapshotPartial, isStreaming: true }
        ]
      }
    });

    const assistantMessages = state.messages.filter((message) => message.role === "assistant" && message.kind !== "trace");
    expect(assistantMessages).toHaveLength(1);
    expect(assistantMessages[0]).toMatchObject({ content: livePartial, isStreaming: true });
    expect(state.pendingCanonicalHydrateByChatId["chat-1"]).toBeUndefined();
    expect(state.currentHistoryRequestIdByChatId["chat-1"]).toBeUndefined();
    expect(state.currentHistoryHydrateRequestIdByChatId["chat-1"]).toBeUndefined();
    expect(state.isLoadingHistory).toBe(false);
  });

  it("allows a closed foreground history snapshot to settle a stale live stream", () => {
    const prompt = "总结这个任务";
    let state = agentReducer(initialAgentState, { type: "agent/wsEvent", event: { event: "ready", chat_id: "chat-1" } });
    state = agentReducer(state, {
      type: "agent/wsEvent",
      event: { event: "goal_status", chat_id: "chat-1", status: "running", started_at: 1780732800 }
    });
    state = agentReducer(state, {
      type: "agent/userMessageQueued",
      chatId: "chat-1",
      content: prompt
    });
    state = agentReducer(state, { type: "agent/wsEvent", event: { event: "delta", chat_id: "chat-1", text: "处理中" } });
    state = agentReducer(state, {
      type: "agent/historyLoading",
      sessionKey: "websocket:chat-1",
      chatId: "chat-1",
      requestId: "foreground-closed"
    });
    state = agentReducer(state, {
      type: "agent/historyLoaded",
      requestId: "foreground-closed",
      thread: {
        schemaVersion: 3,
        sessionKey: "websocket:chat-1",
        last_turn_closed: true,
        messages: [
          { role: "user", content: prompt },
          { role: "assistant", content: "最终完整回答" }
        ]
      }
    });

    expect(state.messages.map((message) => message.content)).toEqual([prompt, "最终完整回答"]);
    expect(state.messages[1]?.isStreaming).not.toBe(true);
    expect(state.isSending).toBe(false);
    expect(state.runStartedAtByChatId["chat-1"]).toBeNull();
  });

  it("history hydrate clears stale running only when transcript reports the last turn closed", () => {
    let state = agentReducer(initialAgentState, { type: "agent/sessionsLoaded", sessions });
    state = agentReducer(state, { type: "agent/wsEvent", event: { event: "ready", chat_id: "chat-1" } });
    state = agentReducer(state, {
      type: "agent/wsEvent",
      event: { event: "goal_status", chat_id: "chat-1", status: "running", started_at: 1780732800 }
    });
    state = agentReducer(state, {
      type: "agent/historyHydrateLoading",
      sessionKey: "websocket:chat-1",
      chatId: "chat-1",
      requestId: "hydrate-closed"
    });
    state = agentReducer(state, {
      type: "agent/historyHydrateLoaded",
      requestId: "hydrate-closed",
      thread: {
        schemaVersion: 3,
        sessionKey: "websocket:chat-1",
        last_turn_closed: true,
        messages: [{ role: "assistant", content: "完成" }]
      }
    });

    expect(state.tasks.find((task) => task.chatId === "chat-1")?.runStartedAt).toBeNull();
    expect(state.isSending).toBe(false);
    expect(state.messages.map((message) => message.content)).toEqual(["完成"]);
  });

  it("background hydrate with last_turn_closed recovers completed unseen and clears stale streaming without latency", () => {
    let state = agentReducer(initialAgentState, { type: "agent/sessionsLoaded", sessions });
    state = agentReducer(state, { type: "agent/wsEvent", event: { event: "ready", chat_id: "chat-1" } });
    state = agentReducer(state, {
      type: "agent/wsEvent",
      event: { event: "goal_status", chat_id: "chat-1", status: "running", started_at: 1780732800 }
    });
    state = agentReducer(state, { type: "agent/wsEvent", event: { event: "delta", chat_id: "chat-1", text: "处理中" } });
    state = agentReducer(state, {
      type: "agent/historyLoading",
      sessionKey: "websocket:chat-2",
      chatId: "chat-2",
      requestId: "chat-2-request"
    });
    state = agentReducer(state, {
      type: "agent/historyHydrateLoading",
      sessionKey: "websocket:chat-1",
      chatId: "chat-1",
      requestId: "hydrate-background-closed"
    });
    state = agentReducer(state, {
      type: "agent/historyHydrateLoaded",
      requestId: "hydrate-background-closed",
      thread: {
        schemaVersion: 3,
        sessionKey: "websocket:chat-1",
        last_turn_closed: true,
        messages: []
      }
    });

    expect(state.currentChatId).toBe("chat-2");
    expect(state.tasks.find((task) => task.chatId === "chat-1")).toMatchObject({
      runStartedAt: null,
      completedUnseen: true
    });
    expect(state.messagesByChatId["chat-1"]?.[0]).toMatchObject({
      role: "assistant",
      content: "处理中",
      isStreaming: false,
      reasoningStreaming: false
    });
    expect(state.messagesByChatId["chat-1"]?.[0]?.latencyMs).toBeUndefined();
  });

  it("background hydrate does not leave a New Agent blank draft", () => {
    let state = loadHistory(initialAgentState, "websocket:chat-1", [{ role: "user", content: "已有历史" }]);
    state = agentReducer(state, { type: "agent/newChatRequested" });
    state = agentReducer(state, {
      type: "agent/historyHydrateLoading",
      sessionKey: "websocket:chat-1",
      chatId: "chat-1",
      requestId: "hydrate-blank"
    });
    state = agentReducer(state, {
      type: "agent/historyHydrateLoaded",
      requestId: "hydrate-blank",
      thread: { schemaVersion: 1, sessionKey: "websocket:chat-1", messages: [{ role: "assistant", content: "旧任务完成" }] }
    });

    expect(state.currentChatId).toBeNull();
    expect(state.currentSessionKey).toBeNull();
    expect(state.blankDraftActive).toBe(true);
    expect(state.messages).toEqual([]);
    expect(state.messagesByChatId["chat-1"]?.map((message) => message.content)).toEqual(["旧任务完成"]);
  });

  it("stale background hydrate responses do not overwrite a newer hydrate request", () => {
    let state = loadHistory(initialAgentState, "websocket:chat-1", [{ role: "user", content: "已有历史" }]);
    state = agentReducer(state, {
      type: "agent/historyHydrateLoading",
      sessionKey: "websocket:chat-1",
      chatId: "chat-1",
      requestId: "old-hydrate"
    });
    state = agentReducer(state, {
      type: "agent/historyHydrateLoading",
      sessionKey: "websocket:chat-1",
      chatId: "chat-1",
      requestId: "new-hydrate"
    });
    state = agentReducer(state, {
      type: "agent/historyHydrateLoaded",
      requestId: "old-hydrate",
      thread: { schemaVersion: 1, sessionKey: "websocket:chat-1", messages: [{ role: "assistant", content: "旧响应" }] }
    });

    expect(state.messages.map((message) => message.content)).toEqual(["已有历史"]);
    expect(state.currentHistoryHydrateRequestIdByChatId["chat-1"]).toBe("new-hydrate");

    state = agentReducer(state, {
      type: "agent/historyHydrateLoaded",
      requestId: "new-hydrate",
      thread: { schemaVersion: 1, sessionKey: "websocket:chat-1", messages: [{ role: "assistant", content: "新响应" }] }
    });
    expect(state.messages.map((message) => message.content)).toEqual(["新响应"]);
  });

  it("foreground history loading supersedes an in-flight background hydrate for the same chat", () => {
    let state = agentReducer(initialAgentState, {
      type: "agent/historyHydrateLoading",
      sessionKey: "websocket:chat-1",
      chatId: "chat-1",
      requestId: "background"
    });
    state = agentReducer(state, {
      type: "agent/historyLoading",
      sessionKey: "websocket:chat-1",
      chatId: "chat-1",
      requestId: "foreground"
    });

    expect(state.currentChatId).toBe("chat-1");
    expect(state.currentHistoryHydrateRequestIdByChatId["chat-1"]).toBeUndefined();

    state = agentReducer(state, {
      type: "agent/historyHydrateLoaded",
      requestId: "background",
      thread: { schemaVersion: 1, sessionKey: "websocket:chat-1", messages: [{ role: "assistant", content: "后台旧响应" }] }
    });
    expect(state.messages).toEqual([]);

    state = agentReducer(state, {
      type: "agent/historyLoaded",
      requestId: "foreground",
      thread: { schemaVersion: 1, sessionKey: "websocket:chat-1", messages: [{ role: "assistant", content: "前台响应" }] }
    });
    expect(state.messages.map((message) => message.content)).toEqual(["前台响应"]);
  });

  it("goal status idle after New Agent clears the old task without leaving blank draft", () => {
    let state = agentReducer(initialAgentState, { type: "agent/sessionsLoaded", sessions });
    state = agentReducer(state, { type: "agent/wsEvent", event: { event: "ready", chat_id: "chat-1" } });
    state = agentReducer(state, {
      type: "agent/wsEvent",
      event: { event: "goal_status", chat_id: "chat-1", status: "running", started_at: 1780732800 }
    });
    state = agentReducer(state, { type: "agent/newChatRequested" });
    state = agentReducer(state, { type: "agent/wsEvent", event: { event: "goal_status", chat_id: "chat-1", status: "idle" } });

    expect(state.currentChatId).toBeNull();
    expect(state.currentSessionKey).toBeNull();
    expect(state.blankDraftActive).toBe(true);
    expect(state.tasks.find((task) => task.chatId === "chat-1")).toMatchObject({
      runStartedAt: null,
      completedUnseen: false
    });
  });

  it("background turn_end completion marks the task unseen while goal idle only clears running", () => {
    let state = agentReducer(initialAgentState, { type: "agent/sessionsLoaded", sessions });
    state = agentReducer(state, { type: "agent/wsEvent", event: { event: "ready", chat_id: "chat-1" } });
    state = agentReducer(state, {
      type: "agent/wsEvent",
      event: { event: "goal_status", chat_id: "chat-1", status: "running", started_at: 1780732800 }
    });
    state = agentReducer(state, {
      type: "agent/historyLoading",
      sessionKey: "websocket:chat-2",
      chatId: "chat-2",
      requestId: "chat-2-request"
    });
    state = agentReducer(state, { type: "agent/wsEvent", event: { event: "goal_status", chat_id: "chat-1", status: "idle" } });
    expect(state.tasks.find((task) => task.chatId === "chat-1")).toMatchObject({
      runStartedAt: null,
      completedUnseen: false
    });

    state = agentReducer(state, {
      type: "agent/wsEvent",
      event: { event: "goal_status", chat_id: "chat-1", status: "running", started_at: 1780732900 }
    });
    state = agentReducer(state, { type: "agent/wsEvent", event: { event: "turn_end", chat_id: "chat-1" } });
    expect(state.tasks.find((task) => task.chatId === "chat-1")).toMatchObject({
      runStartedAt: null,
      completedUnseen: true
    });
  });

  it("ignores lifecycle websocket events without chat ids", () => {
    let state = agentReducer(initialAgentState, { type: "agent/sessionsLoaded", sessions });
    state = agentReducer(state, { type: "agent/wsEvent", event: { event: "ready", chat_id: "chat-1" } });
    state = agentReducer(state, {
      type: "agent/wsEvent",
      event: { event: "goal_status", chat_id: "chat-1", status: "running", started_at: 1780732800 }
    });
    state = agentReducer(state, {
      type: "agent/historyLoading",
      sessionKey: "websocket:chat-2",
      chatId: "chat-2",
      requestId: "chat-2-request"
    });
    const before = state;

    state = agentReducer(state, { type: "agent/wsEvent", event: { event: "goal_status", status: "idle" } });
    state = agentReducer(state, { type: "agent/wsEvent", event: { event: "turn_end" } });
    state = agentReducer(state, { type: "agent/wsEvent", event: { event: "session_updated" } });

    expect(state).toEqual(before);
    expect(state.currentChatId).toBe("chat-2");
    expect(state.tasks.find((task) => task.chatId === "chat-1")?.runStartedAt).toBe(1780732800);
  });

  it("metadata-scoped session updates request only task-list refresh without canonical hydrate", () => {
    let state = agentReducer(initialAgentState, { type: "agent/sessionsLoaded", sessions });

    state = agentReducer(state, {
      type: "agent/wsEvent",
      event: { event: "session_updated", chat_id: "chat-1", scope: "metadata" }
    });

    expect(state.refreshRequested).toBe(true);
    expect(state.pendingCanonicalHydrateByChatId).toEqual({});
  });

  it("newChatCreated switches to the created chat", () => {
    let state = agentReducer(initialAgentState, { type: "agent/newChatRequested" });
    state = agentReducer(state, { type: "agent/newChatCreated", chatId: "chat-new" });

    expect(state.currentChatId).toBe("chat-new");
    expect(state.currentSessionKey).toBe("websocket:chat-new");
    expect(state.messages).toEqual([]);
    expect(state.isSending).toBe(false);
    expect(state.blankDraftActive).toBe(false);
  });

  it("switching from running chat to idle chat clears active isSending without stopping the old chat", () => {
    let state = agentReducer(initialAgentState, { type: "agent/sessionsLoaded", sessions });
    state = agentReducer(state, { type: "agent/wsEvent", event: { event: "ready", chat_id: "chat-1" } });
    state = agentReducer(state, {
      type: "agent/wsEvent",
      event: { event: "goal_status", chat_id: "chat-1", status: "running", started_at: 1780732800 }
    });
    expect(state.isSending).toBe(true);

    state = agentReducer(state, {
      type: "agent/historyLoading",
      sessionKey: "websocket:chat-2",
      chatId: "chat-2",
      requestId: "chat-2-request"
    });

    expect(state.currentChatId).toBe("chat-2");
    expect(state.isSending).toBe(false);
    expect(state.runStartedAtByChatId["chat-1"]).toBe(1780732800);
    expect(state.tasks.find((task) => task.chatId === "chat-1")?.runStartedAt).toBe(1780732800);
  });

  it("switching back to running chat restores active isSending", () => {
    let state = agentReducer(initialAgentState, { type: "agent/sessionsLoaded", sessions });
    state = agentReducer(state, { type: "agent/wsEvent", event: { event: "ready", chat_id: "chat-1" } });
    state = agentReducer(state, {
      type: "agent/wsEvent",
      event: { event: "goal_status", chat_id: "chat-1", status: "running", started_at: 1780732800 }
    });
    state = agentReducer(state, {
      type: "agent/historyLoading",
      sessionKey: "websocket:chat-2",
      chatId: "chat-2",
      requestId: "chat-2-request"
    });
    state = agentReducer(state, {
      type: "agent/historyLoading",
      sessionKey: "websocket:chat-1",
      chatId: "chat-1",
      requestId: "chat-1-request"
    });

    expect(state.currentChatId).toBe("chat-1");
    expect(state.isSending).toBe(true);
  });

  it("routes background chat scoped events without changing the active blank draft", () => {
    let state = agentReducer(initialAgentState, { type: "agent/wsEvent", event: { event: "ready", chat_id: "chat-1" } });
    state = agentReducer(state, {
      type: "agent/wsEvent",
      event: { event: "goal_status", chat_id: "chat-1", status: "running", started_at: 1780732800 }
    });
    state = agentReducer(state, { type: "agent/newChatRequested" });
    state = agentReducer(state, { type: "agent/wsEvent", event: { event: "message", chat_id: "chat-1", text: "旧会话消息" } });
    state = agentReducer(state, { type: "agent/wsEvent", event: { event: "delta", chat_id: "chat-1", text: "旧流式内容" } });
    state = agentReducer(state, { type: "agent/wsEvent", event: { event: "turn_end", chat_id: "chat-1" } });

    expect(state.currentChatId).toBeNull();
    expect(state.messages).toEqual([]);
    expect(state.blankDraftActive).toBe(true);
    expect(state.messagesByChatId["chat-1"]?.map((message) => message.content)).toEqual(["旧会话消息", "旧流式内容"]);
    expect(state.messagesByChatId["chat-1"]?.every((message) => !message.isStreaming)).toBe(true);
    expect(state.completedUnseenByChatId["chat-1"]).toBeTypeOf("number");
  });

  it("keeps concurrent session output isolated by chat id", () => {
    let state = agentReducer(initialAgentState, { type: "agent/wsEvent", event: { event: "ready", chat_id: "chat-1" } });
    state = agentReducer(state, {
      type: "agent/userMessageQueued",
      chatId: "chat-1",
      content: "第一个会话问题"
    });
    state = agentReducer(state, {
      type: "agent/historyLoading",
      sessionKey: "websocket:chat-2",
      chatId: "chat-2",
      requestId: "chat-2-request"
    });
    state = agentReducer(state, {
      type: "agent/userMessageQueued",
      chatId: "chat-2",
      content: "第二个会话问题"
    });

    state = agentReducer(state, { type: "agent/wsEvent", event: { event: "delta", chat_id: "chat-1", text: "会话一回答" } });
    state = agentReducer(state, { type: "agent/wsEvent", event: { event: "delta", chat_id: "chat-2", text: "会话二回答" } });

    expect(state.currentChatId).toBe("chat-2");
    expect(state.messages.map((message) => message.content)).toEqual(["第二个会话问题", "会话二回答"]);
    expect(state.messagesByChatId["chat-1"]?.map((message) => message.content)).toEqual(["第一个会话问题", "会话一回答"]);
    expect(state.messagesByChatId["chat-2"]?.map((message) => message.content)).toEqual(["第二个会话问题", "会话二回答"]);
  });

  it("ready does not leave explicit blank draft mode", () => {
    let state = agentReducer(initialAgentState, { type: "agent/newChatRequested" });
    state = agentReducer(state, { type: "agent/wsEvent", event: { event: "ready", chat_id: "default-chat" } });

    expect(state.connectionStatus).toBe("connected");
    expect(state.currentChatId).toBeNull();
    expect(state.currentSessionKey).toBeNull();
    expect(state.blankDraftActive).toBe(true);
  });
});

function loadHistory(state: AgentState, sessionKey: string, messages: Array<Record<string, unknown>>, requestId = `${sessionKey}-request`): AgentState {
  const chatId = sessionKey.replace(/^websocket:/, "");
  const loading = agentReducer(state, { type: "agent/historyLoading", sessionKey, chatId, requestId });
  return agentReducer(loading, {
    type: "agent/historyLoaded",
    requestId,
    thread: { schemaVersion: 1, sessionKey, messages }
  });
}

function readyPendingFile(fileName: string): PendingAttachment {
  return {
    id: `pending-${fileName}`,
    sourceKey: `source-${fileName}`,
    fileName,
    kind: "file",
    status: "ready",
    originalBytes: 12,
    uploadBlob: new Blob(["file"]),
    uploadMime: "text/plain",
    uploadBytes: 4,
    extension: ".txt"
  };
}

function sidebar(overrides: Partial<MemmyAgentSidebarState>): MemmyAgentSidebarState {
  return {
    ...defaultAgentSidebarState,
    ...overrides,
    view: {
      ...defaultAgentSidebarState.view,
      ...(overrides.view ?? {})
    }
  };
}
