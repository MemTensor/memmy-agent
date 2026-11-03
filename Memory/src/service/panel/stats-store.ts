export interface StoredStats<T> { data: T; generatedAt: string; safety: string; revision: string; day: string; bytes?:number }
export interface StatsStore<T> {
  load(key: string): Promise<StoredStats<T> | undefined>;
  save(key: string, value: StoredStats<T>): Promise<void>;
}
/** The HTTP thread only sends IPC. Persistence and serialization belong to the worker. */
export function statsStore<T>(run: <R>(method:string,args:unknown[])=>Promise<{data:R}>, section: string): StatsStore<T> {
  return {
    async load(key) { return (await run<StoredStats<T> | undefined>("statsLoad",[section,key])).data; },
    async save(key,value) { await run("statsSave",[section,key,value]); }
  };
}
