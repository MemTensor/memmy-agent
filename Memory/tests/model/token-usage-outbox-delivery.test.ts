import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { DEFAULT_MEMMY_CONFIG, MemoryDb } from "../../src/index.js";
import { createLlmClient } from "../../src/model/llm.js";
import {
  HttpByokTokenUsageRecorder,
  type MemoryModelUsageEvent
} from "../../src/model/token-usage.js";
import { MemoryTokenBudgetLedger } from "../../src/service/memory-token-budget-ledger.js";
import { Repositories } from "../../src/storage/repositories.js";
import { TokenUsageOutbox } from "../../src/storage/token-usage-outbox.js";

const roots: string[] = [];
const recorders: HttpByokTokenUsageRecorder[] = [];

afterEach(() => {
  vi.unstubAllGlobals();
  for (const recorder of recorders.splice(0)) {
    recorder.stop();
  }
  for (const root of roots.splice(0)) {
    rmSync(root, { recursive: true, force: true });
  }
});

describe("durable BYOK token usage delivery", () => {
  it("persists then sends the original payload and deletes after { ok: true }", async () => {
    const fetchMock = vi.fn<typeof fetch>(async () => jsonResponse({ ok: true }));
    const { recorder, outbox, ledger } = createRecorder(fetchMock);

    recorder.record(usageEvent());
    await waitFor(() => fetchMock.mock.calls.length === 1 && !outbox.hasPending());

    const [, init] = fetchMock.mock.calls[0] as [URL, RequestInit];
    const body = JSON.parse(String(init.body)) as Record<string, unknown>;
    expect(body).toMatchObject({
      kind: "memory_summary",
      source: "memory",
      totalTokens: 30,
      model: "summary-model"
    });
    expect(outbox.hasPending()).toBe(false);
    expect(ledger.snapshot().dailyUsed).toBe(30);
  });

  it("does not send when the queue is empty", async () => {
    const fetchMock = vi.fn<typeof fetch>(async () => jsonResponse({ ok: true }));
    createRecorder(fetchMock);
    await new Promise((resolve) => setTimeout(resolve, 20));
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("rolls back the outbox and budget when persist fails", () => {
    const root = createRoot();
    const db = new MemoryDb({ path: join(root, "memory.sqlite") });
    const outbox = new TokenUsageOutbox(db.db);
    const fetchMock = vi.fn<typeof fetch>(async () => jsonResponse({ ok: true }));
    const recorder = new HttpByokTokenUsageRecorder({
      outbox,
      transaction: () => {
        throw new Error("disk full");
      },
      onBudgetedUsage: () => {
        throw new Error("should not count");
      },
      fetchImpl: fetchMock,
      runtimeConfig: { baseUrl: "http://127.0.0.1:18100", localToken: "runtime-token" }
    });
    recorders.push(recorder);
    recorder.start();
    expect(recorder.record(usageEvent())).toBe("persist_failed");
    expect(recorder.isPersistUnreliable()).toBe(true);
    expect(outbox.hasPending()).toBe(false);
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("rolls back a real SQLite enqueue failure and marks persist unreliable", () => {
    const harness = createSqliteHarness();
    failOutboxInsert(harness.db);
    const recorder = sqliteRecorder(harness);
    expect(recorder.record(usageEvent({ totalTokens: 30 }))).toBe("persist_failed");
    expect(recorder.isPersistUnreliable()).toBe(true);
    expect(harness.outbox.hasPending()).toBe(false);
    expect(harness.ledger.snapshot().lifetimeUsed).toBe(0);
  });

  it("rolls back a real SQLite budget write failure without retrying the completed model call", async () => {
    const harness = createSqliteHarness();
    failBudgetInsert(harness.db);
    let modelCalls = 0;
    vi.stubGlobal("fetch", vi.fn<typeof fetch>(async () => {
      modelCalls += 1;
      return jsonResponse({
        choices: [{ message: { content: "completed model result" } }],
        usage: { prompt_tokens: 20, completion_tokens: 10, total_tokens: 30 }
      });
    }));
    const recorder = sqliteRecorder(harness);
    const llm = createLlmClient({
      ...DEFAULT_MEMMY_CONFIG.summary,
      provider: "openai_compatible",
      endpoint: "http://example.invalid/v1/chat/completions",
      apiKey: "sk-test",
      model: "test-model",
      actualModelContext: usageEvent().actualModelContext
    }, { modelRole: "memory_summary", usageRecorder: recorder });

    await expect(llm.complete(
      [{ role: "user", content: "test" }],
      { operation: "episode.summarize" }
    )).resolves.toBe("completed model result");

    expect(modelCalls).toBe(1);
    expect(recorder.isPersistUnreliable()).toBe(true);
    expect(harness.outbox.hasPending()).toBe(false);
    expect(harness.ledger.snapshot().lifetimeUsed).toBe(0);
  });

  it("clears persist failure after disk writes succeed again and does not invent the lost event", async () => {
    const harness = createSqliteHarness();
    failBudgetInsert(harness.db);
    const fetchMock = vi.fn<typeof fetch>(async () => jsonResponse({ ok: true }));
    const recorder = sqliteRecorder(harness, fetchMock);
    expect(recorder.record(usageEvent({ totalTokens: 30 }))).toBe("persist_failed");
    expect(harness.outbox.hasPending()).toBe(false);

    harness.db.db.exec("DROP TRIGGER fail_budget_insert");
    expect(recorder.record(usageEvent({ totalTokens: 12 }))).toBe("recorded");
    expect(recorder.isPersistUnreliable()).toBe(false);
    await waitFor(() => !harness.outbox.hasPending());
    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(JSON.parse(String((fetchMock.mock.calls[0] as [URL, RequestInit])[1].body)).totalTokens).toBe(12);
    expect(harness.ledger.snapshot().lifetimeUsed).toBe(12);
  });

  it("does not clear a budget-write fault after a zero-total budgeted usage persists", async () => {
    const harness = createSqliteHarness();
    failBudgetInsert(harness.db);
    const fetchMock = vi.fn<typeof fetch>(async () => jsonResponse({ ok: true }));
    const recorder = sqliteRecorder(harness, fetchMock);
    expect(recorder.record(usageEvent({ totalTokens: 30 }))).toBe("persist_failed");
    expect(recorder.record(usageEvent({
      totalTokens: 0,
      cachedInputTokens: 64
    }))).toBe("recorded");
    expect(recorder.isPersistUnreliable()).toBe(true);
    await waitFor(() => fetchMock.mock.calls.length === 1);
    expect(harness.ledger.snapshot().lifetimeUsed).toBe(0);

    harness.db.db.exec("DROP TRIGGER fail_budget_insert");
    await waitFor(() => !recorder.isPersistUnreliable());
    expect(harness.outbox.hasPending()).toBe(false);
    expect(harness.ledger.snapshot().lifetimeUsed).toBe(0);
  });

  it("does not clear a budget-write fault after a retrieval embedding persists", async () => {
    const harness = createSqliteHarness();
    failBudgetInsert(harness.db);
    const fetchMock = vi.fn<typeof fetch>(async () => jsonResponse({ ok: true }));
    const recorder = sqliteRecorder(harness, fetchMock);
    expect(recorder.record(usageEvent({ totalTokens: 30 }))).toBe("persist_failed");
    expect(recorder.record(usageEvent({
      kind: "embedding",
      operation: "embedding.query",
      capability: "embedding",
      totalTokens: 7
    }))).toBe("recorded");
    expect(recorder.isPersistUnreliable()).toBe(true);
    await waitFor(() => fetchMock.mock.calls.length === 1);
    expect(harness.ledger.snapshot().lifetimeUsed).toBe(0);
  });

  it("recovers persist health without a new billed event once writes succeed", async () => {
    const harness = createSqliteHarness();
    failBudgetInsert(harness.db);
    const recorder = sqliteRecorder(harness);
    expect(recorder.record(usageEvent({ totalTokens: 30 }))).toBe("persist_failed");
    expect(harness.ledger.snapshot().lifetimeUsed).toBe(0);
    harness.db.db.exec("DROP TRIGGER fail_budget_insert");
    await waitFor(() => !recorder.isPersistUnreliable());
    expect(harness.outbox.hasPending()).toBe(false);
    expect(harness.ledger.snapshot().lifetimeUsed).toBe(0);
  });

  it("does not probe or write after stop", async () => {
    const harness = createSqliteHarness();
    failBudgetInsert(harness.db);
    const recorder = sqliteRecorder(harness);
    expect(recorder.record(usageEvent({ totalTokens: 30 }))).toBe("persist_failed");
    recorder.stop();
    harness.db.db.exec("DROP TRIGGER fail_budget_insert");
    await new Promise((resolve) => setTimeout(resolve, 40));
    expect(recorder.isPersistUnreliable()).toBe(true);
    expect(harness.outbox.hasPending()).toBe(false);
    expect(harness.db.db.prepare(
      `SELECT 1 AS present FROM runtime_kv WHERE key = 'memory_byok_budget_v1'`
    ).get()).toBeUndefined();
  });

  it("keeps the event when the confirmation is missing or invalid", async () => {
    const bodies = ["", "{", '{"ok":false}', "not-json"];
    const fetchMock = vi.fn<typeof fetch>(async () => {
      const body = bodies.shift() ?? '{"ok":false}';
      return new Response(body, { status: 200, headers: { "content-type": "application/json" } });
    });
    const { recorder, outbox } = createRecorder(fetchMock, { retryDelaysMs: [15] });
    recorder.record(usageEvent({ totalTokens: 7 }));
    await waitFor(() => fetchMock.mock.calls.length >= 3);
    expect(outbox.hasPending()).toBe(true);
    const first = JSON.parse(String((fetchMock.mock.calls[0] as [URL, RequestInit])[1].body));
    const second = JSON.parse(String((fetchMock.mock.calls[1] as [URL, RequestInit])[1].body));
    expect(second).toEqual(first);
  });

  it("retries the same payload after App accepts but the confirmation is lost", async () => {
    const seen = new Map<string, number>();
    const fetchMock = vi.fn<typeof fetch>(async (_input, init) => {
      const payload = JSON.parse(String(init?.body)) as { id: string; operationId: string };
      const key = `${payload.id}:${payload.operationId}`;
      seen.set(key, (seen.get(key) ?? 0) + 1);
      if (seen.get(key) === 1) {
        return new Response("", { status: 200 });
      }
      return jsonResponse({ ok: true });
    });
    const { recorder, outbox, ledger } = createRecorder(fetchMock, { retryDelaysMs: [15] });
    recorder.record(usageEvent({ totalTokens: 30 }));
    await waitFor(() => fetchMock.mock.calls.length === 2 && !outbox.hasPending());
    expect(seen.size).toBe(1);
    expect([...seen.values()][0]).toBe(2);
    expect(ledger.snapshot().dailyUsed).toBe(30);
  });

  it("does not add budget again when a queued event is delivered the next day", async () => {
    let now = new Date(2026, 8, 20, 23, 59, 0);
    let release!: (response: Response) => void;
    const fetchMock = vi.fn<typeof fetch>(() => new Promise<Response>((resolve) => {
      release = resolve;
    }));
    const { recorder, outbox, ledger } = createRecorder(fetchMock, {
      now: () => now
    });
    recorder.record(usageEvent({ totalTokens: 40 }));
    await waitFor(() => fetchMock.mock.calls.length === 1);
    expect(ledger.snapshot().dailyUsed).toBe(40);
    const payload = JSON.parse(outbox.listNext(1)[0]!.payloadJson) as { createdAt: string };
    expect(payload.createdAt).toBe(now.toISOString());

    now = new Date(2026, 8, 21, 0, 5, 0);
    release(jsonResponse({ ok: true }));
    await waitFor(() => !outbox.hasPending());
    expect(JSON.parse(String((fetchMock.mock.calls[0] as [URL, RequestInit])[1].body)).createdAt)
      .toBe(payload.createdAt);
    expect(ledger.snapshot()).toMatchObject({
      dailyUsed: 0,
      lifetimeUsed: 40
    });
  });

  it("keeps the model captured at record time after later config changes", async () => {
    const fetchMock = vi.fn<typeof fetch>(async () => new Response("", { status: 503 }));
    const { recorder, outbox } = createRecorder(fetchMock, { retryDelaysMs: [20] });
    recorder.record(usageEvent({ model: "first-model", totalTokens: 11 }));
    await waitFor(() => fetchMock.mock.calls.length === 1);
    const queued = JSON.parse(outbox.listNext(1)[0]!.payloadJson) as { model: string };
    expect(queued.model).toBe("first-model");
    recorder.record(usageEvent({ model: "second-model", totalTokens: 12 }));
    expect(outbox.listNext(2).map((row) => JSON.parse(row.payloadJson).model)).toEqual([
      "first-model",
      "second-model"
    ]);
  });

  it("queues retrieval embeddings without increasing the memory budget", async () => {
    const fetchMock = vi.fn<typeof fetch>(async () => jsonResponse({ ok: true }));
    const { recorder, ledger } = createRecorder(fetchMock);
    recorder.record(usageEvent({
      kind: "embedding",
      operation: "embedding.query",
      capability: "embedding",
      totalTokens: 99
    }));
    await waitFor(() => fetchMock.mock.calls.length === 1);
    expect(ledger.snapshot().dailyUsed).toBe(0);
    expect(JSON.parse(String((fetchMock.mock.calls[0] as [URL, RequestInit])[1].body))).toMatchObject({
      kind: "embedding",
      totalTokens: 99
    });
  });

  it("gives each actual model call its own event id", async () => {
    const fetchMock = vi.fn<typeof fetch>(async () => jsonResponse({ ok: true }));
    const { recorder } = createRecorder(fetchMock);
    recorder.record(usageEvent({ totalTokens: 4 }));
    recorder.record(usageEvent({ totalTokens: 5 }));
    await waitFor(() => fetchMock.mock.calls.length === 2);
    const first = JSON.parse(String((fetchMock.mock.calls[0] as [URL, RequestInit])[1].body));
    const second = JSON.parse(String((fetchMock.mock.calls[1] as [URL, RequestInit])[1].body));
    expect(first.id).not.toBe(second.id);
    expect(first.operationId).not.toBe(second.operationId);
  });

  it("does not let a new event bypass an active failure backoff", async () => {
    let failFirst = true;
    const fetchMock = vi.fn<typeof fetch>(async () => {
      if (failFirst) {
        failFirst = false;
        return new Response("", { status: 503 });
      }
      return jsonResponse({ ok: true });
    });
    const { recorder } = createRecorder(fetchMock, { retryDelaysMs: [80] });
    recorder.record(usageEvent({ totalTokens: 3 }));
    await waitFor(() => fetchMock.mock.calls.length === 1);
    recorder.record(usageEvent({ totalTokens: 4 }));
    await new Promise((resolve) => setTimeout(resolve, 30));
    expect(fetchMock).toHaveBeenCalledTimes(1);
    await waitFor(() => fetchMock.mock.calls.length === 3, 300);
  });

  it("reads a new runtime address on the next send", async () => {
    const root = createRoot();
    const runtimePath = join(root, "runtime.json");
    writeFileSync(runtimePath, JSON.stringify({
      baseUrl: "http://127.0.0.1:18100",
      localToken: "first-token"
    }));
    const urls: string[] = [];
    const tokens: string[] = [];
    const fetchMock = vi.fn<typeof fetch>(async (input, init) => {
      urls.push(String(input));
      tokens.push(String((init?.headers as Record<string, string>)["x-memmy-local-token"]));
      if (urls.length === 1) {
        return new Response("", { status: 503 });
      }
      return jsonResponse({ ok: true });
    });
    const { recorder } = createRecorder(fetchMock, {
      runtimeConfig: undefined,
      runtimeConfigPath: runtimePath,
      retryDelaysMs: [15]
    });
    recorder.record(usageEvent());
    await waitFor(() => fetchMock.mock.calls.length === 1);
    writeFileSync(runtimePath, JSON.stringify({
      baseUrl: "http://127.0.0.1:18200",
      localToken: "second-token"
    }));
    await waitFor(() => fetchMock.mock.calls.length === 2);
    expect(urls[0]).toContain("18100");
    expect(urls[1]).toContain("18200");
    expect(tokens).toEqual(["first-token", "second-token"]);
  });

  it("does not delete after stop even if a late response succeeds", async () => {
    let release!: (response: Response) => void;
    const fetchMock = vi.fn<typeof fetch>(() => new Promise<Response>((resolve) => {
      release = resolve;
    }));
    const { recorder, outbox } = createRecorder(fetchMock);
    recorder.record(usageEvent());
    await waitFor(() => fetchMock.mock.calls.length === 1);
    recorder.stop();
    release(jsonResponse({ ok: true }));
    await new Promise((resolve) => setTimeout(resolve, 20));
    expect(outbox.hasPending()).toBe(true);
  });

  it("resumes leftover disk events after a new recorder starts", async () => {
    const root = createRoot();
    const db = new MemoryDb({ path: join(root, "memory.sqlite") });
    const outbox = new TokenUsageOutbox(db.db);
    const fetchMock = vi.fn<typeof fetch>(async () => jsonResponse({ ok: true }));
    const first = new HttpByokTokenUsageRecorder({
      outbox,
      transaction: (fn) => db.db.transaction(fn)(),
      fetchImpl: fetchMock,
      runtimeConfig: { baseUrl: "http://127.0.0.1:18100", localToken: "runtime-token" },
      retryDelaysMs: [15]
    });
    first.record(usageEvent({ totalTokens: 8 }));
    expect(outbox.hasPending()).toBe(true);
    expect(fetchMock).not.toHaveBeenCalled();
    first.stop();

    const second = new HttpByokTokenUsageRecorder({
      outbox,
      transaction: (fn) => db.db.transaction(fn)(),
      fetchImpl: fetchMock,
      runtimeConfig: { baseUrl: "http://127.0.0.1:18100", localToken: "runtime-token" }
    });
    recorders.push(second);
    second.start();
    await waitFor(() => fetchMock.mock.calls.length === 1 && !outbox.hasPending());
    expect(JSON.parse(String((fetchMock.mock.calls[0] as [URL, RequestInit])[1].body)).totalTokens).toBe(8);
  });

  it("sends at most one request at a time and only loads a batch", async () => {
    let inFlight = 0;
    let maxInFlight = 0;
    const fetchMock = vi.fn<typeof fetch>(async () => {
      inFlight += 1;
      maxInFlight = Math.max(maxInFlight, inFlight);
      await new Promise((resolve) => setTimeout(resolve, 5));
      inFlight -= 1;
      return jsonResponse({ ok: true });
    });
    const { recorder, outbox } = createRecorder(fetchMock, { batchSize: 4, continueDelayMs: 5 });
    for (let index = 0; index < 10; index += 1) {
      recorder.record(usageEvent({ totalTokens: index + 1 }));
    }
    await waitFor(() => !outbox.hasPending(), 500);
    expect(maxInFlight).toBe(1);
    expect(fetchMock).toHaveBeenCalledTimes(10);
  });

  it("retries after listNext fails and does not raise an unhandled rejection", async () => {
    const rejections: unknown[] = [];
    const onReject = (reason: unknown) => {
      rejections.push(reason);
    };
    process.on("unhandledRejection", onReject);
    const fetchMock = vi.fn<typeof fetch>(async () => jsonResponse({ ok: true }));
    const { recorder, outbox } = createRecorder(fetchMock, { retryDelaysMs: [20] });
    const original = outbox.listNext.bind(outbox);
    let remainingFails = 1;
    outbox.listNext = (limit) => {
      if (remainingFails > 0) {
        remainingFails -= 1;
        throw Object.assign(new Error("injected transient disk I/O error"), { code: "SQLITE_IOERR" });
      }
      return original(limit);
    };
    try {
      recorder.record(usageEvent({ totalTokens: 6 }));
      await waitFor(() => fetchMock.mock.calls.length === 1 && !outbox.hasPending());
      expect(rejections).toEqual([]);
    } finally {
      process.off("unhandledRejection", onReject);
    }
  });

  it("retries after hasPending fails and then drains leftover events", async () => {
    const fetchMock = vi.fn<typeof fetch>(async () => jsonResponse({ ok: true }));
    const { recorder, outbox } = createRecorder(fetchMock, { retryDelaysMs: [20], batchSize: 1 });
    const original = outbox.hasPending.bind(outbox);
    let remainingFails = 1;
    outbox.hasPending = () => {
      if (remainingFails > 0) {
        remainingFails -= 1;
        throw Object.assign(new Error("injected hasPending failure"), { code: "SQLITE_IOERR" });
      }
      return original();
    };
    recorder.record(usageEvent({ totalTokens: 2 }));
    recorder.record(usageEvent({ totalTokens: 3 }));
    await waitFor(() => fetchMock.mock.calls.length === 2 && !outbox.hasPending());
  });

  it("does not read the queue again after stop during a store failure", async () => {
    const { recorder, outbox } = createRecorder(vi.fn<typeof fetch>(async () => jsonResponse({ ok: true })), {
      retryDelaysMs: [15]
    });
    let reads = 0;
    outbox.listNext = () => {
      reads += 1;
      throw Object.assign(new Error("injected transient disk I/O error"), { code: "SQLITE_IOERR" });
    };
    recorder.record(usageEvent());
    await waitFor(() => reads === 1);
    recorder.stop();
    await new Promise((resolve) => setTimeout(resolve, 40));
    expect(reads).toBe(1);
  });

  it("does not let a new event bypass store-failure backoff", async () => {
    const fetchMock = vi.fn<typeof fetch>(async () => jsonResponse({ ok: true }));
    const { recorder, outbox } = createRecorder(fetchMock, { retryDelaysMs: [80] });
    const original = outbox.listNext.bind(outbox);
    let remainingFails = 1;
    outbox.listNext = (limit) => {
      if (remainingFails > 0) {
        remainingFails -= 1;
        throw Object.assign(new Error("injected transient disk I/O error"), { code: "SQLITE_IOERR" });
      }
      return original(limit);
    };
    recorder.record(usageEvent({ totalTokens: 2 }));
    await waitFor(() => remainingFails === 0);
    recorder.record(usageEvent({ totalTokens: 3 }));
    await new Promise((resolve) => setTimeout(resolve, 30));
    expect(fetchMock).toHaveBeenCalledTimes(0);
    await waitFor(() => fetchMock.mock.calls.length === 2, 300);
  });
});

function createSqliteHarness(): {
  db: MemoryDb;
  outbox: TokenUsageOutbox;
  ledger: MemoryTokenBudgetLedger;
} {
  const root = createRoot();
  const db = new MemoryDb({ path: join(root, "memory.sqlite") });
  const ledger = new MemoryTokenBudgetLedger(new Repositories(db.db).runtime);
  return { db, outbox: new TokenUsageOutbox(db.db), ledger };
}

function sqliteRecorder(
  harness: ReturnType<typeof createSqliteHarness>,
  fetchImpl: typeof fetch = async () => jsonResponse({ ok: true })
): HttpByokTokenUsageRecorder {
  const recorder = new HttpByokTokenUsageRecorder({
    outbox: harness.outbox,
    transaction: (fn) => harness.db.db.transaction(fn)(),
    onBudgetedUsage: (event) => harness.ledger.addIfBudgeted({
      kind: event.kind,
      operation: event.operation,
      totalTokens: event.usage.totalTokens
    }),
    touchBudget: () => harness.ledger.touch(),
    fetchImpl,
    runtimeConfig: { baseUrl: "http://127.0.0.1:18100", localToken: "runtime-token" },
    retryDelaysMs: [15]
  });
  recorders.push(recorder);
  recorder.start();
  return recorder;
}

function failOutboxInsert(db: MemoryDb): void {
  db.db.exec(`
    CREATE TRIGGER fail_outbox_insert BEFORE INSERT ON token_usage_outbox
    BEGIN SELECT RAISE(ABORT, 'injected outbox write failure'); END
  `);
}

function failBudgetInsert(db: MemoryDb): void {
  db.db.exec(`
    CREATE TRIGGER fail_budget_insert BEFORE INSERT ON runtime_kv
    WHEN NEW.key = 'memory_byok_budget_v1'
    BEGIN SELECT RAISE(ABORT, 'injected budget write failure'); END
  `);
}

function createRecorder(
  fetchImpl: typeof fetch,
  overrides: ConstructorParameters<typeof HttpByokTokenUsageRecorder>[0] = {}
): {
  recorder: HttpByokTokenUsageRecorder;
  outbox: TokenUsageOutbox;
  ledger: MemoryTokenBudgetLedger;
} {
  const root = createRoot();
  const db = new MemoryDb({ path: join(root, "memory.sqlite") });
  const outbox = new TokenUsageOutbox(db.db);
  const store = new Map<string, unknown>();
  const nowFn = overrides.now ?? (() => new Date());
  const ledger = new MemoryTokenBudgetLedger({
    getKv(key) {
      return store.has(key) ? { value: store.get(key) } : undefined;
    },
    setKv(key, value) {
      store.set(key, value);
    }
  }, nowFn);
  const recorder = new HttpByokTokenUsageRecorder({
    outbox,
    transaction: (fn) => db.db.transaction(fn)(),
    onBudgetedUsage: (event) => ledger.addIfBudgeted({
      kind: event.kind,
      operation: event.operation,
      totalTokens: event.usage.totalTokens
    }),
    fetchImpl,
    runtimeConfig: { baseUrl: "http://127.0.0.1:18100", localToken: "runtime-token" },
    retryDelaysMs: [15],
    ...overrides
  });
  recorders.push(recorder);
  recorder.start();
  return { recorder, outbox, ledger };
}

function usageEvent(overrides: {
  kind?: MemoryModelUsageEvent["kind"];
  operation?: string;
  capability?: "memory_summary" | "memory_evolution" | "embedding";
  model?: string;
  totalTokens?: number;
  cachedInputTokens?: number;
} = {}): MemoryModelUsageEvent {
  const kind = overrides.kind ?? "memory_summary";
  const capability = overrides.capability ?? kind;
  const totalTokens = overrides.totalTokens ?? 30;
  const cachedInputTokens = overrides.cachedInputTokens ?? 0;
  return {
    kind,
    operation: overrides.operation ?? "episode.summarize",
    provider: "openai",
    model: overrides.model ?? "summary-model",
    actualModelContext: {
      presetId: `byok-${capability}`,
      provider: "openai",
      endpointId: capability === "embedding" ? "embedding" : "chat",
      protocol: capability === "embedding" ? "openai-embeddings" : "openai-chat-completions",
      model: overrides.model ?? "summary-model",
      source: "byok",
      ownerAccountId: null,
      capability,
      capabilities: [capability]
    },
    usage: {
      inputTokens: totalTokens,
      outputTokens: 0,
      cachedInputTokens,
      cacheCreationInputTokens: 0,
      totalTokens,
      rawUsage: {
        total_tokens: totalTokens,
        cache_read_input_tokens: cachedInputTokens
      }
    }
  };
}

function jsonResponse(body: unknown): Response {
  return new Response(JSON.stringify(body), {
    status: 200,
    headers: { "content-type": "application/json" }
  });
}

function createRoot(): string {
  const root = mkdtempSync(join(tmpdir(), "memmy-token-delivery-"));
  roots.push(root);
  return root;
}

async function waitFor(assert: () => boolean, timeoutMs = 400): Promise<void> {
  const started = Date.now();
  while (!assert()) {
    if (Date.now() - started > timeoutMs) {
      throw new Error("timed out waiting for token usage delivery");
    }
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
}
