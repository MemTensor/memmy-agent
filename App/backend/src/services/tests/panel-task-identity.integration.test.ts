import type { Server } from "node:http";
import { afterEach, describe, expect, it } from "vitest";
import { createMemoryHttpServer } from "../../../../../Memory/src/index.js";
import { createMemoryServiceFixture } from "../../../../../Memory/tests/fixtures/memory-service-fixture.js";
import { createHttpMemoryClient } from "../../adapters/outbound/memory-client/http-memory-client.js";
import { createPanelService } from "../panel-service.js";

const { cleanup, createTestService } = createMemoryServiceFixture();
let server: Server | undefined;

afterEach(async () => {
  if (server) {
    await new Promise<void>((resolve, reject) => server!.close(error => error ? reject(error) : resolve()));
    server = undefined;
  }
  cleanup();
});

async function fixture() {
  const { service } = createTestService();
  const namespace = (userId: string) => ({ source: "cursor", profileId: "default", userId });
  server = createMemoryHttpServer({
    service,
    startAgentSourceAutomation: false,
    auth: {
      localServiceToken: "local-panel-token",
      scopedApiKeys: {
        "scoped-panel-token": { namespace: namespace("account-user"), scopes: ["panel:read"] }
      },
      cloudAccessTokens: { "cloud-panel-token": namespace("account-user") }
    }
  });
  await new Promise<void>(resolve => server!.listen(0, "127.0.0.1", resolve));
  const address = server.address();
  if (!address || typeof address === "string") throw new Error("expected TCP address");
  const endpoint = `http://127.0.0.1:${address.port}`;
  return {
    service,
    endpoint,
    addTask(userId: string, label: string) {
      const session = service.openSession({ namespace: namespace(userId) });
      return service.completeTurn(`turn-${label}`, {
        sessionId: session.sessionId,
        query: `issue 409 ${label}`,
        answer: `Completed ${label}`
      }).episodeId;
    },
    panel(token: string, getUserId: () => string) {
      return createPanelService({
        memoryClient: createHttpMemoryClient({ baseUrl: endpoint, token, timeoutMs: 5000, maxRetries: 0 }),
        getUserId
      });
    },
    async viewer(page: number) {
      const response = await fetch(`${endpoint}/api/v1/episodes?page=${page}`, { headers: { "x-memmy-viewer": "1" } });
      expect(response.status).toBe(200);
      return response.json() as Promise<{ tasks: Array<{ id: string }>; total: number }>;
    }
  };
}

// A caller's account identity must not become a filter for the machine's task dashboard.
const ctx = { adapterId: "runtime", userId: "stale-caller-user", timeZone: "+08:00" };

describe("desktop task identity / issue 409", () => {
  it("keeps local and account tasks visible across login, account switching and logout, matching the viewer", async () => {
    const f = await fixture();
    const localIds = Array.from({ length: 21 }, (_, i) => f.addTask("local-user", `local-task-${i}`));
    const accountId = f.addTask("account-user", "account-task");
    const previousAccountId = f.addTask("previous-account", "previous-task");
    const expectedIds = [...localIds, accountId, previousAccountId].sort();
    let currentUser = "local-user";
    const panel = f.panel("local-panel-token", () => currentUser);

    for (const userId of ["local-user", "account-user", "another-account", "local-user"]) {
      currentUser = userId;
      const first = await panel.tasks({ page: 1 }, ctx);
      const second = await panel.tasks({ page: 2 }, ctx);
      expect(first).toMatchObject({ total: 23, totalPages: 2, pageSize: 20, page: 1, hasNext: true, hasPrev: false });
      expect(second).toMatchObject({ total: 23, page: 2, hasNext: false, hasPrev: true });
      expect(first.tasks).toHaveLength(20);
      expect(second.tasks).toHaveLength(3);
      expect([...first.tasks, ...second.tasks].map(task => task.id).sort()).toEqual(expectedIds);
      for (const [page, desktop] of [[1, first], [2, second]] as const) {
        const viewer = await f.viewer(page);
        expect(desktop.tasks.map(task => task.id)).toEqual(viewer.tasks.map(task => task.id));
        expect(desktop.total).toBe(viewer.total);
      }
      const searched = await panel.tasks({ q: "local-task-20", page: 99 }, ctx);
      expect(searched).toMatchObject({ total: 1, page: 1, totalPages: 1 });
      expect(searched.tasks.map(task => task.id)).toEqual([localIds[20]]);
      expect(searched.tasks[0]?.turns).toEqual(expect.arrayContaining([
        expect.objectContaining({ userText: "issue 409 local-task-20", assistantText: "Completed local-task-20" })
      ]));
      expect(await panel.tasks({ q: "no-matching-task" }, ctx)).toMatchObject({ total: 0, tasks: [] });
    }

    // Displaying local data must not migrate the original task ownership.
    for (const [userId, total] of [["local-user", 21], ["account-user", 1], ["previous-account", 1]] as const) {
      expect(f.service.panelTasks({ namespace: { userId } }).total).toBe(total);
    }
  });

  it("preserves Memory service authentication and token-bound user scopes", async () => {
    const f = await fixture();
    const localId = f.addTask("local-user", "local-scope-task");
    const accountId = f.addTask("account-user", "account-scope-task");
    for (const token of ["scoped-panel-token", "cloud-panel-token"]) {
      const panel = f.panel(token, () => "account-user");
      const result = await panel.tasks({}, ctx);
      expect(result.total).toBe(1);
      expect(result.tasks.map(task => task.id)).toEqual([accountId]);
      if (token === "scoped-panel-token") {
        await expect(panel.deleteTask(localId, ctx)).rejects.toMatchObject({ code: "forbidden" });
      }
    }
    await expect(f.panel("invalid-token", () => "account-user").tasks({}, ctx))
      .rejects.toMatchObject({ code: "unauthorized" });
  });
});
