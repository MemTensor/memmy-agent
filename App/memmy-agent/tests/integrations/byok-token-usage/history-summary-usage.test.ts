import fs from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { randomUUID } from "node:crypto";
import { afterEach, describe, expect, it, vi } from "vitest";
import { LLMResponse } from "../../../src/providers/base.js";
import { HistorySummaryUsageGuard } from "../../../src/integrations/byok-token-usage/history-summary-usage.js";
import type { HistorySummaryUsageClient } from "../../../src/integrations/byok-token-usage/types.js";

const directories: string[] = [];
afterEach(() => {
  vi.restoreAllMocks();
  for (const dir of directories.splice(0)) fs.rmSync(dir, { recursive: true, force: true });
});

function fixture() {
  const dir = fs.mkdtempSync(path.join(tmpdir(), "history-summary-billing-"));
  directories.push(dir);
  const outboxPath = path.join(dir, "queue", "outbox.json");
  const recordEvent = vi.fn<HistorySummaryUsageClient["recordEvent"]>(async () => undefined);
  const getMemoryBudget = vi.fn<HistorySummaryUsageClient["getMemoryBudget"]>(async () => ({
    dailyLimitM: 10, totalLimitM: 500, dailyUsed: 0, lifetimeUsed: 0,
    paused: false, trigger: null, nextLocalMidnightAt: "2026-10-14T00:00:00.000Z",
  }));
  const options = { outboxPath, client: { recordEvent, getMemoryBudget } };
  return { ...options, dir, recordEvent, getMemoryBudget, guard: new HistorySummaryUsageGuard(options) };
}

const context = { presetId: "byok-cheap-summary", provider: "openai", model: "small-text-model" };
const response = () => new LLMResponse({ content: "Already generated summary", usage: {
  prompt_tokens: 100, completion_tokens: 20, total_tokens: 120, cached_tokens: 5,
  credentials: "must-not-persist", messages: [{ content: "must-not-persist" }],
} });

