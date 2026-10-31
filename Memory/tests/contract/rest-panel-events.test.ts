import { LEGACY_TEST_CONFIG } from "../fixtures/memory-service-fixture.js";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it, vi } from "vitest";
import {
  createMemoryHttpServer,
  type Embedder,
  MemoryDb,
  MemoryRestClient,
  MemoryService
} from "../../src/index.js";

describe("REST panel contract", () => {
  it("serves the minimal panel endpoints", async () => {
    const root = mkdtempSync(join(tmpdir(), "mindock-rest-contract-"));
    const db = new MemoryDb({ path: join(root, "memory.sqlite") });
    const service = new MemoryService({
      db,
      config: LEGACY_TEST_CONFIG,
      mode: "dev",
      embedder: createTestEmbedder(),
      fetchAppMemoryBudget: async () => null
    });
    const server = createMemoryHttpServer({
      service,
      auth: {
        localServiceToken: "panel-token"
      }
    });

    try {
      await new Promise<void>((resolve) => {
        server.listen(0, "127.0.0.1", resolve);
      });
      const address = server.address();
      if (!address || typeof address === "string") {
        throw new Error("expected TCP address");
      }
      const endpoint = `http://127.0.0.1:${address.port}`;
      const client = new MemoryRestClient({
        endpoint,
        token: "panel-token"
      });
      const statsHeaders = {authorization: "Bearer panel-token", "x-memmy-time-zone": "+08:00", "x-memmy-user-id": "local-user"};
      const warmOverview = vi.spyOn(service, "panelOverviewStatsSnapshot");
      const warmAnalysis = vi.spyOn(service, "panelStatsSnapshot");
      expect((await fetch(`${endpoint}/api/v1/health`)).status).toBe(200);
      expect((await fetch(`${endpoint}/api/v1/health`, {headers: {...statsHeaders, authorization: "Bearer invalid"}})).status).toBe(200);
      expect(warmOverview).not.toHaveBeenCalled();
      expect(warmAnalysis).not.toHaveBeenCalled();
      await fetch(`${endpoint}/api/v1/health`, {headers: statsHeaders});
      expect(warmOverview).not.toHaveBeenCalled();
      expect(warmAnalysis).not.toHaveBeenCalled();
      service.startPanelWarmup();
      await vi.waitFor(() => expect(warmAnalysis).toHaveBeenCalledExactlyOnceWith({},true));
      let overviewStats;
      await vi.waitFor(async () => {
        const response = await fetch(`${endpoint}/api/v1/panel/overview-stats`, {headers: statsHeaders});
        expect(response.status).toBe(200);
        overviewStats = await response.json() as {status: string; data?: unknown; generatedAt?: string};
        expect(overviewStats.status).toBe("ready");
      });
      expect(overviewStats).toHaveProperty("generatedAt");
      expect(overviewStats).toHaveProperty("data.counts.memories", 0);
      expect(overviewStats).not.toHaveProperty("data.analysis");
      expect((await fetch(`${endpoint}/api/v1/panel/overview-stats`)).status).toBe(401);
      const viewerResponse = await fetch(`${endpoint}/viewer`);
      const viewerHtml = await viewerResponse.text();
      expect(viewerResponse.status).toBe(200);
      expect(viewerResponse.headers.get("content-type")).toContain("text/html");
      expect(viewerHtml).toContain("<title>Memmy Memory — Memory Viewer</title>");
      expect(viewerHtml).toContain("/viewer/assets/");
      const viewerScript = viewerHtml.match(/src="([^"]+\.js)"/)?.[1];
      expect(viewerScript).toBeTruthy();
      const viewerBundle = await (await fetch(`${endpoint}${viewerScript}`)).text();
      expect(viewerBundle).toContain("/api/v1/traces");
      expect(viewerBundle).toContain("/api/v1/events");

      const session = await client.openSession({
        adapterId: "contract",
        requestId: "session",
        sessionId: "contract-session",
        source: "openclaw"
      }) as { sessionId: string };
      const completed = await client.completeTurn("turn-contract", {
        adapterId: "contract",
        requestId: "turn",
        sessionId: session.sessionId,
        query: "check panel items",
        answer: "panel items are backed by memory rows",
        source: "openclaw"
      }) as { l1MemoryId: string; changeSeq: number };
      expect(completed.changeSeq).toBeGreaterThan(0);
      const workerResponse = await fetch(`${endpoint}/api/v1/worker/run`, {
        method: "POST",
        headers: {
          authorization: "Bearer panel-token",
          "content-type": "application/json"
        },
        body: JSON.stringify({ limit: 20 })
      });
      expect(workerResponse.status).toBe(200);

      const search = await client.search({
        query: "panel items",
        sessionId: session.sessionId,
        source: "openclaw"
      }) as { injectedContext: string };
      expect(search.injectedContext).toContain(completed.l1MemoryId);
      const overview = await client.panelOverview() as { counts: { memories: number } };
      expect(overview.counts.memories).toBeGreaterThan(0);
      const items = await client.panelItems({ layer: "L1" }) as { items: Array<{ id: string; metadata?: { source?: string } }> };
      expect(items.items.map((item) => item.id)).toContain(completed.l1MemoryId);
      expect(items.items.find((item) => item.id === completed.l1MemoryId)?.metadata?.source).toBe("openclaw");
      const detail = await client.getMemory(completed.l1MemoryId) as { item: { id: string } };
      expect(detail.item.id).toBe(completed.l1MemoryId);
      const deleted = await client.deleteMemory(completed.l1MemoryId) as {
        ok: boolean;
        id: string;
        kind: string;
        status: string;
        changeSeq: number;
        syncCursor: string;
        auditId: string;
        serverTime: string;
      };
      expect(deleted).toMatchObject({
        ok: true,
        id: completed.l1MemoryId,
        kind: "trace",
        status: "deleted"
      });
      expect(deleted.changeSeq).toBeGreaterThan(completed.changeSeq);
      expect(deleted.syncCursor).toMatch(/^cur_/);
      expect(deleted.auditId).toMatch(/^audit_/);
      expect(Date.parse(deleted.serverTime)).not.toBeNaN();
    } finally {
      await new Promise<void>((resolve) => server.close(() => resolve()));
      await service.stop();
      db.close();
      rmSync(root, { recursive: true, force: true });
    }
  });
});

function createTestEmbedder(): Embedder {
  return {
    config: {
      provider: "local",
      mode: "local",
      model: "rest-contract-test-embedding",
      batchSize: 32,
      timeoutMs: 60_000,
      maxRetries: 0,
      cache: false,
      normalize: false
    },
    isRemote() {
      return false;
    },
    async embed(texts: string[]) {
      return texts.map(() => [1, 0, 0]);
    },
    async embedOne() {
      return [1, 0, 0];
    },
    status() {
      return {
        provider: "local",
        model: "rest-contract-test-embedding",
        configured: true,
        remote: false
      };
    }
  };
}
