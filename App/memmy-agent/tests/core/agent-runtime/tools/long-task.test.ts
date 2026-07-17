import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { describe, expect, it, vi } from "vitest";
import { MessageBus } from "../../../../src/core/runtime-messages/queue.js";
import { Config } from "../../../../src/config/schema.js";
import { SubagentManager } from "../../../../src/core/agent-runtime/subagent.js";
import { RequestContext, ToolContext } from "../../../../src/core/agent-runtime/tools/context.js";
import { ExecSessionManager, ListExecSessionsTool, WriteStdinTool } from "../../../../src/core/agent-runtime/tools/exec-session.js";
import { CompleteGoalTool, LongTaskTool } from "../../../../src/core/agent-runtime/tools/long-task.js";
import { ToolLoader } from "../../../../src/core/agent-runtime/tools/loader.js";
import { ExecTool } from "../../../../src/core/agent-runtime/tools/shell.js";
import { CronService } from "../../../../src/cron/service.js";
import { GOAL_STATE_KEY } from "../../../../src/core/session/goal-state.js";
import { SessionManager } from "../../../../src/core/session/manager.js";

function tmpDir(prefix: string): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), prefix));
}

function nodeCommand(code: string): string {
  return `${JSON.stringify(process.execPath)} -e ${JSON.stringify(code)}`;
}

function makeGoalTools(root = tmpDir("memmy-goal-tools-"), bus: any = null) {
  const sessions = new SessionManager(root);
  const longTask = new LongTaskTool({ sessions, bus });
  const completeGoal = new CompleteGoalTool({ sessions, bus });
  const ctx = new RequestContext({
    channel: "websocket",
    chatId: "c1",
    sessionKey: "websocket:c1",
    metadata: {},
  });
  longTask.setContext(ctx);
  completeGoal.setContext(ctx);
  return { sessions, longTask, completeGoal, ctx };
}

describe("ToolLoader expanded registry", () => {
  it("loads context-aware core tools and excludes disabled/generated wrappers", () => {
    const root = tmpDir("memmy-loader-");
    const ctx = new ToolContext({
      config: new Config().tools,
      workspace: root,
      bus: new MessageBus(),
      sessions: new SessionManager(path.join(root, "sessions")),
      cronService: new CronService(path.join(root, "cron")),
      execSessionManager: new ExecSessionManager(),
      subagentManager: new SubagentManager(),
      timezone: "Asia/Shanghai",
    });

    const registry = new ToolLoader({ workspace: root, ctx }).loadRegistry(ctx);
    const names = new Set(registry.toolNames);

    for (const name of [
      "apply_patch",
      "complete_goal",
      "cron",
      "edit_file",
      "exec",
      "find_files",
      "grep",
      "list_dir",
      "list_exec_sessions",
      "long_task",
      "message",
      "read_file",
      "spawn",
      "web_fetch",
      "web_search",
      "write_file",
      "write_stdin",
    ]) {
      expect(names.has(name), `missing ${name}`).toBe(true);
    }
    expect(names.has("image_generation")).toBe(false);
    expect(names.has("mcp_tool")).toBe(false);
  });

  it("filters memory scope to file mutation/read tools", () => {
    const root = tmpDir("memmy-loader-memory-");
    const ctx = new ToolContext({ config: new Config().tools, workspace: root });
    const registry = new ToolLoader({ workspace: root, ctx }).loadRegistry(ctx, { scope: "memory" });

    expect(new Set(registry.toolNames)).toEqual(new Set(["edit_file", "read_file", "write_file"]));
  });
});

