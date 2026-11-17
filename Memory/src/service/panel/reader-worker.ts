import { isSqliteBusy } from "./write-coordinator.js";
import { openPanelCache } from "../../storage/panel-cache-db.js";
import { sourceVersion } from "../../storage/source-changes.js";
import { loadStatistics, saveStatistics, clearLegacyStatistics } from "./stats-worker-store.js";
import { syncPanelCacheBatch, fillPanelCacheBatch, panelMemoryStats, type PanelCachePart } from "../../storage/panel-cache.js";
import { parentPort, workerData } from "node:worker_threads";
import { MemoryDb } from "../../storage/db.js";
import { createPanelReaderModel } from "./reader-model.js";
import { panelSafetyToken } from "../../storage/panel-security.js";
import { MemoryServiceError } from "../../utils/error.js";
import { setImmediate } from "node:timers/promises";
import type { PanelReadModel } from "../read-model/panel-read.js";
const db = new MemoryDb({ path: workerData.path, readonly: true });
const cacheWriter = openPanelCache(db.db,workerData.path);
const model = createPanelReaderModel(db);
function partsFor(method: string,args: unknown[]): PanelCachePart[] {
  if (["stats", "analysis"].includes(method))
    return ["memories", "metrics"];
  if (["overview", "overviewStats"].includes(method))
    return ["memories"];
  if (["items","members","page"].includes(method)) {
    const input=args[method==="page"?1:0] as {section?:string;layer?:string} | undefined;
    if (input?.section!=="tasks" && input?.layer!=="UserMemory") return ["memories"];
  }
  if (method === "logs") {
    return ["logs", "visibility"];
  }
  return [];
}
let stopping = false;
let running = false;
function checkStopped() { if (stopping) throw new Error("Panel reader stopped"); }
function closeWorker() {
  if (db.db.inTransaction) db.db.exec("ROLLBACK");
  cacheWriter.close(); db.db.close(); parentPort!.close();
}
async function writeBatch<T>(operation: () => T): Promise<T> {
  for (let attempt=0;;attempt++) {
    try {checkStopped();return operation();}
    catch(error) {if(attempt>=3 || !isSqliteBusy(error))throw error;}
    await new Promise(resolve=>setTimeout(resolve,25*2**attempt));
  }
}
async function prepare(parts:PanelCachePart[],target:number) {
  while(await writeBatch(()=>syncPanelCacheBatch(db.db,target))) {checkStopped();await setImmediate();}
  for(const part of parts)while(await writeBatch(()=>fillPanelCacheBatch(db.db,part,128))) {checkStopped();await setImmediate();}
}
async function statistics(method: "stats" | "overviewStats", input: Parameters<PanelReadModel["panelStatistics"]>[0]) {
  const safety = panelSafetyToken(db.db);
  const rows = [];
  for (const row of panelMemoryStats(db.db,true)) {
    rows.push(row);
    // Worker termination cannot interrupt a single large native .all().
    // Keep one read snapshot, but allow cancellation every bounded batch.
    if (rows.length % 256 === 0) {
      await setImmediate(); checkStopped();
    }
  }
  const data = method === "overviewStats"
    ? model.panelOverviewSummary(input, rows)
    : model.panelStatistics(input, rows,true);
  return { safety, data };
}
parentPort!.on("message", async ({ id, method, args, stop }) => {
  if (stop) { stopping=true;if(!running)closeWorker();return; }
  running = true;
  try {
    checkStopped();
    const initialSafety=panelSafetyToken(db.db);
    if(method==="statsLoad" || method==="statsSave") {
      const state=cacheWriter.prepare("SELECT identity,generation,seq FROM panel_sync_state").get() as {identity:string;generation:number;seq:number};
      const version=sourceVersion(db.db);
      if(state.identity!==version.identity || state.generation!==version.generation || state.seq>version.seq || state.seq<version.floor)
        await writeBatch(()=>syncPanelCacheBatch(db.db,version.seq));
      let data;
      if(method==="statsLoad")data=loadStatistics(db.db,cacheWriter,workerData.path,args[0],args[1]);
      else if(args[2]?.safety===initialSafety)saveStatistics(cacheWriter,args[0],args[1],args[2]);
      parentPort!.postMessage({id,result:{safety:initialSafety,data}});
      return;
    }
    if(method==="cacheClear")clearLegacyStatistics(workerData.path);
    const target=sourceVersion(db.db).seq;
    await prepare(partsFor(method,args),target);
    if(method==="logDetail") {
      while(await writeBatch(()=>fillPanelCacheBatch(db.db,"logs",128,[args[0]])))await setImmediate();
      while(await writeBatch(()=>fillPanelCacheBatch(db.db,"visibility",128)))await setImmediate();
    }
    db.db.exec("BEGIN");
    checkStopped();
    if(panelSafetyToken(db.db)!==initialSafety)throw new MemoryServiceError("conflict","Panel visibility changed during preparation");
    const result = method === "stats" || method === "overviewStats"
      ? await statistics(method, args[0])
      : (() => {
        const safety = panelSafetyToken(db.db);
        switch (method) {
          case "cacheClear":
            return {safety,data:undefined};
          case "members":
            return { safety, data: model.panelMembers(args[0]) };
          case "page":
            return { safety, data: model.panelPageByIds(args[0], args[1]) };
          case "items":
            return { safety, data: model.panelItems(args[0]) };
          case "tasks":
            return { safety, data: model.panelTaskSummaries(args[0]) };
          case "taskCheck":
            return { safety, data: model.panelTaskCheck(args[0], args[1]) };
          case "detail":
            return { safety, data: model.panelTaskDetail(args[0], args[1]) };
          case "field":
            return { safety, data: model.panelTaskField(args[0], args[1], args[2], args[3]) };
          case "logs":
            return { safety, data: model.panelLogs(args[0], args[1]) };
          case "logDetail":
            return { safety, data: model.panelLogDetail(args[0],args[1]) };
          case "overview":
            return { safety, data: model.panelOverviewSummary(args[0]) };
          case "analysis":
            return { safety, data: model.panelAnalysis(args[0]) };
          case "legacyTasks":
            return { safety, data: model.panelTasks(args[0]) };
          default:
            throw new Error("Unsupported panel reader operation");
        }
      })();
    if (db.db.inTransaction)
      db.db.exec("COMMIT");
    parentPort!.postMessage({ id, result:{...result,bytes:Buffer.byteLength(JSON.stringify(result.data) ?? "")} });
  }
  catch (error) {
    if (db.db.inTransaction)
      db.db.exec("ROLLBACK");
    parentPort!.postMessage({
      id,
      error: {
        message: error instanceof Error ? error.message : String(error),
        code: error instanceof MemoryServiceError ? error.code : "internal"
      }
    });
  }
  finally { running = false; if (stopping) closeWorker(); }
});
