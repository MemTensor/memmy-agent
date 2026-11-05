import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";
import {
  TaskPlanRuntime,
  type TaskPlanItemInput,
} from "../../../src/core/agent-runtime/task-plan-runtime.js";
import { MessageBus } from "../../../src/core/runtime-messages/queue.js";
import {
  TASK_PLAN_STATE_KEY,
  readTaskPlanState,
} from "../../../src/core/session/task-plan-state.js";
import { SessionManager } from "../../../src/core/session/manager.js";

const SESSION_KEY = "websocket:task-plan";
const ROUTE = { channel: "websocket", chatId: "task-plan" } as const;
const ITEMS: TaskPlanItemInput[] = [
  { id: "inspect", content: "Inspect the current implementation" },
  { id: "implement", content: "Implement the change" },
  { id: "verify", content: "Verify the completed change" },
];

function createRuntime() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "memmy-task-plan-runtime-"));
  const sessions = new SessionManager(root);
  sessions.getOrCreate(SESSION_KEY);
  const bus = new MessageBus();
  const runtime = new TaskPlanRuntime({ sessions, bus });
  return { sessions, bus, runtime };
}

describe("TaskPlanRuntime", () => {
  it("persists item progress, derives plan status, and broadcasts each update", async () => {
    const { sessions, bus, runtime } = createRuntime();
    const created = await runtime.create({
      sessionKey: SESSION_KEY,
      title: "Ship Task Plan",
      items: ITEMS,
      route: ROUTE,
    });
    expect(created).toMatchObject({
      title: "Ship Task Plan",
      status: "active",
      items: [
        { id: "inspect", status: "pending" },
        { id: "implement", status: "pending" },
        { id: "verify", status: "pending" },
      ],
    });
    await runtime.flushEffects(SESSION_KEY);
    const broadcast = (await bus.consumeOutbound()).metadata.taskPlanState;
    expect(broadcast.status).toBe("active");
    expect(broadcast.items[0]).toMatchObject({ id: "inspect", status: "pending" });

    await runtime.updateItem(SESSION_KEY, "inspect", "in_progress");
    await runtime.updateItem(SESSION_KEY, "inspect", "completed");
    await runtime.updateItem(SESSION_KEY, "implement", "in_progress");
    await runtime.updateItem(SESSION_KEY, "implement", "completed");
    await runtime.updateItem(SESSION_KEY, "verify", "in_progress");
    const completed = await runtime.updateItem(SESSION_KEY, "verify", "completed");
    expect(completed.status).toBe("completed");
    expect(readTaskPlanState(sessions.get(SESSION_KEY)?.metadata)?.items)
      .toEqual(completed.items);
    expect(sessions.get(SESSION_KEY)?.metadata[TASK_PLAN_STATE_KEY])
      .toMatchObject({ status: "completed" });
  });

  it("allows only one in-progress item and blocks replacing an active plan", async () => {
    const { runtime } = createRuntime();
    await runtime.create({
      sessionKey: SESSION_KEY,
      title: "First plan",
      items: ITEMS,
      route: ROUTE,
    });
    await runtime.updateItem(SESSION_KEY, "inspect", "in_progress");
    await expect(runtime.updateItem(SESSION_KEY, "implement", "in_progress"))
      .rejects.toMatchObject({ code: "task_plan_item_already_in_progress" });
    await expect(runtime.create({
      sessionKey: SESSION_KEY,
      title: "Replacement",
      items: ITEMS,
      route: ROUTE,
    })).rejects.toMatchObject({ code: "task_plan_already_active" });
  });

  it("recovers a blocked item and permits a new plan after completion", async () => {
    const { runtime } = createRuntime();
    await runtime.create({
      sessionKey: SESSION_KEY,
      title: "Recoverable plan",
      items: ITEMS,
      route: ROUTE,
    });
    expect((await runtime.updateItem(SESSION_KEY, "inspect", "blocked")).status)
      .toBe("blocked");
    expect((await runtime.updateItem(SESSION_KEY, "inspect", "in_progress")).status)
      .toBe("active");
    await runtime.updateItem(SESSION_KEY, "inspect", "completed");
    await runtime.updateItem(SESSION_KEY, "implement", "completed");
    await runtime.updateItem(SESSION_KEY, "verify", "completed");
    await expect(runtime.create({
      sessionKey: SESSION_KEY,
      title: "Next plan",
      items: ITEMS,
      route: ROUTE,
    })).resolves.toMatchObject({ title: "Next plan", status: "active" });
  });
});
