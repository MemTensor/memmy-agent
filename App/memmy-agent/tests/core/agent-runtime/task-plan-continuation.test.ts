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
