import { describe, expect, it, vi } from "vitest";
import { createTaskPlanContinuation } from "../../../src/core/agent-runtime/task-plan-continuation.js";
import { AgentRunner, AgentRunSpec } from "../../../src/core/agent-runtime/runner.js";
import { LLMResponse, ToolCallRequest } from "../../../src/providers/base.js";
import type { TaskPlanState } from "../../../src/core/session/task-plan-state.js";

function plan(): TaskPlanState {
  return { planId: "p", title: "Review", status: "active", createdAt: "", updatedAt: "", items: [
    { id: "body", content: "Write body", status: "completed" },
    { id: "audit", content: "Audit", status: "pending" },
    { id: "render", content: "Render", status: "pending" },
  ] };
}
const handoff = "连续调用守卫要求我停止重复调用同一工具并先汇报。回「继续」。";

describe("task plan premature handoff recovery", () => {
  const partial = () => ({ ok: true, taskId: "review-test", data: { persisted: true, generation: {
    mode: "partial-host-model", checkpointed: true, safeToResume: true,
    completedOutlineNodeIds: ["s1"], pendingOutlineNodeIds: ["s2"], exhaustedFallbackOutlineNodeIds: [] as string[],
    paragraphProgress: [{ outlineNodeId: "s2", savedModelParagraphs: 1, retryBudget: { planning: { used: 1, limit: 2 } } }]
  } } });

  it("recovers the installed-runtime handoff wording and follows paragraph progress within an unchanged plan item", async () => {
    const state = plan();
    const progress = partial();
    let calls = 0;
    const observedHandoff = '我停止重复同一调用。插件 safeToResume=true，但我收到了“不要以相同参数重复调用该工具”的运行时约束。要我现在继续跑完剩余 7 节吗？';
    const provider: any = { getDefaultModel: () => "test", chatWithRetry: vi.fn(async () => {
      calls++;
      if (calls <= 8 && calls % 2) return new LLMResponse({ content: observedHandoff });
      if (calls <= 8) return new LLMResponse({ content: null, toolCalls: [new ToolCallRequest({ id: `write-${calls}`, name: "write", arguments: { taskId: "review-test", batchSize: 1 } })] });
      return new LLMResponse({ content: "Body completed" });
    }) };
    const tools: any = { getDefinitions: () => [], execute: vi.fn(async () => {
      progress.data.generation.paragraphProgress[0]!.savedModelParagraphs++;
      return JSON.stringify(progress);
    }) };
    const result = await new AgentRunner(provider).run(new AgentRunSpec({
      messages: [{ role: "user", content: "Complete all 12 sections" }, { role: "tool", content: JSON.stringify(progress) }],
      provider, tools, finalResponseContinuation: createTaskPlanContinuation(() => state)
    }));
    expect(result.finalContent).toBe("Body completed");
    expect(tools.execute).toHaveBeenCalledTimes(4);
  });

  it("recognizes a safe checkpoint returned through review_resume", () => {
    const p = partial();
    const result = { ...p, data: { resumedToolName: "review_generate_sections", result: p.data } };
    expect(createTaskPlanContinuation(() => null)({ finalContent: "我停止重复同一调用。", messages: [{ role: "tool", content: JSON.stringify(result) }] })).toBeTruthy();
  });

  it("continues checkpointed writing in the same runner without requiring a task plan", async () => {
    let n = 0;
    const provider: any = { getDefaultModel: () => "test", chatWithRetry: vi.fn(async () => {
      if (++n === 1) return new LLMResponse({ content: "运行时判定我在重复相同调用并要求停止，请回复“继续”。" });
      if (n === 2) return new LLMResponse({ content: null, toolCalls: [new ToolCallRequest({ id: "write", name: "write", arguments: {} })] });
      return new LLMResponse({ content: "Body completed" });
    }) };
    const tools: any = { getDefinitions: () => [], execute: vi.fn(async () => JSON.stringify({ ok: true, data: { generation: { mode: "host-model" } } })) };
    const result = await new AgentRunner(provider).run(new AgentRunSpec({
      messages: [{ role: "user", content: "Finish all body sections" }, { role: "tool", content: JSON.stringify(partial()) }],
      provider, tools, finalResponseContinuation: createTaskPlanContinuation(() => null)
    }));
    expect(result.finalContent).toBe("Body completed");
    expect(tools.execute).toHaveBeenCalledTimes(1);
  });

  it("bounds checkpoint corrections using actual progress, and leaves errors, status reads and completed work alone", () => {
    const recover = createTaskPlanContinuation(() => null);
    const result = partial();
    const context = () => ({ finalContent: handoff, messages: [{ role: "tool", content: JSON.stringify(result) }] });
    expect(recover(context())).toBeTruthy();
    expect(recover({ finalContent: handoff, messages: [...context().messages, { role: "user", content: "Only explain the previous status; do not continue" }] })).toBeNull();
    Object.assign(result, { runId: "new-call", updatedAt: Date.now() });
    expect(recover(context())).toBeTruthy();
    expect(recover(context())).toBeNull();
    result.data.generation.paragraphProgress[0]!.savedModelParagraphs++;
    expect(recover(context())).toBeTruthy();
    result.data.generation.exhaustedFallbackOutlineNodeIds.push("s2");
    expect(recover(context())).toBeNull();
    expect(recover({ finalContent: handoff, messages: [{ role: "tool", content: JSON.stringify({ ok: false, data: result.data }) }] })).toBeNull();
    expect(recover({ finalContent: handoff, messages: [{ role: "tool", content: JSON.stringify(result) }, { role: "tool", content: '{"ok":true,"data":{"sectionGeneration":{}}}' }] })).toBeNull();
    result.data.generation.exhaustedFallbackOutlineNodeIds = [];
    result.data.generation.pendingOutlineNodeIds = [];
    expect(recover(context())).toBeNull();
  });

  it("continues the original runner through audit and render after a false guard claim", async () => {
    const state = plan();
    let n = 0;
    const provider: any = { getDefaultModel: () => "test", chatWithRetry: vi.fn(async () => {
      n++;
      if (n === 1) return new LLMResponse({ content: handoff });
      if (n === 2 || n === 3) return new LLMResponse({ content: null, toolCalls: [new ToolCallRequest({ id: `call-${n}`, name: n === 2 ? "audit" : "render", arguments: {} })] });
      return new LLMResponse({ content: "Delivered" });
    }) };
    const tools: any = { getDefinitions: () => [], execute: vi.fn(async (name: string) => {
      state.items.find(i => i.id === name)!.status = "completed";
      if (name === "render") state.status = "completed";
      return JSON.stringify({ persisted: true, artifact: name });
    }) };
    const result = await new AgentRunner(provider).run(new AgentRunSpec({
      messages: [{ role: "user", content: "Finish existing review" }], provider, tools,
      finalResponseContinuation: createTaskPlanContinuation(() => state),
    }));
    expect(result.finalContent).toBe("Delivered");
    expect(result.stopReason).toBe("completed");
    expect(tools.execute.mock.calls.map((c: any[]) => c[0])).toEqual(["audit", "render"]);
    expect(state.status).toBe("completed");
  });

  it("leaves status answers, user decisions, completed and blocked plans alone", () => {
    const state = plan();
    const recover = createTaskPlanContinuation(() => state);
    expect(recover({ finalContent: "Current progress: 8/12", messages: [] })).toBeNull();
    expect(recover({ finalContent: "需要你选择图表使用方案", messages: [] })).toBeNull();
    state.items[1]!.status = "blocked";
    expect(recover({ finalContent: handoff, messages: [] })).toBeNull();
    state.status = "completed";
    expect(recover({ finalContent: handoff, messages: [] })).toBeNull();
    expect(createTaskPlanContinuation(() => null)({ finalContent: handoff, messages: [] })).toBeNull();
  });

  it("bounds no-progress corrections; calls and timestamps cannot reset them", () => {
    const state = plan();
    const recover = createTaskPlanContinuation(() => state);
    const ctx = { finalContent: handoff, messages: [{ role: "tool", content: '{"calledAt":"one"}' }] };
    expect(recover(ctx)).toBeTruthy();
    ctx.messages.push({ role: "tool", content: '{"calledAt":"two"}' });
    expect(recover(ctx)).toBeTruthy();
    expect(recover(ctx)).toBeNull();
    ctx.messages.push({ role: "tool", content: JSON.stringify({ contentHash: `sha256:${"a".repeat(64)}` }) });
    expect(recover(ctx)).toBeTruthy();
  });

  it("does not override the real iteration budget or provider errors", async () => {
    const continuation = vi.fn(createTaskPlanContinuation(plan));
    const provider: any = { getDefaultModel: () => "test", chatWithRetry: vi.fn(async () => new LLMResponse({ content: handoff, finishReason: "error" })) };
    const result = await new AgentRunner(provider).run(new AgentRunSpec({ provider, messages: [], finalResponseContinuation: continuation }));
    expect(result.stopReason).toBe("error");
    expect(continuation).not.toHaveBeenCalled();
    const exhausted = await new AgentRunner(provider).run(new AgentRunSpec({ provider, maxIterations: 0, messages: [], finalResponseContinuation: continuation }));
    expect(exhausted.stopReason).toBe("maxIterations");
    expect(continuation).not.toHaveBeenCalled();
  });
});
