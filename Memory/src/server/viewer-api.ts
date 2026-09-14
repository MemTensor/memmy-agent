import { readFile } from "node:fs/promises";
import type { IncomingMessage, ServerResponse } from "node:http";
import { parse as parseYaml } from "yaml";
import { mutateMemoryConfig } from "../config/writer.js";
import { syncMemoryModelCatalog } from "../config/model-catalog.js";
import type { MemoryGovernanceRequest, MemoryImportRequest, RecallMemoryLayer } from "../types.js";
import { MemoryService } from "../service/memory-service.js";
import { MemoryServiceError } from "../utils/error.js";
import { resolveTimeZone } from "../utils/time.js";
import type { AgentSourceExecutor } from "../agent-source/runtime.js";
import {
  installViewerCli,
  viewerCliStatus,
  type ViewerCliOptions,
} from "./viewer-cli.js";

export const VIEWER_API_ROUTES = [
  "GET /api/v1/auth/status",
  "POST /api/v1/telemetry/viewer-opened",
  "GET /api/v1/overview",
  "GET /api/v1/memories",
  "GET /api/v1/traces",
  "GET /api/v1/episodes",
  "GET /api/v1/policies",
  "GET /api/v1/world-models",
  "GET /api/v1/skills",
  "POST /api/v1/traces/delete",
  "POST /api/v1/skills/archive",
  "POST /api/v1/world-models/:id/archive",
  "GET /api/v1/analytics",
  "GET /api/v1/api-logs",
  "GET /api/v1/service-logs",
  "GET /api/v1/metrics",
  "GET /api/v1/diagnostics",
  "GET /api/v1/config",
  "PATCH /api/v1/config",
  "GET /api/v1/agent-sources",
  "POST /api/v1/agent-sources/scan",
  "GET /api/v1/agent-sources/scan/status",
  "GET /api/v1/agent-sources/scan/jobs/:jobId/results",
  "POST /api/v1/agent-sources/scan/stop",
  "POST /api/v1/agent-sources/scan/cancel",
  "POST /api/v1/agent-sources/:id/plugin",
  "DELETE /api/v1/agent-sources/:id/plugin",
  "POST /api/v1/agent-sources/:id/skill",
  "DELETE /api/v1/agent-sources/:id/skill",
  "GET /api/v1/system/cli",
  "POST /api/v1/system/cli/install",
  "POST /api/v1/system/restart",
  "POST /api/v1/models/test",
  "GET /api/v1/embeddings/maintenance",
  "POST /api/v1/embeddings/rebuild",
  "GET /api/v1/export",
  "POST /api/v1/import",
  "GET /api/v1/hub/status",
  "GET /api/v1/hub/items",
  "GET /api/v1/events",
  "POST /api/v1/memory/:id/archive"
] as const;

export interface ViewerApiContext {
  service: MemoryService;
  configPath?: string;
  routes: readonly string[];
  scheduleWorker(): void;
  timeZone?: string;
  viewerCli?: ViewerCliOptions;
  restartService?: () => void | Promise<void>;
  agentSources: AgentSourceExecutor;
}

export interface ViewerRouteResult {
  status?: number;
  body: unknown;
  headers?: Record<string, string>;
  afterResponse?: () => void | Promise<void>;
}

export function isViewerApiRequest(request: IncomingMessage, url: URL): boolean {
  return url.pathname === "/api/v1/events" || header(request, "x-memmy-viewer") === "1";
}

