import { parentPort, workerData } from "node:worker_threads";
import { MemoryDb } from "../storage/db.js";

const port = parentPort;
if (!port) throw new Error("Memory database preparation worker requires a parent port");

const sqlitePath = typeof workerData?.sqlitePath === "string" ? workerData.sqlitePath : "";
if (!sqlitePath) throw new Error("Memory database preparation worker requires sqlitePath");

try {
  const database = new MemoryDb({
    path: sqlitePath,
    onStartupStage: (stage) => port.postMessage({ type: "stage", stage })
  });
  database.close();
  port.postMessage({ type: "ready" });
} catch (error) {
  port.postMessage({
    type: "failed",
    error: error instanceof Error ? error.message : String(error)
  });
  process.exitCode = 1;
}
