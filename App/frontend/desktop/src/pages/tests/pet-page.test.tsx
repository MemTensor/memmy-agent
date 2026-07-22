/** Pet page tests. */
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { renderToString } from "react-dom/server";
import { describe, expect, it } from "vitest";
import { I18nProvider } from "../../i18n/i18n-provider.js";
import type { Task, TaskBusValue } from "../../lib/task-bus.js";
import { mockBootstrap } from "./fixtures/bootstrap.js";
import {
  computeInsideHotzone,
  decidePetSessionId,
  deriveDisplayState,
  derivePetInputActivity,
  formatRecordSeconds,
  hasPetThreadLatestAnswer,
  isPetDoubleClick,
  mapPetThreadMessagesToTaskBus,
  PET_CANVAS,
  PET_TASK_RECONCILE_INTERVAL_MS,
  PET_TIMING,
  PET_TRANSPARENT_ROOT_CLASS,
  resolvePetContextMenuPosition,
  resolvePetTaskReconcileTargets,
  resolvePetMeasuredLayout,
  resolvePetAgentErrorMessage,
  resolvePetAgentEventAction,
  resolvePetFullRoute,
  resolvePetMainRouteSessionId,
  resolvePetMainRouteTarget,
  selectMiniTaskListItems,
  shouldSubmitPetInputOnKeyDown,
  PetPageView
} from "../pet-page.js";

const stylesPath = fileURLToPath(new URL("../../styles.css", import.meta.url));
const petPageSourcePath = fileURLToPath(new URL("../pet-page.tsx", import.meta.url));

