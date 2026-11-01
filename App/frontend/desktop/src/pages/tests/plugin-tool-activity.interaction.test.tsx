// @vitest-environment happy-dom
import { act } from "react";
import { createRoot } from "react-dom/client";
import { expect, it } from "vitest";
import { I18nProvider } from "../../i18n/i18n-provider.js";
import { PluginUiProvider, usePluginUi } from "../../app/plugin-ui-context.js";
import { PluginToolActivity } from "../plugin-tool-activity.js";
import { AgentThreadMessages } from "../agent-thread-messages.js";

it("keeps overlapping legal questions attached to their exact calls after a history reload", async () => {
  localStorage.clear();
  const container = document.createElement("div");
  document.body.append(container);
  let root = createRoot(container);
  let ui: ReturnType<typeof usePluginUi>;
  function Harness() {
    ui = usePluginUi();
    return <><section data-call="a"><PluginToolActivity toolCallId="tool-a" /></section>
      <section data-call="b"><PluginToolActivity toolCallId="tool-b" /></section>
      <section data-call="other"><PluginToolActivity toolCallId="unrelated" /></section></>;
  }
  const render = () => root.render(<I18nProvider language="zh-CN"><PluginUiProvider><Harness /></PluginUiProvider></I18nProvider>);
  const request = (id: string) => ({ interactionId: `question-${id}`, type: "question" as const,
    payload: { title: `问题 ${id}`, questions: [{ id: "q", label: `确认 ${id}` }] } });
  const call = (id: string) => ({ pluginId: "legal-labor", capabilityId: "gap-resolve", callId: `plugin-${id}`,
    agentToolCallId: `tool-${id}`, conversationId: "websocket:chat", turnId: "turn", origin: "agent" as const });
  try {
    await act(async () => render());
    await act(async () => {
      ui!.receive({ ...call("b"), event: { type: "interaction", request: request("b") } });
      ui!.receive({ ...call("a"), event: { type: "interaction", request: request("a") } });
    });
    await act(async () => {
      ui!.recordLegalQuestionAnswer(call("a"), request("a"), { answers: { q: "上海" } });
      ui!.recordLegalQuestionAnswer(call("b"), request("b"), { answers: { q: "北京" } });
    });
    await act(async () => root.unmount());
    root = createRoot(container);
    await act(async () => render());
    const process = container.querySelector<HTMLElement>('[data-call="a"] .agent-question-answer--process');
    expect(process?.hasAttribute("open")).toBe(true);
    expect(process?.parentElement?.getAttribute("data-call")).toBe("a");
    expect(process?.querySelector("summary")?.textContent).toBe("向用户提问");
    expect(process?.querySelector(".agent-question-answer__details dd")?.textContent).toBe("上海");
    expect(container.querySelector('[data-call="a"]')?.textContent).toContain("上海");
    expect(container.querySelector('[data-call="a"]')?.textContent).not.toContain("北京");
    expect(container.querySelector('[data-call="b"]')?.textContent).toContain("北京");
    expect(container.querySelector('[data-call="other"]')?.textContent).toBe("");
  } finally {
    await act(async () => root.unmount()); container.remove(); localStorage.clear();
  }
});

it("keeps the same question heading after a legal card is interrupted", async () => {
  localStorage.clear();
  const container = document.createElement("div");
  document.body.append(container);
  const root = createRoot(container);
  let ui: ReturnType<typeof usePluginUi>;
  function Harness() {
    ui = usePluginUi();
    return <PluginToolActivity toolCallId="tool-gap" />;
  }
  const call = { pluginId: "legal-labor", capabilityId: "gap-resolve", callId: "plugin-gap",
    agentToolCallId: "tool-gap", conversationId: "websocket:chat-gap", turnId: "turn", origin: "agent" as const };
  try {
    await act(async () => root.render(<I18nProvider language="zh-CN"><PluginUiProvider><Harness /></PluginUiProvider></I18nProvider>));
    await act(async () => ui!.receive({ ...call, event: { type: "interaction", request: {
      interactionId: "company", type: "question", payload: { title: "补充企业情况",
        questions: [{ id: "location", label: "社保参保地" }] }
    } } }));
    expect(container.querySelector(".agent-question-answer--review")?.textContent).toBe("等待补充企业情况");

    await act(async () => ui!.interruptPendingInteractions(["legal-labor:plugin-gap:company"]));
    expect(container.querySelector(".agent-question-answer summary")?.textContent).toContain("向用户提问");
    expect(container.querySelector(".agent-question-answer summary")?.textContent).not.toContain("已取消");
  } finally {
    await act(async () => root.unmount());
    container.remove();
    localStorage.clear();
  }
});

