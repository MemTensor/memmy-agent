// @vitest-environment happy-dom

import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { AgentTaskPlanState } from "../../api/memmy-agent-client.js";
import type { AgentChatMessage } from "../../state/agent-chat-slice.js";
import { I18nProvider } from "../../i18n/i18n-provider.js";
import { AgentTaskPlanBar } from "../agent-task-plan-bar.js";
import { AgentThreadMessages, shouldEmbedTaskPlanInProcess } from "../agent-thread-messages.js";

(globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

function plan(overrides: Partial<AgentTaskPlanState> = {}): AgentTaskPlanState {
  return {
    plan_id: "32f2868d-ae25-4f47-b33b-17f474eecc3a",
    title: "Generate literature review",
    status: "active",
    items: [
      { id: "evidence", content: "Map evidence", status: "completed" },
      { id: "sections", content: "Generate sections", status: "in_progress" },
      { id: "render", content: "Render and verify outputs", status: "pending" },
    ],
    created_at: "2026-09-14T06:00:00.000Z",
    updated_at: "2026-09-14T06:05:00.000Z",
    ...overrides,
  };
}

describe("AgentTaskPlanBar", () => {
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

  function render(value: AgentTaskPlanState, runActive = true): void {
    act(() => root.render(
      <I18nProvider language="en-US">
        <AgentTaskPlanBar plan={value} runActive={runActive} />
      </I18nProvider>
    ));
  }

  it("renders ordered progress and supports collapsing the fixed panel", () => {
    render(plan());
    const header = container.querySelector<HTMLButtonElement>(
      ".agent-task-plan-bar__header",
    )!;
    expect(header.getAttribute("aria-expanded")).toBe("true");
    expect(container.textContent).toContain("Task plan");
    expect(container.textContent).not.toContain("Generate literature review");
    expect(container.textContent).toContain("1/3");
    expect([...container.querySelectorAll(".agent-task-plan-bar__item")]
      .map((item) => item.textContent)).toEqual([
        "Map evidence",
        "Generate sections",
        "Render and verify outputs",
      ]);

    act(() => header.click());
    expect(header.getAttribute("aria-expanded")).toBe("false");
    expect(container.querySelector(".agent-task-plan-bar__items")).toBeNull();
  });

  it("starts a completed plan collapsed while preserving its summary", () => {
    render(plan({
      status: "completed",
      items: [
        { id: "evidence", content: "Map evidence", status: "completed" },
        { id: "sections", content: "Generate sections", status: "completed" },
      ],
    }));
    expect(container.querySelector(".agent-task-plan-bar__header")
      ?.getAttribute("aria-expanded")).toBe("false");
    expect(container.textContent).toContain("Completed");
    expect(container.textContent).toContain("2/2");
  });

  it("collapses a blocked standalone plan when its run ends", () => {
    render(plan());
    expect(container.querySelector(".agent-task-plan-bar__header")?.getAttribute("aria-expanded")).toBe("true");
    render(plan({ status: "blocked" }));
    expect(container.querySelector(".agent-task-plan-bar__header")?.getAttribute("aria-expanded")).toBe("false");
    expect(container.querySelector(".agent-task-plan-bar__items")).toBeNull();
  });

  it("pauses a persisted checklist after interruption and resumes only when reactivated", () => {
    render(plan());
    expect(container.querySelector(".agent-task-plan-bar__item--in_progress")).not.toBeNull();

    render(plan(), false);
    const header = container.querySelector<HTMLButtonElement>(".agent-task-plan-bar__header")!;
    expect(header.getAttribute("aria-expanded")).toBe("false");
    expect(container.textContent).toContain("Waiting to continue");
    act(() => header.click());
    expect(container.querySelector(".agent-task-plan-bar__item--in_progress")).toBeNull();
    expect(container.querySelectorAll(".agent-task-plan-bar__item--pending")).toHaveLength(2);

    render(plan(), true);
    expect(container.querySelector(".agent-task-plan-bar__item--in_progress")).not.toBeNull();
    expect(container.textContent).toContain("Active");
  });

  it("does not render an empty task plan snapshot", () => {
    render(plan({
      plan_id: null,
      title: "",
      status: null,
      items: [],
      created_at: null,
      updated_at: null,
    }));
    expect(container.querySelector(".agent-task-plan-bar")).toBeNull();
  });

  it("keeps one checklist at its creation step and updates that card in place", () => {
    const active = plan();
    const messages: AgentChatMessage[] = [
      { id: "user", role: "user", content: "按清单推进", turnId: "turn" },
      { id: "create", role: "tool", kind: "trace", content: "", turnId: "turn", toolEvents: [
        { phase: "end", call_id: "create", name: "create_task_plan", arguments: { title: active.title } }
      ] },
      { id: "update", role: "tool", kind: "trace", content: "", turnId: "turn", isStreaming: true, toolEvents: [
        { phase: "end", call_id: "update", name: "update_task_plan", arguments: { item_id: "sections", status: "in_progress" } }
      ] }
    ];
    expect(shouldEmbedTaskPlanInProcess(messages, "plan-chat", active, true)).toBe(true);
    const show = (value: AgentTaskPlanState) => act(() => root.render(<I18nProvider language="zh-CN">
      <AgentThreadMessages chatScopeKey="plan-chat" messages={messages} isSending taskPlan={value} />
    </I18nProvider>));
    show(active);
    const card = container.querySelector<HTMLElement>(".agent-activity-cluster__body .agent-task-plan-bar--embedded")!;
    expect(card).not.toBeNull();
    expect(card.textContent).toContain("1/3");
    expect(container.querySelector(".agent-activity-timeline-item--tool")?.textContent).toContain("Create task plan");
    expect(container.textContent).not.toContain("Update task plan");
    show(plan({ items: [
      { id: "evidence", content: "Map evidence", status: "completed" },
      { id: "sections", content: "Generate sections", status: "completed" },
      { id: "render", content: "Render and verify outputs", status: "in_progress" }
    ] }));
    expect(container.querySelector(".agent-task-plan-bar--embedded")).toBe(card);
    expect(card.textContent).toContain("2/3");
  });

  it("keeps a stopped plan in the existing process rather than adding a new chat row", () => {
    const messages: AgentChatMessage[] = [
      { id: "user", role: "user", content: "写综述", turnId: "turn" },
      { id: "tool", role: "tool", kind: "trace", content: "", turnId: "turn", stoppedByUser: true,
        toolEvents: [{ phase: "end", call_id: "write", name: "write_file" }] }
    ];
    expect(shouldEmbedTaskPlanInProcess(messages, "stopped", plan(), false)).toBe(true);
    expect(shouldEmbedTaskPlanInProcess(messages, "stopped", plan({ status: "completed" }), false)).toBe(false);
    act(() => root.render(<I18nProvider language="zh-CN">
      <AgentThreadMessages chatScopeKey="stopped" messages={messages} taskPlan={plan()} />
    </I18nProvider>));
    expect(container.querySelector(".agent-activity-cluster__body .agent-task-plan-bar--embedded")).not.toBeNull();
    expect(container.querySelectorAll(".agent-task-plan-bar")).toHaveLength(1);
    act(() => container.querySelector<HTMLButtonElement>(".agent-activity-cluster__toggle")!.click());
    expect(container.querySelector(".agent-task-plan-bar")).toBeNull();
    expect(container.querySelector(".agent-activity-cluster__toggle")?.textContent).not.toContain("任务清单");
  });

  it("keeps an interrupted first-turn plan still while an unrelated next turn runs", () => {
    const active = plan();
    const messages: AgentChatMessage[] = [
      { id: "first-user", role: "user", content: "写综述", turnId: "first" },
      { id: "create", role: "tool", kind: "trace", content: "", turnId: "first",
        isStreaming: true, stoppedByUser: true, toolEvents: [
          { phase: "end", call_id: "create", name: "create_task_plan", arguments: { title: active.title } }
        ] },
      { id: "next-user", role: "user", content: "另一件事", turnId: "second" },
      { id: "next-tool", role: "tool", kind: "trace", content: "", turnId: "second",
        isStreaming: true, toolEvents: [{ phase: "start", call_id: "read", name: "read_file" }] }
    ];
    const show = (nextMessages: AgentChatMessage[]) => act(() => root.render(<I18nProvider language="zh-CN">
      <AgentThreadMessages chatScopeKey="interrupted-plan" messages={nextMessages} isSending taskPlan={active} />
    </I18nProvider>));
    show(messages);
    const first = container.querySelectorAll(".agent-activity-cluster")[0]!;
    const card = first.querySelector<HTMLElement>(".agent-task-plan-bar--embedded")!;
    expect(card).not.toBeNull();
    expect(first.querySelector(".agent-activity-cluster__toggle")?.textContent).not.toContain("工作中");
    act(() => card.querySelector<HTMLButtonElement>(".agent-task-plan-bar__header")!.click());
    expect(card.querySelector(".agent-task-plan-bar__item--in_progress")).toBeNull();

    show([...messages.slice(0, -1), {
      ...messages.at(-1)!, toolEvents: [{ phase: "start", call_id: "resume", name: "get_task_plan" }]
    }]);
    const clusters = container.querySelectorAll(".agent-activity-cluster");
    expect(clusters[0]?.querySelector(".agent-task-plan-bar__item--in_progress")).not.toBeNull();
    expect(clusters[1]?.querySelector(".agent-task-plan-bar")).toBeNull();
  });

  it("stops the plan when the run is idle even if an old trace still says streaming", () => {
    const active = plan();
    const messages: AgentChatMessage[] = [
      { id: "user", role: "user", content: "写综述" },
      { id: "create", role: "tool", kind: "trace", content: "", isStreaming: true,
        toolEvents: [{ phase: "start", call_id: "create", name: "create_task_plan", arguments: { title: active.title } }] }
    ];
    act(() => root.render(<I18nProvider language="zh-CN">
      <AgentThreadMessages chatScopeKey="idle-stale-trace" messages={messages} isSending={false} taskPlan={active} />
    </I18nProvider>));
    const cluster = container.querySelector<HTMLElement>(".agent-activity-cluster")!;
    expect(cluster.querySelector(".agent-activity-cluster__toggle")?.textContent).not.toContain("工作中");
    act(() => cluster.querySelector<HTMLButtonElement>(".agent-activity-cluster__toggle")!.click());
    const card = cluster.querySelector<HTMLElement>(".agent-task-plan-bar--embedded")!;
    expect(card).not.toBeNull();
    act(() => card.querySelector<HTMLButtonElement>(".agent-task-plan-bar__header")!.click());
    expect(card.querySelector(".agent-task-plan-bar__item--in_progress")).toBeNull();
  });

  it("does not revive an older turn's working label or plan during a newer turn", () => {
    const active = plan();
    const messages: AgentChatMessage[] = [
      { id: "first-user", role: "user", content: "写综述", turnId: "first" },
      { id: "create", role: "tool", kind: "trace", content: "", turnId: "first", isStreaming: true,
        toolEvents: [{ phase: "end", call_id: "create", name: "create_task_plan", arguments: { title: active.title } }] },
      { id: "second-user", role: "user", content: "另一件事", turnId: "second" },
      { id: "second-tool", role: "tool", kind: "trace", content: "", turnId: "second", isStreaming: true,
        toolEvents: [{ phase: "start", call_id: "read", name: "read_file" }] }
    ];
    act(() => root.render(<I18nProvider language="zh-CN">
      <AgentThreadMessages chatScopeKey="stale-old-turn" messages={messages} isSending activeTurnId="second" taskPlan={active} />
    </I18nProvider>));
    const clusters = container.querySelectorAll(".agent-activity-cluster");
    expect(clusters[0]?.querySelector(".agent-activity-cluster__toggle")?.textContent).not.toContain("工作中");
    expect(clusters[1]?.querySelector(".agent-activity-cluster__toggle")?.textContent).toContain("工作中");
    expect(clusters[0]?.querySelector(".agent-activity-cluster__toggle")?.textContent).not.toContain("任务清单");
    expect(container.querySelector(".agent-task-plan-bar__item--in_progress")).toBeNull();
  });

  it("does not animate an unanchored plan for unrelated work in a new turn", () => {
    const messages: AgentChatMessage[] = [
      { id: "first-user", role: "user", content: "写综述", turnId: "first" },
      { id: "first-tool", role: "tool", kind: "trace", content: "", turnId: "first",
        toolEvents: [{ phase: "end", call_id: "read-old", name: "read_file" }] },
      { id: "next-user", role: "user", content: "另一件事", turnId: "second" },
      { id: "next-tool", role: "tool", kind: "trace", content: "", turnId: "second", isStreaming: true,
        toolEvents: [{ phase: "start", call_id: "read-new", name: "read_file" }] }
    ];
    const show = (nextMessages: AgentChatMessage[]) => act(() => root.render(<I18nProvider language="zh-CN">
      <AgentThreadMessages chatScopeKey="global-plan" messages={nextMessages} isSending taskPlan={plan()} />
    </I18nProvider>));
    show(messages);
    const card = container.querySelector<HTMLElement>(".agent-task-plan-bar")!;
    expect(card.querySelector(".agent-task-plan-bar__status")?.textContent).toBe("等待继续");
    expect(card.querySelector(".agent-task-plan-bar__header")?.getAttribute("aria-expanded")).toBe("false");

    show([...messages.slice(0, -1), {
      ...messages.at(-1)!, toolEvents: [{ phase: "start", call_id: "resume", name: "get_task_plan" }]
    }]);
    expect(container.querySelectorAll(".agent-task-plan-bar")).toHaveLength(1);
    expect(container.querySelector(".agent-task-plan-bar__item--in_progress")).not.toBeNull();
  });

  it("keeps a completed plan at the earlier creation turn after a later task", () => {
    const completed = plan({ status: "completed", items: plan().items.map((item) => ({ ...item, status: "completed" })) });
    const messages: AgentChatMessage[] = [
      { id: "user", role: "user", content: "做综述", turnId: "first" },
      { id: "create", role: "tool", kind: "trace", content: "", turnId: "first",
        toolEvents: [{ phase: "end", call_id: "create", name: "create_task_plan", arguments: { title: completed.title } }] },
      { id: "answer", role: "assistant", content: "第一轮完成", turnId: "first" },
      { id: "next-user", role: "user", content: "继续", turnId: "second" },
      { id: "next-tool", role: "tool", kind: "trace", content: "", turnId: "second",
        toolEvents: [{ phase: "end", call_id: "next", name: "read_file" }] }
    ];
    act(() => root.render(<I18nProvider language="zh-CN">
      <AgentThreadMessages chatScopeKey="history-plan" messages={messages} taskPlan={completed} />
    </I18nProvider>));
    const clusters = container.querySelectorAll(".agent-activity-cluster");
    expect(clusters).toHaveLength(2);
    expect(clusters[0]!.querySelector(".agent-activity-cluster__toggle")?.textContent).not.toContain("任务清单");
    expect(container.querySelectorAll(".agent-task-plan-bar")).toHaveLength(0);
    act(() => clusters[0]!.querySelector<HTMLButtonElement>(".agent-activity-cluster__toggle")!.click());
    expect(clusters[0]!.querySelector(".agent-task-plan-bar--embedded")).not.toBeNull();
    expect(clusters[1]!.querySelector(".agent-task-plan-bar--embedded")).toBeNull();
    expect(container.querySelectorAll(".agent-task-plan-bar")).toHaveLength(1);
  });

  it("keeps a resumed plan inside its original folded creation step", () => {
    const active = plan();
    const messages: AgentChatMessage[] = [
      { id: "first-user", role: "user", content: "写综述", turnId: "first" },
      { id: "create", role: "tool", kind: "trace", content: "", turnId: "first",
        toolEvents: [{ phase: "end", call_id: "create", name: "create_task_plan", arguments: { title: active.title } }] },
      { id: "first-answer", role: "assistant", content: "先到这里", turnId: "first" },
      { id: "second-user", role: "user", content: "继续清单", turnId: "second" },
      { id: "resume", role: "tool", kind: "trace", content: "", turnId: "second",
        toolEvents: [{ phase: "end", call_id: "resume", name: "get_task_plan" }] },
      { id: "second-answer", role: "assistant", content: "已继续", turnId: "second" }
    ];
    act(() => root.render(<I18nProvider language="zh-CN">
      <AgentThreadMessages chatScopeKey="folded-resumed-plan" messages={messages} isSending={false} taskPlan={active} />
    </I18nProvider>));
    const clusters = container.querySelectorAll(".agent-activity-cluster");
    expect(clusters).toHaveLength(2);
    expect(clusters[0]!.querySelector(".agent-activity-cluster__toggle")?.textContent).not.toContain("任务清单");
    expect(clusters[1]!.querySelector(".agent-task-plan-bar")).toBeNull();
    expect(container.querySelectorAll(".agent-task-plan-bar")).toHaveLength(0);
    act(() => clusters[0]!.querySelector<HTMLButtonElement>(".agent-activity-cluster__toggle")!.click());
    expect(clusters[0]!.querySelector(".agent-activity-cluster__body .agent-task-plan-bar")).not.toBeNull();
    expect(container.querySelectorAll(".agent-task-plan-bar")).toHaveLength(1);
  });
});
