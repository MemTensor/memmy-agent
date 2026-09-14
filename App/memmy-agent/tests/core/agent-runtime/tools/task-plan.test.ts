import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { Config } from "../../../../src/config/schema.js";
import { TaskPlanRuntime } from "../../../../src/core/agent-runtime/task-plan-runtime.js";
import { MessageBus } from "../../../../src/core/runtime-messages/queue.js";
import { SessionManager } from "../../../../src/core/session/manager.js";
import { RequestContext, ToolContext } from "../../../../src/core/agent-runtime/tools/context.js";
import { ToolLoader } from "../../../../src/core/agent-runtime/tools/loader.js";
import {
  CreateTaskPlanTool,
  GetTaskPlanTool,
  UpdateTaskPlanTool,
} from "../../../../src/core/agent-runtime/tools/task-plan.js";

function tmpDir(): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), "memmy-task-plan-tools-"));
}

function makeTools() {
  const root = tmpDir();
  const sessions = new SessionManager(root);
  sessions.getOrCreate("websocket:c1");
  const runtime = new TaskPlanRuntime({ sessions, bus: new MessageBus() });
  const create = new CreateTaskPlanTool(runtime);
  const get = new GetTaskPlanTool(runtime);
  const update = new UpdateTaskPlanTool(runtime);
  const context = new RequestContext({
    channel: "websocket",
    chatId: "c1",
    sessionKey: "websocket:c1",
  });
  create.setContext(context);
  get.setContext(context);
  update.setContext(context);
  return { create, get, update };
}

describe("Task Plan model tools", () => {
  it("creates, queries, and completes the persisted checklist", async () => {
    const { create, get, update } = makeTools();
    expect(await create.execute({
      title: "Generate review",
      items: [
        { id: "evidence", content: "Map evidence" },
        { id: "write", content: "Generate sections" },
        { id: "verify", content: "Audit and render the review" },
      ],
    })).toContain("Task plan created.");
    expect(await get.execute()).toContain('"id": "evidence"');
    expect(await update.execute({ item_id: "evidence", status: "in_progress" }))
      .toContain('"status": "in_progress"');
    await update.execute({ item_id: "evidence", status: "completed" });
    await update.execute({ item_id: "write", status: "completed" });
    expect(await update.execute({ item_id: "verify", status: "completed" }))
      .toContain('"status": "completed"');
  });

  it("registers all three tools only when TaskPlanRuntime is available", () => {
    const root = tmpDir();
    const sessions = new SessionManager(path.join(root, "sessions"));
    const runtime = new TaskPlanRuntime({ sessions });
    const withRuntime = new ToolContext({
      config: new Config().tools,
      workspace: root,
      sessions,
      taskPlanRuntime: runtime,
    });
    const names = new Set(
      new ToolLoader({ workspace: root, ctx: withRuntime }).loadRegistry(withRuntime).toolNames,
    );
    for (const name of ["create_task_plan", "get_task_plan", "update_task_plan"]) {
      expect(names.has(name)).toBe(true);
    }

    const withoutRuntime = new ToolContext({
      config: new Config().tools,
      workspace: root,
      sessions,
    });
    const namesWithoutRuntime = new Set(
      new ToolLoader({ workspace: root, ctx: withoutRuntime })
        .loadRegistry(withoutRuntime).toolNames,
    );
    for (const name of ["create_task_plan", "get_task_plan", "update_task_plan"]) {
      expect(namesWithoutRuntime.has(name)).toBe(false);
    }
  });
});
