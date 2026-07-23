import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { runCommand } from "../../Memory/src/cli/commands.js";
import { PROJECT_VERSION } from "../../Memory/src/cli/project-version.js";
import {
  API_ROUTES,
  DEFAULT_MEMMY_CONFIG,
  MemoryDb,
  MemoryService,
  type Embedder
} from "../../Memory/src/index.js";

const tempRoots: string[] = [];

afterEach(() => {
  for (const root of tempRoots.splice(0)) {
    rmSync(root, { recursive: true, force: true });
  }
});

describe("memory layer smoke plan", () => {
  it("stores, processes, reads, and recalls a turn through the real Memory service", async () => {
    const root = mkdtempSync(join(tmpdir(), "memmy-memory-smoke-"));
    tempRoots.push(root);
    const db = new MemoryDb({ path: join(root, "memory.sqlite") });
    const service = new MemoryService({
      db,
      mode: "dev",
      config: DEFAULT_MEMMY_CONFIG,
      embedder: createSmokeEmbedder()
    });
    const namespace = {
      source: "smoke-plan",
      profileId: "default",
      userId: "smoke-user"
    };

    try {
      expect(service.health([...API_ROUTES])).toMatchObject({
        ok: true,
        version: PROJECT_VERSION,
        storage: { backendId: "sqlite-local" }
      });

      const session = service.openSession({
        adapterId: "smoke-plan",
        requestId: "smoke-session-open",
        namespace
      });
      const completed = service.completeTurn("smoke-turn-1", {
        adapterId: "smoke-plan",
        requestId: "smoke-turn-complete",
        sessionId: session.sessionId,
        query: "How should the v1.0.2 release workflow be verified?",
        answer: "Run the release contracts and publish only after every attachment succeeds.",
        status: "succeeded"
      });

      expect(completed).toMatchObject({
        sessionId: session.sessionId,
        turnId: "smoke-turn-1",
        episodeId: expect.any(String),
        rawTurnId: expect.any(String),
        l1MemoryId: expect.any(String)
      });
      expect(completed.jobs.map((job) => job.jobType)).toContain("embedding");

      const worker = await service.runWorkerOnce(20, { namespace });
      expect(worker.failed).toBe(0);
      expect(worker.jobs.map((job) => job.jobType)).toContain("embedding");

      const detail = service.getMemory(completed.l1MemoryId, { namespace });
      expect(detail).toMatchObject({
        id: completed.l1MemoryId,
        kind: "trace",
        memoryLayer: "L1"
      });

      const recall = await service.search({
        namespace,
        query: "v1.0.2 release attachments",
        layers: ["L1"],
        includeInjectedContext: true
      });
      expect(recall.hits.map((hit) => hit.id)).toContain(completed.l1MemoryId);
      expect(recall.injectedContext.markdown).toContain("## L1 Trace Memories");
      expect(recall.injectedContext.markdown).not.toContain("# Memory context");
    } finally {
      db.close();
    }
  });

  it("maps the executable Memory CLI search command to the public REST contract", async () => {
    const requests: CapturedRequest[] = [];
    const result = await runCommand({
      argv: [
        "search",
        "release attachments",
        "--url",
        "https://memory.example.invalid",
        "--token",
        "test-token",
        "--session-id",
        "smoke-session",
        "--source",
        "memmy-agent",
        "--layers",
        "L1"
      ],
      fetch: captureFetch(requests, { hits: [], injectedContext: { markdown: "" } })
    });

    expect(API_ROUTES).toContain("POST /api/v1/memory/search");
    expect(result).toEqual({ hits: [], injectedContext: { markdown: "" } });
    expect(requests).toEqual([
      {
        method: "POST",
        path: "/api/v1/memory/search",
        authorization: "Bearer test-token",
        body: {
          query: "release attachments",
          sessionId: "smoke-session",
          layers: ["L1"],
          source: "memmy-agent"
        }
      }
    ]);
  });
});

interface CapturedRequest {
  method: string;
  path: string;
  authorization: string | null;
  body?: unknown;
}

function createSmokeEmbedder(): Embedder {
  return {
    config: {
      ...DEFAULT_MEMMY_CONFIG.embedding,
      provider: "local",
      model: "smoke-plan-embedding"
    },
    isRemote: () => false,
    async embed(texts: string[]) {
      return texts.map(() => [1, 0, 0]);
    },
    async embedOne() {
      return [1, 0, 0];
    },
    status() {
      return {
        provider: "local",
        model: "smoke-plan-embedding",
        configured: true,
        remote: false
      };
    }
  };
}

function captureFetch(requests: CapturedRequest[], responseBody: unknown): typeof fetch {
  return (async (input: string | URL | Request, init?: RequestInit) => {
    const rawUrl = input instanceof Request ? input.url : String(input);
    const headers = new Headers(init?.headers ?? (input instanceof Request ? input.headers : undefined));
    requests.push({
      method: init?.method ?? (input instanceof Request ? input.method : "GET"),
      path: new URL(rawUrl).pathname,
      authorization: headers.get("authorization"),
      body: typeof init?.body === "string" ? JSON.parse(init.body) as unknown : undefined
    });
    return new Response(JSON.stringify(responseBody), {
      status: 200,
      headers: { "content-type": "application/json" }
    });
  }) as typeof fetch;
}