it("replaces the waiting upload card with one lasting process action after submission", async () => {
  const container = document.createElement("div");
  document.body.append(container);
  const root = createRoot(container);
  let ui: ReturnType<typeof usePluginUi>;
  function Harness() {
    ui = usePluginUi();
    return <AgentThreadMessages chatScopeKey="chat-upload" isSending messages={[
      { id: "user", role: "user", content: "开始诊断" },
      { id: "tool", role: "tool", kind: "trace", content: "", activitySegmentId: "diagnosis",
        toolEvents: [{ phase: "start", call_id: "tool-upload", name: "mcp_plugins_plugin_material-collect_1234abcd" }] }
    ]} />;
  }
  const call = { pluginId: "legal-labor", capabilityId: "material-collect", callId: "plugin-upload",
    agentToolCallId: "tool-upload", conversationId: "websocket:chat-upload", turnId: "turn", origin: "agent" as const };
  try {
    await act(async () => root.render(<I18nProvider language="zh-CN"><PluginUiProvider><Harness /></PluginUiProvider></I18nProvider>));
    await act(async () => ui!.receive({ ...call, event: { type: "interaction", request: {
      interactionId: "files", type: "file-input", payload: { title: "补充诊断材料" }
    } } }));
    expect(container.querySelector(".agent-question-answer--review")).toBeNull();

    await act(async () => ui!.setAnsweredInteractions((current) => new Set([...current, "legal-labor:plugin-upload:files"])));
    expect(container.querySelectorAll(".agent-question-answer--review")).toHaveLength(1);
    expect(container.querySelector(".agent-question-answer--review")?.textContent).toBe("用户上传文件");
    expect(container.querySelector(".agent-question-answer--review")?.parentElement?.classList.contains("plugin-tool-activity")).toBe(false);
    expect(container.querySelector(".agent-activity-timeline-item--tool")).toBeNull();

    await act(async () => ui!.receive({ ...call, event: { type: "result", output: {} } }));
    expect(container.querySelector(".agent-question-answer--review")?.textContent).toBe("用户上传文件");
  } finally {
    await act(async () => root.unmount());
    container.remove();
  }
});

it("keeps a completed literature import action on the timeline baseline", async () => {
  const container = document.createElement("div");
  document.body.append(container);
  const root = createRoot(container);
  let ui: ReturnType<typeof usePluginUi>;
  function Harness() {
    ui = usePluginUi();
    return <section className="agent-activity-cluster__body"><PluginToolActivity toolCallId="tool-sources" /></section>;
  }
  try {
    await act(async () => root.render(<I18nProvider language="zh-CN"><PluginUiProvider><Harness /></PluginUiProvider></I18nProvider>));
    await act(async () => ui!.receive({ pluginId: "literature-review", capabilityId: "review_request_interaction",
      callId: "plugin-sources", agentToolCallId: "tool-sources", conversationId: "websocket:chat-review",
      turnId: "turn", origin: "agent", event: { type: "interaction", request: {
        interactionId: "sources", type: "custom", payload: { title: "导入本地文献（可选）", cardType: "source-import" }
      } } }));
    await act(async () => ui!.setAnsweredInteractions((current) => new Set([...current, "literature-review:plugin-sources:sources"])));

    const action = container.querySelector<HTMLElement>(".agent-question-answer--review");
    expect(action?.textContent).toBe("用户补充文献");
    expect(action?.parentElement?.classList.contains("agent-activity-cluster__body")).toBe(true);
  } finally {
    await act(async () => root.unmount());
    container.remove();
  }
});
