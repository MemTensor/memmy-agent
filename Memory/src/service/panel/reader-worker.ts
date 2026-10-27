import { parentPort, workerData } from "node:worker_threads";
import { MemoryDb } from "../../storage/db.js";
import { createPanelReaderModel } from "./reader-model.js";
import { panelSafetyToken } from "../../storage/panel-security.js";
import { MemoryServiceError } from "../../utils/error.js";
import { Repositories } from "../../storage/repositories.js";
import { setImmediate } from "node:timers/promises";
import type { PanelReadModel } from "../read-model/panel-read.js";
const db = new MemoryDb({ path: workerData.path, readonly: true });
const model = createPanelReaderModel(db);
const repos = new Repositories(db.db);
async function statistics(input: Parameters<PanelReadModel["panelStatistics"]>[0]) {
  db.db.exec("BEGIN");
  try {
    const safety = panelSafetyToken(db.db);
    const rows = [];
    for (const row of repos.memories.iterateStats()) {
      rows.push(row);
      // Worker termination cannot interrupt a single large native .all().
      // Keep one read snapshot, but allow cancellation every bounded batch.
      if (rows.length % 256 === 0) await setImmediate();
    }
    const data = model.panelStatistics(input, rows);
    db.db.exec("COMMIT");
    return { safety, data };
  } catch (error) {
    db.db.exec("ROLLBACK");
    throw error;
  }
}
parentPort!.on("message", async ({ id, method, args }) => {
  try {
    const result = method === "stats" ? await statistics(args[0]) : db.db.transaction(() => {
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
          return { safety, data: model.panelLogDetail(args[0]) };
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
    parentPort!.postMessage({ id, result });
  } catch (error) {
    parentPort!.postMessage({
      id,
      error: {
        message: error instanceof Error ? error.message : String(error),
        code: error instanceof MemoryServiceError ? error.code : "internal"
      }
    });
  }
});
