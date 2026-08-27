import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { MessageBus } from "../../../../src/core/runtime-messages/queue.js";
import { Config } from "../../../../src/config/schema.js";
import { GoalRuntime } from "../../../../src/core/agent-runtime/goal-runtime.js";
import { SubagentManager } from "../../../../src/core/agent-runtime/subagent.js";
import { RequestContext, ToolContext } from "../../../../src/core/agent-runtime/tools/context.js";
import { ExecSessionManager, ListExecSessionsTool, WriteStdinTool } from "../../../../src/core/agent-runtime/tools/exec-session.js";
import { CreateGoalTool, GetGoalTool, UpdateGoalTool } from "../../../../src/core/agent-runtime/tools/goal.js";
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

function makeGoalTools(root = tmpDir("memmy-goal-tools-"), bus = new MessageBus()) {
  const sessions = new SessionManager(root);
  sessions.getOrCreate("websocket:c1");
  const goalRuntime = new GoalRuntime({ sessions, bus });
  const create = new CreateGoalTool(goalRuntime);
  const get = new GetGoalTool(goalRuntime);
  const update = new UpdateGoalTool(goalRuntime);
  const context = new RequestContext({
    channel: "websocket",
    chatId: "c1",
    sessionKey: "websocket:c1",
    metadata: { turn_id: "turn-1" },
  });
  create.setContext(context);
  get.setContext(context);
  update.setContext(context);
  return { sessions, bus, goalRuntime, create, get, update };
}

describe("ToolLoader expanded registry", () => {
  it("loads the three core Goal tools", () => {
    const root = tmpDir("memmy-loader-");
    const sessions = new SessionManager(path.join(root, "sessions"));
    const ctx = new ToolContext({
      config: new Config().tools,
      workspace: root,
      bus: new MessageBus(),
      sessions,
      goalRuntime: new GoalRuntime({ sessions }),
      cronService: new CronService(path.join(root, "cron")),
      execSessionManager: new ExecSessionManager(),
      subagentManager: new SubagentManager(),
      timezone: "Asia/Shanghai",
    });
    const names = new Set(new ToolLoader({ workspace: root, ctx }).loadRegistry(ctx).toolNames);
    for (const name of ["create_goal", "get_goal", "update_goal"]) expect(names.has(name)).toBe(true);
    expect(names.has("long_task")).toBe(false);
    expect(names.has("complete_goal")).toBe(false);
  });

  it("keeps Goal tools out of the memory scope", () => {
    const root = tmpDir("memmy-loader-memory-");
    const ctx = new ToolContext({ config: new Config().tools, workspace: root });
    const registry = new ToolLoader({ workspace: root, ctx }).loadRegistry(ctx, { scope: "memory" });
    expect(new Set(registry.toolNames)).toEqual(new Set(["edit_file", "read_file", "write_file"]));
  });
});

describe("Goal model tools", () => {
  it("creates, queries, and completes a strict Goal", async () => {
    const { sessions, bus, create, get, update } = makeGoalTools();
    expect(await create.execute({ objective: "Implement Goal mode", token_budget: 2_000 })).toContain("Goal created.");
    expect(await get.execute()).toContain('"token_budget": 2000');
    expect(sessions.get("websocket:c1")?.metadata[GOAL_STATE_KEY]).toMatchObject({
      objective: "Implement Goal mode",
      status: "active",
      tokenBudget: 2_000,
    });
    expect((await bus.consumeOutbound()).metadata.goalState.status).toBe("active");
    expect(await update.execute({ status: "completed" })).toContain("Goal updated.");
    expect(sessions.get("websocket:c1")?.metadata[GOAL_STATE_KEY].status).toBe("completed");
  });

  it("rejects an unfinished replacement and invalid budget", async () => {
    const { create } = makeGoalTools();
    await create.execute({ objective: "First" });
    expect(await create.execute({ objective: "Second" })).toBe("Error: goal_unfinished");
    expect((await makeGoalTools().create.execute({ objective: "Bad", token_budget: 0 }))).toBe("Error: invalid_token_budget");
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
    const sessionId = initial.match(/session_id:\s*([0-9a-f]+)/)?.[1];
    expect(sessionId).toBeTruthy();
    expect(await list.execute()).toContain(sessionId);
    expect(await stdin.execute({ session_id: sessionId!, wait_for: "done", wait_timeout_ms: 3000 })).toContain("done");
  });
});
