// @vitest-environment happy-dom
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { I18nProvider } from "../../i18n/i18n-provider.js";
import type { AgentChatMessage } from "../../state/agent-chat-slice.js";
import { AgentThreadMessages } from "../agent-thread-messages.js";

const trace: AgentChatMessage = {
  id: "trace",
  role: "tool",
  kind: "trace",
  content: "web_search()",
  traces: ["web_search()"],
  toolEvents: [{ phase: "end", call_id: "call-search", name: "web_search" }],
  activitySegmentId: "activity-current",
  isStreaming: false
};

const workingMessages: AgentChatMessage[] = [
  { id: "question", role: "user", content: "你帮我填下这个表单，不要提交" },
  trace
];

describe("queued follow-ups keep the live activity open", () => {
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

  function renderMessages(messages: AgentChatMessage[], isSending: boolean) {
    act(() => {
      root.render(
        <I18nProvider language="zh-CN">
          <AgentThreadMessages chatScopeKey="chat-queue-hold" isSending={isSending} messages={messages} />
        </I18nProvider>
      );
    });
  }

  function clusterToggle(): HTMLButtonElement {
    const toggle = container.querySelector<HTMLButtonElement>(".agent-activity-cluster__toggle");
    if (!toggle) throw new Error("missing activity toggle");
    return toggle;
  }

  it("keeps the in-progress cluster expanded when queued user rows are appended", () => {
    renderMessages(workingMessages, true);
    expect(clusterToggle().getAttribute("aria-expanded")).toBe("true");
    expect(container.textContent).toContain("工作中");
    expect(container.textContent).toContain("Searched web for");

    renderMessages([
      ...workingMessages,
      { id: "queued-1", role: "user", content: "你在哪里填的呀？我怎么没看到" },
      { id: "queued-2", role: "user", content: "挺好的" }
    ], true);

    expect(clusterToggle().getAttribute("aria-expanded")).toBe("true");
    expect(container.textContent).toContain("工作中");
    expect(container.textContent).toContain("Searched web for");
    expect(container.textContent).toContain("你在哪里填的呀？我怎么没看到");
    expect(container.textContent).toContain("挺好的");
  });

  it("still collapses the cluster once a real answer arrives after the queued rows", () => {
    renderMessages(workingMessages, true);
    renderMessages([
      ...workingMessages,
      { id: "queued-1", role: "user", content: "你在哪里填的呀？我怎么没看到" },
      { id: "answer", role: "assistant", content: "填在页面上了，还没提交。" }
    ], true);

    expect(clusterToggle().getAttribute("aria-expanded")).toBe("false");
    expect(container.textContent).not.toContain("Searched web for");
    expect(container.textContent).toContain("填在页面上了，还没提交。");
    expect(container.textContent).not.toContain("工作中");
  });

  it("does not reopen a finished cluster when the next turn starts sending", () => {
    renderMessages(workingMessages, false);
    expect(clusterToggle().getAttribute("aria-expanded")).toBe("false");
    expect(container.textContent).toContain("工作了一会儿");

    renderMessages([
      ...workingMessages,
      { id: "next", role: "user", content: "再查一个" }
    ], true);

    expect(clusterToggle().getAttribute("aria-expanded")).toBe("false");
    expect(container.textContent).toContain("工作了一会儿");
    expect(container.textContent).not.toContain("工作中");
    expect(container.textContent).not.toContain("Searched web for");
  });
});