describe("long_task and complete_goal", () => {
  it("records goal metadata on the active session", async () => {
    const { sessions, longTask } = makeGoalTools();

    const out = await longTask.execute({ goal: "Do the thing", uiSummary: "thing" });

    expect(out).toContain("Goal recorded");
    const blob = sessions.getOrCreate("websocket:c1").metadata[GOAL_STATE_KEY];
    expect(blob).toMatchObject({
      status: "active",
      objective: "Do the thing",
      uiSummary: "thing",
    });
  });

  it("publishes websocket goal state after saving a long task", async () => {
    const bus = { publishOutbound: vi.fn(async () => undefined) };
    const { longTask, ctx } = makeGoalTools(tmpDir("memmy-goal-publish-"), bus);
    ctx.chatId = "chat-99";
    ctx.sessionKey = "websocket:chat-99";

    await longTask.execute({ goal: "Objective alpha", uiSummary: "alpha" });

    expect(bus.publishOutbound).toHaveBeenCalledTimes(1);
    const call = (bus.publishOutbound.mock.calls[0] as any[])[0];
    expect(call.channel).toBe("websocket");
    expect(call.chatId).toBe("chat-99");
    expect(call.metadata.goalStateSync).toBe(true);
    expect(call.metadata.goalState).toEqual({
      active: true,
      objective: "Objective alpha",
      ui_summary: "alpha",
    });
  });

  it("reports no active goal when complete_goal has nothing to close", async () => {
    const { completeGoal } = makeGoalTools();

    await expect(completeGoal.execute({ recap: "n/a" })).resolves.toContain("No active");
  });

  it("skips websocket publishing when no bus is configured", async () => {
    const { longTask } = makeGoalTools();

    await expect(longTask.execute({ goal: "Solo", uiSummary: "s" })).resolves.toContain("Goal recorded");
  });

  it("requires an active chat session for long_task", async () => {
    const root = tmpDir("memmy-goal-no-context-");
    const longTask = new LongTaskTool({ sessions: new SessionManager(root) });

    await expect(longTask.execute({ goal: "Detached" })).resolves.toContain("requires an active chat session");
  });

  it("persists active/completed goal state and publishes websocket snapshots", async () => {
    const root = tmpDir("memmy-goal-tool-");
    const sessions = new SessionManager(root);
    const bus = new MessageBus();
    const ctx = new RequestContext({
      channel: "websocket",
      chatId: "chat-1",
      sessionKey: "websocket:chat-1",
      metadata: {},
    });
    const longTask = new LongTaskTool({ sessions, bus });
    const completeGoal = new CompleteGoalTool({ sessions, bus });
    longTask.setContext(ctx);
    completeGoal.setContext(ctx);

    const started = await longTask.execute({ goal: "Refactor the agent", uiSummary: "refactor" });
    expect(started).toContain("Goal recorded");
    let session = sessions.getOrCreate("websocket:chat-1");
    expect(session.metadata[GOAL_STATE_KEY]).toMatchObject({
      status: "active",
      objective: "Refactor the agent",
      uiSummary: "refactor",
    });
    expect((await bus.consumeOutbound()).metadata.goalState).toEqual({
      active: true,
      objective: "Refactor the agent",
      ui_summary: "refactor",
    });

    expect(await longTask.execute({ goal: "Second" })).toContain("already active");
    const ended = await completeGoal.execute({ recap: "Done." });
    expect(ended).toContain("Goal marked complete");
    session = sessions.getOrCreate("websocket:chat-1");
    expect(session.metadata[GOAL_STATE_KEY]).toMatchObject({ status: "completed", recap: "Done." });
    expect((await bus.consumeOutbound()).metadata.goalState).toEqual({ active: false });
  });
});

describe("exec session tools", () => {
  it("shares long-running exec sessions across exec, list, and write_stdin", async () => {
    const root = tmpDir("memmy-exec-session-");
    const manager = new ExecSessionManager();
    const exec = new ExecTool({ workspace: root, sessionManager: manager });
    const stdin = new WriteStdinTool({ manager });
    const list = new ListExecSessionsTool({ manager });

    const initial = await exec.execute({
      command: nodeCommand("console.log('ready'); setTimeout(() => console.log('done'), 500);"),
      yield_time_ms: 100,
      timeout_s: 5,
    });
    const match = initial.match(/session_id:\s*([0-9a-f]+)/);
    expect(match?.[1]).toBeTruthy();
    const sessionId = match![1];

    const listing = await list.execute();
    expect(listing).toContain(sessionId);
    expect(listing).toContain("running");

    const final = await stdin.execute({ session_id: sessionId, wait_for: "done", wait_timeout_ms: 3000 });
    expect(final).toContain("done");
    expect(final).toContain("Exit code: 0");
  });
});