export function assertLocalViewerRequest(request: IncomingMessage, url: URL): void {
  const remote = request.socket.remoteAddress;
  if (remote && !isLoopbackAddress(remote)) {
    throw new MemoryServiceError("forbidden", "Viewer API is available only from the local machine");
  }
  const host = header(request, "host");
  if (!host || !isLoopbackHost(host)) {
    throw new MemoryServiceError("forbidden", "Viewer API requires a loopback Host header");
  }
  const origin = header(request, "origin");
  if (origin) {
    let parsed: URL;
    try {
      parsed = new URL(origin);
    } catch {
      throw new MemoryServiceError("forbidden", "Viewer API received an invalid Origin header");
    }
    if (parsed.protocol !== "http:" || parsed.host !== host || !isLoopbackHost(parsed.host)) {
      throw new MemoryServiceError("forbidden", "Viewer API requires a same-origin request");
    }
  }
  if (header(request, "sec-fetch-site") === "cross-site") {
    throw new MemoryServiceError("forbidden", "cross-site Viewer API requests are not allowed");
  }
  if (request.method !== "GET" && request.method !== "HEAD") {
    if (header(request, "x-memmy-viewer") !== "1") {
      throw new MemoryServiceError("forbidden", "Viewer write requests require x-memmy-viewer: 1");
    }
    const contentType = header(request, "content-type");
    if (!contentType?.toLowerCase().startsWith("application/json")) {
      throw new MemoryServiceError("invalid_argument", "Viewer write requests must use application/json");
    }
  }
  void url;
}

