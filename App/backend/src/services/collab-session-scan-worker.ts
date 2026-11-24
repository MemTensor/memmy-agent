/**
 * Reads agent stores on a worker thread for the local session listing.
 *
 * <p>Reading one agent's history is seconds of synchronous parsing on a thread that also serves messages, page
 * loads and the sync timer. The listing only needs the result, so the reading happens here and the request thread
 * waits. Requests are answered one at a time: reading several stores at once made the whole pass slower on a real
 * machine, since they compete for the same disk.</p>
 */
import { parentPort } from "node:worker_threads";
import { readRecentSessions } from "../adapters/outbound/agent-source/session-reference/local-session-reader.js";
import { createBuiltinAgentSourceRegistry } from "./builtin-agent-source-registry.js";

/** A request from the reader thread. */
interface ScanRequest {
  type: "scan";
  id: number;
  sourceId: string;
  /** The store the reader thread wants read; this thread only reads the one it resolves for that source. */
  dataPath: string;
  limit: number;
}

if (!parentPort) {
  throw new Error("The local session scan worker needs a parent port");
}
const port = parentPort;

const registry = createBuiltinAgentSourceRegistry();
/** One store at a time; messages arriving while one is being read wait their turn. */
let queue: Promise<void> = Promise.resolve();

port.on("message", (message: unknown) => {
  if (!isScanRequest(message)) {
    return;
  }
  const request = message;
  queue = queue.then(() => answer(request));
});

async function answer(request: ScanRequest): Promise<void> {
  const adapter = registry.list().find((item) => item.descriptor.sourceId === request.sourceId);
  if (!adapter) {
    // 这套来源不在内置适配器里（以后用户自己添加的 Agent）：让请求线程自己读，免得两边读的不是同一份。
    port.postMessage({ type: "scanned", id: request.id, accepted: false, reason: `Unknown agent source: ${request.sourceId}` });
    return;
  }
  if (adapter.descriptor.dataPath !== request.dataPath) {
    // 同一个来源读的却是另一份存储：只可能是调用方手里有别的适配器，结果不能替代。
    port.postMessage({ type: "scanned", id: request.id, accepted: false, reason: `Store mismatch: ${request.sourceId}` });
    return;
  }
  try {
    const sessions = await readRecentSessions(adapter, request.limit);
    port.postMessage({ type: "scanned", id: request.id, accepted: true, sessions });
  } catch (error) {
    port.postMessage({
      type: "scanned",
      id: request.id,
      accepted: false,
      reason: error instanceof Error ? error.message : String(error)
    });
  }
}

function isScanRequest(message: unknown): message is ScanRequest {
  if (typeof message !== "object" || message === null) {
    return false;
  }
  const request = message as Partial<ScanRequest>;
  return request.type === "scan"
    && typeof request.id === "number"
    && typeof request.sourceId === "string"
    && typeof request.dataPath === "string"
    && typeof request.limit === "number";
}
