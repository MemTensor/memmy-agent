import type { Server } from "node:http";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { localCalendarDate } from "@memmy/agent-source-core";
import { DEFAULT_MEMMY_CONFIG, MemoryDb, MemoryService } from "../../src/index.js";
import { closeMemoryHttpServer, createMemoryHttpServer } from "../../src/server/http.js";
import { MEMORY_BYOK_BUDGET_KV_KEY } from "../../src/service/memory-token-budget-ledger.js";
import { Repositories } from "../../src/storage/repositories.js";
import { TokenUsageOutbox } from "../../src/storage/token-usage-outbox.js";
import { byokRuntimeConfig, createMemoryServiceFixture } from "../fixtures/memory-service-fixture.js";

const fixture = createMemoryServiceFixture();
const extraServices: MemoryService[] = [];
const extraDatabases: MemoryDb[] = [];
const extraServers: Server[] = [];

afterEach(async () => {
  vi.unstubAllGlobals();
  for (const server of extraServers.splice(0)) {
    await closeMemoryHttpServer(server);
  }
  for (const service of extraServices.splice(0)) {
    await service.stop();
  }
  for (const database of extraDatabases.splice(0)) {
    if (database.db.open) {
      database.close();
    }
  }
  fixture.cleanup();
});

describe("MemoryService token usage outbox lifecycle", () => {
  it("delivers leftover outbox events on startup without a new model call", async () => {
    const fetchMock = vi.fn<typeof fetch>(async () => jsonResponse({ ok: true }));
    const { db, outbox } = createQueuedDatabase(leftoverPayload(12));
    fixture.createTestMemoryService({
      db,
      mode: "dev",
      tokenUsage: {
        fetchImpl: fetchMock,
        runtimeConfig: { baseUrl: "http://127.0.0.1:18100", localToken: "runtime-token" },
        retryDelaysMs: [15]
      }
    });

    await waitFor(() => fetchMock.mock.calls.length === 1 && !outbox.hasPending());
    expect(JSON.parse(String((fetchMock.mock.calls[0] as [URL, RequestInit])[1].body))).toMatchObject({
      id: "byok_usage_leftover",
      totalTokens: 12,
      createdAt: "2026-09-20T15:00:00.000Z"
    });
  });

  it("keeps delivering leftover events after the memory budget is paused", async () => {
    const fetchMock = vi.fn<typeof fetch>(async () => jsonResponse({ ok: true }));
    const { db, outbox } = createQueuedDatabase(leftoverPayload(9));
    new Repositories(db.db).runtime.setKv(MEMORY_BYOK_BUDGET_KV_KEY, {
      dailyUsed: 10_000_000,
      lifetimeUsed: 10_000_000,
      dailyDate: localCalendarDate()
    });
    const service = fixture.createTestMemoryService({
      db,
      mode: "dev",
      tokenUsage: {
        fetchImpl: fetchMock,
        runtimeConfig: { baseUrl: "http://127.0.0.1:18100", localToken: "runtime-token" },
        retryDelaysMs: [15]
      }
    });

    expect(service.memoryTokenBudget().paused).toBe(true);
    await waitFor(() => fetchMock.mock.calls.length === 1 && !outbox.hasPending());
  });

  it("does not resume budgeted title work after retrieval while budget writes still fail", async () => {
    const counts = createUsageFetch();
    const { service, db, sessionId } = createTitleWorkerHarness();
    installBudgetWriteFailure(db);
    const first = await service.runWorkerOnce(1);
    expect(first.succeeded).toBe(1);
    expect(counts.llm).toBe(1);
    expect(service.isMemoryBudgetPaused()).toBe(true);

    await service.search({
      sessionId,
      query: "Review database persistence behavior",
      limit: 5
    });
    expect(counts.embedding).toBeGreaterThan(0);
    expect(service.isMemoryBudgetPaused()).toBe(true);
    const llmAfterSearch = counts.llm;

    const second = await service.runWorkerOnce(1);
    expect(second.leased).toBe(0);
    expect(counts.llm).toBe(llmAfterSearch);
    expect(service.memoryTokenBudget().lifetimeUsed).toBe(0);
  });

  it("resumes queued title jobs after writes recover without manufacturing usage", async () => {
    const counts = createUsageFetch();
    const { service, db } = createTitleWorkerHarness();
    installBudgetWriteFailure(db);
    const first = await service.runWorkerOnce(1);
    expect(first.succeeded).toBe(1);
    expect(counts.llm).toBe(1);
    expect(service.isMemoryBudgetPaused()).toBe(true);
    expect(service.memoryTokenBudget().lifetimeUsed).toBe(0);

    db.db.exec("DROP TRIGGER fail_budget_insert");
    await waitFor(() => service.isMemoryBudgetPaused() === false);
    expect(service.memoryTokenBudget().lifetimeUsed).toBe(0);
    expect(counts.llm).toBe(1);

    const resumed = await service.runWorkerOnce(10);
    expect(resumed.leased).toBeGreaterThan(0);
    expect(counts.llm).toBe(2);
    expect(service.isMemoryBudgetPaused()).toBe(false);
    expect(service.memoryTokenBudget().lifetimeUsed).toBeGreaterThan(0);
  });

  it("wakes queued title jobs from the production scheduler after persist recovers", async () => {
    const counts = createUsageFetch();
    const { service, db } = createTitleWorkerHarness({
      jobCount: 6,
      fetchAppMemoryBudget: async () => ({ dailyUsed: 0, lifetimeUsed: 0 })
    });
    await waitFor(() => Boolean(
      db.db.prepare("SELECT 1 AS ok FROM runtime_kv WHERE key = 'memory_byok_budget_v1'").get()
    ));
    installBudgetWriteFailure(db);
    const server = createMemoryHttpServer({
      service,
      workerStartupFallbackMs: 0,
      workerPostHealthDelayMs: 0
    });
    extraServers.push(server);
    server.emit("listening");

    await waitFor(() => service.isMemoryBudgetPaused() === true, 1_500);
    const queuedBefore = queuedJobCount(db);
    expect(queuedBefore).toBeGreaterThan(0);
    expect(service.memoryTokenBudget().lifetimeUsed).toBe(0);

    db.db.exec("DROP TRIGGER fail_budget_insert");
    await waitFor(() => service.isMemoryBudgetPaused() === false, 1_500);
    await waitFor(() => (
      queuedJobCount(db) < queuedBefore && service.memoryTokenBudget().lifetimeUsed > 0
    ), 1_500);
  });

  it("does not clear a budget-write fault after a cache-only budgeted model probe", async () => {
    const counts = createUsageFetch({ provider: "anthropic" });
    const { service, db } = createTitleWorkerHarness({ anthropic: true });
    installBudgetWriteFailure(db);
    const first = await service.runWorkerOnce(1);
    expect(first.succeeded).toBe(1);
    expect(counts.llm).toBe(1);
    expect(service.isMemoryBudgetPaused()).toBe(true);

    counts.cacheOnly = true;
    const result = await service.testModels();
    expect(result.models.summary.ok).toBe(false);
    await waitFor(() => cacheOnlyUploaded(counts.uploaded).length >= 2);
    expect(cacheOnlyUploaded(counts.uploaded)).toHaveLength(2);
    expect(service.isMemoryBudgetPaused()).toBe(true);
    expect(service.memoryTokenBudget().lifetimeUsed).toBe(0);

    const blocked = await service.runWorkerOnce(1);
    expect(blocked.leased).toBe(0);

    db.db.exec("DROP TRIGGER fail_budget_insert");
    await waitFor(() => service.isMemoryBudgetPaused() === false);
    expect(service.memoryTokenBudget().lifetimeUsed).toBe(0);
  });
});

