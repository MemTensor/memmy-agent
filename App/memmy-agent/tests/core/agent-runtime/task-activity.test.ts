import { describe, expect, it, vi } from "vitest";
import { agentTaskActivity } from "../../../src/core/agent-runtime/task-activity.js";
import { AgentLoop } from "../../../src/core/agent-runtime/loop.js";
import { SubagentManager, SubagentStatus } from "../../../src/core/agent-runtime/subagent.js";
import { InboundMessage } from "../../../src/core/runtime-messages/events.js";

function deferred() {
  let resolve!: () => void;
  const promise = new Promise<void>(done => { resolve = done; });
  return { promise, resolve };
}

function loopFixture(run: () => Promise<void>) {
  const loop = Object.create(AgentLoop.prototype) as AgentLoop;
  Object.assign(loop, {
    modelSelectionResolver: {},
    stateRestore: vi.fn(async () => undefined),
    autoCompact: { checkExpired: vi.fn() },
    busySessionKeysForAutoCompact: () => [],
    stateCompact: vi.fn(async () => undefined),
    stateCommand: vi.fn(async () => undefined),
    stateBuild: vi.fn(async () => undefined),
    stateRun: run,
    stateSave: vi.fn(async () => undefined),
    stateRespond: vi.fn(async () => undefined)
  });
  return loop;
}
const message = () => new InboundMessage({ channel: "websocket", senderId: "user", chatId: "test", content: "review" });

describe("whole Agent task activity", () => {
  it("stays busy while thinking, between plugin calls, and while waiting for user input", async () => {
    const thinking = deferred(), interaction = deferred(), finalStep = deferred();
    const phases: string[] = [];
    const loop = loopFixture(async () => {
      phases.push("thinking");
      await thinking.promise;
      phases.push("first-plugin-call-finished");
      await interaction.promise;
      phases.push("second-plugin-call-finished");
      await finalStep.promise;
    });
    const turn = loop.processMessageInternal(message());
    try {
      await vi.waitFor(() => expect(phases).toEqual(["thinking"]));
      expect(agentTaskActivity.busy).toBe(true);
      thinking.resolve();
      await vi.waitFor(() => expect(phases).toHaveLength(2));
      expect(agentTaskActivity.busy).toBe(true);
      interaction.resolve();
      await vi.waitFor(() => expect(phases).toHaveLength(3));
      expect(agentTaskActivity.busy).toBe(true);
    } finally {
      thinking.resolve(); interaction.resolve(); finalStep.resolve();
      await turn;
    }
    expect(agentTaskActivity.busy).toBe(false);
  });

  it.each(["error", "cancelled"])("clears activity after a task is %s", async reason => {
    const error = new Error(reason);
    if (reason === "cancelled") error.name = "TaskCancelledError";
    const loop = loopFixture(async () => { throw error; });
    Object.assign(loop, { settleCancelledGoalTurn: vi.fn(async () => undefined) });
    await expect(loop.processMessageInternal(message())).rejects.toThrow(reason);
    expect(agentTaskActivity.busy).toBe(false);
  });

  it("clears activity even if restoring the task fails before the run loop starts", async () => {
    const loop = loopFixture(async () => undefined);
    loop.stateRestore = vi.fn(async () => { throw new Error("restore failed"); });
    await expect(loop.processMessageInternal(message())).rejects.toThrow("restore failed");
    expect(agentTaskActivity.busy).toBe(false);
  });

  it("waits for other turns and subagents after one turn finishes", async () => {
    const one = deferred(), two = deferred(), child = deferred();
    const a = loopFixture(() => one.promise).processMessageInternal(message());
    const b = loopFixture(() => two.promise).processMessageInternal(message());
    const manager = Object.create(SubagentManager.prototype) as SubagentManager;
    Object.assign(manager, { runSubagentTask: () => child.promise });
    const c = manager.runSubagent("id", "task", "child", {}, new SubagentStatus({ label: "child" }));
    try {
      one.resolve(); await a;
      expect(agentTaskActivity.busy).toBe(true);
      two.resolve(); await b;
      expect(agentTaskActivity.busy).toBe(true);
    } finally {
      one.resolve(); two.resolve(); child.resolve();
      await Promise.all([a, b, c]);
    }
    expect(agentTaskActivity.busy).toBe(false);
  });

  it("tracks system follow-up turns as well as user turns", async () => {
    const finish = deferred();
    const loop = loopFixture(async () => undefined);
    loop.processSystemMessage = vi.fn(async () => { await finish.promise; return null; });
    const turn = loop.processMessageInternal(new InboundMessage({ channel: "system", senderId: "system", chatId: "test", content: "continue" }));
    expect(agentTaskActivity.busy).toBe(true);
    finish.resolve(); await turn;
    expect(agentTaskActivity.busy).toBe(false);
  });
});
