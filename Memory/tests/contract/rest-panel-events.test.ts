import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
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
    const service = new MemoryService({ db, mode: "dev", embedder: createTestEmbedder() });
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
      const viewerResponse = await fetch(`${endpoint}/viewer`);
      const viewerHtml = await viewerResponse.text();
      expect(viewerResponse.status).toBe(200);
      expect(viewerResponse.headers.get("content-type")).toContain("text/html");
      expect(viewerHtml).toContain("Memmy Memory Panel");
      expect(viewerHtml).toContain("/api/v1/panel/items");
      expect(viewerHtml).toContain("/api/v1/memory/");
      expect(viewerHtml).not.toContain("EventSource");

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
      db.close();
      rmSync(root, { recursive: true, force: true });
    }
  });
});

function createTestEmbedder(): Embedder {
  return {
    config: {
      provider: "local",
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