function createTitleWorkerHarness(options: {
  jobCount?: number;
  anthropic?: boolean;
  fetchAppMemoryBudget?: () => Promise<{ dailyUsed: number; lifetimeUsed: number } | null>;
} = {}): {
  service: MemoryService;
  db: MemoryDb;
  sessionId: string;
} {
  const root = fixture.createTestRoot();
  const db = new MemoryDb({ path: join(root, "memory.sqlite") });
  extraDatabases.push(db);
  const repos = new Repositories(db.db);
  const config = byokRuntimeConfig({
    algorithm: {
      ...DEFAULT_MEMMY_CONFIG.algorithm,
      enableQueryRewrite: false
    }
  });
  if (options.anthropic) {
    for (const role of ["summary", "evolution"] as const) {
      config[role] = {
        ...config[role],
        provider: "anthropic",
        sourceProvider: "anthropic",
        endpoint: "https://api.anthropic.test/v1/messages",
        actualModelContext: {
          ...config[role].actualModelContext!,
          provider: "anthropic",
          protocol: "anthropic-messages"
        }
      };
    }
  }
  const service = new MemoryService({
    db,
    mode: "dev",
    config,
    fetchAppMemoryBudget: options.fetchAppMemoryBudget ?? (async () => null),
    tokenUsage: {
      fetchImpl: globalThis.fetch,
      runtimeConfig: { baseUrl: "http://127.0.0.1:18100", localToken: "runtime-token" },
      retryDelaysMs: [15]
    }
  });
  extraServices.push(service);
  const namespace = { source: "codex", profileId: "default", userId: "outbox-worker" };
  let sessionId = "";
  const jobCount = options.jobCount ?? 2;
  for (let index = 0; index < jobCount; index += 1) {
    const session = service.openSession({
      namespace: { ...namespace, sessionKey: `outbox-worker-${index}` }
    });
    sessionId = session.sessionId;
    service.completeTurn(`turn-outbox-worker-${index}`, {
      sessionId: session.sessionId,
      query: "Review database persistence behavior",
      answer: "Checked the SQLite write behavior.",
      status: "succeeded"
    });
  }
  db.db.exec("DELETE FROM evolution_jobs WHERE job_type != 'episode_title'");
  const turn = db.db.prepare("SELECT id FROM raw_turns LIMIT 1").get() as { id: string };
  const at = new Date().toISOString();
  repos.userMemories.insert({
    id: "user-memory-outbox-worker",
    sourceTurnId: turn.id,
    userId: namespace.userId,
    memoryTypes: ["User Preference"],
    content: "Review database persistence behavior",
    normalizedUserTextHash: "outbox-worker",
    sourceTurnRefs: [turn.id],
    status: "active",
    embedding: [1, 0, 0],
    embeddingModel: "embedding",
    embeddingProvider: "openai",
    createdAt: at,
    updatedAt: at
  });
  return { service, db, sessionId };
}

