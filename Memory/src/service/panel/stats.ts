import type { PanelMemoryBudget } from "./memory-budget.js";
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
    private readonly read: (input: StatsInput) => Promise<{ safety: string; data: TData; bytes?:number }>,
    private readonly safety: () => string,
    private readonly revision: () => string = () => "0",
    private readonly store?: StatsStore<TData>,
    private readonly memory?:PanelMemoryBudget
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
      this.entries.set(key, entry);
      if(this.store) {
        entry.running=true;
        const current=entry, generation=current.generation;
        void this.store.load(key).then(saved=>{
          this.validate(current);
          if(this.stopped || current.disposed || generation!==current.generation)return;
          if(saved && saved.safety===current.safety && saved.day===current.day && saved.revision.split(":")[0]===current.revision.split(":")[0]) {
            this.account(current,saved.data,saved.bytes);
            current.data=saved.data;current.generatedAt=saved.generatedAt;current.revision=saved.revision;
            if(saved.revision===this.revision())current.lastAttempt=Date.now();
          }
        }).catch(()=>undefined).finally(()=>{
          current.running=false;
          if(!this.stopped && !current.disposed && current.lastAttempt===undefined)this.generate(current);
        });
      }
      if (this.entries.size > 16) {
        const oldKey = this.entries.keys().next().value!;
        this.dispose(this.entries.get(oldKey)!);
        this.entries.delete(oldKey);
      }
    }
    this.memory?.touch(entry);
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
      this.memory?.release(entry);
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
      .then(async (result) => {
        this.validate(entry);
        if (this.stopped || entry.disposed || generation !== entry.generation || result.safety !== entry.safety) return;
        const generatedAt=new Date().toISOString();
        const key=JSON.stringify([entry.input.namespace ?? {},entry.input.userId ?? null,resolveTimeZone(entry.input.timeZone)]);
        try {await this.store?.save(key,{data:result.data,generatedAt,safety:entry.safety,revision:entry.revision,day:entry.day,bytes:result.bytes});}
        catch { /* A failed cache write must not discard a safe in-memory result. */ }
        this.validate(entry);
        if(this.stopped || entry.disposed || generation!==entry.generation || result.safety!==entry.safety)return;
        this.account(entry,result.data,result.bytes);
        entry.data=result.data;entry.generatedAt=generatedAt;entry.error=undefined;
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
  private account(entry:Entry<TData>,data:TData,bytes?:number) {
    this.memory?.reserve(entry,bytes ?? Buffer.byteLength(JSON.stringify(data)),()=>{
      this.dispose(entry);
      for(const [key,value] of this.entries)if(value===entry)this.entries.delete(key);
    });
  }
  private dispose(entry: Entry<TData>) {
    this.memory?.release(entry);
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
