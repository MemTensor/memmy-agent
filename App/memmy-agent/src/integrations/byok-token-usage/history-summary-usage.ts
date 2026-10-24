import { randomUUID } from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import type { LLMResponse } from "../../providers/base.js";
import { normalizeByokTokenUsage } from "./normalizer.js";
import type { ByokTokenUsageEvent, HistorySummaryUsageClient } from "./types.js";

type SummaryContext = { presetId: string; provider: string; model: string };
type Entry = { state: "intent" | "unresolved"; id: string; context: SummaryContext; createdAt: string }
  | { state: "event"; event: ByokTokenUsageEvent };
type Outbox = { version: 1; entries: Entry[] };
type SharedState = { tail: Promise<void>; pendingWrite?: Outbox };

// Assignment changes construct new providers. Their accounting and budget
// checks must still share one queue and serialize each actual paid attempt.
const sharedStates = new Map<string, SharedState>();

export class HistorySummaryUsageBlockedError extends Error {
  constructor(reason: "accounting_unavailable" | "budget_unavailable" | "budget_paused") {
    super(`history_summary_${reason}`);
    this.name = "HistorySummaryUsageBlockedError";
  }
}

export class HistorySummaryUsageGuard {
  private readonly outboxPath: string;
  private readonly shared: SharedState;

  constructor(private readonly options: { client: HistorySummaryUsageClient; outboxPath: string }) {
    this.outboxPath = path.resolve(options.outboxPath);
    let shared = sharedStates.get(this.outboxPath);
    if (!shared) {
      shared = { tail: Promise.resolve() };
      sharedStates.set(this.outboxPath, shared);
    }
    this.shared = shared;
  }

  async run(context: SummaryContext, operation: () => Promise<LLMResponse>, signal?: AbortSignal | null): Promise<LLMResponse> {
    const prior = this.shared.tail;
    let release!: () => void;
    this.shared.tail = new Promise<void>((resolve) => { release = resolve; });
    await prior;
    try {
      signal?.throwIfAborted();
      return await this.runAttempt(context, operation, signal);
    } finally {
      release();
    }
  }

  private async runAttempt(context: SummaryContext, operation: () => Promise<LLMResponse>, signal?: AbortSignal | null): Promise<LLMResponse> {
    let box: Outbox;
    try {
      if (this.shared.pendingWrite) this.save(this.shared.pendingWrite);
      box = this.read();
      // After a crash there may be no real usage to recover. Preserve this
      // diagnostic metadata without inventing tokens or permanently blocking
      // future summaries. Paid events with known usage still must be uploaded.
      if (box.entries.some((entry) => entry.state === "intent")
        || box.entries.filter((entry) => entry.state === "unresolved").length > 100) {
        box = retainUnresolved({ version: 1, entries: box.entries.map((entry) => entry.state === "intent"
          ? { ...entry, state: "unresolved" } : entry) });
        this.save(box);
      }
      // Upload all recoverable usage first. Stable event IDs make retries safe
      // even if the previous process exited after POST but before deletion.
      for (const entry of [...box.entries]) {
        if (entry.state !== "event") continue;
        await this.options.client.recordEvent(entry.event, { requireRuntime: true });
        box = { version: 1, entries: box.entries.filter((candidate) => candidate !== entry) };
        this.save(box);
      }
    } catch (error) {
      if (error instanceof HistorySummaryUsageBlockedError) throw error;
      throw new HistorySummaryUsageBlockedError("accounting_unavailable");
    }

    let budget;
    try {
      budget = await this.options.client.getMemoryBudget();
      if (budget.stale) throw new Error("stale");
    } catch {
      throw new HistorySummaryUsageBlockedError("budget_unavailable");
    }
    if (budget.paused
      || (budget.dailyLimitM > 0 && budget.dailyUsed >= budget.dailyLimitM * 1_000_000)
      || (budget.totalLimitM > 0 && budget.lifetimeUsed >= budget.totalLimitM * 1_000_000)) {
      throw new HistorySummaryUsageBlockedError("budget_paused");
    }
    signal?.throwIfAborted();

    const id = randomUUID();
    const createdAt = new Date().toISOString();
    const intent: Entry = { state: "intent", id, context: cleanContext(context), createdAt };
    const attemptedBox: Outbox = { version: 1, entries: [...box.entries, intent] };
    try {
      this.save(attemptedBox);
    } catch {
      // No model request has started. Recover the prior state before
      // allowing another request, including a rename/fsync partial failure.
      this.shared.pendingWrite = box;
      throw new HistorySummaryUsageBlockedError("accounting_unavailable");
    }

    let response: LLMResponse;
    try {
      response = await operation();
    } catch (error) {
      try {
        this.save(retainUnresolved({ version: 1, entries: attemptedBox.entries.map((entry) => entry === intent
          ? { ...intent, state: "unresolved" } : entry) }));
      } catch {
        // The intent remains durable and becomes unresolved on recovery.
      }
      throw error;
    }
    const usage = normalizeByokTokenUsage(response.usage);
    const event = usage ? {
      id,
      operationId: id,
      kind: "memory_summary" as const,
      source: "memory" as const,
      capability: "memory_summary" as const,
      presetId: intent.context.presetId,
      provider: cleanIdentifier(response.actualProvider ?? intent.context.provider),
      model: cleanIdentifier(response.actualModel ?? intent.context.model),
      ...usage,
      // Providers may put arbitrary response fields inside raw usage. Retain
      // only token counters; never persist prompt text, credentials or config.
      rawUsage: tokenCounters(usage),
      metadata: { operation: "history.summary" },
      createdAt,
    } satisfies ByokTokenUsageEvent : null;

    try {
      this.save(retainUnresolved({ version: 1, entries: [...box.entries, event
        ? { state: "event", event } : { ...intent, state: "unresolved" }] }));
      if (event) {
        await this.options.client.recordEvent(event, { requireRuntime: true });
        this.save(box);
      }
    } catch {
      // A completed model result remains usable. Any known usage remains
      // queued (or pending persistence in process) for the next accounting
      // attempt; do not repeat this completed model request.
    }
    return response;
  }