function createUsageFetch(options: {
  provider?: "openai_compatible" | "anthropic";
} = {}): {
  llm: number;
  embedding: number;
  cacheOnly: boolean;
  uploaded: Record<string, unknown>[];
} {
  const titleText = JSON.stringify({
    title: "Review example",
    summary: "Checked example behavior."
  });
  const counts = { llm: 0, embedding: 0, cacheOnly: false, uploaded: [] as Record<string, unknown>[] };
  vi.stubGlobal("fetch", async (input: Parameters<typeof fetch>[0], init?: RequestInit) => {
    const path = String(input);
    if (path.includes("/api/app/byok-token-usage/events")) {
      counts.uploaded.push(JSON.parse(String(init?.body)) as Record<string, unknown>);
      return jsonResponse({ ok: true });
    }
    if (path.includes("embeddings")) {
      counts.embedding += 1;
      return jsonResponse({
        data: [{ embedding: [1, 0, 0] }],
        usage: { prompt_tokens: 7, total_tokens: 7 }
      });
    }
    counts.llm += 1;
    if (counts.cacheOnly) {
      return jsonResponse({
        content: [],
        stop_reason: "end_turn",
        usage: {
          input_tokens: 0,
          output_tokens: 0,
          cache_read_input_tokens: 64
        }
      });
    }
    if (options.provider === "anthropic") {
      return jsonResponse({
        content: [{ type: "text", text: titleText }],
        stop_reason: "end_turn",
        usage: { prompt_tokens: 20, completion_tokens: 10, total_tokens: 30 }
      });
    }
    return jsonResponse({
      choices: [{
        message: { content: titleText }
      }],
      usage: { prompt_tokens: 20, completion_tokens: 10, total_tokens: 30 }
    });
  });
  return counts;
}

function cacheOnlyUploaded(uploaded: Array<Record<string, unknown>>): Array<Record<string, unknown>> {
  return uploaded.filter((event) => event.totalTokens === 0 && event.cachedInputTokens === 64);
}

function queuedJobCount(db: MemoryDb): number {
  const row = db.db.prepare("SELECT count(*) AS n FROM evolution_jobs WHERE status = 'queued'").get() as { n: number };
  return Number(row.n);
}

function installBudgetWriteFailure(db: MemoryDb): void {
  db.db.exec(`
    CREATE TRIGGER fail_budget_insert BEFORE INSERT ON runtime_kv
    WHEN NEW.key = 'memory_byok_budget_v1'
    BEGIN SELECT RAISE(ABORT, 'injected budget write failure'); END
  `);
}

function createQueuedDatabase(payload: Record<string, unknown>): {
  db: MemoryDb;
  outbox: TokenUsageOutbox;
} {
  const root = fixture.createTestRoot();
  const db = new MemoryDb({ path: join(root, "memory.sqlite") });
  const outbox = new TokenUsageOutbox(db.db);
  outbox.enqueue(String(payload.id), JSON.stringify(payload));
  return { db, outbox };
}

function leftoverPayload(totalTokens: number): Record<string, unknown> {
  return {
    id: "byok_usage_leftover",
    kind: "memory_summary",
    source: "memory",
    operationId: "episode.summarize:byok_usage_leftover",
    presetId: "byok-memory_summary",
    provider: "openai",
    model: "summary-model",
    capability: "memory_summary",
    inputTokens: totalTokens,
    outputTokens: 0,
    totalTokens,
    cachedInputTokens: 0,
    cacheCreationInputTokens: 0,
    metadata: { operation: "episode.summarize" },
    rawUsage: { total_tokens: totalTokens },
    createdAt: "2026-09-20T15:00:00.000Z"
  };
}

function jsonResponse(body: unknown): Response {
  return new Response(JSON.stringify(body), {
    status: 200,
    headers: { "content-type": "application/json" }
  });
}

async function waitFor(assert: () => boolean, timeoutMs = 400): Promise<void> {
  const started = Date.now();
  while (!assert()) {
    if (Date.now() - started > timeoutMs) {
      throw new Error("timed out waiting for leftover token usage delivery");
    }
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
}