export async function routeViewerRequest(
  context: ViewerApiContext,
  method: string,
  url: URL,
  body: unknown
): Promise<ViewerRouteResult | undefined> {
  const path = url.pathname;
  const envelope = { timeZone: resolveTimeZone(context.timeZone) };

  if (method === "GET" && path === "/api/v1/auth/status") {
    return { body: { enabled: false, needsSetup: false, authenticated: true } };
  }
  if (method === "POST" && path === "/api/v1/telemetry/viewer-opened") {
    return { body: { ok: true } };
  }
  if (method === "GET" && path === "/api/v1/overview") {
    const userId = viewerUserId(context);
    return {
      body: {
        ...context.service.panelOverview({ ...envelope, userId }),
        summary: context.service.panelOverviewSummary({ ...envelope, userId })
      }
    };
  }
  if (method === "GET" && path === "/api/v1/analytics") {
    return { body: context.service.panelAnalysis(envelope) };
  }
  if (method === "GET" && path === "/api/v1/episodes") {
    return {
      body: context.service.panelTasks({
        ...envelope,
        q: query(url, "q"),
        sourceAgent: query(url, "sourceAgent"),
        page: numberQuery(url, "page")
      })
    };
  }
  const layer = layerForViewerPath(path);
  if (method === "GET" && layer) {
    return {
      body: context.service.panelItems({
        ...envelope,
        ...(layer === "UserMemory" ? { userId: viewerUserId(context) } : {}),
        layer,
        q: query(url, "q"),
        status: statusQuery(url),
        sourceAgent: query(url, "sourceAgent"),
        page: numberQuery(url, "page"),
        limit: numberQuery(url, "limit")
      })
    };
  }
  if (method === "GET" && path === "/api/v1/api-logs") {
    return {
      body: context.service.apiLogs({
        tools: apiLogToolsQuery(url),
        sourceAgent: query(url, "sourceAgent"),
        limit: numberQuery(url, "limit"),
        offset: numberQuery(url, "offset")
      })
    };
  }
  if (method === "GET" && path === "/api/v1/service-logs") {
    return {
      body: context.service.serviceLogs({
        ...envelope,
        limit: numberQuery(url, "limit"),
        cursor: query(url, "cursor")
      })
    };
  }
  if (method === "GET" && path === "/api/v1/metrics") {
    return { body: context.service.serviceMetrics(envelope) };
  }
  if (method === "GET" && path === "/api/v1/diagnostics") {
    return { body: context.service.adminStatus(envelope, [...context.routes]) };
  }
  if (method === "GET" && path === "/api/v1/config") {
    return { body: await viewerConfig(context) };
  }
  if (method === "PATCH" && path === "/api/v1/config") {
    return { body: await patchViewerConfig(context, body) };
  }
  if (method === "GET" && path === "/api/v1/agent-sources") {
    return { body: await context.agentSources.list() };
  }
  if (method === "GET" && path === "/api/v1/system/cli") {
    return { body: await viewerCliStatus(context.viewerCli) };
  }
  if (method === "POST" && path === "/api/v1/system/cli/install") {
    return { body: await installViewerCli(context.viewerCli) };
  }
  if (method === "POST" && path === "/api/v1/system/restart") {
    if (!context.restartService) {
      throw new MemoryServiceError("conflict", "Memory service restart is unavailable");
    }
    return {
      status: 202,
      body: { accepted: true, serverTime: new Date().toISOString() },
      afterResponse: context.restartService,
    };
  }
  if (method === "POST" && path === "/api/v1/agent-sources/scan") {
    return { status: 202, body: await context.agentSources.startScan(body) };
  }
  if (method === "GET" && path === "/api/v1/agent-sources/scan/status") {
    return { body: context.agentSources.scanStatus() };
  }
  const scanResults = path.match(/^\/api\/v1\/agent-sources\/scan\/jobs\/([^/]+)\/results$/);
  if (method === "GET" && scanResults?.[1]) {
    return { body: context.agentSources.scanResults
      ? await context.agentSources.scanResults(decodeURIComponent(scanResults[1]), query(url, "cursor") ?? "0", numberQuery(url, "limit") ?? 100)
      : { items: [], nextCursor: null } };
  }
  if (method === "POST" && path === "/api/v1/agent-sources/scan/stop") {
    return { body: await context.agentSources.pauseScan() };
  }
  if (method === "POST" && path === "/api/v1/agent-sources/scan/cancel") {
    return { body: await context.agentSources.cancelScan() };
  }
  const sourceConnection = path.match(/^\/api\/v1\/agent-sources\/([^/]+)\/(plugin|skill)$/);
  if ((method === "POST" || method === "DELETE") && sourceConnection?.[1] && sourceConnection[2]) {
    return {
      body: await context.agentSources.mutateConnection(
        decodeURIComponent(sourceConnection[1]),
        sourceConnection[2] as "plugin" | "skill",
        method
      )
    };
  }
  if (method === "POST" && path === "/api/v1/models/test") {
    return { body: await context.service.testModels() };
  }
  if (method === "GET" && path === "/api/v1/embeddings/maintenance") {
    return { body: context.service.embeddingMaintenanceStats() };
  }
  if (method === "POST" && path === "/api/v1/embeddings/rebuild") {
    const result = context.service.rebuildEmbeddings();
    context.scheduleWorker();
    return { status: 202, body: result };
  }
  if (method === "GET" && path === "/api/v1/export") {
    return {
      body: context.service.exportBundle({
        ...envelope,
        includeRawText: url.searchParams.get("includeRawText") === "true",
        includeAudit: url.searchParams.get("includeAudit") === "true"
      }),
      headers: {
        "content-disposition": `attachment; filename="memmy-memory-${new Date().toISOString().slice(0, 10)}.json"`
      }
    };
  }
  if (method === "POST" && path === "/api/v1/import") {
    const request = record(body);
    const result = context.service.importBundle({
      ...envelope,
      bundle: record(request.bundle) as MemoryImportRequest["bundle"],
      conflictStrategy: conflictStrategy(request.conflictStrategy)
    });
    context.scheduleWorker();
    return { body: result };
  }
  if (method === "GET" && path === "/api/v1/hub/status") {
    const config = await rawMemoryConfig(context.configPath);
    const hub = record(config.hub);
    return {
      body: {
        enabled: hub.enabled === true,
        role: hub.role === "hub" ? "hub" : "client",
        configured: hub.enabled === true && (hub.role === "hub" || typeof hub.address === "string"),
        address: typeof hub.address === "string" ? hub.address : undefined,
        teamName: typeof hub.teamName === "string" ? hub.teamName : undefined,
        serverTime: new Date().toISOString()
      }
    };
  }
  if (method === "GET" && path === "/api/v1/hub/items") {
    const items = context.service.hubRecords(numberQuery(url, "limit"));
    return { body: { items, total: items.length, serverTime: new Date().toISOString() } };
  }
  if (method === "POST" && path === "/api/v1/traces/delete") {
    const ids = stringArray(record(body).ids);
    for (const id of ids) context.service.deleteMemory(id, envelope);
    return { body: { deleted: ids.length } };
  }
  if (method === "POST" && path === "/api/v1/skills/archive") {
    const skillId = requiredString(record(body).skillId, "skillId");
    return { body: context.service.archiveMemory(skillId, envelope) };
  }
  const worldModelArchive = path.match(/^\/api\/v1\/world-models\/([^/]+)\/archive$/);
  if (method === "POST" && worldModelArchive?.[1]) {
    return { body: context.service.archiveMemory(decodeURIComponent(worldModelArchive[1]), envelope) };
  }
  const archive = path.match(/^\/api\/v1\/memory\/([^/]+)\/archive$/);
  if (method === "POST" && archive?.[1]) {
    const request = record(body) as MemoryGovernanceRequest;
    return {
      body: context.service.archiveMemory(decodeURIComponent(archive[1]), { ...request, ...envelope })
    };
  }
  return undefined;
}

