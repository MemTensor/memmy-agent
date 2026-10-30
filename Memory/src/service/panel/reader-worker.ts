import { isSqliteBusy } from "./write-coordinator.js";
import Database from "better-sqlite3";
import { panelStatisticsDirtyIds, fillPanelCacheBatch, ensurePanelLogIds, panelLogIdsPending, panelCachePending, panelMemoryStats, type PanelCachePart } from "../../storage/panel-cache.js";
import { parentPort, workerData } from "node:worker_threads";
import { MemoryDb } from "../../storage/db.js";
import { createPanelReaderModel } from "./reader-model.js";
import { panelSafetyToken } from "../../storage/panel-security.js";
import { MemoryServiceError } from "../../utils/error.js";
import { setImmediate } from "node:timers/promises";
import type { PanelReadModel } from "../read-model/panel-read.js";
const db = new MemoryDb({ path: workerData.path, readonly: true });
const cacheWriter = new Database(workerData.path, { fileMustExist: true });
cacheWriter.pragma("busy_timeout = 1000");
cacheWriter.pragma("synchronous = NORMAL");
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
let writeGranted: (() => void) | undefined;
async function writeBatch<T>(id: number, operation: () => T): Promise<T> {
  for (let attempt = 0; ; attempt++) {
    await new Promise<void>(resolve => { writeGranted = resolve; parentPort!.postMessage({id,write:"acquire"}); });
    try { checkStopped(); return operation(); }
    catch (error) { if (attempt >= 3 || !isSqliteBusy(error)) throw error; }
    finally { parentPort!.postMessage({id,write:"release"}); }
    await new Promise(resolve => setTimeout(resolve,25 * 2 ** attempt));
  }
}
let resumePreparation: (() => void) | undefined;
async function prepare(parts: PanelCachePart[], id: number, backgroundId?: number) {
  let batches = 0;
  if (backgroundId !== undefined) {
    for (const part of parts) {
      if (part !== "memories" && part !== "metrics") continue;
      const ids = panelStatisticsDirtyIds(cacheWriter, part);
      for (let offset = 0; offset < ids.length; offset += 128) {
        checkStopped();
        await writeBatch(id, () => fillPanelCacheBatch(cacheWriter,part,128,ids.slice(offset,offset+128)));
        await setImmediate();
      }
    }
    return;
  }
  for (const part of parts)
    while (await writeBatch(id, () => fillPanelCacheBatch(cacheWriter, part, part === "logs" ? 64 : 128))) {
      // Release SQLite's writer after every small batch. Check producer
      // activity initially and every four batches, avoiding an IPC round trip
      // for each transaction when the service is idle.
      if (backgroundId === undefined || batches++ % 4 !== 0) await setImmediate();
      else await new Promise<void>(resolve => {
        resumePreparation = resolve;
        parentPort!.postMessage({ id: backgroundId, yield: true });
      });
    }
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
parentPort!.on("message", async ({ id, method, args, resume, writeGranted: granted, stop }) => {
  if (stop) { stopping = true; resumePreparation?.(); writeGranted?.(); if (!running) closeWorker(); return; }
  if (granted !== undefined) { const resolve = writeGranted; writeGranted = undefined; resolve?.(); return; }
  if (resume !== undefined) {
    const continuePreparation = resumePreparation;
    resumePreparation = undefined;
    continuePreparation?.();
    return;
  }
  running = true;
  try {
    checkStopped();
    const parts = partsFor(method,args);
    const stats = method === "stats" || method === "overviewStats";
    const initialSafety = panelSafetyToken(db.db);
    // A source write racing preparation is retried before entering the read snapshot.
    let attempts = 0;
    while (true) {
      if (method === "logDetail") await writeBatch(id, () => ensurePanelLogIds(cacheWriter,[args[0]]));
      await prepare(parts, id, method === "stats" || method === "overviewStats" ? id : undefined);
      db.db.exec("BEGIN");
      if (stats || !(method === "logDetail" ? panelLogIdsPending(db.db,[args[0]]) : panelCachePending(db.db, parts)))
        break;
      db.db.exec("ROLLBACK");
      if (++attempts >= 8)
        throw new MemoryServiceError("conflict", "Panel changed during preparation; retry");
    }
    checkStopped();
    if (stats && panelSafetyToken(db.db) !== initialSafety) throw new MemoryServiceError("conflict", "Panel visibility changed during preparation");
    const result = method === "stats" || method === "overviewStats"
      ? await statistics(method, args[0])
      : (() => {
        const safety = panelSafetyToken(db.db);
        switch (method) {
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
    parentPort!.postMessage({ id, result });
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