  private read(): Outbox {
    if (!fs.existsSync(this.outboxPath)) return { version: 1, entries: [] };
    const parsed = JSON.parse(fs.readFileSync(this.outboxPath, "utf8"));
    if (parsed?.version !== 1 || !Array.isArray(parsed.entries)) throw new Error("invalid_outbox");
    const entries: Entry[] = parsed.entries.map((entry: any) => {
      if (entry?.state === "intent" || entry?.state === "unresolved") {
        return { state: entry.state, id: cleanId(entry.id), context: cleanContext(entry.context), createdAt: cleanDate(entry.createdAt) };
      }
      if (entry?.state !== "event") throw new Error("invalid_outbox");
      const event = entry.event;
      if (event?.kind !== "memory_summary" || event.source !== "memory" || event.capability !== "memory_summary"
        || event.metadata?.operation !== "history.summary") throw new Error("invalid_outbox");
      const id = cleanId(event.id);
      const context = cleanContext(event);
      const counters = {
        inputTokens: cleanCounter(event.inputTokens), outputTokens: cleanCounter(event.outputTokens),
        totalTokens: cleanCounter(event.totalTokens), cachedInputTokens: cleanCounter(event.cachedInputTokens),
        cacheCreationInputTokens: cleanCounter(event.cacheCreationInputTokens),
      };
      return { state: "event", event: {
        id, operationId: id, ...context, kind: "memory_summary", source: "memory", capability: "memory_summary",
        ...counters, rawUsage: tokenCounters(counters), metadata: { operation: "history.summary" }, createdAt: cleanDate(event.createdAt),
      } };
    });
    return { version: 1, entries };
  }

  private save(box: Outbox): void {
    this.shared.pendingWrite = box;
    const dir = path.dirname(this.outboxPath);
    fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
    fs.chmodSync(dir, 0o700);
    const temporary = path.join(dir, `.outbox-${randomUUID()}.tmp`);
    let fd: number | undefined;
    try {
      fd = fs.openSync(temporary, "wx", 0o600);
      fs.writeFileSync(fd, JSON.stringify(box), "utf8");
      fs.fsyncSync(fd);
      fs.closeSync(fd);
      fd = undefined;
      fs.renameSync(temporary, this.outboxPath);
      // Directory syncing is unsupported by Windows. The file itself is
      // already synced before atomic replacement on both platforms.
      if (process.platform !== "win32") {
        const dirFd = fs.openSync(dir, "r");
        try { fs.fsyncSync(dirFd); } finally { fs.closeSync(dirFd); }
      }
      this.shared.pendingWrite = undefined;
    } finally {
      if (fd !== undefined) fs.closeSync(fd);
      if (fs.existsSync(temporary)) fs.unlinkSync(temporary);
    }
  }
}

function retainUnresolved(box: Outbox): Outbox {
  const latest = new Set(box.entries.filter((entry) => entry.state === "unresolved")
    .sort((left, right) => Date.parse((left as Exclude<Entry, { state: "event" }>).createdAt)
      - Date.parse((right as Exclude<Entry, { state: "event" }>).createdAt)).slice(-100));
  return { version: 1, entries: box.entries.filter((entry) => entry.state !== "unresolved" || latest.has(entry)) };
}

function cleanContext(context: SummaryContext): SummaryContext {
  return { presetId: cleanIdentifier(context?.presetId), provider: cleanIdentifier(context?.provider), model: cleanIdentifier(context?.model) };
}

function cleanIdentifier(value: unknown): string {
  if (typeof value !== "string" || !value.trim() || value.length > 1_024) throw new Error("invalid_usage_identifier");
  return value.trim();
}

function cleanId(value: unknown): string {
  const id = cleanIdentifier(value);
  if (!/^[\da-f]{8}-(?:[\da-f]{4}-){3}[\da-f]{12}$/iu.test(id)) throw new Error("invalid_usage_id");
  return id;
}

function cleanDate(value: unknown): string {
  const date = cleanIdentifier(value);
  if (!Number.isFinite(Date.parse(date))) throw new Error("invalid_usage_date");
  return date;
}

function cleanCounter(value: unknown): number {
  if (typeof value !== "number" || !Number.isSafeInteger(value) || value < 0) throw new Error("invalid_usage_counter");
  return value;
}

function tokenCounters(usage: { inputTokens: number; outputTokens: number; totalTokens: number; cachedInputTokens: number; cacheCreationInputTokens: number }): Record<string, number> {
  return {
    prompt_tokens: usage.inputTokens, completion_tokens: usage.outputTokens, total_tokens: usage.totalTokens,
    cached_tokens: usage.cachedInputTokens, cache_creation_input_tokens: usage.cacheCreationInputTokens,
  };
}