export function streamViewerEvents(
  context: ViewerApiContext,
  request: IncomingMessage,
  response: ServerResponse,
  url: URL
): void {
  let cursor = header(request, "last-event-id") ?? query(url, "cursor");
  const first = context.service.panelChanges({ cursor, limit: 100, timeZone: context.timeZone });
  response.writeHead(200, {
    "content-type": "text/event-stream; charset=utf-8",
    "cache-control": "no-cache, no-transform",
    connection: "keep-alive",
    "x-accel-buffering": "no"
  });
  response.flushHeaders();

  const send = (snapshot: ReturnType<MemoryService["panelChanges"]>) => {
    cursor = snapshot.cursor;
    if (snapshot.changes.length === 0) return;
    response.write(`id: ${snapshot.cursor}\n`);
    response.write("event: memory.changes\n");
    response.write(`data: ${JSON.stringify(snapshot)}\n\n`);
  };
  send(first);
  const poll = setInterval(() => {
    try {
      send(context.service.panelChanges({ cursor, limit: 100, timeZone: context.timeZone }));
    } catch (error) {
      response.write("event: error\n");
      response.write(`data: ${JSON.stringify({ message: error instanceof Error ? error.message : String(error) })}\n\n`);
    }
  }, 1_000);
  const keepAlive = setInterval(() => response.write(": keepalive\n\n"), 15_000);
  request.once("close", () => {
    clearInterval(poll);
    clearInterval(keepAlive);
  });
}

async function viewerConfig(context: ViewerApiContext): Promise<Record<string, unknown>> {
  const status = context.service.configStatus();
  const raw = await rawMemoryConfig(context.configPath);
  return {
    ...status,
    config: {
      ...(status.config as unknown as Record<string, unknown>),
      ...(raw.hub ? { hub: redactSecrets(raw.hub) } : {}),
      ...(raw.telemetry ? { telemetry: redactSecrets(raw.telemetry) } : {})
    },
    readOnly: ["storage.endpoint", "storage.sqlitePath", "storage.backend", "storage.mode"]
  };
}

async function patchViewerConfig(context: ViewerApiContext, body: unknown): Promise<Record<string, unknown>> {
  if (!context.configPath) {
    throw new MemoryServiceError("conflict", "Memory config path is unavailable");
  }
  const request = record(body);
  const patch = record(request.config ?? request);
  const allowed = new Set([
    "domain",
    "roleRouting",
    "summary",
    "evolution",
    "embedding",
    "algorithm",
    "logging",
    "telemetry",
    "agentAccess",
    "timeZone",
    "hub"
  ]);
  for (const key of Object.keys(patch)) {
    if (!allowed.has(key)) {
      throw new MemoryServiceError("invalid_argument", `config field is read-only or unsupported: ${key}`);
    }
  }
  await mutateMemoryConfig(context.configPath, (root) => {
    const current = record(root.memmyMemory);
    const next = deepMerge(current, stripMaskedSecrets(patch));
    root.memmyMemory = next;
    syncMemoryModelCatalog(root, next, patch);
  });
  const reload = context.service.reloadConfig({ reason: "viewer.config.patch" });
  context.scheduleWorker();
  return { ok: true, reload, ...(await viewerConfig(context)) };
}

