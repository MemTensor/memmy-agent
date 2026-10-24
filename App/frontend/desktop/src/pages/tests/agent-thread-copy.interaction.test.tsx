// @vitest-environment happy-dom
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { I18nProvider } from "../../i18n/i18n-provider.js";
import type { AgentChatMessage } from "../../state/agent-chat-slice.js";
import { AgentThreadMessages } from "../agent-thread-messages.js";

describe("AgentThreadMessages copy actions across turns", () => {
  let container: HTMLDivElement;
  let root: Root;
  const completedMessages: AgentChatMessage[] = [
    { id: "question-1", role: "user", content: "First question" },
    { id: "answer-1", role: "assistant", content: "First **answer**" },
    { id: "question-2", role: "user", content: "Second question" },
    { id: "answer-2", role: "assistant", content: "Second `answer`" },
  ];

  beforeEach(() => {
    vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
    container = document.createElement("div");
    document.body.append(container);
    root = createRoot(container);
  });

  afterEach(() => {
    act(() => root.unmount());
    container.remove();
    vi.restoreAllMocks();
    vi.unstubAllGlobals();
  });

  async function render(messages: AgentChatMessage[], isSending = false) {
    await act(async () => {
      root.render(
        <I18nProvider language="en-US">
          <AgentThreadMessages chatScopeKey="copy-history" messages={messages} isSending={isSending} />
        </I18nProvider>
      );
    });
  }

  function copyButtons() {
    return [...container.querySelectorAll<HTMLButtonElement>(".agent-message-copy-button--left")];
  }

  it("keeps the first answer copyable after a second turn and copies each answer's raw text", async () => {
    const writeText = vi.spyOn(navigator.clipboard, "writeText").mockResolvedValue();
    await render(completedMessages.slice(0, 2));
    expect(copyButtons()).toHaveLength(1);

    await render(completedMessages);
    const buttons = copyButtons();
    expect(buttons).toHaveLength(2);
    await act(async () => buttons[0]!.click());
    await act(async () => buttons[1]!.click());
    expect(writeText.mock.calls).toEqual([["First **answer**"], ["Second `answer`"]]);
  });

  it.each(["waiting", "streaming", "reasoning", "tools"] as const)(
    "keeps both completed turns copyable while the third turn is %s",
    async (phase) => {
      const messages: AgentChatMessage[] = [
        ...completedMessages,
        { id: "question-3", role: "user", content: "Third question" },
      ];
      if (phase !== "waiting") {
        messages.push({
          id: "answer-3", role: "assistant", content: "Third draft",
          isStreaming: phase === "streaming",
          reasoningStreaming: phase === "reasoning",
        });
      }
      if (phase === "tools") {
        messages.push({ id: "tool-3", role: "tool", kind: "trace", content: "read_file()", isStreaming: true });
      }
      await render(messages, true);
      expect(copyButtons()).toHaveLength(2);
      expect(copyButtons().map((button) => button.closest(".agent-chat-bubble-frame")?.textContent))
        .toEqual([expect.stringContaining("First answer"), expect.stringContaining("Second answer")]);
    },
  );

  it("only exposes the final answer within each completed turn", async () => {
    await render([
      { id: "question-1", role: "user", content: "First question" },
      { id: "continuation-1", role: "assistant", content: "Checking first" },
      { id: "tool-1", role: "tool", kind: "trace", content: "read_file()" },
      { id: "answer-1", role: "assistant", content: "First final" },
      { id: "question-2", role: "user", content: "Second question" },
      { id: "continuation-2", role: "assistant", content: "Checking second" },
      { id: "narration-2", role: "assistant", kind: "narration", content: "Still checking" },
      { id: "answer-2", role: "assistant", content: "Second final", stoppedByUser: true },
      { id: "empty-2", role: "assistant", content: " " },
    ]);
    expect(copyButtons()).toHaveLength(2);
    expect(copyButtons().map((button) => button.closest(".agent-chat-bubble-frame")?.textContent))
      .toEqual([expect.stringContaining("First final"), expect.stringContaining("Second final")]);
  });
});
