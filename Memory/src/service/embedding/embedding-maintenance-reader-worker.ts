import { parentPort, workerData } from "node:worker_threads";
import { MemoryDb } from "../../storage/db.js";
import { Repositories } from "../../storage/repositories.js";
import {
  readEmbeddingMaintenanceStats,
  readEmbeddingMaintenanceTargets,
  readEmbeddingUpgradeCandidates,
  type EmbeddingMaintenanceReaderStatsRequest,
  type EmbeddingMaintenanceReaderTargetsRequest
} from "./embedding-maintenance-reader-query.js";

type ReaderOperation =
  | { type: "stats"; request: EmbeddingMaintenanceReaderStatsRequest }
  | { type: "targets"; request: EmbeddingMaintenanceReaderTargetsRequest }
  | { type: "upgrade-candidates" };

type ReaderMessage =
  | { type: "request"; id: number; operation: ReaderOperation }
  | { type: "close" };

const port = parentPort;
if (!port) throw new Error("Embedding maintenance reader requires a parent port");
const sqlitePath = typeof workerData?.sqlitePath === "string" ? workerData.sqlitePath : "";
if (!sqlitePath || sqlitePath === ":memory:") {
  throw new Error("Embedding maintenance reader requires a file-backed SQLite database");
}

const database = new MemoryDb({ path: sqlitePath, readonly: true });
const repos = new Repositories(database.db);

port.on("message", (message: ReaderMessage) => {
  if (message.type === "close") {
    database.close();
    port.close();
    return;
  }
  try {
    const result = message.operation.type === "stats"
      ? readEmbeddingMaintenanceStats(repos, message.operation.request)
      : message.operation.type === "targets"
        ? readEmbeddingMaintenanceTargets(repos, message.operation.request)
        : readEmbeddingUpgradeCandidates(repos);
    port.postMessage({ type: "response", id: message.id, result });
  } catch (error) {
    port.postMessage({
      type: "response",
      id: message.id,
      error: error instanceof Error ? error.message : String(error)
    });
  }
});