describe("PetPage helpers", () => {
  it("按规范派生 displayState", () => {
    expect(deriveDisplayState({ focusedTask: null, hasUndismissedAnswer: false, isActive: false, isInHotzone: false })).toBe("idle");
    expect(deriveDisplayState({ focusedTask: null, hasUndismissedAnswer: false, isActive: true, isInHotzone: false })).toBe("active");
    expect(deriveDisplayState({ focusedTask: task({ status: "processing" }), hasUndismissedAnswer: false, isActive: true, isInHotzone: true })).toBe("processing");
    expect(deriveDisplayState({ focusedTask: task({ status: "answering" }), hasUndismissedAnswer: true, isActive: false, isInHotzone: false })).toBe("answering");
    expect(deriveDisplayState({ focusedTask: task({ status: "done" }), hasUndismissedAnswer: true, isActive: false, isInHotzone: false })).toBe("answering");
  });

  it("单击收起 active 后忽略当前热区，直到下一次主动进入", () => {
    expect(deriveDisplayState({ focusedTask: null, hasUndismissedAnswer: false, isActive: false, isInHotzone: true, isActiveSuppressed: true })).toBe("idle");
    expect(deriveDisplayState({ focusedTask: task({ status: "processing" }), hasUndismissedAnswer: false, isActive: false, isInHotzone: true, isActiveSuppressed: true })).toBe("processing");
  });

  it("输入活动包含 input focus、未发送文本、录音和已交互标记", () => {
    expect(derivePetInputActivity({ isTextInputFocused: true, textInput: "", isRecording: false, hasInteracted: false })).toBe(true);
    expect(derivePetInputActivity({ isTextInputFocused: false, textInput: "  hi  ", isRecording: false, hasInteracted: false })).toBe(true);
    expect(derivePetInputActivity({ isTextInputFocused: false, textInput: "", isRecording: true, hasInteracted: false })).toBe(true);
    expect(derivePetInputActivity({ isTextInputFocused: false, textInput: "", isRecording: false, hasInteracted: true })).toBe(true);
    expect(derivePetInputActivity({ isTextInputFocused: false, textInput: "", isRecording: false, hasInteracted: false })).toBe(false);
  });

  it("中文输入法组合输入中的 Enter 不会提交桌宠消息", () => {
    expect(shouldSubmitPetInputOnKeyDown(petInputKeyEvent({ nativeEvent: { isComposing: true } }), true)).toBe(false);
    expect(shouldSubmitPetInputOnKeyDown(petInputKeyEvent({ nativeEvent: { keyCode: 229 } }), true)).toBe(false);
    expect(shouldSubmitPetInputOnKeyDown(petInputKeyEvent({ nativeEvent: { isComposing: false, keyCode: 13 } }), true)).toBe(true);
    expect(shouldSubmitPetInputOnKeyDown(petInputKeyEvent(), false)).toBe(false);
    expect(shouldSubmitPetInputOnKeyDown(petInputKeyEvent({ shiftKey: true }), true)).toBe(false);
  });

  it("热区使用多个 rect 并集和 16px buffer", () => {
    const rects = [
      { left: 100, top: 100, right: 220, bottom: 220, width: 120, height: 120 },
      { left: 80, top: 40, right: 240, bottom: 90, width: 160, height: 50 }
    ];

    expect(computeInsideHotzone(rects, 84, 95, 16)).toBe(true);
    expect(computeInsideHotzone(rects, 60, 95, 16)).toBe(false);
  });

  it("session 生命周期按 pending、焦点和 5min 最近完成任务决策", () => {
    const finished = task({ id: "done-1", sessionId: "session-done", status: "done", finishedAt: 1_000 });
    const processing = task({ id: "run-1", sessionId: "session-run", status: "processing" });
    const cancelled = task({ id: "cancel-1", sessionId: "session-cancel", status: "cancelled", finishedAt: 1_000 });

    expect(decidePetSessionId({ pendingNewSession: true, focusedTask: processing, lastFinishedTask: finished, now: 2_000 })).toBeUndefined();
    expect(decidePetSessionId({ pendingNewSession: false, focusedTask: processing, lastFinishedTask: null, now: 1_000 + 6 * 60_000 })).toBe("session-run");
    expect(decidePetSessionId({ pendingNewSession: false, focusedTask: finished, lastFinishedTask: null, now: 1_000 + 4 * 60_000 })).toBe("session-done");
    expect(decidePetSessionId({ pendingNewSession: false, focusedTask: finished, lastFinishedTask: null, now: 1_000 + 5 * 60_000 })).toBe("session-done");
    expect(decidePetSessionId({ pendingNewSession: false, focusedTask: null, lastFinishedTask: finished, now: 1_000 + 4 * 60_000 })).toBe("session-done");
    expect(decidePetSessionId({ pendingNewSession: false, focusedTask: null, lastFinishedTask: finished, now: 1_000 + 6 * 60_000 })).toBeUndefined();
    expect(decidePetSessionId({ pendingNewSession: false, focusedTask: cancelled, lastFinishedTask: finished, now: 1_000 + 6 * 60_000 })).toBeUndefined();
    expect(decidePetSessionId({ pendingNewSession: false, focusedTask: null, lastFinishedTask: null, now: 2_000 })).toBeUndefined();
  });

  it("展开完整模式时焦点丢失也会回到最近桌宠会话", () => {
    const finished = task({ id: "done-1", sessionId: "session-done", status: "done", finishedAt: 1_000, dismissed: true });

    expect(resolvePetMainRouteTarget({ pendingNewSession: false, focusedTask: null, lastFinishedTask: finished, now: 1_000 + 4 * 60_000 })).toEqual({ route: "/main", agentChatId: "session-done" });
    expect(resolvePetMainRouteTarget({ pendingNewSession: false, focusedTask: null, lastFinishedTask: finished, now: 1_000 + 6 * 60_000 })).toEqual({ route: "/main", agentChatId: "session-done" });
    expect(resolvePetMainRouteTarget({ pendingNewSession: true, focusedTask: null, lastFinishedTask: finished, now: 1_000 + 4 * 60_000 })).toEqual({ route: "/main" });
  });

  it("完整模式跳转可使用记住的当前会话，不受 5min 续聊窗口影响", () => {
    const focused = task({ id: "done-focused", sessionId: "session-focused", status: "done", finishedAt: 2_000 });
    const finished = task({ id: "done-1", sessionId: "session-done", status: "done", finishedAt: 1_000, dismissed: true });

    expect(resolvePetMainRouteSessionId({ pendingNewSession: false, focusedTask: null, lastFinishedTask: finished, rememberedSessionId: "session-visible", now: 1_000 + 6 * 60_000 })).toBe("session-visible");
    expect(resolvePetMainRouteTarget({ pendingNewSession: false, focusedTask: null, lastFinishedTask: finished, rememberedSessionId: "session-visible", now: 1_000 + 6 * 60_000 })).toEqual({ route: "/main", agentChatId: "session-visible" });
    expect(resolvePetMainRouteTarget({ pendingNewSession: false, focusedTask: focused, lastFinishedTask: finished, rememberedSessionId: "session-visible", now: 2_000 })).toEqual({ route: "/main", agentChatId: "session-visible" });
  });

  it("展开完整模式优先使用当前可见焦点任务，避免 pending 新会话把旧任务结果带到 New Agent", () => {
    const focused = task({ id: "done-1", sessionId: "session-visible", status: "done", finishedAt: 1_000 });
    const older = task({ id: "done-2", sessionId: "session-older", status: "done", finishedAt: 900 });

    expect(resolvePetMainRouteTarget({ pendingNewSession: true, focusedTask: focused, lastFinishedTask: older, now: 1_000 + 4 * 60_000 })).toEqual({ route: "/main", agentChatId: "session-visible" });
  });

  it("未登录时桌宠展开完整模式回到登录入口而不是主界面", () => {
    const bootstrap = {
      ...mockBootstrap,
      app: {
        ...mockBootstrap.app,
        userMode: "account" as const,
        defaultLaunchMode: "pet" as const,
        lastLaunchMode: "pet" as const
      },
      onboarding: {
        ...mockBootstrap.onboarding,
        completed: true as const,
        currentStep: "completed" as const,
        hasAcceptedTerms: true,
        scanPermission: "scan_only" as const,
        improvementProgram: "accepted" as const,
        completedAt: "2026-06-01T00:00:00.000Z"
      }
    };

    expect(resolvePetFullRoute({
      bootstrap,
      account: {
        email: "",
        phoneNumber: null,
        nickname: "",
        registeredAt: null
      }
    })).toBe("/welcome");
    expect(resolvePetMainRouteTarget({ route: "/welcome", pendingNewSession: false, focusedTask: task({ id: "done-1", sessionId: "session-visible", status: "done" }), lastFinishedTask: null })).toEqual({ route: "/welcome" });
  });

  it("本机已完成引导时桌宠展开不受滞后的账号引导状态阻塞", () => {
    expect(resolvePetFullRoute({
      bootstrap: {
        ...mockBootstrap,
        app: {
          ...mockBootstrap.app,
          userMode: "account" as const
        },
        onboarding: {
          ...mockBootstrap.onboarding,
          completed: false,
          currentStep: "scan_permission_required" as const,
          completedAt: null
        }
      },
      account: {
        email: "hello@example.com",
        phoneNumber: null,
        nickname: "Memmy User",
        registeredAt: "2026-06-01T00:00:00.000Z"
      },
      guidanceCompleted: true
    })).toBe("/main");
  });

  it("录音计时格式化为 m:ss", () => {
    expect(formatRecordSeconds(0)).toBe("0:00");
    expect(formatRecordSeconds(65)).toBe("1:05");
  });

  it("原生双击事件展开完整模式，普通单击不能退出桌宠", () => {
    const current = { timestamp: 1_000, screenX: 500, screenY: 300 };

    expect(isPetDoubleClick({ clickDetail: 0, current, previous: null })).toBe(false);
    expect(isPetDoubleClick({ clickDetail: 1, current, previous: null })).toBe(false);
    expect(isPetDoubleClick({ clickDetail: 2, current, previous: null })).toBe(true);
    expect(isPetDoubleClick({ clickDetail: 3, current, previous: null })).toBe(true);
  });

  it("Windows 调整透明窗口后原生 click detail 重置为 1 时仍识别同位置快速双击", () => {
    const previous = { timestamp: 1_000, screenX: 500, screenY: 300 };

    expect(isPetDoubleClick({
      clickDetail: 1,
      previous,
      current: { timestamp: 1_400, screenX: 507, screenY: 305 }
    })).toBe(true);
    expect(isPetDoubleClick({
      clickDetail: 1,
      previous,
      current: { timestamp: 1_501, screenX: 500, screenY: 300 }
    })).toBe(false);
    expect(isPetDoubleClick({
      clickDetail: 1,
      previous,
      current: { timestamp: 1_250, screenX: 509, screenY: 300 }
    })).toBe(false);
  });

  it("把真实 Agent WebSocket 事件映射到桌宠 TaskBus 动作", () => {
    expect(resolvePetAgentEventAction({ event: "delta", text: "你" }, "", "未接入")).toEqual({ type: "append", text: "你" });
    expect(resolvePetAgentEventAction({ event: "stream_end", text: "你好" }, "你", "未接入")).toEqual({ type: "complete", text: "你好" });
    expect(resolvePetAgentEventAction({ event: "stream_end" }, "你好", "未接入")).toEqual({ type: "complete", text: "你好" });
    expect(resolvePetAgentEventAction({ event: "message", kind: "progress", text: "工具调用中" }, "你好", "未接入")).toEqual({ type: "ignore" });
    expect(resolvePetAgentEventAction({ event: "turn_end" }, "最终答案", "未接入")).toEqual({ type: "complete", text: "最终答案" });
    expect(resolvePetAgentEventAction({ event: "goal_status", status: "running" }, "最终答案", "未接入")).toEqual({ type: "ignore" });
    expect(resolvePetAgentEventAction({ event: "goal_status", status: "idle" }, "最终答案", "未接入")).toEqual({ type: "complete", text: "最终答案" });
    expect(resolvePetAgentEventAction({ event: "run_status_snapshot", status: "running", started_at: 1780732800 }, "最终答案", "未接入")).toEqual({ type: "ignore" });
    expect(resolvePetAgentEventAction({ event: "run_status_snapshot", status: "idle" }, "最终答案", "未接入")).toEqual({ type: "ignore" });
    expect(resolvePetAgentEventAction({ event: "error", detail: "invalid chat_id" }, "", "未接入")).toEqual({ type: "error", message: "invalid chat_id" });
  });

  it("归一化桌宠 Agent 接入错误文案", () => {
    expect(resolvePetAgentErrorMessage(new Error("连接失败"), "未接入")).toBe("连接失败");
    expect(resolvePetAgentErrorMessage({ reason: "missing content" }, "未接入")).toBe("missing content");
    expect(resolvePetAgentErrorMessage({}, "未接入")).toBe("未接入");
  });

  it("根据可见内容 union 生成动态原生窗口尺寸和桌宠锚点偏移", () => {
    const measurement = resolvePetMeasuredLayout({
      currentOffset: { x: 0, y: 0 },
      mascotRect: { left: 0, top: 0, right: PET_TIMING.mascotSize, bottom: PET_TIMING.mascotSize, width: PET_TIMING.mascotSize, height: PET_TIMING.mascotSize },
      contentRects: [
        { left: 0, top: 0, right: PET_TIMING.mascotSize, bottom: PET_TIMING.mascotSize, width: PET_TIMING.mascotSize, height: PET_TIMING.mascotSize },
        { left: -84, top: -88, right: 204, bottom: 0, width: PET_CANVAS.answerBubbleWidth, height: 88 },
        { left: -54, top: 104, right: 174, bottom: 144, width: PET_CANVAS.inputBubbleWidth, height: 40 }
      ],
      padding: PET_CANVAS.edgePadding
    });

    expect(measurement).toEqual({
      offset: { x: 108, y: 112 },
      windowLayout: { width: 336, height: 280, mascotOffsetX: 108, mascotOffsetY: 112 }
    });
  });

  it("回答气泡使用固定最大高度滚动容器展示内容", () => {
    const source = readFileSync(petPageSourcePath, "utf8");
    const styles = readFileSync(stylesPath, "utf8");

    expect(source).toContain("pet-answer-preview-frame");
    expect(source).toContain('data-overflowing={isOverflowing && !isScrolledToBottom ? "true" : "false"}');
    expect(source).toContain("node.scrollHeight - node.scrollTop - node.clientHeight < 4");
    expect(source).toContain("stripMarkdownForPetPreview");
    expect(source).toContain("pet-answer-preview-text");
    expect(styles).toContain(".pet-answer-preview-frame");
    expect(styles).toContain("max-height:");
    expect(styles).toContain("overflow-y: auto;");
    expect(styles).toContain(".pet-answer-preview-frame[data-overflowing=\"true\"]::after");
    expect(styles).toContain(".pet-answer-preview-text");
  });

  it("右键菜单靠近屏幕右侧时向左展开并纳入动态窗口测量", () => {
    const menuPosition = resolvePetContextMenuPosition({
      x: 96,
      y: 60,
      screenX: 1432,
      screenLeft: 0,
      screenWidth: 1440
    });

    expect(menuPosition).toEqual({ left: -80, top: 14 });

    const measurement = resolvePetMeasuredLayout({
      currentOffset: { x: 0, y: 0 },
      mascotRect: { left: 0, top: 0, right: PET_TIMING.mascotSize, bottom: PET_TIMING.mascotSize, width: PET_TIMING.mascotSize, height: PET_TIMING.mascotSize },
      contentRects: [
        { left: 0, top: 0, right: PET_TIMING.mascotSize, bottom: PET_TIMING.mascotSize, width: PET_TIMING.mascotSize, height: PET_TIMING.mascotSize },
        { left: menuPosition.left, top: menuPosition.top, right: menuPosition.left + 168, bottom: menuPosition.top + 92, width: 168, height: 92 }
      ],
      padding: PET_CANVAS.edgePadding
    });

    expect(measurement).toEqual({
      offset: { x: 104, y: 24 },
      windowLayout: { width: 248, height: 168, mascotOffsetX: 104, mascotOffsetY: 24 }
    });
  });

  it("mini 任务列表按 session 展示 processing 加最近少量完成任务，按最近活动倒序且最多 6 条", () => {
    const items = selectMiniTaskListItems([
      task({ id: "done-old", sessionId: "session-old", status: "done", startedAt: 1_000, updatedAt: 1_000, finishedAt: 1_100 }),
      task({ id: "run-new-older-query", sessionId: "session-run-new", title: "旧问题", status: "done", startedAt: 8_000, updatedAt: 8_200, finishedAt: 8_200 }),
      task({ id: "run-new", sessionId: "session-run-new", title: "新问题", status: "processing", startedAt: 9_000, updatedAt: 9_100 }),
      task({ id: "answering-new", sessionId: "session-answering-new", status: "answering", startedAt: 9_500, updatedAt: 9_600 }),
      task({ id: "cancelled-new", sessionId: "session-cancelled-new", status: "cancelled", startedAt: 10_000, updatedAt: 10_000 }),
      task({ id: "done-4", sessionId: "session-done-4", status: "done", startedAt: 4_000, updatedAt: 4_000, finishedAt: 4_100 }),
      task({ id: "error-8", sessionId: "session-error-8", status: "error", startedAt: 8_000, updatedAt: 8_000, finishedAt: 8_100 }),
      task({ id: "done-7", sessionId: "session-done-7", status: "done", startedAt: 7_000, updatedAt: 7_000, finishedAt: 7_100 }),
      task({ id: "run-mid", sessionId: "session-run-mid", status: "processing", startedAt: 6_000, updatedAt: 6_100 }),
      task({ id: "done-5", sessionId: "session-done-5", status: "done", startedAt: 5_000, updatedAt: 5_000, finishedAt: 5_100 }),
      task({ id: "done-3", sessionId: "session-done-3", status: "done", startedAt: 3_000, updatedAt: 3_000, finishedAt: 3_100 })
    ]);

    expect(items.map((item) => item.sessionId)).toEqual(["session-answering-new", "session-run-new", "session-error-8", "session-done-7", "session-run-mid", "session-done-5"]);
    expect(items.find((item) => item.sessionId === "session-run-new")).toMatchObject({
      taskId: "run-new",
      title: "新问题",
      status: "processing"
    });
  });

  it("mini 任务列表全部为完成态时也最多展示 6 个 session", () => {
    const items = selectMiniTaskListItems([
      task({ id: "done-7", sessionId: "session-done-7", status: "done", startedAt: 7_000, updatedAt: 7_000, finishedAt: 7_100 }),
      task({ id: "error-6", sessionId: "session-error-6", status: "error", startedAt: 6_000, updatedAt: 6_000, finishedAt: 6_100 }),
      task({ id: "done-5", sessionId: "session-done-5", status: "done", startedAt: 5_000, updatedAt: 5_000, finishedAt: 5_100 }),
      task({ id: "done-4", sessionId: "session-done-4", status: "done", startedAt: 4_000, updatedAt: 4_000, finishedAt: 4_100 }),
      task({ id: "done-3", sessionId: "session-done-3", status: "done", startedAt: 3_000, updatedAt: 3_000, finishedAt: 3_100 }),
      task({ id: "done-2", sessionId: "session-done-2", status: "done", startedAt: 2_000, updatedAt: 2_000, finishedAt: 2_100 }),
      task({ id: "done-1", sessionId: "session-done-1", status: "done", startedAt: 1_000, updatedAt: 1_000, finishedAt: 1_100 })
    ]);

    expect(items.map((item) => item.sessionId)).toEqual([
      "session-done-7",
      "session-error-6",
      "session-done-5",
      "session-done-4",
      "session-done-3",
      "session-done-2"
    ]);
  });

  it("mini 任务列表以 session 最新有效任务状态为准，避免旧 query 残留转圈", () => {
    const items = selectMiniTaskListItems([
      task({ id: "stale-answering", sessionId: "session-same", title: "旧问题", status: "answering", startedAt: 1_000, updatedAt: 1_500, lastAgentMessage: "旧回答片段" }),
      task({ id: "latest-done", sessionId: "session-same", title: "新问题", status: "done", startedAt: 2_000, updatedAt: 3_000, finishedAt: 3_000, lastAgentMessage: "新回答完成" }),
      task({ id: "other-running", sessionId: "session-running", title: "其他运行任务", status: "processing", startedAt: 2_500, updatedAt: 2_600 })
    ]);

    expect(items.find((item) => item.sessionId === "session-same")).toMatchObject({
      taskId: "latest-done",
      title: "新问题",
      status: "done",
      activityAt: 3_000
    });
    expect(items.filter((item) => item.status === "processing" || item.status === "answering").map((item) => item.sessionId)).toEqual(["session-running"]);
  });

  it("mini 任务列表不展示读过的完成通知，也不会退回旧 answering 任务", () => {
    const items = selectMiniTaskListItems([
      task({ id: "same-stale-answering", sessionId: "session-same", title: "旧问题", status: "answering", startedAt: 1_000, updatedAt: 1_500, lastAgentMessage: "旧回答片段" }),
      task({ id: "same-read-done", sessionId: "session-same", title: "已读完成", status: "done", startedAt: 2_000, updatedAt: 3_000, finishedAt: 3_000, readAt: 3_100, lastAgentMessage: "已读回答" }),
      task({ id: "read-done", sessionId: "session-read", title: "另一个已读完成", status: "done", startedAt: 4_000, updatedAt: 4_000, finishedAt: 4_100, readAt: 4_200 }),
      task({ id: "dismissed-done", sessionId: "session-dismissed", title: "老数据已收起完成", status: "done", startedAt: 4_500, updatedAt: 4_500, finishedAt: 4_600, dismissed: true }),
      task({ id: "unread-done", sessionId: "session-unread", title: "未读完成", status: "done", startedAt: 5_000, updatedAt: 5_000, finishedAt: 5_100 }),
      task({ id: "running", sessionId: "session-running", title: "运行中", status: "processing", startedAt: 6_000, updatedAt: 6_100 })
    ]);

    expect(items.map((item) => item.sessionId)).toEqual(["session-running", "session-unread"]);
    expect(items.map((item) => item.title)).toEqual(["运行中", "未读完成"]);
  });

  it("桌宠运行中 session 校准目标兼容 chatId/sessionKey，并按 WebUI run_started_at 判定运行态", () => {
    const client = {
      chatIdToSessionKey: (chatId: string) => `websocket:${chatId}`,
      sessionKeyToChatId: (sessionKey: string) => sessionKey.replace(/^websocket:/, "")
    };
    const targets = resolvePetTaskReconcileTargets({
      client,
      sessions: [
        { key: "websocket:chat-running", run_started_at: 1780732800 },
        { key: "websocket:chat-done" }
      ],
      items: [
        { id: "chat-running", sessionId: "chat-running", taskId: "task-running", title: "运行中", status: "processing", activityAt: 2_000 },
        { id: "chat-done", sessionId: "websocket:chat-done", taskId: "task-done", title: "已完成但本地滞后", status: "answering", activityAt: 1_000 },
        { id: "chat-finished", sessionId: "chat-finished", taskId: "task-finished", title: "完成", status: "done", activityAt: 3_000 }
      ]
    });

    expect(targets).toEqual([
      { chatId: "chat-running", sessionKey: "websocket:chat-running", isRunning: true },
      { chatId: "chat-done", sessionKey: "websocket:chat-done", isRunning: false }
    ]);
  });

  it("桌宠 thread 同步只在最新 query 有 answer 时写回，避免 query/answer 错配", () => {
    const messages = mapPetThreadMessagesToTaskBus([
      { role: "user", content: "旧问题", createdAt: 1_000 },
      { role: "assistant", content: "旧答案", createdAt: 1_100 },
      { role: "user", content: "新问题", createdAt: 2_000 }
    ]);

    expect(messages).toEqual([
      { role: "user", content: "旧问题", createdAt: 1_000 },
      { role: "assistant", content: "旧答案", createdAt: 1_100 },
      { role: "user", content: "新问题", createdAt: 2_000 }
    ]);
    expect(hasPetThreadLatestAnswer(messages)).toBe(false);

    expect(hasPetThreadLatestAnswer([
      ...messages,
      { role: "assistant", content: "新答案", createdAt: 2_100 }
    ])).toBe(true);
  });
});

