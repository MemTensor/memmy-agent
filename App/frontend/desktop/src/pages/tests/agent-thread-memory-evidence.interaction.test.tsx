// @vitest-environment happy-dom
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { I18nProvider } from "../../i18n/i18n-provider.js";
import { AgentThreadMessages } from "../agent-thread-messages.js";

describe("AgentThreadMessages memory evidence interaction", () => {
  let container: HTMLDivElement;
  let root: Root;

  beforeEach(() => {
    container = document.createElement("div");
    document.body.append(container);
    root = createRoot(container);
  });

  afterEach(() => {
    act(() => root.unmount());
    container.remove();
  });

  it("keeps a separate memory evidence control for every completed turn", async () => {
    const recallEvidence = vi.fn(async (turnId: string) => ({
      recallEventId: `recall-${turnId}`,
      queryId: turnId,
      query: turnId,
      createdAt: "2026-08-21T00:00:00.000Z",
      serverTime: "2026-08-21T00:00:00.000Z",
      hits: []
    }));

    await act(async () => {
      root.render(
        <I18nProvider language="zh-CN">
          <AgentThreadMessages
            chatScopeKey="chat-memory-history"
            isSending
            memoryRuntimeClient={{ recallEvidence, deleteMemory: vi.fn() }}
            messages={[
              { id: "query-1", role: "user", content: "第一轮" },
              { id: "answer-1", role: "assistant", turnId: "turn-1", content: "第一轮完成" },
              { id: "query-2", role: "user", content: "第二轮" },
              { id: "answer-2", role: "assistant", turnId: "turn-2", content: "第二轮完成" },
              { id: "query-3", role: "user", content: "第三轮正在处理" }
            ]}
          />
        </I18nProvider>
      );
    });

    const buttons = [...container.querySelectorAll<HTMLButtonElement>("button.agent-memory-evidence-toggle")];
    expect(buttons).toHaveLength(2);
    await act(async () => buttons[0]?.click());
    await act(async () => buttons[1]?.click());
    expect(recallEvidence).toHaveBeenNthCalledWith(1, "turn-1");
    expect(recallEvidence).toHaveBeenNthCalledWith(2, "turn-2");
  });

  it("[BC-27 chat] deletes same-turn L1 and User Memory members together", async () => {
    const deleteMemory = vi.fn(async (id: string) => {
      if (id === "trace-1") throw Object.assign(new Error("already deleted"), { status: 404 });
      return {
        ok: true as const,
        id,
        kind: "trace" as const,
        status: "deleted" as const,
        changeSeq: 1,
        syncCursor: "cursor",
        serverTime: "2026-08-17T00:00:00.000Z"
      };
    });
    const recallEvidence = vi.fn(async () => ({
      recallEventId: "recall-1",
      queryId: "turn-1",
      query: "简洁代码",
      createdAt: "2026-08-17T00:00:00.000Z",
      serverTime: "2026-08-17T00:00:00.000Z",
      hits: [
        {
          id: "turn:turn-source",
          kind: "trace" as const,
          memoryLayer: "L1" as const,
          status: "activated" as const,
          title: "memory.add:agent-source:workbuddy:turn:workbuddy:406eaf47addb146159e05da3",
          snippet: "保持代码简洁",
          score: 0.9,
          tags: [],
          source: "search" as const,
          sourceTurnId: "turn-source",
          memberMemoryIds: ["trace-1", "user-memory-1"],
          members: [
            {
              id: "trace-1",
              kind: "trace" as const,
              memoryLayer: "L1" as const,
              status: "activated" as const,
              content: "任务反馈：保持代码简洁",
              createdAt: "2026-08-17T00:00:00.000Z",
              updatedAt: "2026-08-17T00:00:00.000Z",
              retrievalRoute: "l1" as const
            },
            {
              id: "user-memory-1",
              kind: "user_memory" as const,
              memoryLayer: "UserMemory" as const,
              status: "active" as const,
              content: "我喜欢简洁代码",
              createdAt: "2026-08-17T00:00:00.000Z",
              updatedAt: "2026-08-17T00:00:00.000Z",
              retrievalRoute: "user_memory" as const
            }
          ]
        },
        {
          id: "turn:turn-source-2",
          kind: "trace" as const,
          memoryLayer: "L1" as const,
          status: "activated" as const,
          snippet: "第二条记忆",
          score: 0.6,
          tags: [],
          source: "search" as const,
          sourceTurnId: "turn-source-2",
          memberMemoryIds: ["trace-2"],
          members: [{
            id: "trace-2",
            kind: "trace" as const,
            memoryLayer: "L1" as const,
            status: "activated" as const,
            content: "第二条记忆",
            createdAt: "2026-08-17T00:00:00.000Z",
            updatedAt: "2026-08-17T00:00:00.000Z",
            retrievalRoute: "l1" as const
          }]
        }
      ]
    }));

    await act(async () => {
      root.render(
        <I18nProvider language="zh-CN">
          <AgentThreadMessages
            chatScopeKey="chat-memory-delete"
            memoryRuntimeClient={{ recallEvidence, deleteMemory }}
            messages={[
              {
                id: "query-1",
                role: "user",
                content: "请保持代码简洁"
              },
              {
                id: "answer-1",
                role: "assistant",
                turnId: "turn-1",
                content: "已完成。"
              }
            ]}
          />
        </I18nProvider>
      );
    });

    const showButton = [...container.querySelectorAll("button")]
      .find((button) => button.textContent?.includes("查看本轮记忆依据"));
    expect(showButton?.classList.contains("agent-memory-evidence-toggle")).toBe(true);
    const userTurn = container.querySelector(".agent-user-turn");
    const userBubble = userTurn?.querySelector(".agent-chat-bubble--user");
    expect(userTurn?.contains(showButton ?? null)).toBe(true);
    expect(Boolean(userBubble && showButton && (userBubble.compareDocumentPosition(showButton) & Node.DOCUMENT_POSITION_FOLLOWING))).toBe(true);
    await act(async () => showButton?.click());

    expect(container.textContent).toContain("trace-1");
    expect(container.textContent).toContain("L1 记忆");
    expect(container.textContent).toContain("用户记忆");
    expect(container.textContent).toContain("召回分 0.90");
    expect(container.textContent).not.toContain("memory.add:agent-source");
    expect(container.textContent).not.toContain("user_memory");
    expect(container.innerHTML).not.toContain("turn-source");
    const evidenceCard = container.querySelector("article");
    expect(evidenceCard?.className).toContain("bg-canvas-oat/35");
    expect(evidenceCard?.className.split(/\s+/)).not.toContain("border");
    expect(evidenceCard?.firstElementChild?.textContent).toContain("trace-1L1 记忆用户记忆召回分 0.90");

    const header = container.querySelector("[data-memory-evidence-header]");
    const headerInfo = header?.firstElementChild;
    expect(headerInfo?.textContent).toBe("trace-1L1 记忆用户记忆召回分 0.90");

    const deleteButton = [...container.querySelectorAll("button")]
      .find((button) => button.textContent?.trim() === "删除");
    expect(header?.lastElementChild?.contains(deleteButton ?? null)).toBe(true);
    expect(deleteButton?.className).toContain("agent-memory-evidence-delete");
    expect(document.querySelector('[role="tooltip"]')).toBeNull();
    await act(async () => deleteButton?.click());

    expect(container.textContent).toContain("trace-1");
    expect(deleteButton?.textContent?.trim()).toBe("撤销");
    expect(deleteButton?.className).toContain("agent-memory-evidence-undo");
    expect(deleteMemory).not.toHaveBeenCalled();

    await act(async () => deleteButton?.click());
    expect(deleteButton?.textContent?.trim()).toBe("删除");
    expect(deleteMemory).not.toHaveBeenCalled();

    await act(async () => deleteButton?.click());
    expect(deleteButton?.textContent?.trim()).toBe("撤销");

    const hideButton = [...container.querySelectorAll("button")]
      .find((button) => button.textContent?.includes("收起记忆依据"));
    await act(async () => hideButton?.click());

    expect(deleteMemory).toHaveBeenCalledTimes(2);
    expect(deleteMemory).toHaveBeenCalledWith("trace-1");
    expect(deleteMemory).toHaveBeenCalledWith("user-memory-1");

    const reopenButton = [...container.querySelectorAll("button")]
      .find((button) => button.textContent?.includes("查看本轮记忆依据"));
    await act(async () => reopenButton?.click());
    expect(container.textContent).not.toContain("暂时无法读取本轮记忆依据");
    expect(container.textContent).not.toContain("部分记忆删除失败");
    expect(container.textContent).not.toContain("trace-1");
    const remainingDeleteButton = [...container.querySelectorAll("button")]
      .find((button) => button.textContent?.trim() === "删除");
    await act(async () => remainingDeleteButton?.click());
    expect(remainingDeleteButton?.textContent?.trim()).toBe("撤销");
    expect(deleteMemory).toHaveBeenCalledTimes(2);

    await act(async () => {
      root.render(
        <I18nProvider language="zh-CN">
          <AgentThreadMessages
            chatScopeKey="another-chat"
            memoryRuntimeClient={{ recallEvidence, deleteMemory }}
            messages={[]}
          />
        </I18nProvider>
      );
    });
    expect(deleteMemory).toHaveBeenCalledTimes(3);
    expect(deleteMemory).toHaveBeenCalledWith("trace-2");
  });
});
