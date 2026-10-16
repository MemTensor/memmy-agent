import type { IncomingMessage } from "node:http";
import type { AgentSourceExecutor } from "../agent-source/runtime.js";
import { MemoryServiceError } from "../utils/error.js";

/** These controls read local history, so cloud and scoped memory credentials are insufficient. */
export function assertLocalAgentSourceRequest(request: IncomingMessage, kind: string): void {
  const remote = request.socket.remoteAddress;
  if (kind !== "local" || (remote && !["127.0.0.1", "::1", "::ffff:127.0.0.1"].includes(remote))) {
    throw new MemoryServiceError("forbidden", "Agent source scanning requires the local service token on loopback");
  }
  const host = request.headers.host;
  const origin = request.headers.origin;
  if (!host || !["127.0.0.1", "localhost", "[::1]"].includes(new URL(`http://${host}`).hostname) ||
      (origin && origin !== `http://${host}`) || request.headers["sec-fetch-site"] === "cross-site") {
    throw new MemoryServiceError("forbidden", "Agent source scanning requires a local same-origin request");
  }
}

export function isAgentSourceScanPath(path: string): boolean {
  return path === "/api/v1/agent-sources" || path === "/api/v1/agent-sources/scan" || path.startsWith("/api/v1/agent-sources/scan/");
}

/** Shared by the local-token API and the existing local Viewer API. */
export async function routeAgentSourceScan(executor: AgentSourceExecutor, method: string, url: URL, body: unknown) {
  const path = url.pathname;
  if (method === "GET" && path === "/api/v1/agent-sources") return { body: await executor.list() };
  if (method === "POST" && path === "/api/v1/agent-sources/scan") return { status: 202, body: await executor.startScan(body) };
  if (method === "GET" && path === "/api/v1/agent-sources/scan/status") return { body: executor.scanStatus() };
  if (method === "POST" && path === "/api/v1/agent-sources/scan/stop") return { body: await executor.pauseScan() };
  if (method === "POST" && path === "/api/v1/agent-sources/scan/cancel") return { body: await executor.cancelScan() };
  const results = path.match(/^\/api\/v1\/agent-sources\/scan\/jobs\/([^/]+)\/results$/);
  if (method === "GET" && results?.[1]) {
    const jobId = decodeURIComponent(results[1]);
    if (!/^[a-zA-Z0-9_-]{1,128}$/.test(jobId)) throw new MemoryServiceError("invalid_argument", "Invalid scan job id");
    const limit = Number(url.searchParams.get("limit") ?? 100);
    if (!Number.isInteger(limit) || limit < 1 || limit > 500) throw new MemoryServiceError("invalid_argument", "Invalid scan page size");
    return { body: await executor.scanResults?.(jobId, url.searchParams.get("cursor") ?? "0", limit) ?? { items: [], nextCursor: null } };
  }
  return undefined;
}
