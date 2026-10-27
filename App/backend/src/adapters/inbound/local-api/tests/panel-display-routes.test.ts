import Fastify, { type FastifyInstance } from "fastify";
import { afterEach, describe, expect, it, vi } from "vitest";
import { registerPanelRoutes } from "../routes/agent-runtime/panel.js";
import type { AgentRuntimeRouteDeps } from "../routes/agent-runtime/index.js";
import { createPanelService } from "../../../../services/panel-service.js";
type MemoryClient = Parameters<typeof createPanelService>[0]["memoryClient"];
let app: FastifyInstance;
afterEach(async () => {
  await app?.close();
});
describe("panel display contracts", () => {
  it("forwards tool identifiers, snapshot filters and log cursors behind authentication", async () => {
    const calls: unknown[][] = [];
    const panel = Object.fromEntries(
      ["taskField", "browse", "logs", "taskDetail", "stats"].map((name) => [
        name,
        async (...args: unknown[]) => {
          calls.push([name, ...args]);
          return { ok: true };
        }
      ])
    );
    app = Fastify();
    registerPanelRoutes(app, {
      services: { panel },
      authenticateRuntimeToken: async (req, reply) => {
        if (req.headers.authorization !== "Bearer test") return reply.code(401).send({ error: "unauthorized" });
      }
    } as unknown as AgentRuntimeRouteDeps);
    const query = "field=toolCalls&toolId=stable-tool&offset=4096&revision=hash";
    const response = await app.inject({
      method: "GET",
      url: `/api/v1/panel/task-details/task/turns/raw/field?${query}`,
      headers: { authorization: "Bearer test" }
    });
    expect(response.statusCode).toBe(200);
    expect(calls[0]?.slice(0, 4)).toMatchObject([
      "taskField",
      "task",
      "raw",
      { field: "toolCalls", toolId: "stable-tool", offset: 4096, revision: "hash" }
    ]);
    await app.inject({
      method: "POST",
      url: "/api/v1/panel/browse",
      headers: { authorization: "Bearer test" },
      payload: { op: "page", viewId: "view", page: 2, filter: { section: "tasks", q: "old" } }
    });
    expect(calls[1]?.[1]).toEqual({ op: "page", viewId: "view", page: 2, filter: { section: "tasks", q: "old" } });
    await app.inject({
      method: "POST",
      url: "/api/v1/panel/logs",
      headers: { authorization: "Bearer test" },
      payload: { skillId: "skill", cursor: "earlier", q: "full text" }
    });
    expect(calls[2]?.[1]).toEqual({ skillId: "skill", cursor: "earlier", q: "full text" });
    for (const url of ["/api/v1/panel/stats", `/api/v1/panel/task-details/task/turns/raw/field?${query}`])
      expect((await app.inject({ method: "GET", url })).statusCode).toBe(401);
  });
  it("keeps device task scope and resolves the live account for personal views", async () => {
    const panelBrowse = vi.fn(async (..._args: unknown[]) => ({ ok: true as const }));
    const panelTaskField = vi.fn(async (..._args: unknown[]) => ({
      text: "x",
      revision: "r",
      serverTime: new Date().toISOString()
    }));
    let account = "account-a";
    const panel = createPanelService({
      memoryClient: { panelBrowse, panelTaskField } as unknown as MemoryClient,
      getUserId: () => account
    });
    const ctx = { adapterId: "runtime", userId: "stale" };
    await panel.browse({ op: "create", filter: { section: "tasks" } }, ctx);
    expect(panelBrowse.mock.calls[0]?.[1]).toMatchObject({ userId: undefined });
    account = "account-b";
    await panel.browse({ op: "create", filter: { section: "items", layer: "UserMemory" } }, ctx);
    expect(panelBrowse.mock.calls[1]?.[1]).toMatchObject({ userId: "account-b" });
    await panel.taskField("task", "turn", { field: "toolCalls", toolId: "tool", offset: 5 }, ctx);
    expect(panelTaskField.mock.calls[0]).toMatchObject([
      "task",
      "turn",
      { toolId: "tool", offset: 5 },
      { userId: undefined }
    ]);
  });
});