describe("PetPageView SSR", () => {
  it("渲染欢迎、processing、多任务和 i18n 文案", () => {
    const running = [task({ id: "run-1", status: "processing" }), task({ id: "run-2", status: "processing" })];
    const bus = createBus({ tasks: running, focusedTask: running[0], runningTasks: running });
    const html = renderToString(
      <I18nProvider language="zh-CN">
        <PetPageView bus={bus} onNavigate={() => undefined} onPetWindowChange={() => undefined} />
      </I18nProvider>
    );

    expect(html).toContain('data-display-state="processing"');
    expect(html).toContain("正在处理");
    expect(html).toContain("2");
    expect(html).toContain("新对话");
    expect(html).toContain("停止");
    expect(html).toContain('data-icon="loader-2"');
    expect(html).toContain('data-icon="stop-square"');
    expect(html).not.toContain("Memo 会常驻屏幕角落");
  });

  it("processing 焦点任务只显示处理中气泡，并提供新对话入口而不直接共存 active 输入条", () => {
    const running = task({ id: "run-1", status: "processing" });
    const bus = createBus({ tasks: [running], focusedTask: running, runningTasks: [running] });
    const html = renderToString(
      <I18nProvider language="zh-CN">
        <PetPageView bus={bus} onNavigate={() => undefined} onPetWindowChange={() => undefined} />
      </I18nProvider>
    );

    expect(html).toContain('data-display-state="processing"');
    expect(html).toContain("正在处理");
    expect(html).toContain("新对话");
    expect(html).toContain("停止");
    expect(html).not.toContain("想跟我说什么？");
  });

  it("idle 运行中汇总气泡自动加宽、文本居中，并限制到回答气泡宽度", () => {
    const running = [task({ id: "run-1", status: "processing" })];
    const bus = createBus({ tasks: running, focusedTask: null, runningTasks: running });
    const html = renderToString(
      <I18nProvider language="zh-CN">
        <PetPageView bus={bus} onNavigate={() => undefined} onPetWindowChange={() => undefined} />
      </I18nProvider>
    );

    expect(html).toContain('data-display-state="idle"');
    expect(html).toContain("1 个任务进行中");
    expect(html).toContain('data-task-count="1"');

    const source = readFileSync(petPageSourcePath, "utf8");
    expect(source).toContain("style={{ minWidth: 156, maxWidth: PET_CANVAS.answerBubbleWidth }}");
    expect(source).toContain("const hasTaskHistorySwitcher = miniTaskListItems.length > 0;");
    expect(source).toContain("text-center leading-snug whitespace-normal break-words");
    expect(source).not.toContain("splitRunningSummaryLabel");
  });

  it("answering 态展示纯文本答案气泡和完整模式入口", () => {
    const done = task({
      status: "done",
      lastAgentMessage: [
        "# 结果汇总",
        "已经帮你 **整理** 好了，使用 `main`。",
        "",
        "- 列表项一",
        "- 列表项二",
        "",
        "1. 第一步",
        "2. 第二步",
        "",
        "> 这是引用说明",
        "",
        "结果见 [报告](https://example.com/report)。",
        "",
        "| 项目 | 状态 |",
        "| --- | --- |",
        "| 表格 | 已渲染 |",
        "",
        "```ts",
        "const ok = true;",
        "```"
      ].join("\n"),
      finishedAt: 2_000
    });
    const bus = createBus({ tasks: [done], focusedTask: done });
    const html = renderToString(
      <I18nProvider language="zh-CN">
        <PetPageView bus={bus} onNavigate={() => undefined} onPetWindowChange={() => undefined} />
      </I18nProvider>
    );
    const source = readFileSync(petPageSourcePath, "utf8");

    expect(html).toContain('data-display-state="answering"');
    expect(source).toContain("stripMarkdownForPetPreview");
    expect(html).toContain("pet-answer-preview-text");
    expect(html).toContain("结果汇总");
    expect(html).toContain("已经帮你");
    expect(html).toContain("整理");
    expect(html).toContain("main");
    expect(html).toContain("列表项一");
    expect(html).toContain("第一步");
    expect(html).toContain("这是引用说明");
    expect(html).toContain("报告");
    expect(html).toContain("已渲染");
    expect(html).not.toContain("<h1>");
    expect(html).not.toContain("<strong");
    expect(html).not.toContain("<table");
    expect(html).not.toContain("agent-message-content__code-block");
    expect(html).toContain("展开查看完整对话");
    expect(html).toContain("pet-answer-preview-frame");
    expect(html).not.toContain("-webkit-line-clamp:3");
  });

  it("answering 运行态展示流式答案并仍计入运行任务", () => {
    const answering = task({ status: "answering", lastAgentMessage: "正在给你写结果", streamingChunks: ["正在给你写结果"] });
    const bus = createBus({ tasks: [answering], focusedTask: answering });
    const html = renderToString(
      <I18nProvider language="zh-CN">
        <PetPageView bus={bus} onNavigate={() => undefined} onPetWindowChange={() => undefined} />
      </I18nProvider>
    );

    expect(html).toContain('data-display-state="answering"');
    expect(html).toContain("正在给你写结果");
    expect(html).toContain('data-icon="loader-2"');
  });

  it("所有 session 完成后仍保留 mini 任务列表入口，方便切回其他会话", () => {
    const first = task({ id: "done-1", sessionId: "session-first", status: "done", lastAgentMessage: "第一条完成", finishedAt: 2_000 });
    const second = task({ id: "done-2", sessionId: "session-second", status: "done", lastAgentMessage: "第二条完成", finishedAt: 3_000 });
    const bus = createBus({ tasks: [second, first], focusedTask: second, runningTasks: [] });
    const html = renderToString(
      <I18nProvider language="zh-CN">
        <PetPageView bus={bus} onNavigate={() => undefined} onPetWindowChange={() => undefined} />
      </I18nProvider>
    );

    expect(html).toContain("第二条完成");
    expect(html).toContain("data-task-count=\"2\"");
    expect(html).toContain("切换任务");
  });

  it("同 session 最新任务已完成时 mini 列表不再被旧 query 残留 answering 计为运行中", () => {
    const stale = task({ id: "stale-answering", sessionId: "session-same", title: "旧问题", status: "answering", startedAt: 1_000, updatedAt: 1_500, lastAgentMessage: "旧回答片段" });
    const done = task({ id: "latest-done", sessionId: "session-same", title: "新问题", status: "done", startedAt: 2_000, updatedAt: 3_000, finishedAt: 3_000, lastAgentMessage: "新回答完成" });
    const other = task({ id: "other-done", sessionId: "session-other", title: "其他完成", status: "done", startedAt: 2_500, updatedAt: 2_700, finishedAt: 2_700, lastAgentMessage: "其他回答完成" });
    const bus = createBus({ tasks: [done, other, stale], focusedTask: done, runningTasks: [stale] });
    const html = renderToString(
      <I18nProvider language="zh-CN">
        <PetPageView bus={bus} onNavigate={() => undefined} onPetWindowChange={() => undefined} />
      </I18nProvider>
    );

    expect(html).toContain('data-task-count="2"');
    expect(html).toContain('title="切换任务"');
    expect(html).not.toContain("1 个任务进行中");
    expect(html).not.toContain('data-icon="loader-2"');
    expect(html).toContain('data-icon="check-circle-2"');
  });

  it("只有一个已完成但未读任务且没有运行中任务时也展示数字角标", () => {
    const done = task({ id: "done-unread", sessionId: "session-unread", title: "未读完成任务", status: "done", startedAt: 2_000, updatedAt: 2_000, finishedAt: 2_100 });
    const bus = createBus({ tasks: [done], focusedTask: null, runningTasks: [] });
    const html = renderToString(
      <I18nProvider language="zh-CN">
        <PetPageView bus={bus} onNavigate={() => undefined} onPetWindowChange={() => undefined} />
      </I18nProvider>
    );

    expect(html).toContain('data-display-state="idle"');
    expect(html).toContain('data-task-count="1"');
    expect(html).toContain('title="切换任务"');
  });

  it("mini 任务列表行展示状态图标、单行标题和短相对时间，并使用可见条数作为徽标数字", () => {
    const now = Date.now();
    const tasks = [
      task({ id: "run-1", sessionId: "session-run", title: "正在跑的任务", status: "processing", startedAt: now - 30_000 }),
      task({ id: "error-1", sessionId: "session-error", title: "失败任务", status: "error", startedAt: now - 5 * 60_000 }),
      task({ id: "done-1", sessionId: "session-done", title: "完成任务", status: "done", startedAt: now - 2 * 60_000 }),
      task({ id: "done-read", sessionId: "session-read", title: "读过的完成任务", status: "done", readAt: now - 3 * 60_000, startedAt: now - 3 * 60_000 }),
      task({ id: "cancel-1", sessionId: "session-cancel", title: "取消任务", status: "cancelled", startedAt: now - 60_000 })
    ];
    const bus = createBus({ tasks, focusedTask: tasks[0], runningTasks: [tasks[0] as Task] });
    const html = renderToString(
      <I18nProvider language="zh-CN">
        <PetPageView bus={bus} onNavigate={() => undefined} onPetWindowChange={() => undefined} />
      </I18nProvider>
    );

    expect(html).toContain('data-task-count="3"');
    expect(html).not.toContain('data-task-count="4"');
    expect(html).not.toContain("读过的完成任务");

    const source = readFileSync(petPageSourcePath, "utf8");
    expect(source).toContain("data-session-id={task.sessionId}");
    expect(source).toContain("data-task-id={task.taskId}");
    expect(source).toContain("data-task-status={task.status}");
    expect(source).toContain("data-activity-at={task.activityAt}");
    expect(source).toContain("<MiniTaskStatusIcon status={task.status} />");
    expect(source).toContain("relativeTime(task.activityAt, labels.justNow)");
    expect(source).toContain('return <Loader2 size={12} className="text-action-sky animate-spin" />;');
    expect(source).toContain('return <CheckCircle2 size={12} className="text-status-success" />;');
    expect(source).toContain('return <AlertTriangle size={12} className="text-status-error" />;');
  });

  it("mini 列表点击完成项会先标记通知已读，再恢复任务回看", () => {
    const source = readFileSync(petPageSourcePath, "utf8");
    const markReadIndex = source.indexOf('if (item.status === "done" || item.status === "error")');
    const focusIndex = source.indexOf("bus.focusTask(item.taskId);", markReadIndex);

    expect(source).toContain("bus.markTaskRead(item.taskId);");
    expect(markReadIndex).toBeGreaterThan(-1);
    expect(focusIndex).toBeGreaterThan(markReadIndex);
    expect(source).toContain("const hasTaskHistorySwitcher = miniTaskListItems.length > 0;");
  });

  it("声明桌宠透明根背景样式，避免透明 Electron 窗口绘制桌面面板", () => {
    const styles = readFileSync(stylesPath, "utf8");

    expect(PET_TRANSPARENT_ROOT_CLASS).toBe("memmy-pet-transparent");
    expect(styles).toContain(`.${PET_TRANSPARENT_ROOT_CLASS}`);
    expect(styles).toContain("background: transparent !important");
    expect(styles).toContain(".pet-answer-preview-text");
    expect(styles).toContain(".pet-answer-preview-frame");
    expect(styles).toContain("max-height:");
    expect(styles).toContain("overflow-y: auto;");
  });

  it("桌宠输入气泡显式高于 mascot 本体，避免输入框被桌宠压住", () => {
    const source = readFileSync(petPageSourcePath, "utf8");

    expect(source).toContain("function ListeningInputBubble");
    expect(source).toContain('className={`absolute z-[220] flex items-center gap-1');
    expect(source).toContain('ref={registerHotzone("mascot")}');
  });

  it("不在 PetPage effect cleanup 中恢复完整窗口，避免 StrictMode 或普通重渲染关闭桌宠", () => {
    const source = readFileSync(petPageSourcePath, "utf8");

    expect(source).not.toContain("return () => onPetWindowChange?.(false);");
  });

  it("拖拽桌宠时移动 Electron 原生窗口，不再把角色限制在透明窗口 viewport 内", () => {
    const source = readFileSync(petPageSourcePath, "utf8");

    expect(source).toContain("window.memmy?.syncPetWindowLayout?.(nextMeasurement.windowLayout)");
    expect(source).toContain("window.memmy?.startPetWindowDrag?.({ clientX: event.clientX, clientY: event.clientY })");
    expect(source).toContain("window.memmy?.movePetWindow?.({ clientX: event.clientX, clientY: event.clientY })");
    expect(source).toContain("window.memmy?.stopPetWindowDrag?.()");
    expect(source).not.toContain("setPosition(next)");
  });

  it("更换桌宠形象从透明窗口切回设置页定位点，而不是默认主页面", () => {
    const source = readFileSync(petPageSourcePath, "utf8");

    expect(source).toContain('window.memmy.setPetWindow(false, { route: "/settings", hash: "pet-avatar" })');
    expect(source).toContain('onNavigate("/settings")');
  });

  it("右键菜单在返回完整模式下方提供关闭桌宠，隐藏桌宠到后台而不退出应用", () => {
    const source = readFileSync(petPageSourcePath, "utf8");

    expect(source).toContain('hidePet: t("pet.context.hidePet")');
    expect(source).toContain("window.memmy?.hidePetWindow?.()");
    expect(source).toContain("onHidePet");
    expect(source.indexOf("labels.fullMode")).toBeLessThan(source.indexOf("labels.hidePet"));
  });

  it("展开完整对话时把桌宠当前 chat 传给完整主页面", () => {
    const source = readFileSync(petPageSourcePath, "utf8");

    expect(source).toContain("const resolveMainRouteSessionId = useCallback(");
    expect(source).toContain("rememberedSessionId: lastMainRouteSessionIdRef.current");
    expect(source).toContain("window.memmy.setPetWindow(false, target)");
    expect(source).toContain("rememberFocusSession(target.agentChatId);");
    expect(source).toContain("onExpand={() => navigateToMain(focusedTask.sessionId)}");
    expect(source).toContain("onNavigate(mainRoute)");
  });

  it("双击桌宠和右键返回完整模式复用最近可展开 session，避免落到 New Agent", () => {
    const source = readFileSync(petPageSourcePath, "utf8");

    expect(source).toContain("lastMainRouteSessionIdRef.current = focusedTask.sessionId;");
    expect(source).toContain("const selectedSessionId = explicitSessionId ?? resolveFocusedTaskRouteChatId(focusedTask);");
    expect(source).toContain("if (input.rememberedSessionId) {");
    expect(source.indexOf("if (input.rememberedSessionId) {")).toBeLessThan(source.indexOf("const focusedSessionId = resolveFocusedTaskRouteChatId(input.focusedTask);"));
    expect(source).not.toContain("resolvePetMainRouteSessionId({ explicitSessionId, pendingNewSession, focusedTask, lastFinishedTask });");
    expect(source).toContain("navigateToMain(contextMenu.sessionId ?? undefined)");
    expect(source).toContain('event.currentTarget.closest<HTMLElement>("[data-pet-root]")');
    expect(source).toContain("x: Math.round(event.clientX - rootLeft)");
    expect(source).toContain("width: PET_CONTEXT_MENU.width");
    expect(source).toContain("whitespace-nowrap");
    expect(source).toContain("lastMainRouteSessionIdRef.current = item.sessionId;");
    expect(source).toContain("lastMainRouteSessionIdRef.current = runningSession?.sessionId ?? null;");
  });

  it("按 16.1 状态机优先处理 answering/active 的退出路径", () => {
    const source = readFileSync(petPageSourcePath, "utf8");

    expect(source).toContain("resetPetInputState();");
    expect(source).toContain("setIsActiveSuppressed(true);");
    expect(source).toContain("dismissFocusedTask();");
    expect(source.indexOf('if (displayState === "answering" && focusedTask)')).toBeLessThan(source.indexOf("if (isActive || isRecording)"));
  });

  it("processing 气泡新对话入口切到 pending new session，并由 mini 任务列表保留焦点切换能力", () => {
    const source = readFileSync(petPageSourcePath, "utf8");

    expect(source).toContain("const startNewPetConversation = useCallback(() => {");
    expect(source).toContain("bus.startNewSession();");
    expect(source).toContain("setIsActive(true);");
    expect(source).toContain("newConversationLabel={t(\"pet.newConversation\")}");
    expect(source).toContain("stopLabel={t(\"pet.stop\")}");
    expect(source).toContain("onNewConversation={startNewPetConversation}");
    expect(source).toContain("onStop={stopFocusedPetTask}");
    expect(source).toContain("const stoppedBySubmitHandler = onStopTask?.(focusedTask) ?? false;");
    expect(source).toContain("if (!stoppedBySubmitHandler) {");
    expect(source).toContain("petAgentBridge?.stopTask(focusedTask.id);");
    expect(source).toContain("bus.cancelTask(focusedTask.id)");
    expect(source).toContain("bus.focusTask(item.taskId);");
  });

  it("桌宠直连发送路径停止时会向真实 WebSocket 发 stop，并阻断尚未发送的 pending 消息", () => {
    const source = readFileSync(petPageSourcePath, "utf8");

    expect(source).toContain("const cancelledTaskIdsRef = useRef<Set<string>>(new Set());");
    expect(source).toContain("onSubmitTask={submitPetAgentTask} onStopTask={stopPetAgentTask}");
    expect(source).toContain("cancelledTaskIdsRef.current.add(task.id);");
    expect(source).toContain("connectionRef.current?.stop(chatId);");
    expect(source).toContain("dispatch(agentActions.stopRequested(chatId));");
    expect(source).toContain('dispatch(agentActions.wsEventReceived({ event: "stop_result", chat_id: chatId, stopped: 1 }));');
    expect(source).toContain("if (cancelledTaskIdsRef.current.has(task.id))");
    expect(source).toContain("cleanupPetAgentTaskRun(task);");
    expect(source.indexOf("if (cancelledTaskIdsRef.current.has(task.id))")).toBeLessThan(source.indexOf("connection.sendMessage({ chatId, content });"));
    const stopFocusedTaskIndex = source.indexOf("const stopFocusedPetTask = useCallback");
    const rememberStoppedSessionIndex = source.indexOf("lastMainRouteSessionIdRef.current = focusedTask.sessionId;", stopFocusedTaskIndex);
    const stopHandlerIndex = source.indexOf("const stoppedBySubmitHandler = onStopTask?.(focusedTask) ?? false;", stopFocusedTaskIndex);
    expect(rememberStoppedSessionIndex).toBeGreaterThan(stopFocusedTaskIndex);
    expect(rememberStoppedSessionIndex).toBeLessThan(stopHandlerIndex);
  });

  it("进入桌宠窗口前已完成 onboarding 持久化，避免 petWindow 重新 bootstrap 到引导页", () => {
    const source = readFileSync(fileURLToPath(new URL("../onboarding-page.tsx", import.meta.url)), "utf8");
    const completeHandlerIndex = source.indexOf("async function completeOnboarding(mode: PreferredMode)");
    const persistIndex = source.indexOf("await clients.config.updateOnboarding(completionPatch)", completeHandlerIndex);
    const navigateIndex = source.indexOf("dispatch(appActions.navigate(targetRoute));", completeHandlerIndex);

    expect(persistIndex).toBeGreaterThan(completeHandlerIndex);
    expect(navigateIndex).toBeGreaterThan(persistIndex);
  });

  it("桌宠录音结束后通过共享 ASR 录音器转写并发送文本", () => {
    const source = readFileSync(petPageSourcePath, "utf8");

    expect(source).toContain("useAsrRecorder");
    expect(source).toContain("asrRecorder.start()");
    expect(source).toContain("asrRecorder.finishAndTranscribe()");
    expect(source).toContain("submitInput(transcript.text)");
    expect(source).toContain("recordingSubmitInFlightRef.current = true;");
    expect(source).toContain("isSubmittingRecording={isRecordingSubmitting}");
    expect(source).not.toContain("const transcript = textInput.trim();");
  });

  it("挂载时只清除已完成 focusedTask 的焦点，避免残留气泡同时保留任务列表记录", () => {
    const source = readFileSync(petPageSourcePath, "utf8");

    const mountGuard = source.indexOf('if (focusedTask && (focusedTask.status === "done" || focusedTask.status === "error")');
    const mountEffectEnd = source.indexOf("}, []);", mountGuard);
    const mountEffect = source.slice(mountGuard, mountEffectEnd);

    expect(mountGuard).toBeGreaterThan(-1);
    expect(mountEffectEnd).toBeGreaterThan(mountGuard);
    expect(mountEffect).toContain("bus.focusTask(null);");
    expect(mountEffect).not.toContain("bus.dismissTask(");
    expect(source).not.toContain("react-hooks/exhaustive-deps");
  });

  it("桌宠模式会主动校准运行中 session 的真实 thread，避免主页面已完成但桌宠仍 processing", () => {
    const source = readFileSync(petPageSourcePath, "utf8");

    expect(PET_TASK_RECONCILE_INTERVAL_MS).toBe(2500);
    expect(source).toContain("memmyAgentClient.listSessions()");
    expect(source).toContain("memmyAgentClient.readWebuiThread(target.sessionKey)");
    expect(source).toContain("mapPetThreadMessagesToTaskBus(thread.messages)");
    expect(source).toContain("const isRunning = target.isRunning && thread.last_turn_closed !== true;");
    expect(source).toContain("preserveFocus: target.chatId !== focusedChatId");
    expect(source).not.toContain("items: runningSessionItems,");
  });
});