describe("History summary BYOK budget and durable usage", () => {
  it("records the actual summary role and identifiers, preserving only token metadata", async () => {
    const { guard, recordEvent, getMemoryBudget, outboxPath } = fixture();
    const call = vi.fn(async () => new LLMResponse({ ...response(), actualProvider: "alternate-provider", actualModel: "resolved-small-model" }));
    await expect(guard.run(context, call)).resolves.toMatchObject({ content: "Already generated summary" });
    expect(getMemoryBudget).toHaveBeenCalledTimes(1);
    expect(recordEvent).toHaveBeenCalledWith(expect.objectContaining({
      kind: "memory_summary", source: "memory", capability: "memory_summary", presetId: context.presetId,
      provider: "alternate-provider", model: "resolved-small-model", totalTokens: 120,
      metadata: { operation: "history.summary" },
    }), { requireRuntime: true });
    const event = recordEvent.mock.calls[0][0];
    expect(event.operationId).toBe(event.id);
    expect(JSON.stringify(event)).not.toContain("must-not-persist");
    expect(JSON.parse(fs.readFileSync(outboxPath, "utf8")).entries).toEqual([]);
    if (process.platform !== "win32") {
      expect(fs.statSync(path.dirname(outboxPath)).mode & 0o777).toBe(0o700);
      expect(fs.statSync(outboxPath).mode & 0o777).toBe(0o600);
    }
  });

  it.each(["paused", "daily", "total", "stale", "unavailable"])("fails closed before provider calls for %s budget", async (state) => {
    const { guard, getMemoryBudget, recordEvent, outboxPath } = fixture();
    const budget = await getMemoryBudget();
    getMemoryBudget.mockClear();
    if (state === "unavailable") getMemoryBudget.mockRejectedValue(new Error("private upstream error"));
    else getMemoryBudget.mockResolvedValue({ ...budget,
      paused: state === "paused", stale: state === "stale",
      dailyUsed: state === "daily" ? 10_000_000 : 0,
      lifetimeUsed: state === "total" ? 500_000_000 : 0,
    });
    const call = vi.fn(async () => response());
    await expect(guard.run(context, call)).rejects.toThrow(/history_summary_budget_/u);
    expect(call).not.toHaveBeenCalled();
    expect(recordEvent).not.toHaveBeenCalled();
    expect(fs.existsSync(outboxPath)).toBe(false);
  });

  it("returns a completed result when POST fails, blocks new generation, and restores the same event after restart", async () => {
    const { guard, recordEvent, getMemoryBudget, outboxPath, client } = fixture();
    recordEvent.mockRejectedValue(new Error("local service down"));
    const call = vi.fn(async () => response());
    await expect(guard.run(context, call)).resolves.toMatchObject({ content: "Already generated summary" });
    expect(call).toHaveBeenCalledTimes(1);
    const saved = JSON.parse(fs.readFileSync(outboxPath, "utf8"));
    expect(saved.entries[0].state).toBe("event");
    const eventId = saved.entries[0].event.id;
    const restarted = new HistorySummaryUsageGuard({ outboxPath, client });
    const nextCall = vi.fn(async () => response());
    await expect(restarted.run({ ...context, model: "new-summary-assignment" }, nextCall)).rejects.toThrow("accounting_unavailable");
    expect(nextCall).not.toHaveBeenCalled();
    expect(getMemoryBudget).toHaveBeenCalledTimes(1);
    expect(recordEvent.mock.calls[1][0].id).toBe(eventId);
    recordEvent.mockResolvedValue(undefined);
    await restarted.run({ ...context, model: "new-summary-assignment" }, nextCall);
    expect(recordEvent.mock.calls[2][0].id).toBe(eventId);
    expect(recordEvent.mock.calls[2][0].model).toBe(context.model);
    expect(nextCall).toHaveBeenCalledTimes(1);
    expect(call).toHaveBeenCalledTimes(1);
  });

  it("uses stable IDs if an event was accepted but the acknowledgement was lost", async () => {
    const { guard, recordEvent } = fixture();
    const billedIds = new Set<string>();
    recordEvent.mockImplementationOnce(async (event) => {
      billedIds.add(event.id);
      throw new Error("ack lost");
    });
    await guard.run(context, async () => response());
    recordEvent.mockImplementation(async (event) => { billedIds.add(event.id); });
    await guard.run(context, async () => new LLMResponse({ content: "No billed usage in next result" }));
    expect(recordEvent).toHaveBeenCalledTimes(2);
    expect(billedIds.size).toBe(1);
  });

  it("counts usage even on an error response and checks the next budget before a retry", async () => {
    const { guard, recordEvent, getMemoryBudget } = fixture();
    await guard.run(context, async () => new LLMResponse({ content: "overloaded", finishReason: "error", usage: { prompt_tokens: 12 } }));
    expect(recordEvent.mock.calls[0][0].totalTokens).toBe(12);
    const budget = await getMemoryBudget();
    getMemoryBudget.mockResolvedValue({ ...budget, paused: true, trigger: "daily" });
    const retry = vi.fn(async () => response());
    await expect(guard.run(context, retry)).rejects.toThrow("budget_paused");
    expect(retry).not.toHaveBeenCalled();
  });

  it.each([undefined, {}, { prompt_tokens: 0, completion_tokens: 0 }, { prompt_tokens: -1, completion_tokens: "invalid", total_tokens: Infinity }])(
    "does not invent billing for absent, zero or invalid usage: %j", async (usage) => {
      const { guard, recordEvent, outboxPath } = fixture();
      await guard.run(context, async () => new LLMResponse({ content: "summary", usage }));
      expect(recordEvent).not.toHaveBeenCalled();
      expect(JSON.parse(fs.readFileSync(outboxPath, "utf8")).entries).toEqual([
        expect.objectContaining({ state: "unresolved", context }),
      ]);
    },
  );

  it("never calls a model if the pre-call intent cannot be persisted", async () => {
    const { guard } = fixture();
    const open = vi.spyOn(fs, "openSync").mockImplementation(() => { throw new Error("disk full"); });
    const call = vi.fn(async () => response());
    await expect(guard.run(context, call)).rejects.toThrow("accounting_unavailable");
    expect(call).not.toHaveBeenCalled();
    open.mockRestore();
    await guard.run(context, call);
    expect(call).toHaveBeenCalledTimes(1);
  });

  it.each(["queued", "budget"])("does not leave an uncertain intent when cancelled during %s preparation", async (stage) => {
    const { guard, getMemoryBudget, outboxPath } = fixture();
    const controller = new AbortController();
    const budget = await getMemoryBudget();
    getMemoryBudget.mockClear();
    if (stage === "queued") controller.abort();
    else getMemoryBudget.mockImplementation(async () => { controller.abort(); return budget; });
    const call = vi.fn(async () => response());
    await expect(guard.run(context, call, controller.signal)).rejects.toMatchObject({ name: "AbortError" });
    expect(call).not.toHaveBeenCalled();
    expect(fs.existsSync(outboxPath)).toBe(false);
  });

  it("retains an intent if usage persistence fails, recovers usage in process, and never repeats the completed request", async () => {
    const { guard, recordEvent, outboxPath } = fixture();
    const rename = fs.renameSync.bind(fs);
    const spy = vi.spyOn(fs, "renameSync").mockImplementationOnce(rename).mockImplementation(() => { throw new Error("disk full"); });
    const call = vi.fn(async () => response());
    await expect(guard.run(context, call)).resolves.toMatchObject({ content: "Already generated summary" });
    expect(JSON.parse(fs.readFileSync(outboxPath, "utf8")).entries[0].state).toBe("intent");
    const next = vi.fn(async () => response());
    await expect(guard.run(context, next)).rejects.toThrow("accounting_unavailable");
    expect(next).not.toHaveBeenCalled();
    expect(recordEvent).not.toHaveBeenCalled();
    spy.mockRestore();
    await guard.run(context, next);
    expect(call).toHaveBeenCalledTimes(1);
    expect(next).toHaveBeenCalledTimes(1);
    expect(recordEvent).toHaveBeenCalledTimes(2);
  });

  it("recovers after restart with an unfinished intent without inventing usage", async () => {
    const { guard, outboxPath, recordEvent } = fixture();
    const id = randomUUID();
    fs.mkdirSync(path.dirname(outboxPath), { recursive: true });
    fs.writeFileSync(outboxPath, JSON.stringify({ version: 1, entries: [{ state: "intent", id, context, createdAt: new Date().toISOString() }] }));
    const call = vi.fn(async () => response());
    await expect(guard.run(context, call)).resolves.toMatchObject({ content: "Already generated summary" });
    expect(call).toHaveBeenCalledTimes(1);
    expect(recordEvent).toHaveBeenCalledTimes(1);
    expect(recordEvent.mock.calls[0][0].id).not.toBe(id);
    expect(JSON.parse(fs.readFileSync(outboxPath, "utf8")).entries).toEqual([
      expect.objectContaining({ state: "unresolved", id, context }),
    ]);
  });

  it.each(["network error", "cancelled request"])("preserves metadata but permits the next call after a %s", async (kind) => {
    const { guard, outboxPath, recordEvent } = fixture();
    const failure = kind === "network error" ? new Error("network connection lost") : new DOMException("cancelled", "AbortError");
    const failedCall = vi.fn(async (): Promise<LLMResponse> => { throw failure; });
    await expect(guard.run(context, failedCall)).rejects.toBe(failure);
    expect(recordEvent).not.toHaveBeenCalled();
    const unresolved = JSON.parse(fs.readFileSync(outboxPath, "utf8")).entries[0];
    expect(unresolved).toMatchObject({ state: "unresolved", context });
    const nextCall = vi.fn(async () => response());
    await expect(guard.run({ ...context, model: "new-model" }, nextCall)).resolves.toMatchObject({ content: "Already generated summary" });
    expect(failedCall).toHaveBeenCalledTimes(1);
    expect(nextCall).toHaveBeenCalledTimes(1);
    expect(recordEvent).toHaveBeenCalledTimes(1);
    expect(recordEvent.mock.calls[0][0]).toMatchObject({ totalTokens: 120, model: "new-model" });
    expect(JSON.parse(fs.readFileSync(outboxPath, "utf8")).entries).toEqual([unresolved]);
  });

  it("retains the latest 100 unknown attempts without losing or estimating known queued usage", async () => {
    const { guard, outboxPath, recordEvent } = fixture();
    recordEvent.mockRejectedValueOnce(new Error("upload unavailable"));
    await guard.run(context, async () => response());
    const queued = JSON.parse(fs.readFileSync(outboxPath, "utf8"));
    const eventId = queued.entries[0].event.id;
    const intents = Array.from({ length: 105 }, (_, index) => ({ state: "intent", id: randomUUID(), context,
      createdAt: new Date(Date.parse("2026-10-01T00:00:00.000Z") + index * 1_000).toISOString() }));
    fs.writeFileSync(outboxPath, JSON.stringify({ version: 1, entries: [...intents, ...queued.entries] }));
    await guard.run(context, async () => new LLMResponse({ content: "unknown usage" }));
    expect(recordEvent).toHaveBeenCalledTimes(2);
    expect(recordEvent.mock.calls[1][0].id).toBe(eventId);
    const saved = JSON.parse(fs.readFileSync(outboxPath, "utf8")).entries;
    expect(saved).toHaveLength(100);
    expect(saved.every((entry: any) => entry.state === "unresolved")).toBe(true);
    expect(saved.some((entry: any) => entry.id === intents[0].id)).toBe(false);
    expect(saved.some((entry: any) => entry.id === intents[104].id)).toBe(true);
    expect(saved.some((entry: any) => entry.state === "event")).toBe(false);
  });

  it("serializes attempts across providers so the second sees usage from the first", async () => {
    const { guard, client, outboxPath, getMemoryBudget, recordEvent } = fixture();
    const nextGuard = new HistorySummaryUsageGuard({ outboxPath, client });
    let resolve!: (response: LLMResponse) => void;
    const firstCall = vi.fn(() => new Promise<LLMResponse>((done) => { resolve = done; }));
    const first = guard.run(context, firstCall);
    await vi.waitFor(() => expect(firstCall).toHaveBeenCalledTimes(1));
    const secondCall = vi.fn(async () => response());
    const second = nextGuard.run({ ...context, model: "changed-model" }, secondCall);
    recordEvent.mockImplementation(async () => {
      const budget = await getMemoryBudget();
      getMemoryBudget.mockResolvedValue({ ...budget, paused: true, trigger: "total" });
    });
    resolve(response());
    await first;
    await expect(second).rejects.toThrow("budget_paused");
    expect(secondCall).not.toHaveBeenCalled();
  });
});
