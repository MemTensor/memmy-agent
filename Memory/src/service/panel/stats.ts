import type { StatsStore } from "./stats-store.js";
import type { PanelReadModel } from "../read-model/panel-read.js";
import { resolveTimeZone } from "../../utils/time.js";
import { panelDateKey } from "../read-model/model-costs.js";
import type { RequestEnvelope } from "../../types.js";
type StatsInput = RequestEnvelope & { userId?: string };
export type PanelStatsData = {
  overview: ReturnType<PanelReadModel["panelOverviewSummary"]>;
  analysis: ReturnType<PanelReadModel["panelAnalysis"]>;
};
interface Entry<TData> {
  input: StatsInput;
  data?: TData;
  generatedAt?: string;
  safety: string;
  revision: string;
  running: boolean;
  error?: string;
  lastAttempt?: number;
  timer?: ReturnType<typeof setTimeout>;
  day: string;
  disposed: boolean;
  generation: number;
}
export class PanelStats<TData = PanelStatsData> {
  private entries = new Map<string, Entry<TData>>();
  private stopped = false;
  constructor(
    private readonly read: (input: StatsInput) => Promise<{ safety: string; data: TData }>,
    private readonly safety: () => string,
    private readonly revision: () => string = () => "0",
    private readonly store?: StatsStore<TData>
  ) {}
  get(input: StatsInput) {
    const timeZone = resolveTimeZone(input.timeZone);
    const key = JSON.stringify([input.namespace ?? {}, input.userId ?? null, timeZone]);
    let entry = this.entries.get(key);
    if (!entry) {
      entry = {
        input: { ...input, timeZone },
        running: false,
        day: this.day(timeZone),
        safety: this.safety(),
        revision: this.revision(),
        disposed: false,
        generation: 0
      };
      const saved = this.store?.load(key);
      if (saved && saved.safety === entry.safety && saved.day === entry.day && saved.revision.split(":")[0] === entry.revision.split(":")[0]) {
        entry.data = saved.data;
        entry.generatedAt = saved.generatedAt;
        entry.revision = saved.revision;
        if (saved.revision === this.revision()) entry.lastAttempt = Date.now();
      }
      this.entries.set(key, entry);
      if (this.entries.size > 16) {
        const oldKey = this.entries.keys().next().value!;
        this.dispose(this.entries.get(oldKey)!);
        this.entries.delete(oldKey);
      }
    }
    this.validate(entry);
    if (entry.revision !== this.revision() && !entry.running) {
      const remaining = 1000 - (Date.now() - (entry.lastAttempt ?? 0));
      if (remaining <= 0) entry.lastAttempt = undefined;
      else { clearTimeout(entry.timer); entry.timer = setTimeout(() => this.generate(entry), remaining); entry.timer.unref(); }
    }
    if (
      !entry.running &&
      (entry.lastAttempt === undefined || Date.now() - entry.lastAttempt >= (entry.error ? 60_000 : 5 * 60_000))
    )
      this.generate(entry);
    return {
      status: entry.error ? ("error" as const) : entry.data ? ("ready" as const) : ("preparing" as const),
      data: entry.data,
      generatedAt: entry.generatedAt,
      error: entry.error,
      serverTime: new Date().toISOString()
    };
  }
  private day(timeZone?: string) {
    return panelDateKey(new Date().toISOString(), resolveTimeZone(timeZone));
  }
  private validate(entry: Entry<TData>) {
    const safety = this.safety();
    const day = this.day(entry.input.timeZone);
    const revision = this.revision();
    if (entry.safety !== safety || entry.day !== day || entry.revision.split(":")[0] !== revision.split(":")[0]) {
      entry.generation++;
      entry.data = undefined;
      entry.generatedAt = undefined;
      entry.error = undefined;
      entry.day = day;
      entry.safety = safety;
      entry.revision = revision;
      entry.lastAttempt = undefined;
    }
  }
  private generate(entry: Entry<TData>) {
    if (this.stopped || entry.disposed || entry.running) return;
    this.validate(entry);
    entry.revision = this.revision();
    entry.running = true;
    entry.lastAttempt = Date.now();
    clearTimeout(entry.timer);
    const generation = entry.generation;
    void this.read(entry.input)
      .then((result) => {
        this.validate(entry);
        if (this.stopped || entry.disposed || generation !== entry.generation || result.safety !== entry.safety) return;
        entry.data = result.data;
        entry.generatedAt = new Date().toISOString();
        entry.error = undefined;
        const key = JSON.stringify([entry.input.namespace ?? {}, entry.input.userId ?? null, resolveTimeZone(entry.input.timeZone)]);
        try { this.store?.save(key, {data:entry.data,generatedAt:entry.generatedAt,safety:entry.safety,revision:entry.revision,day:entry.day}); }
        catch { /* Persistence failure must not discard valid in-memory statistics. */ }
      })
      .catch((error) => {
        this.validate(entry);
        if (!entry.disposed && generation === entry.generation)
          entry.error = error instanceof Error ? error.message : String(error);
      })
      .finally(() => {
        entry.running = false;
        if (!this.stopped && !entry.disposed) {
          // A result spanning midnight/reset cannot be published; retry with fresh scope.
          const delay = generation !== entry.generation ? 0 : entry.error ? 60_000
            : entry.revision !== this.revision() ? 1000 : 5 * 60_000;
          entry.timer = setTimeout(() => this.generate(entry), delay);
          entry.timer.unref();
        }
      });
  }
  private dispose(entry: Entry<TData>) {
    entry.disposed = true;
    entry.generation++;
    clearTimeout(entry.timer);
  }
  stop() {
    this.stopped = true;
    for (const entry of this.entries.values()) this.dispose(entry);
    this.entries.clear();
  }
}
