import { existsSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { runCommand } from "../../Memory/src/cli/commands.js";
import { PROJECT_VERSION } from "../../Memory/src/cli/project-version.js";
import {
  API_ROUTES,
  DEFAULT_MEMMY_CONFIG,
  MemoryDb,
  MemoryService,
  type Embedder,
  type JobRef,
  type LlmClient,
  type LlmMessage,
  type LlmCompletionOptions
} from "../../Memory/src/index.js";
import { Repositories } from "../../Memory/src/storage/repositories.js";

const tempRoots: string[] = [];

afterEach(() => {
  vi.restoreAllMocks();
  for (const root of tempRoots.splice(0)) {
    rmSync(root, { recursive: true, force: true });
  }
});

describe("memory layer smoke plan", () => {
  it("keeps the executable Memory smoke entrypoint wired into the repository", () => {
    const repoRoot = resolve(import.meta.dirname, "../..");
    const manifest = JSON.parse(readFileSync(join(repoRoot, "package.json"), "utf8")) as {
      scripts: Record<string, string>;
    };

    expect(existsSync(join(repoRoot, "tests/smoke/tsconfig.json"))).toBe(true);
    expect(existsSync(join(repoRoot, "tests/smoke/memory-layer-smoke.ts"))).toBe(true);
    expect(manifest.scripts["smoke:memory-layer:typecheck"])
      .toBe("tsc -p tests/smoke/tsconfig.json --noEmit");
    expect(manifest.scripts["smoke:memory-layer"])
      .toContain("npm run smoke:memory-layer:test");
    expect(manifest.scripts["smoke:memory-layer:test"])
      .toContain("tests/smoke/async-capture-http.test.ts");
    expect(manifest.scripts["smoke:memory-layer"])
      .toContain("tsx tests/smoke/memory-layer-smoke.ts");
  });

  it.each([[1, false], [1, true], [20, false], [20, true]] as const)("stores, processes, reads, and recalls a verified turn with budget %i, turnJudge=%s", async (workerBudget, turnJudge) => {
    const root = mkdtempSync(join(tmpdir(), "memmy-memory-smoke-"));
    tempRoots.push(root);
    const db = new MemoryDb({ path: join(root, "memory.sqlite") });
    const repos = new Repositories(db.db);
    let judgeCalls = 0;
    const llm = createSmokeSummaryLlm(() => { judgeCalls++; });
    const embedder = createSmokeEmbedder();
    const modelCalls = [
      vi.spyOn(llm, "complete"),
      vi.spyOn(llm, "completeJson"),
      vi.spyOn(embedder, "embed"),
      vi.spyOn(embedder, "embedOne")
    ];
    const service = new MemoryService({
      db,
      mode: "dev",
      config: { ...DEFAULT_MEMMY_CONFIG, algorithm: { ...DEFAULT_MEMMY_CONFIG.algorithm, session: { ...DEFAULT_MEMMY_CONFIG.algorithm.session, turnJudge } } },
      llm,
      embedder,
      fetchAppMemoryBudget: async () => null
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
      const completed = await service.completeTurn("smoke-turn-1", {
        adapterId: "smoke-plan",
        requestId: "smoke-turn-complete",
        sessionId: session.sessionId,
        query: "How should the v1.0.2 release workflow be verified?",
        answer: "Run the release contracts and publish only after every attachment succeeds.",
        toolCalls: [{
          id: "smoke-release-contracts",
          name: "verify_release_contracts",
          input: { version: "v1.0.2" }
        }],
        toolResults: [{
          toolCallId: "smoke-release-contracts",
          output: { attachmentsVerified: true }
        }],
        status: "succeeded"
      });

      expect(completed).toMatchObject({
        sessionId: session.sessionId,
        turnId: "smoke-turn-1",
        assignmentStatus: "pending",
        rawTurnId: expect.any(String),
        l1MemoryId: expect.any(String)
      });
      expect(completed.episodeId).toBeUndefined();
      expect(db.db.prepare("SELECT user_text, assistant_text FROM raw_turns WHERE id=?").get(completed.rawTurnId))
        .toMatchObject({ user_text: "How should the v1.0.2 release workflow be verified?", assistant_text: "Run the release contracts and publish only after every attachment succeeds." });
      expect(completed.jobs.map((job) => job.jobType)).toContain("trace_summary");

      // Continuous refill may process the summary and its embedding in one call.
      // Collect bounded rounds so this smoke contract also holds with a small budget.
      const processedJobs: JobRef[] = [];
      let drained = false;
      for (let round = 0; round < 20; round += 1) {
        const worker = await service.runWorkerOnce(workerBudget, { namespace });
        expect(worker.failed).toBe(0);
        expect(worker.embeddingRetries.failed).toBe(0);
        expect(worker.succeeded).toBe(worker.leased);
        processedJobs.push(...worker.jobs);
        if (worker.leased === 0 && worker.embeddingRetries.leased === 0) {
          drained = true;
          break;
        }
      }
      expect(drained, "Smoke jobs must finish within the bounded worker rounds").toBe(true);
      for (const jobType of ["trace_summary", "embedding"] as const) {
        const jobs = processedJobs.filter((job) =>
          job.jobType === jobType && job.targetMemoryId === completed.l1MemoryId
        );
        expect(jobs).toHaveLength(1);
        expect(jobs[0]?.status).toBe("succeeded");
      }
      expect(new Set(processedJobs.map((job) => job.jobId)).size).toBe(processedJobs.length);
      expect(repos.memories.hasVector(completed.l1MemoryId, "vec_summary")).toBe(true);
      expect(repos.processing.get(completed.l1MemoryId)).toMatchObject({ state: "ready" });

      const callsAfterProcessing = modelCalls.map((spy) => spy.mock.calls.length);
      for (let round = 0; round < 2; round += 1) {
        const idleWorker = await service.runWorkerOnce(workerBudget, { namespace });
        expect(idleWorker).toMatchObject({
          leased: 0, succeeded: 0, failed: 0, jobs: [],
          embeddingRetries: { leased: 0, succeeded: 0, failed: 0, items: [] }
        });
      }
      expect(modelCalls.map((spy) => spy.mock.calls.length)).toEqual(callsAfterProcessing);

      for (let attempt = 0; attempt < 8; attempt++) {
        const raw = db.db.prepare("SELECT episode_id FROM raw_turns WHERE id=?").get(completed.rawTurnId) as { episode_id: string | null };
        if (raw.episode_id) break;
        const run = await service.runWorkerOnce(20, { namespace });
        expect(run.failed).toBe(0);
      }
      expect(db.db.prepare("SELECT episode_id FROM raw_turns WHERE id=?").get(completed.rawTurnId)).toMatchObject({ episode_id: expect.any(String) });
      expect(judgeCalls).toBe(turnJudge ? 1 : 0);
      expect(db.db.prepare("SELECT job_type,status FROM evolution_jobs WHERE target_memory_id=? AND job_type IN ('trace_summary','embedding') ORDER BY job_type").all(completed.l1MemoryId))
        .toEqual(["embedding", "trace_summary"].map(job_type => ({ job_type, status: "succeeded" })));
      expect(db.db.prepare("SELECT state FROM memory_processing_state WHERE memory_id=?").get(completed.l1MemoryId))
        .toEqual({ state: "ready" });
      const detail = service.getMemory(completed.l1MemoryId, { namespace });
      expect(detail).toMatchObject({
        id: completed.l1MemoryId,
        kind: "trace",
        memoryLayer: "L1",
        metadata: {
          properties: {
            internal_info: {
              evidence_status: "verified"
            }
          }
        }
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
      await service.stop();
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

function createSmokeSummaryLlm(onJudge: () => void = () => {}): LlmClient {
  return {
    config: {
      ...DEFAULT_MEMMY_CONFIG.summary,
      provider: "host",
      endpoint: "http://127.0.0.1/summary",
      model: "smoke-summary"
    },
    isConfigured: () => true,
    async complete() {
      return JSON.stringify({ title: "Smoke turn", summary: "Verified smoke summary" });
    },
    async completeJson<T extends Record<string, unknown>>(messages: LlmMessage[], options: LlmCompletionOptions) {
      if (options.operation === "episode.select.v1") return { episodeId: null, title: "Release verification", summary: "Verify the release workflow" } as unknown as T;
      const system = messages
        .filter((message) => message.role === "system")
        .map((message) => message.content)
        .join("\n");
      const joint = system.includes("In one answer you judge four things");
      if (joint) onJudge();
      if (joint || system.includes("Judge L1 and User Memory independently")) {
        return {
          ...(joint ? { relation: null, feedback: null, reason: "First turn" } : {}),
          l1: {
            ...(joint ? { unverified_answer: false } : {}),
            title: "Release verification",
            summary: "Verified release contracts and attachments.",
            evidence: [{ quote: "release workflow", role: "user", kind: "task_request" }]
          },
          user: null
        } as unknown as T;
      }
      return { title: "Smoke turn", summary: "Verified smoke summary" } as unknown as T;
    },
    status: () => ({
      provider: "host",
      model: "smoke-summary",
      configured: true,
      remote: true
    })
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
