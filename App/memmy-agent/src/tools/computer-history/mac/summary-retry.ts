import fs from "node:fs";
import path from "node:path";
import { randomUUID } from "node:crypto";
import { z } from "zod";

export type SummaryFailureKind = "input" | "empty" | "invalid_response" | "transient" | "service" | "storage";
export const SUMMARY_RETRY_INTERVAL_MS = 60_000;
export const SUMMARY_MAX_ATTEMPTS = 5;
const delay = (failures: number) => Math.min(60_000 * 2 ** Math.min(failures - 1, 3), 300_000);
const timestamp = z.number().finite().nonnegative();
const stateSchema = z.object({
  version: z.literal(1),
  modelKey: z.string().nullable(),
  service: z.object({ failures: z.number().int().min(0).max(4), retryAt: timestamp }),
  streak: z.object({ kind: z.string(), ids: z.array(z.string()).max(3) }),
  items: z.record(z.string(), z.object({
    input: z.string(), attempts: z.number().int().min(1).max(SUMMARY_MAX_ATTEMPTS), retryAt: timestamp,
  })),
});
type RetryState = z.infer<typeof stateSchema>;
const emptyState = (): RetryState => ({ version: 1, modelKey: null,
  service: { failures: 0, retryAt: 0 }, streak: { kind: "", ids: [] }, items: {} });

/** Durable scheduling metadata only: never store evidence, credentials, or model responses. */
export class SummaryRetries {
  private state: RetryState | null = null;
  epoch = 0;
  constructor(private readonly file: string) {}

  private load(): RetryState {
    if (!this.state) {
      try {
        this.state = stateSchema.parse(JSON.parse(fs.readFileSync(this.file, "utf8")));
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== "ENOENT") {
          throw new Error("Computer History retry state is unreadable; automatic summaries are paused");
        }
        this.state = emptyState();
      }
    }
    return this.state;
  }

  private save(): void {
    fs.mkdirSync(path.dirname(this.file), { recursive: true, mode: 0o700 });
    const temporary = `${this.file}.${randomUUID()}.tmp`;
    try {
      fs.writeFileSync(temporary, JSON.stringify(this.load()), { encoding: "utf8", flag: "wx", mode: 0o600 });
      fs.renameSync(temporary, this.file);
    } finally {
      fs.rmSync(temporary, { force: true });
    }
  }

  setModel(key: string | undefined, changedInProcess: boolean): void {
    const state = this.load();
    if ((key !== undefined && state.modelKey !== null && state.modelKey !== key)
      || (key === undefined && changedInProcess)) {
      this.state = emptyState();
      this.epoch++;
    }
    if (key !== undefined && this.load().modelKey !== key) {
      this.load().modelKey = key;
      this.save();
    } else if (this.state !== state) this.save();
  }

  get retryAt(): number { return this.load().service.retryAt; }
  get needsProbe(): boolean { return this.load().service.failures > 0; }
  get stoppedCount(): number {
    return Object.values(this.load().items).filter(item => item.attempts >= SUMMARY_MAX_ATTEMPTS).length;
  }

  eligible(id: string, input: string): boolean {
    const state = this.load();
    const item = state.items[id];
    return Date.now() >= state.service.retryAt && (!item || item.input !== input
      || (item.attempts < SUMMARY_MAX_ATTEMPTS && Date.now() >= item.retryAt));
  }

  start(id: string, input: string): void {
    const state = this.load();
    const previous = state.items[id];
    const attempts = (previous?.input === input ? previous.attempts : 0) + 1;
    // Reserve before model access so restarting during a request cannot reset its retry budget.
    state.items[id] = { input, attempts, retryAt: Date.now() + delay(attempts) };
    this.save();
  }

  fail(id: string, input: string, kind: SummaryFailureKind): void {
    const state = this.load();
    const item = state.items[id];
    if (!item || item.input !== input) return;
    item.retryAt = Date.now() + delay(item.attempts);
    if (kind === "service") {
      // Shared outages do not exhaust an individual record's automatic retry budget.
      if (--item.attempts === 0) delete state.items[id];
    }
    const uncertain = ["empty", "invalid_response", "transient"].includes(kind);
    if (uncertain) {
      if (state.streak.kind !== kind) state.streak = { kind, ids: [] };
      state.streak.ids = [...new Set([...state.streak.ids, id])].slice(-3);
    } else state.streak = { kind: "", ids: [] };
    if (kind === "service" || state.streak.ids.length >= 3 || (state.service.failures > 0 && uncertain)) {
      state.service.failures = Math.min(state.service.failures + 1, 4);
      state.service.retryAt = Date.now() + delay(state.service.failures);
      this.epoch++;
    }
    this.save();
  }

  success(id: string, input: string, epoch: number): void {
    const state = this.load();
    if (state.items[id]?.input === input) delete state.items[id];
    // An older in-flight success cannot undo a newer service failure.
    if (epoch === this.epoch) {
      state.service = { failures: 0, retryAt: 0 };
      state.streak = { kind: "", ids: [] };
    }
    this.save();
  }

  remove(id: string): void {
    const state = this.load();
    if (!state.items[id]) return;
    delete state.items[id];
    this.save();
  }
}
