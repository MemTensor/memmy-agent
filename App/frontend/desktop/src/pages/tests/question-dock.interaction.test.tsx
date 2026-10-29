// @vitest-environment happy-dom
import { act, useRef, useState } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { I18nProvider } from "../../i18n/i18n-provider.js";
import { AgentQuestionActiveRequestContext, AgentQuestionCard, type AgentQuestionResponse } from "../agent-question-card.js";
import { AgentThreadMessages } from "../agent-thread-messages.js";
import { useQuestionDockLayout } from "../use-question-dock-layout.js";
import { buildPluginCapabilityLabels, PluginCapabilityLabelsContext } from "../plugin-tool-activity.js";
import { summarizeToolCall } from "../../state/agent-tool-traces.js";
import type { InstalledPlugin } from "@memmy/local-api-contracts";

(globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
let root: Root;
let container: HTMLDivElement;
beforeEach(() => { container = document.createElement("div"); document.body.append(container); root = createRoot(container); });
afterEach(async () => { await act(async () => root.unmount()); container.remove(); vi.restoreAllMocks(); });
const card = { version: 1 as const, requestId: "question-1", questions: [
  { id: "scope", prompt: "研究范围？", options: [{ id: "ai", label: "人工智能" }, { id: "medical", label: "医学" }], allowMultiple: false, allowOther: true }
] };

it("keeps the active form in its dock and leaves an expanded answer in the original process", async () => {
  function Harness() {
    const [answer, setAnswer] = useState<AgentQuestionResponse | null>(null);
    return <I18nProvider language="zh-CN">
      <article data-testid="transcript"><AgentQuestionActiveRequestContext.Provider value={answer ? null : card.requestId}>
        <AgentThreadMessages chatScopeKey="chat" isSending messages={[
          { id: "q", role: "assistant", content: "", turnId: "turn", isStreaming: true, agentUi: { questionCard: card }, ...(answer ? { questionResponse: answer } : {}) },
          ...(answer ? [{ id: "tool", role: "tool" as const, kind: "trace" as const, content: "", toolEvents: [{ phase: "end" as const, name: "ask_question", call_id: "ask" }] }] : [])
        ]} />
      </AgentQuestionActiveRequestContext.Provider></article>
      <div className="agent-question-dock">{!answer ? <AgentQuestionCard card={card} onSubmit={(value) => { setAnswer(value); return true; }} /> : null}</div>
    </I18nProvider>;
  }
  await act(async () => root.render(<Harness />));
  expect(container.querySelector('[data-testid="transcript"] .agent-question-card')).toBeNull();
  expect(container.querySelector('[data-waiting-input-anchor]')?.textContent).toContain("等待用户回答");
  expect(container.querySelectorAll(".agent-question-dock .agent-question-card")).toHaveLength(1);
  await act(async () => container.querySelector<HTMLButtonElement>(".agent-activity-cluster__toggle")!.click());
  expect(container.querySelector(".agent-question-dock .agent-question-card")).not.toBeNull();
  await act(async () => [...container.querySelectorAll<HTMLButtonElement>(".agent-question-card__option")].find((button) => button.textContent?.includes("人工智能"))!.click());
  expect(container.querySelector(".agent-question-dock")?.childElementCount).toBe(0);
  // A manually folded process stays the user's choice once it is no longer waiting.
  const toggle = container.querySelector<HTMLButtonElement>(".agent-activity-cluster__toggle")!;
  if (toggle.getAttribute("aria-expanded") !== "true") await act(async () => toggle.click());
  const record = container.querySelector<HTMLDetailsElement>(".agent-question-answer--process")!;
  expect(record.open).toBe(true);
  expect(record.textContent).toContain("人工智能");
  expect(container.textContent).not.toContain("Asked user for input");
});

it("changes one process row from waiting to the completed card action", async () => {
  const messages = [
    { id: "user", role: "user" as const, content: "写一篇综述", turnId: "turn" },
    { id: "tool", role: "tool" as const, kind: "trace" as const, content: "", turnId: "turn", isStreaming: true,
      toolEvents: [{ phase: "start" as const, name: "mcp_plugins_plugin_review_request_interaction",
        call_id: "tool-call", ui_tool_call_id: "ui-tool" }] }
  ];
  const show = (label: string, awaiting: boolean) => root.render(<I18nProvider language="zh-CN">
    <AgentThreadMessages chatScopeKey="review" messages={messages} isSending
      pluginInteractionStatus={{ label, awaiting, agentToolCallId: "ui-tool" }} />
  </I18nProvider>);
  await act(async () => show("等待确认检索关键词", true));
  const row = container.querySelector<HTMLElement>(".agent-activity-cluster__body .agent-question-answer--review")!;
  expect(row.textContent).toBe("等待确认检索关键词");
  expect(row.querySelector("svg")).not.toBeNull();
  expect(row.getAttribute("data-waiting-input-anchor")).toBe("plugin");
  await act(async () => show("确认检索关键词", false));
  expect(container.querySelector(".agent-activity-cluster__body .agent-question-answer--review")).toBe(row);
  expect(row.textContent).toBe("确认检索关键词");
  expect(row.hasAttribute("data-waiting-input-anchor")).toBe(false);
});

it("uses plugin capability names without treating a task suffix as a subagent", async () => {
  const name = "mcp_plugins_plugin_review_create_task";
  expect(summarizeToolCall({ name, phase: "end", arguments: {} })?.verb).not.toBe("Launched");
  expect(summarizeToolCall({ name: "task", phase: "end", arguments: {} })?.verb).toBe("Launched");
  const labels = buildPluginCapabilityLabels([{ manifest: { capabilities: [{ id: "review_create_task", name: "创建综述任务" }] } }] as InstalledPlugin[]);
  await act(async () => root.render(<I18nProvider language="zh-CN"><PluginCapabilityLabelsContext.Provider value={labels}>
    <AgentThreadMessages chatScopeKey="chat" isSending messages={[{ id: "tool", role: "tool", kind: "trace", isStreaming: true,
      content: "", toolEvents: [{ phase: "start", call_id: "create", name }] }]} />
  </PluginCapabilityLabelsContext.Provider></I18nProvider>));
  expect(container.textContent).toContain("创建综述任务");
  expect(container.textContent).not.toContain("Launched subagent");
});

it("names a review interaction tool row after its actual card", async () => {
  const name = "mcp_plugins_plugin_review_request_interaction_30795300";
  const renderCall = (args: unknown) => root.render(<I18nProvider language="zh-CN">
    <AgentThreadMessages chatScopeKey="review-card" isSending messages={[{
      id: "card-tool", role: "tool", kind: "trace", turnId: "turn", content: "", isStreaming: true,
      toolEvents: [{ phase: "start", call_id: "card", name, arguments: args }]
    }]} />
  </I18nProvider>);

  await act(async () => renderCall({ type: "keywords", title: "确认检索关键词" }));
  expect(container.querySelector(".agent-activity-timeline-item--tool")?.textContent).toContain("确认检索关键词");
  expect(container.textContent).not.toContain("发起综述交互");

  await act(async () => renderCall(JSON.stringify({ type: "source-import" })));
  expect(container.querySelector(".agent-activity-timeline-item--tool")?.textContent).toContain("用户补充文献");
});

it("shows review and skill calls as ordinary localized tool rows with raw results folded", async () => {
  const labels = buildPluginCapabilityLabels([{ manifest: { capabilities: [
    { id: "review_find_tasks", name: "Find persisted review tasks" },
    { id: "review_create_task", name: "Create review task" }
  ] } }] as InstalledPlugin[]);
  const names = ["mcp_plugins_read_plugin_skill", "mcp_plugins_plugin_review_find_tasks", "mcp_plugins_plugin_review_create_task"];
  const messages = names.map((name, index) => ({ id: `tool-${index}`, role: "tool" as const, kind: "trace" as const,
    turnId: "turn", content: "", isStreaming: index === 2,
    toolEvents: [{ phase: "end" as const, name, call_id: `call-${index}`,
      arguments: index === 0 ? { pluginId: "literature-review", skillId: "literature-review" } : {},
      result: JSON.stringify({ ok: true, summary: "完成", data: { count: 10 } }) }] }));
  await act(async () => root.render(<I18nProvider language="zh-CN"><PluginCapabilityLabelsContext.Provider value={labels}>
    <AgentThreadMessages chatScopeKey="review" isSending messages={messages} />
  </PluginCapabilityLabelsContext.Provider></I18nProvider>));
  const summaries = [...container.querySelectorAll(".agent-activity-tool-details__summary")].map((item) => item.textContent?.trim());
  expect(summaries).toEqual(["读取文献综述技能", "查找历史综述任务", "创建综述任务"]);
  expect(container.querySelectorAll(".agent-activity-timeline-item--tool")).toHaveLength(3);
  expect([...container.querySelectorAll<HTMLDetailsElement>(".agent-activity-tool-details")].every((item) => !item.open)).toBe(true);
  expect(container.textContent).not.toContain("Launched subagent");
});

it("keeps a manually expanded tool group open when the next reasoning step arrives", async () => {
  const tool = (id: string) => ({ id, role: "tool" as const, kind: "trace" as const, turnId: "turn", content: "",
    toolEvents: [{ phase: "end" as const, name: "mcp_plugins_plugin_review_find_tasks", call_id: id }] });
  const initial = [tool("first"), tool("second")];
  await act(async () => root.render(<I18nProvider language="zh-CN"><AgentThreadMessages chatScopeKey="review" isSending messages={initial} /></I18nProvider>));
  const group = container.querySelector<HTMLDetailsElement>(".agent-activity-tool-group-details")!;
  expect(group.open).toBe(true);
  await act(async () => group.querySelector("summary")!.click());
  await act(async () => group.querySelector("summary")!.click());
  expect(group.open).toBe(true);
  await act(async () => root.render(<I18nProvider language="zh-CN"><AgentThreadMessages chatScopeKey="review" isSending messages={[
    ...initial, { id: "next", role: "assistant", content: "", reasoning: "开始下一步", turnId: "turn", isStreaming: true }
  ]} /></I18nProvider>));
  expect(container.querySelector<HTMLDetailsElement>(".agent-activity-tool-group-details")?.open).toBe(true);
});

it("reserves the covered area and follows a new card once while respecting later manual scrolling", async () => {
  const follow = { current: false };
  const scroll = vi.fn();
  let cardTop = 300;
  function Harness(props: { pendingKey: string | null }) {
    const panel = useRef<HTMLDivElement | null>(null);
    const composer = useRef<HTMLDivElement | null>(null);
    const [dock, setDock] = useState<HTMLDivElement | null>(null);
    useQuestionDockLayout({ panelRef: panel, composerRef: composer, questionDock: dock,
      scopeKey: "chat", pendingKey: props.pendingKey, followingRef: follow, scrollToLatest: scroll });
    return <div ref={(element) => { panel.current = element; if (element) element.getBoundingClientRect = () => ({ bottom: 800 }) as DOMRect; }}>
      <div ref={composer}><div className="agent-question-dock" ref={setDock}>
        <section ref={(element) => { if (element) element.getBoundingClientRect = () => ({ top: cardTop, height: 350 }) as DOMRect; }} />
      </div></div>
    </div>;
  }
  await act(async () => root.render(<Harness pendingKey="question-1" />));
  const panel = container.firstElementChild as HTMLElement;
  expect(panel.style.getPropertyValue("--agent-question-overlay-height")).toBe("516px");
  expect(scroll).toHaveBeenCalled();
  follow.current = false; scroll.mockClear(); cardTop = 400;
  await act(async () => window.dispatchEvent(new Event("resize")));
  expect(panel.style.getPropertyValue("--agent-question-overlay-height")).toBe("416px");
  expect(scroll).not.toHaveBeenCalled();
  await act(async () => root.render(<Harness pendingKey="question-2" />));
  expect(scroll).toHaveBeenCalled();
  await act(async () => root.render(<Harness pendingKey={null} />));
  expect(panel.style.getPropertyValue("--agent-question-overlay-height")).toBe("");
});