function task(overrides: Partial<Task> = {}): Task {
  const base: Task = {
    id: "task-1",
    sessionId: "session-1",
    title: "测试任务",
    status: "processing",
    startedAt: 1_000,
    updatedAt: 1_000,
    lastUserMessage: "测试任务",
    source: "pet"
  };

  return Object.assign(base, overrides);
}

function createBus(overrides: Partial<TaskBusValue> = {}): TaskBusValue {
  const tasks = overrides.tasks ?? [];
  const focusedTask = overrides.focusedTask ?? null;
  return {
    tasks,
    focusedTaskId: focusedTask?.id ?? null,
    focusedTask,
    runningTasks: overrides.runningTasks ?? tasks.filter((item) => item.status === "processing" || item.status === "answering"),
    lastFinishedTask: overrides.lastFinishedTask ?? null,
    pendingNewSession: false,
    createTask: () => task(),
    appendChunk: () => undefined,
    completeTask: () => undefined,
    errorTask: () => undefined,
    cancelTask: () => undefined,
    focusTask: () => undefined,
    startNewSession: () => undefined,
    dismissTask: () => undefined,
    markTaskRead: () => undefined,
    removeTasksBySessionIds: () => undefined,
    syncAgentConversation: () => undefined,
    syncAgentTaskStatuses: () => undefined,
    ...overrides
  };
}

/** Creates a narrow React keyboard event shape for pet input submit tests. */
function petInputKeyEvent(overrides: { key?: string; shiftKey?: boolean; nativeEvent?: { isComposing?: boolean; keyCode?: number } } = {}) {
  return {
    key: overrides.key ?? "Enter",
    shiftKey: overrides.shiftKey ?? false,
    nativeEvent: overrides.nativeEvent ?? {}
  } as Parameters<typeof shouldSubmitPetInputOnKeyDown>[0];
}
