import Database from "better-sqlite3";
import { fillPanelCacheBatch, ensurePanelLogIds, panelLogIdsPending, panelCachePending, panelMemoryStats, type PanelCachePart } from "../../storage/panel-cache.js";
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
function partsFor(method: string): PanelCachePart[] {
  if (["stats", "overviewStats", "analysis"].includes(method))
    return ["memories", "metrics"];
  if (method === "overview")
    return ["memories"];
  if (method === "logs") {
    return ["logs", "visibility"];
  }
  return [];
}
async function prepare(parts: PanelCachePart[]) {
  for (const part of parts)
    while (fillPanelCacheBatch(cacheWriter, part, part === "logs" ? 64 : 512))
      await setImmediate();
}
async function statistics(method: "stats" | "overviewStats", input: Parameters<PanelReadModel["panelStatistics"]>[0]) {
  const safety = panelSafetyToken(db.db);
  const rows = [];
  for (const row of panelMemoryStats(db.db)) {
    rows.push(row);
    // Worker termination cannot interrupt a single large native .all().
    // Keep one read snapshot, but allow cancellation every bounded batch.
    if (rows.length % 256 === 0)
      await setImmediate();
  }
  const data = method === "overviewStats"
    ? model.panelOverviewSummary(input, rows)
    : model.panelStatistics(input, rows);
  return { safety, data };
}
parentPort!.on("message", async ({ id, method, args }) => {
  try {
    const parts = partsFor(method);
    // A source write racing preparation is retried before entering the read snapshot.
    let attempts = 0;
    while (true) {
      if (method === "logDetail") ensurePanelLogIds(cacheWriter,[args[0]]);
      await prepare(parts);
      db.db.exec("BEGIN");
      if (!(method === "logDetail" ? panelLogIdsPending(db.db,[args[0]]) : panelCachePending(db.db, parts)))
        break;
      db.db.exec("ROLLBACK");
      if (++attempts >= 8)
        throw new MemoryServiceError("conflict", "Panel changed during preparation; retry");
    }
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
});
