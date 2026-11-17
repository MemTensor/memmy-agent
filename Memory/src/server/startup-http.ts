import { randomUUID } from "node:crypto";
import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { MEMORY_RUNTIME_BUILD_ID } from "../runtime-build.js";
import type { StorageBackendKind, StorageMode } from "../storage/backend.js";
import { MEMORY_CAPABILITIES, MEMORY_PROTOCOL_VERSION, MEMORY_SERVICE_VERSION, MEMORY_VIEWER_VERSION } from "../version.js";
import { API_ROUTES } from "./http.js";

export type MemoryStartupStatus = "starting" | "upgrading" | "failed";

export interface MemoryStartupState {
  status: MemoryStartupStatus;
  phase: string;
  startedAt: number;
  currentSchemaVersion?: number;
  targetSchemaVersion: number;
  error?: string;
}

export interface MemoryStartupHttpServer {
  server: Server;
  url: string;
  activate(server: Server): void;
  close(): Promise<void>;
}

export async function listenMemoryStartupHttpServer(options: {
  host: string;
  port: number;
  mode: StorageMode;
  storageBackend: StorageBackendKind;
  localServiceToken?: string;
  state: () => MemoryStartupState;
  onShutdownRequested: () => void;
}): Promise<MemoryStartupHttpServer> {
  let delegate: Server | undefined;
  let url = "";
  const server = createServer((request, response) => {
    if (delegate) {
      delegate.emit("request", request, response);
      return;
    }
    const requestId = header(request.headers["x-request-id"]) ?? randomUUID();
    const requestUrl = new URL(request.url ?? "/", "http://127.0.0.1");
    response.setHeader("cache-control", "no-store");
    response.setHeader("x-content-type-options", "nosniff");
    if (request.method === "GET" && (requestUrl.pathname === "/health" || requestUrl.pathname === "/api/v1/health")) {
      writeJson(response, 200, startupHealth(options.state(), url, options.mode, options.storageBackend));
      return;
    }
    if (request.method === "POST" && requestUrl.pathname === "/api/v1/admin/shutdown") {
      const candidate = bearerToken(request.headers.authorization);
      if (options.localServiceToken && candidate !== options.localServiceToken) {
        writeJson(response, 401, { error: { code: "unauthorized", message: "invalid memory service token", requestId } });
        return;
      }
      response.once("finish", options.onShutdownRequested);
      writeJson(response, 200, { accepted: true, serverTime: new Date().toISOString() });
      return;
    }
    request.resume();
    const state = options.state();
    const upgrading = state.status === "upgrading";
    response.setHeader("retry-after", "1");
    writeJson(response, 503, {
      error: {
        code: upgrading ? "memory_upgrading" : "memory_starting",
        message: upgrading ? "Memory service is upgrading its local database." : "Memory service is starting.",
        requestId,
        retryable: true,
        phase: state.phase
      }
    });
  });
  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(options.port, options.host, () => {
      server.off("error", reject);
      resolve();
    });
  });
  const address = server.address() as AddressInfo;
  url = `http://${address.address}:${address.port}`;
  return {
    server,
    url,
    activate(readyServer) {
      // The inner server owns request cleanup but never binds another socket.
      delegate = readyServer;
      readyServer.emit("listening");
    },
    async close() {
      await new Promise<void>((resolveClose, rejectClose) => {
        if (!server.listening) { resolveClose(); return; }
        server.close((error) => error ? rejectClose(error) : resolveClose());
        server.closeAllConnections();
      });
    }
  };
}

function startupHealth(state: MemoryStartupState, endpoint: string, mode: StorageMode, backend: StorageBackendKind): Record<string, unknown> {
  return {
    ok: true,
    status: state.status,
    serviceVersion: MEMORY_SERVICE_VERSION,
    ...(MEMORY_RUNTIME_BUILD_ID ? { buildId: MEMORY_RUNTIME_BUILD_ID } : {}),
    protocolVersion: MEMORY_PROTOCOL_VERSION,
    viewerVersion: MEMORY_VIEWER_VERSION,
    viewerUrl: `${endpoint}/viewer`,
    version: MEMORY_SERVICE_VERSION,
    uptimeMs: Math.max(0, Date.now() - state.startedAt),
    mode,
    storage: {
      backend,
      schemaVersion: String(state.currentSchemaVersion ?? 0),
      targetSchemaVersion: state.targetSchemaVersion,
      ready: false
    },
    startup: {
      phase: state.phase,
      elapsedMs: Math.max(0, Date.now() - state.startedAt),
      ...(state.currentSchemaVersion === undefined ? {} : { currentSchemaVersion: state.currentSchemaVersion }),
      targetSchemaVersion: state.targetSchemaVersion,
      ...(state.error ? { error: state.error } : {})
    },
    models: {
      summary: { provider: "", configured: false, remote: false, routing: null },
      evolution: { provider: "", configured: false, remote: false, routing: null },
      embedding: { provider: "", configured: false, remote: false, mode: null }
    },
    capabilities: {
      routes: [...API_ROUTES],
      tools: [],
      memoryLayers: ["L1", "L2", "L3", "Skill"],
      supportsCli: true,
      service: [...MEMORY_CAPABILITIES]
    },
    serverTime: new Date().toISOString()
  };
}

function bearerToken(value: string | undefined): string | undefined {
  const match = value?.match(/^Bearer\s+(.+)$/iu);
  return match?.[1];
}

function header(value: string | string[] | undefined): string | undefined {
  return Array.isArray(value) ? value[0] : value;
}

function writeJson(response: import("node:http").ServerResponse, status: number, body: unknown): void {
  const payload = Buffer.from(`${JSON.stringify(body, null, 2)}\n`);
  response.writeHead(status, {
    "content-type": "application/json; charset=utf-8",
    "content-length": payload.byteLength
  });
  response.end(payload);
}
