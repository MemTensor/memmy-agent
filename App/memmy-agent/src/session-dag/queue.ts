import type { SessionDagConfig } from "../config/schema.js";
import type { SessionManager } from "../core/session/manager.js";
import { SessionDagBuilder } from "./builder.js";
import { SessionDagStore } from "./store.js";
import type { DagTurnInput } from "./types.js";
import type { SessionDagUsageReporter } from "./usage.js";

export type SessionDagQueueManagerOptions = {
  config: SessionDagConfig;
  sessions: SessionManager;
  provider: () => any;
  model: () => string;
  usageReporter?: SessionDagUsageReporter | null;
};

export class SessionDagQueueManager {
  private readonly config: SessionDagConfig;
  private readonly sessions: SessionManager;
  private readonly provider: () => any;
  private readonly model: () => string;
  private readonly usageReporter: SessionDagUsageReporter | null;
  private readonly queues = new Map<string, SessionDagQueue>();
  private activeWorkers = 0;
  private readonly waiters: Array<() => void> = [];

  constructor(options: SessionDagQueueManagerOptions) {
    this.config = options.config;
    this.sessions = options.sessions;
    this.provider = options.provider;
    this.model = options.model;
    this.usageReporter = options.usageReporter ?? null;
  }

  enqueueSavedTurn(sessionKey: string, turn: DagTurnInput): void {
    this.queueFor(sessionKey).enqueue(turn);
  }

  wakeSession(sessionKey: string): void {
    this.queueFor(sessionKey).wake();
  }

  async waitUntilProcessed(sessionKey: string, turnId: string, timeoutMs: number): Promise<boolean> {
    const queue = this.queueFor(sessionKey);
    queue.wake();
    const deadline = Date.now() + Math.max(0, timeoutMs);
    while (Date.now() <= deadline) {
      if (queue.hasProcessedThrough(turnId)) return true;
      if (queue.hasBlockedBeforeOrAt(turnId)) return false;
      await sleep(100);
    }
    return queue.hasProcessedThrough(turnId);
  }

  closeAll(): void {
    for (const queue of this.queues.values()) queue.close();
    this.queues.clear();
  }

  async runWithSlot<T>(fn: () => Promise<T>): Promise<T> {
    if (this.activeWorkers >= this.config.maxConcurrentSessionQueues) {
      await new Promise<void>((resolve) => this.waiters.push(resolve));
    }
    this.activeWorkers += 1;
    try {
      return await fn();
    } finally {
      this.activeWorkers -= 1;
      this.waiters.shift()?.();
    }
  }

  createBuilder(sessionKey: string, store: SessionDagStore): SessionDagBuilder {
    return new SessionDagBuilder({
      sessionKey,
      sessions: this.sessions,
      store,
      provider: this.provider(),
      model: this.model(),
      maxBuilderContextNodes: this.config.maxBuilderContextNodes,
      usageReporter: this.usageReporter,
      debugLog: this.config.debugLog,
    });
  }

  retryDelayMs(attemptCount: number): number {
    const idx = Math.max(0, Math.min(attemptCount, this.config.retryBackoffMs.length - 1));
    return this.config.retryBackoffMs[idx] ?? 90_000;
  }

  maxUpdateAttempts(): number {
    return this.config.maxUpdateAttempts;
  }

  private queueFor(sessionKey: string): SessionDagQueue {
    let queue = this.queues.get(sessionKey);
    if (!queue) {
      queue = new SessionDagQueue(sessionKey, this);
      this.queues.set(sessionKey, queue);
    }
    return queue;
  }
}

class SessionDagQueue {
  private readonly store: SessionDagStore;
  private running = false;
  private closed = false;
  private storeClosed = false;
  private retryTimer: ReturnType<typeof setTimeout> | null = null;

  constructor(
    private readonly sessionKey: string,
    private readonly manager: SessionDagQueueManager,
  ) {
    this.store = new SessionDagStore({ sessionKey });
  }

  enqueue(turn: DagTurnInput): void {
    if (this.closed) return;
    this.store.upsertTurn(turn);
    this.wake();
  }

  wake(): void {
    if (this.closed) return;
    if (this.retryTimer) {
      clearTimeout(this.retryTimer);
      this.retryTimer = null;
    }
    if (this.running) return;
    this.running = true;
    void this.manager.runWithSlot(() => this.process()).finally(() => {
      this.running = false;
      if (this.closed) this.closeStore();
    });
  }

  hasProcessedThrough(turnId: string): boolean {
    const target = this.store.getTurn(turnId);
    if (!target) return false;
    const processedId = this.store.getMeta("last_processed_turn_id");
    if (!processedId) return false;
    const processed = this.store.getTurn(processedId);
    return Boolean(processed && processed.message_end >= target.message_end);
  }

  hasBlockedBeforeOrAt(turnId: string): boolean {
    const target = this.store.getTurn(turnId);
    if (!target) return false;
    return this.store.listTurns(["blocked"]).some((turn) => turn.message_start <= target.message_start);
  }

  close(): void {
    this.closed = true;
    if (this.retryTimer) clearTimeout(this.retryTimer);
    this.retryTimer = null;
    if (!this.running) this.closeStore();
  }

  private async process(): Promise<void> {
    while (!this.closed) {
      const turn = this.store.claimNextTurn();
      if (!turn) return;
      const builder = this.manager.createBuilder(this.sessionKey, this.store);
      try {
        await builder.buildAndApply(turn);
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        if (turn.attempt_count + 1 < this.maxUpdateAttempts()) {
          const delayMs = this.manager.retryDelayMs(turn.attempt_count);
          this.store.markTurnRetry(turn.turn_id, message, new Date(Date.now() + delayMs).toISOString());
          this.scheduleRetry(delayMs);
          return;
        }
        try {
          builder.applyDeterministicFallback(turn);
        } catch (fallbackError) {
          const fallbackMessage = fallbackError instanceof Error ? fallbackError.message : String(fallbackError);
          this.store.markTurnBlocked(turn.turn_id, fallbackMessage, new Date(Date.now() + this.manager.retryDelayMs(0)).toISOString());
          this.scheduleRetry(this.manager.retryDelayMs(0));
          return;
        }
      }
    }
  }

  private scheduleRetry(delayMs: number): void {
    if (this.closed) return;
    if (this.retryTimer) clearTimeout(this.retryTimer);
    this.retryTimer = setTimeout(() => {
      this.retryTimer = null;
      this.wake();
    }, delayMs);
    this.retryTimer.unref?.();
  }

  private maxUpdateAttempts(): number {
    return this.manager.maxUpdateAttempts();
  }

  private closeStore(): void {
    if (this.storeClosed) return;
    this.storeClosed = true;
    this.store.close();
  }
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