async function rawMemoryConfig(configPath?: string): Promise<Record<string, unknown>> {
  if (!configPath) return {};
  try {
    const parsed = parseYaml(await readFile(configPath, "utf8"));
    return record(record(parsed).memmyMemory);
  } catch (error) {
    if (error instanceof Error && "code" in error && (error as NodeJS.ErrnoException).code === "ENOENT") {
      return {};
    }
    throw error;
  }
}

function layerForViewerPath(path: string): RecallMemoryLayer | undefined {
  if (path === "/api/v1/memories") return "UserMemory";
  if (path === "/api/v1/traces") return "L1";
  if (path === "/api/v1/policies") return "L2";
  if (path === "/api/v1/world-models") return "L3";
  if (path === "/api/v1/skills") return "Skill";
  return undefined;
}

function viewerUserId(context: ViewerApiContext): string {
  const userId = context.service.configStatus().config.userId?.trim();
  return userId || "local-user";
}

function statusQuery(url: URL): "activated" | "resolving" | "archived" | "deleted" | undefined {
  const status = url.searchParams.get("status");
  return status === "activated" || status === "resolving" || status === "archived" || status === "deleted"
    ? status
    : undefined;
}

function conflictStrategy(value: unknown): "skip" | "replace" | "error" {
  return value === "replace" || value === "error" ? value : "skip";
}

function query(url: URL, key: string): string | undefined {
  const value = url.searchParams.get(key);
  return value?.trim() || undefined;
}

function numberQuery(url: URL, key: string): number | undefined {
  const value = query(url, key);
  if (!value) return undefined;
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : undefined;
}

function apiLogToolsQuery(url: URL): Array<"memory_add" | "memory_search"> | undefined {
  const value = query(url, "tools");
  if (!value) return undefined;
  const allowed = new Set(["memory_add", "memory_search"]);
  return value
    .split(",")
    .map((item) => item.trim())
    .filter((item): item is "memory_add" | "memory_search" => allowed.has(item));
}

function stringArray(value: unknown): string[] {
  if (!Array.isArray(value) || value.length === 0 || value.some((item) => typeof item !== "string" || !item.trim())) {
    throw new MemoryServiceError("invalid_argument", "ids must be a non-empty string array");
  }
  return value;
}

function requiredString(value: unknown, key: string): string {
  if (typeof value !== "string" || !value.trim()) {
    throw new MemoryServiceError("invalid_argument", `${key} is required`);
  }
  return value;
}

function header(request: IncomingMessage, name: string): string | undefined {
  const value = request.headers[name];
  return Array.isArray(value) ? value[0] : value;
}

function isLoopbackAddress(value: string): boolean {
  return value === "127.0.0.1" || value === "::1" || value.startsWith("::ffff:127.");
}

function isLoopbackHost(value: string): boolean {
  const host = value.startsWith("[")
    ? value.slice(1, value.indexOf("]"))
    : value.split(":", 1)[0];
  return host === "localhost" || host === "127.0.0.1" || host === "::1";
}

function record(value: unknown): Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value)
    ? value as Record<string, unknown>
    : {};
}

function deepMerge(base: Record<string, unknown>, patch: Record<string, unknown>): Record<string, unknown> {
  const result = { ...base };
  for (const [key, value] of Object.entries(patch)) {
    result[key] = isPlainRecord(value) && isPlainRecord(result[key])
      ? deepMerge(result[key] as Record<string, unknown>, value)
      : value;
  }
  return result;
}

function stripMaskedSecrets(value: Record<string, unknown>): Record<string, unknown> {
  const result: Record<string, unknown> = {};
  for (const [key, item] of Object.entries(value)) {
    if (/token|apiKey|secret|password/i.test(key) && (item === "********" || item === "[redacted]")) continue;
    result[key] = isPlainRecord(item) ? stripMaskedSecrets(item) : item;
  }
  return result;
}

function redactSecrets(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(redactSecrets);
  if (!isPlainRecord(value)) return value;
  return Object.fromEntries(Object.entries(value).map(([key, item]) => [
    key,
    /token|apiKey|secret|password/i.test(key) && item ? "********" : redactSecrets(item)
  ]));
}

function isPlainRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
