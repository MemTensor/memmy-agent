import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import { randomUUID } from "node:crypto";
import type { AddressInfo } from "node:net";
import { createMemoryLogger, memoryErrorFields } from "../logging/logger.js";
import { memoryPanelHtml } from "../viewer/static.js";
import type {
  MemoryAddRequest,
  MemoryGovernanceRequest,
  MemoryLayer,
  MemoryReloadConfigRequest,
  MemorySearchRequest,
  MemoryMarkdownImportRequest,
  RequestEnvelope,
  RuntimeNamespace,
  SessionCheckpointRequest,
  SessionOpenRequest,
  TurnCompleteRequest,
  TurnStartRequest
} from "../types.js";
import { DEFAULT_NAMESPACE_SOURCE } from "../types.js";
import { MemoryService } from "../service/memory-service.js";
import { normalizeNamespace } from "../service/namespace/namespace-scope.js";
import { MemoryServiceError, statusForCode } from "../utils/error.js";
import {
  createPluginRuntimeAnalytics,
  hitCountFromGetResponse,
  hitCountFromSearchResponse,
  storedCountFromAddResponse,
  trackExternalHookCapture,
  trackExternalHookRecall,
  trackExternalToolCall,
  type PluginRuntimeAnalytics,
} from "./plugin-runtime-analytics.js";

const logger = createMemoryLogger("http");
const workerLogger = createMemoryLogger("worker");

export const API_ROUTES = [
  "GET /api/v1/health",
  "POST /api/v1/admin/reload-config",
  "POST /api/v1/admin/shutdown",
  "POST /api/v1/sessions/open",
  "POST /api/v1/sessions/:sessionId/checkpoint",
  "POST /api/v1/sessions/:sessionId/close",
  "POST /api/v1/turns/start",
  "POST /api/v1/turns/:turnId/complete",
  "POST /api/v1/memory/search",
  "POST /api/v1/memory/add",
  "GET /api/v1/memory/audit/markdown",
  "POST /api/v1/memory/audit/markdown/import",
  "POST /api/v1/memory/processing/status",
  "POST /api/v1/memory/:id/processing/retry",
  "POST /api/v1/memory/:id/quality",
  "POST /api/v1/memory/:id/archive",
  "POST /api/v1/memory/:id/promote",
  "GET /api/v1/panel/review/candidates",
  "POST /api/v1/panel/review/candidates/:id/approve",
  "POST /api/v1/panel/review/candidates/:id/reject",
  "POST /api/v1/panel/review/candidates/bulk-approve",
  "POST /api/v1/memory/:id/merge",
  "GET /api/v1/memory/:id",
  "DELETE /api/v1/memory/:id",
  "POST /api/v1/worker/run",
  "POST /api/v1/worker/retry-failed",
  "POST /api/v1/worker/promote-candidates",
  "POST /api/v1/worker/import-summaries/enqueue",
  "GET /api/v1/memory/logs",
  "GET /api/v1/panel/overview",
  "GET /api/v1/panel/evolution",
  "GET /api/v1/panel/context-pack",
  "GET /api/v1/panel/context-packs",
  "GET /api/v1/panel/namespace-audit",
  "GET /api/v1/panel/analysis",
  "GET /api/v1/panel/metrics",
  "GET /api/v1/panel/status",
  "GET /api/v1/panel/config",
  "GET /api/v1/panel/activity",
  "GET /api/v1/panel/items",
  "GET /api/v1/panel/tasks",
  "DELETE /api/v1/panel/tasks/:id"
] as const;

export interface MemoryHttpServerOptions {
  service: MemoryService;
  apiKey?: string;
  auth?: MemoryHttpAuthOptions;
  workerStartupFallbackMs?: number;
  workerPostHealthDelayMs?: number;
  onShutdownRequested?: () => void;
  pluginRuntimeAnalytics?: PluginRuntimeAnalytics;
}

export interface MemoryHttpAuthOptions {
  mode?: "local" | "cloud" | "dev";
  localServiceToken?: string;
  cloudAccessTokens?: Record<string, RuntimeNamespace>;
  scopedApiKeys?: Record<string, {
    namespace: RuntimeNamespace;
    scopes?: string[];
  }>;
  allowAnonymous?: boolean;
}

interface AuthPrincipal {
  kind: "anonymous" | "local" | "cloud" | "scoped";
  tokenId?: string;
  namespace?: RuntimeNamespace;
  scopes: string[];
}

interface AutoWorkerDrain {
  start(): void;
  afterHealthCheck(): void;
  schedule(): void;
  dispose(): void;
}

const DEFAULT_WORKER_STARTUP_FALLBACK_MS = 5_000;
const DEFAULT_WORKER_POST_HEALTH_DELAY_MS = 250;

export function createMemoryHttpServer(options: MemoryHttpServerOptions): Server {
  const autoWorker = createAutoWorkerDrain(options.service, {
    startupFallbackMs: options.workerStartupFallbackMs ?? DEFAULT_WORKER_STARTUP_FALLBACK_MS,
    postHealthDelayMs: options.workerPostHealthDelayMs ?? DEFAULT_WORKER_POST_HEALTH_DELAY_MS
  });
  const pluginRuntimeAnalytics = options.pluginRuntimeAnalytics ?? createPluginRuntimeAnalytics();
  const server = createServer(async (request, response) => {
    const startedAt = Date.now();
    const requestId = requestIdFromHeaders(request) ?? randomUUID();
    const requestPath = request.url?.split("?", 1)[0] ?? "<missing>";
    setCors(response);
    if (request.method === "OPTIONS") {
      response.writeHead(204);
      response.end();
      return;
    }

    try {
      if (!request.url || !request.method) {
        throw new MemoryServiceError("invalid_argument", "missing request url or method");
      }
      const url = new URL(request.url, "http://127.0.0.1");
      if (request.method === "GET" && url.pathname === "/api/v1/health") {
        response.once("finish", () => autoWorker.afterHealthCheck());
      }
      if (request.method === "GET" && isViewerPath(url.pathname)) {
        writeHtml(response, memoryPanelHtml());
        return;
      }
      const principal = authenticate(request, url, options);
      const body = await readJson(request);
      const result = await routeRequest(
        options.service,
        autoWorker,
        request.method,
        url,
        body,
        principal,
        Boolean(options.onShutdownRequested),
        pluginRuntimeAnalytics
      );
      if (request.method === "POST" && url.pathname === "/api/v1/admin/shutdown") {
        response.once("finish", () => options.onShutdownRequested?.());
      }
      writeJson(response, 200, result);
      logger.debug("request.succeeded", {
        requestId,
        method: request.method,
        path: requestPath,
        status: 200,
        durationMs: Date.now() - startedAt
      });
    } catch (error) {
      const status = error instanceof MemoryServiceError ? statusForCode(error.code) : 500;
      const fields = {
        requestId,
        method: request.method,
        path: requestPath,
        status,
        durationMs: Date.now() - startedAt,
        ...(error instanceof MemoryServiceError ? { errorCode: error.code } : {}),
        ...memoryErrorFields(error)
      };
      if (status >= 500) {
        logger.error("request.failed", fields);
      } else {
        logger.warn("request.rejected", fields);
      }
      writeError(response, error, requestId);
    }
  });
  server.once("listening", () => autoWorker.start());
  server.on("close", () => autoWorker.dispose());
  return server;
}

export async function listenMemoryHttpServer(options: MemoryHttpServerOptions & {
  host?: string;
  port?: number;
}): Promise<{
  server: Server;
  url: string;
}> {
  const server = createMemoryHttpServer(options);
  const host = options.host ?? "127.0.0.1";
  const port = options.port ?? 18960;
  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(port, host, () => {
      server.off("error", reject);
      resolve();
    });
  });
  const address = server.address() as AddressInfo;
  return {
    server,
    url: `http://${address.address}:${address.port}`
  };
}

function createAutoWorkerDrain(
  service: MemoryService,
  options: {
    startupFallbackMs: number;
    postHealthDelayMs: number;
  }
): AutoWorkerDrain {
  let running = false;
  let requested = false;
  let scheduled = false;
  let disposed = false;
  let startupReleased = false;
  let startupReconciled = false;
  let startupTimer: ReturnType<typeof setTimeout> | undefined;
  let delayedTimer: ReturnType<typeof setTimeout> | undefined;
  const maxCycles = 40;
  const priorityJobLimit = 100;
  const priorityBatchSize = 20;
  const standardBatchSize = 100;

  async function drain(): Promise<void> {
    if (disposed) {
      return;
    }
    if (running) {
      requested = true;
      return;
    }
    running = true;
    let continueSoon = false;
    try {
      if (!startupReconciled) {
        startupReconciled = true;
        try {
          service.reconcileWorkerStartup();
        } catch (error) {
          workerLogger.error("startup.reconciliation_failed", memoryErrorFields(error));
        }
      }
      do {
        requested = false;
        let prioritySummariesDuringDrain = 0;
        for (let cycle = 0; cycle < maxCycles; cycle += 1) {
          const limit = prioritySummariesDuringDrain < priorityJobLimit ? priorityBatchSize : standardBatchSize;
          const result = await service.runWorkerOnce(limit, {});
          if (result.leased === 0 && result.embeddingRetries.leased === 0) {
            break;
          }
          prioritySummariesDuringDrain += result.jobs.filter((job) =>
            job.jobType === "trace_summary" || job.jobType === "import_summary"
          ).length;
          if (cycle === maxCycles - 1) {
            continueSoon = true;
          }
          await yieldToEventLoop();
        }
      } while (requested && !continueSoon);
    } catch (error) {
      workerLogger.error("drain.failed", memoryErrorFields(error));
    } finally {
      running = false;
      if (disposed) {
        return;
      }
      if (requested || continueSoon) {
        setTimeout(() => {
          requested = true;
          void drain();
        }, 0);
      } else {
        scheduleNextDueJob();
      }
    }
  }

  function scheduleNextDueJob(): void {
    if (disposed) {
      return;
    }
    if (delayedTimer) {
      return;
    }
    const delayMs = nextWorkerRunAfterDelayMs(service);
    if (delayMs === undefined) {
      return;
    }
    delayedTimer = setTimeout(() => {
      delayedTimer = undefined;
      requested = true;
      void drain();
    }, delayMs);
  }

  function schedule(): void {
    if (disposed) {
      return;
    }
    startupReleased = true;
    requested = true;
    if (startupTimer) {
      clearTimeout(startupTimer);
      startupTimer = undefined;
    }
    if (delayedTimer) {
      clearTimeout(delayedTimer);
      delayedTimer = undefined;
    }
    if (scheduled) {
      return;
    }
    scheduled = true;
    setTimeout(() => {
      scheduled = false;
      void drain();
    }, 0);
  }

  return {
    start(): void {
      if (disposed || startupReleased || startupTimer) {
        return;
      }
      startupTimer = setTimeout(() => {
        startupTimer = undefined;
        schedule();
      }, Math.max(0, options.startupFallbackMs));
    },
    afterHealthCheck(): void {
      if (disposed || startupReleased) {
        return;
      }
      startupReleased = true;
      if (startupTimer) {
        clearTimeout(startupTimer);
      }
      startupTimer = setTimeout(() => {
        startupTimer = undefined;
        schedule();
      }, Math.max(0, options.postHealthDelayMs));
    },
    schedule,
    dispose(): void {
      disposed = true;
      requested = false;
      if (startupTimer) {
        clearTimeout(startupTimer);
        startupTimer = undefined;
      }
      if (delayedTimer) {
        clearTimeout(delayedTimer);
        delayedTimer = undefined;
      }
    }
  };
}

function yieldToEventLoop(): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, 0));
}

function nextWorkerRunAfterDelayMs(service: MemoryService): number | undefined {
  const now = Date.now();
  const runAt = service.nextWorkerRunAt();
  return runAt === undefined ? undefined : Math.max(1, runAt - now);
}

async function routeRequest(
  service: MemoryService,
  autoWorker: AutoWorkerDrain,
  method: string,
  url: URL,
  body: unknown,
  principal: AuthPrincipal,
  canShutdown: boolean,
  pluginRuntimeAnalytics: PluginRuntimeAnalytics
): Promise<unknown> {
  const path = url.pathname;

  if (method === "GET" && path === "/api/v1/health") {
    return service.health([...API_ROUTES]);
  }
  if (method === "POST" && path === "/api/v1/admin/reload-config") {
    requireAdminWrite(principal);
    const request = asObject(body, "admin.reload-config") as MemoryReloadConfigRequest;
    const result = service.reloadConfig({
      requestId: typeof request.requestId === "string" ? request.requestId : undefined,
      adapterId: typeof request.adapterId === "string" ? request.adapterId : undefined,
      reason: typeof request.reason === "string" ? request.reason : undefined,
      restartFailedProcessing: typeof request.restartFailedProcessing === "boolean"
        ? request.restartFailedProcessing
        : undefined
    });
    autoWorker.schedule();
    return result;
  }
  if (method === "POST" && path === "/api/v1/admin/shutdown") {
    requireAdminWrite(principal);
    if (!canShutdown) {
      throw new MemoryServiceError("conflict", "memory service restart is not managed by this server");
    }
    return {
      accepted: true,
      serverTime: new Date().toISOString()
    };
  }
  if (method === "POST" && path === "/api/v1/sessions/open") {
    requireMemoryWrite(principal);
    const request = envelopeWithPrincipal(asObject(body, "sessions.create"), principal) as SessionOpenRequest;
    const publicRequest: SessionOpenRequest = {
      requestId: request.requestId,
      adapterId: request.adapterId,
      namespace: request.namespace,
      source: request.source ?? request.namespace?.source,
      profileId: request.profileId ?? request.namespace?.profileId,
      projectId: request.namespace?.projectId,
      workspaceId: request.namespace?.workspaceId,
      sessionId: request.sessionId,
      workspacePath: request.workspacePath ?? request.namespace?.workspacePath,
      meta: isRecord(request.meta) ? request.meta : undefined,
      protocolVersion: typeof request.protocolVersion === "string" ? request.protocolVersion : undefined,
      provenance: isRecord(request.provenance) ? request.provenance : undefined
    };
    return publicOpenSessionResponse(
      await service.idempotent("sessions.create", publicRequest, publicRequest, () => service.openSession(publicRequest))
    );
  }

  const sessionCheckpoint = match(path, /^\/api\/v1\/sessions\/([^/]+)\/checkpoint$/);
  if (method === "POST" && sessionCheckpoint) {
    requireMemoryWrite(principal);
    const request = requestWithPrincipal<SessionCheckpointRequest>(body, "sessions.checkpoint", principal);
    requireStringField(request, "task", "sessions.checkpoint");
    return service.checkpointSession(decodeMatchSegment(sessionCheckpoint, 1), {
      namespace: request.namespace,
      episodeId: request.episodeId,
      task: request.task,
      changes: Array.isArray(request.changes) ? request.changes.filter((item): item is string => typeof item === "string") : undefined,
      validated: Array.isArray(request.validated) ? request.validated.filter((item): item is string => typeof item === "string") : undefined,
      unverified: Array.isArray(request.unverified) ? request.unverified.filter((item): item is string => typeof item === "string") : undefined,
      nextSteps: Array.isArray(request.nextSteps) ? request.nextSteps.filter((item): item is string => typeof item === "string") : undefined,
      sourceTurnIds: Array.isArray(request.sourceTurnIds) ? request.sourceTurnIds.filter((item): item is string => typeof item === "string") : undefined,
      sourceMemoryIds: Array.isArray(request.sourceMemoryIds) ? request.sourceMemoryIds.filter((item): item is string => typeof item === "string") : undefined,
      tokenEstimate: typeof request.tokenEstimate === "number" && Number.isFinite(request.tokenEstimate) ? Math.max(0, Math.trunc(request.tokenEstimate)) : undefined,
      createL1: request.createL1 !== false
    });
  }

  const sessionClose = match(path, /^\/api\/v1\/sessions\/([^/]+)\/close$/);
  if (method === "POST" && sessionClose) {
    requireMemoryWrite(principal);
    const request = envelopeWithPrincipal(asObject(body, "sessions.close"), principal) as RequestEnvelope;
    const sessionId = decodeMatchSegment(sessionClose, 1);
    const result = await service.idempotent("sessions.close", request, { sessionId, request }, () =>
      service.closeSession(sessionId, request)
    );
    scheduleAutoWorkerForEvolution(result, autoWorker);
    return publicCloseSessionResponse(result);
  }

  if (method === "POST" && path === "/api/v1/turns/start") {
    requireMemoryRead(principal);
    const request = requestWithPrincipal<TurnStartRequest>(body, "turn.start", principal);
    requireStringField(request, "sessionId", "turn.start");
    requireStringField(request, "query", "turn.start");
    const publicRequest: TurnStartRequest = {
      requestId: request.requestId,
      adapterId: request.adapterId,
      namespace: request.namespace,
      sessionId: request.sessionId,
      query: request.query,
      turnId: request.turnId,
      contextHints: request.contextHints,
      contextBudget: request.contextBudget,
      protocolVersion: typeof request.protocolVersion === "string" ? request.protocolVersion : undefined,
      provenance: isRecord(request.provenance) ? request.provenance : undefined
    };
    const result = await trackExternalHookRecall(pluginRuntimeAnalytics, request, () =>
      service.idempotent("turn.start", publicRequest, { request: publicRequest }, () =>
        service.startTurn(publicRequest as TurnStartRequest & Record<string, unknown>)
      )
    );
    scheduleAutoWorkerForEvolution(result, autoWorker);
    return publicStartTurnResponse(result);
  }

  const turnComplete = match(path, /^\/api\/v1\/turns\/([^/]+)\/complete$/);
  if (method === "POST" && turnComplete) {
    requireMemoryWrite(principal);
    const request = requestWithPrincipal<TurnCompleteRequest>(body, "turn.complete", principal);
    requireStringField(request, "sessionId", "turn.complete");
    requireStringField(request, "query", "turn.complete");
    requireStringField(request, "answer", "turn.complete");
    const turnId = decodeMatchSegment(turnComplete, 1);
    const publicRequest: TurnCompleteRequest = {
      requestId: request.requestId,
      adapterId: request.adapterId,
      namespace: request.namespace,
      sessionId: request.sessionId,
      episodeId: request.episodeId,
      query: request.query,
      answer: request.answer,
      reasoningSummary: request.reasoningSummary,
      tags: request.tags,
      toolCalls: request.toolCalls,
      toolResults: request.toolResults,
      artifacts: request.artifacts,
      sourceMemoryIds: request.sourceMemoryIds,
      protocolVersion: typeof request.protocolVersion === "string" ? request.protocolVersion : undefined,
      provenance: isRecord(request.provenance) ? request.provenance : undefined,
      usage: request.usage,
      status: request.status
    };
    const result = await trackExternalHookCapture(
      pluginRuntimeAnalytics,
      { ...request, turnId },
      request,
      () =>
        service.completeTurn(
          turnId,
          publicRequest as TurnCompleteRequest & Record<string, unknown>
        )
    );
    scheduleAutoWorkerForEvolution(result, autoWorker);
    return publicCompleteTurnResponse(result);
  }

  if (method === "POST" && path === "/api/v1/memory/search") {
    requireMemoryRead(principal);
    const request = requestWithPrincipal<MemorySearchRequest>(body, "memory.search", principal);
    requireStringField(request, "query", "memory.search");
    const publicRequest: MemorySearchRequest = {
      requestId: request.requestId,
      adapterId: request.adapterId,
      namespace: request.namespace,
      query: request.query,
      sessionId: request.sessionId,
      episodeId: request.episodeId,
      turnId: request.turnId,
      layers: normalizeLayers(request.layers),
      tags: Array.isArray(request.tags) ? request.tags.filter((tag): tag is string => typeof tag === "string") : undefined,
      limit: typeof request.limit === "number" && Number.isFinite(request.limit)
        ? Math.max(1, Math.trunc(request.limit))
        : undefined,
      contextBudget: typeof request.contextBudget === "number" && Number.isFinite(request.contextBudget)
        ? Math.max(0, Math.trunc(request.contextBudget))
        : undefined,
      includeInjectedContext: typeof request.includeInjectedContext === "boolean" ? request.includeInjectedContext : undefined,
      verbose: request.verbose === true
    };
    return publicSearchResponse(await trackExternalToolCall(
      pluginRuntimeAnalytics,
      { ...request, toolName: "memmy_memory_search" },
      () =>
        service.idempotent("memory.search", publicRequest, { path, request: publicRequest }, () =>
          service.search(publicRequest)
        ),
      (result) => ({ hit_count: hitCountFromSearchResponse(result) }),
    ));
  }

  if (method === "POST" && path === "/api/v1/memory/add") {
    requireMemoryWrite(principal);
    const request = requestWithPrincipal<MemoryAddRequest>(body, "memory.add", principal);
    requireStringField(request, "content", "memory.add");
    const publicRequest: MemoryAddRequest = {
      requestId: request.requestId,
      adapterId: request.adapterId,
      namespace: request.namespace,
      content: request.content,
      layer: parseLayerValue(request.layer),
      title: request.title,
      tags: Array.isArray(request.tags) ? request.tags.filter((tag): tag is string => typeof tag === "string") : undefined,
      source: request.source,
      sessionId: request.sessionId,
      turnId: request.turnId,
      createdAt: typeof request.createdAt === "string" ? request.createdAt : undefined,
      deferProcessing: request.deferProcessing === true,
      sourceMemoryIds: parseOptionalStringArray(request.sourceMemoryIds, "memory.add sourceMemoryIds"),
      provenance: isRecord(request.provenance) ? request.provenance : undefined,
      supersedesMemoryId: typeof request.supersedesMemoryId === "string" ? request.supersedesMemoryId : undefined,
      supersessionReason: typeof request.supersessionReason === "string" ? request.supersessionReason : undefined
    };
    const result = await trackExternalToolCall(
      pluginRuntimeAnalytics,
      { ...request, toolName: "memmy_memory_add" },
      () =>
        service.idempotent("memory.add", publicRequest, { path, request: publicRequest }, () =>
          service.addMemory(publicRequest)
        ),
      (addResult) => ({
        stored_count: storedCountFromAddResponse(addResult),
        ...(publicRequest.layer ? { layer: publicRequest.layer } : {}),
      }),
    );
    if (!publicRequest.deferProcessing) {
      autoWorker.schedule();
    }
    return result;
  }

  if (method === "POST" && path === "/api/v1/worker/import-summaries/enqueue") {
    requireMemoryWrite(principal);
    const request = asObject(body, "worker.import-summaries.enqueue") as { memoryIds?: unknown };
    const memoryIds = parseOptionalStringArray(
      request.memoryIds,
      "worker.import-summaries.enqueue.memoryIds"
    );
    const result = service.enqueuePendingImportSummaries(10_000, memoryIds, { namespace: principal.namespace });
    if (result.enqueued > 0) {
      autoWorker.schedule();
    }
    return result;
  }

  if (method === "POST" && path === "/api/v1/worker/run") {
    requireMemoryWrite(principal);
    const request = envelopeWithPrincipal(asObject(body, "worker.run"), principal) as RequestEnvelope & {
      limit?: unknown;
      targetMemoryIds?: unknown;
    };
    return service.runWorkerWithEvolutionSummary(
      parseNumberValue(request.limit) ?? parseNumber(url.searchParams.get("limit")) ?? 20,
      {
        ...request,
        targetMemoryIds: parseOptionalStringArray(request.targetMemoryIds, "worker.run.targetMemoryIds")
      }
    );
  }

  if (method === "POST" && path === "/api/v1/worker/retry-failed") {
    requireMemoryWrite(principal);
    const request = envelopeWithPrincipal(asObject(body, "worker.retry-failed"), principal) as RequestEnvelope & { limit?: unknown };
    const limit = parseNumberValue(request.limit) ?? 100;
    const retry = service.retryFailedWorkerJobs({ ...request, limit });
    const worker = await service.runWorkerWithEvolutionSummary(limit, request);
    return { ...retry, worker, generated: worker.generated };
  }

  if (method === "POST" && path === "/api/v1/worker/promote-candidates") {
    requireMemoryWrite(principal);
    const request = envelopeWithPrincipal(asObject(body, "worker.promote-candidates"), principal) as RequestEnvelope & { limit?: unknown };
    const promotion = service.promoteCandidates(request);
    const worker = await service.runWorkerWithEvolutionSummary(parseNumberValue(request.limit) ?? 100, request);
    return { ...promotion, worker, generated: worker.generated };
  }

  if (method === "GET" && path === "/api/v1/panel/overview") {
    requirePanelRead(principal);
    return service.panelOverviewSummary({
      namespace: principal.namespace
    });
  }

  if (method === "GET" && path === "/api/v1/panel/evolution") {
    requirePanelRead(principal);
    return service.evolutionOverview({ namespace: principal.namespace });
  }

  if (method === "GET" && path === "/api/v1/panel/context-pack") {
    requirePanelRead(principal);
    return service.projectContextPack({ namespace: principal.namespace });
  }

  if (method === "GET" && path === "/api/v1/panel/context-packs") {
    requirePanelRead(principal);
    return service.projectContextPacks({ namespace: principal.namespace });
  }

  if (method === "GET" && path === "/api/v1/panel/namespace-audit") {
    requirePanelRead(principal);
    return service.namespaceAudit({ namespace: principal.namespace });
  }

  if (method === "GET" && path === "/api/v1/panel/analysis") {
    requirePanelRead(principal);
    return service.panelAnalysis({
      namespace: principal.namespace
    });
  }

  if (method === "GET" && path === "/api/v1/panel/metrics") {
    requirePanelRead(principal);
    return service.serviceMetrics({
      namespace: principal.namespace
    });
  }

  if (method === "GET" && path === "/api/v1/panel/status") {
    requirePanelRead(principal);
    return service.adminStatus({
      namespace: principal.namespace
    }, [...API_ROUTES]);
  }

  if (method === "GET" && path === "/api/v1/panel/config") {
    requirePanelRead(principal);
    return service.configStatus({
      namespace: principal.namespace
    });
  }

  if (method === "GET" && path === "/api/v1/panel/activity") {
    requirePanelRead(principal);
    return service.serviceLogs({
      namespace: principal.namespace,
      limit: parseNumber(url.searchParams.get("limit")),
      cursor: url.searchParams.get("cursor") ?? undefined
    });
  }

  if (method === "GET" && path === "/api/v1/panel/items") {
    requirePanelRead(principal);
    return publicPanelItemsResponse(service.panelItems({
      namespace: principal.namespace,
      layer: parseLayer(url.searchParams.get("layer")),
      status: parseStatus(url.searchParams.get("status")),
      q: url.searchParams.get("q") ?? undefined,
      sourceAgent: url.searchParams.get("sourceAgent") ?? undefined,
      excludedSourceAgents: url.searchParams.getAll("excludedSourceAgents"),
      projectId: url.searchParams.get("projectId") ?? undefined,
      workspaceId: url.searchParams.get("workspaceId") ?? undefined,
      page: parseNumber(url.searchParams.get("page"))
    }));
  }

  if (method === "GET" && path === "/api/v1/panel/review/candidates") {
    requirePanelRead(principal);
    const layer = parseLayer(url.searchParams.get("layer"));
    return service.reviewCandidates({ namespace: principal.namespace, layer, limit: parseNumber(url.searchParams.get("limit")) });
  }

  const reviewApprove = match(path, /^\/api\/v1\/panel\/review\/candidates\/([^/]+)\/approve$/);
  if (method === "POST" && reviewApprove) {
    requireMemoryWrite(principal);
    const request = envelopeWithPrincipal(asObject(body, "panel.review.approve"), principal) as MemoryGovernanceRequest & { content?: unknown; title?: unknown };
    return service.approveCandidate(decodeMatchSegment(reviewApprove, 1), {
      ...request,
      content: typeof request.content === "string" ? request.content : undefined,
      title: typeof request.title === "string" ? request.title : undefined
    });
  }

  const reviewReject = match(path, /^\/api\/v1\/panel\/review\/candidates\/([^/]+)\/reject$/);
  if (method === "POST" && reviewReject) {
    requireMemoryWrite(principal);
    const request = envelopeWithPrincipal(asObject(body, "panel.review.reject"), principal) as MemoryGovernanceRequest;
    return service.rejectCandidate(decodeMatchSegment(reviewReject, 1), request);
  }

  if (method === "POST" && path === "/api/v1/panel/review/candidates/bulk-approve") {
    requireMemoryWrite(principal);
    const request = envelopeWithPrincipal(asObject(body, "panel.review.bulk-approve"), principal) as MemoryGovernanceRequest & { minimumConfidence?: unknown; layer?: unknown };
    return service.bulkApproveHighConfidenceCandidates({
      ...request,
      minimumConfidence: typeof request.minimumConfidence === "number" ? request.minimumConfidence : undefined,
      layer: parseLayer(typeof request.layer === "string" ? request.layer : null)
    });
  }

  if (method === "GET" && path === "/api/v1/panel/tasks") {
    requirePanelRead(principal);
    return publicPanelTasksResponse(service.panelTasks({
      namespace: principal.namespace,
      q: url.searchParams.get("q") ?? undefined,
      page: parseNumber(url.searchParams.get("page"))
    }));
  }

  if (method === "GET" && path === "/api/v1/memory/logs") {
    requirePanelRead(principal);
    return service.apiLogs({
      namespace: principal.namespace,
      tools: parseApiLogTools(url.searchParams.get("tools")),
      sourceAgent: url.searchParams.get("sourceAgent") ?? undefined,
      excludedSourceAgents: url.searchParams.getAll("excludedSourceAgents"),
      limit: parseNumber(url.searchParams.get("limit")),
      offset: parseNumber(url.searchParams.get("offset"))
    });
  }

  if (method === "POST" && path === "/api/v1/memory/processing/status") {
    requireMemoryRead(principal);
    const request = envelopeWithPrincipal(
      asObject(body, "memory.processing.status"),
      principal
    ) as RequestEnvelope & { memoryIds?: unknown };
    return service.memoryProcessingStatus(
      parseOptionalStringArray(request.memoryIds, "memory.processing.status.memoryIds") ?? [],
      request
    );
  }

  const memoryProcessingRetry = match(path, /^\/api\/v1\/memory\/([^/]+)\/processing\/retry$/);
  if (method === "POST" && memoryProcessingRetry) {
    requireMemoryWrite(principal);
    const request = envelopeWithPrincipal(
      asObject(body, "memory.processing.retry"),
      principal
    ) as RequestEnvelope;
    const result = service.retryMemoryProcessing(
      decodeMatchSegment(memoryProcessingRetry, 1),
      request
    );
    if (result.accepted) autoWorker.schedule();
    return result;
  }

  const memoryQuality = match(path, /^\/api\/v1\/memory\/([^/]+)\/quality$/);
  if (method === "POST" && memoryQuality) {
    requireMemoryWrite(principal);
    const request = envelopeWithPrincipal(asObject(body, "memory.quality"), principal) as MemoryGovernanceRequest & { useful?: unknown };
    if (typeof request.useful !== "boolean") throw new MemoryServiceError("invalid_argument", "memory.quality useful must be boolean");
    return service.rateMemory(decodeMatchSegment(memoryQuality, 1), request.useful, request);
  }

  const memoryArchive = match(path, /^\/api\/v1\/memory\/([^/]+)\/archive$/);
  if (method === "POST" && memoryArchive) {
    requireMemoryWrite(principal);
    const request = envelopeWithPrincipal(asObject(body, "memory.archive"), principal) as MemoryGovernanceRequest;
    return service.archiveMemory(decodeMatchSegment(memoryArchive, 1), request);
  }

  const memoryPromote = match(path, /^\/api\/v1\/memory\/([^/]+)\/promote$/);
  if (method === "POST" && memoryPromote) {
    requireMemoryWrite(principal);
    const request = envelopeWithPrincipal(asObject(body, "memory.promote"), principal) as MemoryGovernanceRequest;
    return service.promoteL1ToL2(decodeMatchSegment(memoryPromote, 1), request);
  }

  const memoryMerge = match(path, /^\/api\/v1\/memory\/([^/]+)\/merge$/);
  if (method === "POST" && memoryMerge) {
    requireMemoryWrite(principal);
    const request = envelopeWithPrincipal(asObject(body, "memory.merge"), principal) as MemoryGovernanceRequest & { sourceMemoryId?: unknown };
    if (typeof request.sourceMemoryId !== "string" || !request.sourceMemoryId.trim()) throw new MemoryServiceError("invalid_argument", "memory.merge sourceMemoryId is required");
    return service.mergeMemories(decodeMatchSegment(memoryMerge, 1), request.sourceMemoryId, request);
  }

  const memoryGet = match(path, /^\/api\/v1\/memory\/([^/]+)$/);
  if (method === "GET" && path === "/api/v1/memory/audit/markdown") {
    requireMemoryRead(principal);
    return service.exportMarkdown({
      namespace: principal.namespace,
      includeArchived: url.searchParams.get("includeArchived") === "true"
    });
  }

  if (method === "POST" && path === "/api/v1/memory/audit/markdown/import") {
    requireMemoryWrite(principal);
    const request = requestWithPrincipal<MemoryMarkdownImportRequest>(body, "memory.audit.markdown.import", principal);
    requireStringField(request, "markdown", "memory.audit.markdown.import");
    return service.importMarkdown({
      namespace: request.namespace,
      markdown: request.markdown,
      apply: request.apply !== false
    });
  }

  if (method === "GET" && memoryGet) {
    requireMemoryRead(principal);
    return trackExternalToolCall(
      pluginRuntimeAnalytics,
      {
        source: url.searchParams.get("source") ?? undefined,
        adapterId: url.searchParams.get("adapterId") ?? undefined,
        namespace: principal.namespace,
        toolName: "memmy_memory_get",
      },
      () =>
        service.getMemory(
          decodeMatchSegment(memoryGet, 1),
          { namespace: principal.namespace }
        ),
      (result) => ({ hit_count: hitCountFromGetResponse(result) }),
    );
  }

  const panelTaskDelete = match(path, /^\/api\/v1\/panel\/tasks\/([^/]+)$/);
  if (method === "DELETE" && panelTaskDelete) {
    requireMemoryWrite(principal);
    const request = envelopeWithPrincipal(asObject(body, "panel.task.delete"), principal) as MemoryGovernanceRequest;
    const id = decodeMatchSegment(panelTaskDelete, 1);
    return publicDeletePanelTaskResponse(service.deletePanelTask(id, request));
  }

  const memoryDelete = match(path, /^\/api\/v1\/memory\/([^/]+)$/);
  if (method === "DELETE" && memoryDelete) {
    requireMemoryWrite(principal);
    const request = envelopeWithPrincipal(asObject(body, "memory.delete"), principal) as MemoryGovernanceRequest;
    const id = decodeMatchSegment(memoryDelete, 1);
    return publicDeleteMemoryResponse(await service.idempotent("memory.delete", request, { id, request }, () =>
      service.deleteMemory(id, request)
    ));
  }

  throw new MemoryServiceError("not_found", `${method} ${path} is not registered`);
}

function publicOpenSessionResponse(result: unknown): Record<string, unknown> {
  const record = responseRecord(result);
  return {
    sessionId: record.sessionId,
    projectId: record.projectId,
    workspaceId: record.workspaceId,
    workspacePath: record.workspacePath,
    status: record.status,
    resumed: record.resumed,
    serverTime: record.serverTime
  };
}

function scheduleAutoWorkerForEvolution(result: unknown, autoWorker: AutoWorkerDrain): void {
  const record = responseRecord(result);
  const closedEpisodeIds = Array.isArray(record.closedEpisodeIds)
    ? record.closedEpisodeIds.filter((id): id is string => typeof id === "string" && id.length > 0)
    : [];
  const jobs = Array.isArray(record.jobs)
    ? record.jobs.filter((job): job is Record<string, unknown> => typeof job === "object" && job !== null)
    : [];
  if (closedEpisodeIds.length > 0 || jobs.length > 0 || record.scheduledEvolution === true) {
    autoWorker.schedule();
  }
}

function publicCloseSessionResponse(result: unknown): Record<string, unknown> {
  const record = responseRecord(result);
  return {
    ok: record.ok,
    sessionId: record.sessionId,
    status: record.status,
    serverTime: record.serverTime
  };
}

function publicCompleteTurnResponse(result: unknown): Record<string, unknown> {
  const record = responseRecord(result);
  return {
    turnId: record.turnId,
    sessionId: record.sessionId,
    episodeId: record.episodeId,
    rawTurnId: record.rawTurnId,
    l1MemoryId: record.l1MemoryId,
    scheduledEvolution: record.scheduledEvolution,
    jobs: record.jobs,
    changeSeq: record.changeSeq,
    serverTime: record.serverTime
  };
}

function publicStartTurnResponse(result: unknown): Record<string, unknown> {
  const record = responseRecord(result);
  return {
    turnId: record.turnId,
    contextPacketId: record.contextPacketId,
    sessionId: record.sessionId,
    episodeId: record.episodeId,
    searchEventId: record.searchEventId,
    injectedContext: record.injectedContext,
    sourceMemoryIds: record.sourceMemoryIds,
    hits: record.hits,
    status: record.status,
    serverTime: record.serverTime
  };
}

function publicSearchResponse(result: unknown): Record<string, unknown> {
  const record = responseRecord(result);
  if (record.verbose !== true) {
    return {
      injectedContext: publicSearchInjectedContextMarkdown(record.injectedContext)
    };
  }
  const injectedContext = publicSearchInjectedContextRecord(record.injectedContext);
  return {
    injectedContext: publicSearchInjectedContextMarkdown(injectedContext),
    debug: {
      searchEventId: record.searchEventId,
      hits: record.hits,
      sourceMemoryIds: record.sourceMemoryIds,
      retrievalDebug: record.retrievalDebug,
      status: record.status,
      sections: Array.isArray(injectedContext.sections) ? injectedContext.sections : [],
      tokenEstimate: typeof injectedContext.tokenEstimate === "number" ? injectedContext.tokenEstimate : undefined,
      serverTime: record.serverTime
    }
  };
}

function publicSearchInjectedContextRecord(value: unknown): Record<string, unknown> {
  return typeof value === "object" && value !== null
    ? value as Record<string, unknown>
    : {};
}

function publicSearchInjectedContextMarkdown(value: unknown): string {
  const record = publicSearchInjectedContextRecord(value);
  return typeof record.markdown === "string" ? record.markdown : "";
}

function publicPanelItemsResponse(result: unknown): Record<string, unknown> {
  const record = responseRecord(result);
  return {
    items: record.items,
    page: record.page,
    pageSize: record.pageSize,
    total: record.total,
    totalPages: record.totalPages,
    hasNext: record.hasNext,
    hasPrev: record.hasPrev,
    serverTime: record.serverTime
  };
}

function publicPanelTasksResponse(result: unknown): Record<string, unknown> {
  const record = responseRecord(result);
  return {
    tasks: record.tasks,
    page: record.page,
    pageSize: record.pageSize,
    total: record.total,
    totalPages: record.totalPages,
    hasNext: record.hasNext,
    hasPrev: record.hasPrev,
    serverTime: record.serverTime
  };
}

function publicDeletePanelTaskResponse(result: unknown): Record<string, unknown> {
  const record = responseRecord(result);
  return {
    ok: record.ok,
    id: record.id,
    deletedMemoryIds: record.deletedMemoryIds,
    serverTime: record.serverTime
  };
}

function publicDeleteMemoryResponse(result: unknown): Record<string, unknown> {
  const record = responseRecord(result);
  return {
    ok: record.ok,
    id: record.id,
    kind: record.kind,
    status: record.status,
    changeSeq: record.changeSeq,
    syncCursor: record.syncCursor,
    auditId: record.auditId,
    serverTime: record.serverTime
  };
}

function responseRecord(value: unknown): Record<string, unknown> {
  return isRecord(value) ? value : {};
}

async function readJson(request: IncomingMessage): Promise<unknown> {
  if (request.method === "GET" || request.method === "HEAD") {
    return {};
  }
  const chunks: Buffer[] = [];
  let size = 0;
  for await (const chunk of request) {
    const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
    size += buffer.length;
    if (size > 2 * 1024 * 1024) {
      throw new MemoryServiceError("invalid_argument", "request body is too large");
    }
    chunks.push(buffer);
  }
  if (chunks.length === 0) {
    return {};
  }
  const raw = Buffer.concat(chunks).toString("utf8");
  if (!raw.trim()) {
    return {};
  }
  try {
    return JSON.parse(raw) as unknown;
  } catch {
    throw new MemoryServiceError("invalid_argument", "request body must be valid JSON");
  }
}

function writeJson(response: ServerResponse, status: number, body: unknown): void {
  const payload = JSON.stringify(body, null, 2);
  response.writeHead(status, {
    "content-type": "application/json; charset=utf-8",
    "content-length": Buffer.byteLength(payload)
  });
  response.end(payload);
}

function writeHtml(response: ServerResponse, html: string): void {
  response.writeHead(200, {
    "content-type": "text/html; charset=utf-8",
    "content-length": Buffer.byteLength(html)
  });
  response.end(html);
}

function writeError(response: ServerResponse, error: unknown, requestId?: string): void {
  if (error instanceof MemoryServiceError) {
    writeJson(response, statusForCode(error.code), {
      error: {
        code: error.code,
        message: error.message,
        requestId: error.requestId ?? requestId
      }
    });
    return;
  }
  writeJson(response, 500, {
    error: {
      code: "internal",
      message: error instanceof Error ? error.message : String(error),
      requestId
    }
  });
}

function requestIdFromHeaders(request: IncomingMessage): string | undefined {
  return headerString(request, "x-request-id") ?? headerString(request, "x-correlation-id");
}

function authenticate(
  request: IncomingMessage,
  url: URL,
  options: MemoryHttpServerOptions
): AuthPrincipal {
  if (url.pathname === "/api/v1/health") {
    return { kind: "anonymous", scopes: ["health:read"] };
  }
  const auth = options.auth;
  const localToken = auth?.localServiceToken ?? options.apiKey;
  const candidate = tokenFromRequest(request, url);
  if (localToken && candidate === localToken) {
    return {
      kind: "local",
      tokenId: "local-service-token",
      namespace: namespaceFromRequest(request, url),
      scopes: ["*"]
    };
  }
  const cloudNamespace = candidate ? auth?.cloudAccessTokens?.[candidate] : undefined;
  if (cloudNamespace) {
    return {
      kind: "cloud",
      tokenId: stableTokenId(candidate!),
      namespace: mergeNamespaces(cloudNamespace, namespaceFromRequest(request, url)),
      scopes: ["*"]
    };
  }
  const scoped = candidate ? auth?.scopedApiKeys?.[candidate] : undefined;
  if (scoped) {
    return {
      kind: "scoped",
      tokenId: stableTokenId(candidate!),
      namespace: mergeNamespaces(scoped.namespace, namespaceFromRequest(request, url)),
      scopes: scoped.scopes ?? ["memory:read", "memory:write"]
    };
  }
  if (!localToken && (!auth || auth.allowAnonymous === true)) {
    return {
      kind: "anonymous",
      namespace: namespaceFromRequest(request, url),
      scopes: ["*"]
    };
  }
  throw new MemoryServiceError("unauthorized", "invalid memory service token", 401, requestIdFromHeaders(request));
}

function tokenFromRequest(request: IncomingMessage, url: URL): string | undefined {
  const authorization = request.headers.authorization;
  const bearer = authorization?.startsWith("Bearer ")
    ? authorization.slice("Bearer ".length)
    : undefined;
  const headerKey = request.headers["x-api-key"];
  const apiKey = Array.isArray(headerKey) ? headerKey[0] : headerKey;
  return bearer ?? apiKey ?? url.searchParams.get("token") ?? url.searchParams.get("access_token") ?? undefined;
}

function isViewerPath(path: string): boolean {
  return path === "/" || path === "/viewer" || path === "/viewer/";
}

function namespaceFromRequest(request: IncomingMessage, url: URL): RuntimeNamespace | undefined {
  const userId = headerString(request, "x-memmy-user-id");
  const tenantId = headerString(request, "x-memmy-tenant-id");
  const projectId = headerString(request, "x-memmy-project-id");
  const workspaceId = headerString(request, "x-memmy-workspace-id");
  const workspacePath = headerString(request, "x-memmy-workspace-path");
  const source = sourceString(url.searchParams.get("source"));
  const profileId = headerString(request, "x-memmy-profile-id");
  const profileLabel = headerString(request, "x-memmy-profile-label");
  const sessionKey = headerString(request, "x-memmy-session-key");
  const any = userId || tenantId || projectId || workspaceId || workspacePath || source ||
    profileId || profileLabel || sessionKey;
  if (!any) return undefined;
  return {
    userId,
    tenantId,
    projectId,
    workspaceId,
    workspacePath,
    source: source ?? DEFAULT_NAMESPACE_SOURCE,
    profileId: profileId ?? "default",
    profileLabel,
    sessionKey
  };
}

function sourceString(value: string | null | undefined): string | undefined {
  return value && value.trim() ? value.trim() : undefined;
}

function headerString(request: IncomingMessage, key: string): string | undefined {
  const value = request.headers[key];
  const out = Array.isArray(value) ? value[0] : value;
  return out && out.trim() ? out.trim() : undefined;
}

function stableTokenId(token: string): string {
  let hash = 0;
  for (let index = 0; index < token.length; index += 1) {
    hash = (hash * 31 + token.charCodeAt(index)) >>> 0;
  }
  return `tok_${hash.toString(16).padStart(8, "0")}`;
}

function requireMemoryRead(principal: AuthPrincipal): void {
  requireAnyScope(principal, ["memory:read", "memory:write", "panel:read", "panel:write", "admin:read", "admin:write"]);
}

function requireMemoryWrite(principal: AuthPrincipal): void {
  requireAnyScope(principal, ["memory:write", "panel:write", "admin:write"]);
}

function requirePanelRead(principal: AuthPrincipal): void {
  requireAnyScope(principal, ["panel:read", "panel:write", "memory:read", "memory:write", "admin:read", "admin:write"]);
}

function requireAdminWrite(principal: AuthPrincipal): void {
  requireAnyScope(principal, ["admin:write"]);
}

function requireAnyScope(principal: AuthPrincipal, allowed: string[]): void {
  if (principal.scopes.includes("*")) {
    return;
  }
  if (allowed.some((scope) => hasScope(principal, scope))) {
    return;
  }
  throw new MemoryServiceError("forbidden", `token scope does not allow this route`);
}

function hasScope(principal: AuthPrincipal, scope: string): boolean {
  if (principal.scopes.includes(scope)) {
    return true;
  }
  const [domain] = scope.split(":");
  return principal.scopes.includes(`${domain}:*`);
}

function asObject(body: unknown, routeName: string): Record<string, unknown> {
  if (body && typeof body === "object" && !Array.isArray(body)) {
    return body as Record<string, unknown>;
  }
  throw new MemoryServiceError("invalid_argument", `${routeName} request body must be a JSON object`);
}

function requestWithPrincipal<T extends RequestEnvelope>(
  body: unknown,
  routeName: string,
  principal: AuthPrincipal
): T {
  return envelopeWithPrincipal(asObject(body, routeName), principal) as unknown as T;
}

function envelopeWithPrincipal<T extends Record<string, unknown>>(
  body: T,
  principal: AuthPrincipal
): T & RequestEnvelope {
  const existing = isRecord(body.namespace) ? body.namespace as unknown as RuntimeNamespace : undefined;
  const mergedNamespace = mergeNamespaces(mergeNamespaces(existing, namespaceFromSource(body.source)), principal.namespace);
  // Source/profile identify provenance, but cannot establish an isolation
  // boundary. Keep those fields on the request only when a project, tenant,
  // or workspace scope is present; legacy source-only REST calls resolve IDs
  // through their session and remain compatible with the service API.
  const namespace = mergedNamespace && (
    Boolean(mergedNamespace.projectId) ||
    Boolean(mergedNamespace.workspaceId) ||
    Boolean(mergedNamespace.workspacePath) ||
    Boolean(mergedNamespace.tenantId)
  ) ? mergedNamespace : undefined;
  assertNamespaceScope(existing, principal.namespace);
  return {
    ...body,
    namespace
  } as T & RequestEnvelope;
}

function namespaceFromSource(source: unknown): RuntimeNamespace | undefined {
  if (typeof source !== "string" || !source.trim()) {
    return undefined;
  }
  return {
    source: source.trim(),
    profileId: "default"
  };
}

function mergeNamespaces(
  requestNamespace: RuntimeNamespace | undefined,
  principalNamespace: RuntimeNamespace | undefined
): RuntimeNamespace | undefined {
  if (!requestNamespace && !principalNamespace) return undefined;
  const principalSource = principalNamespace?.source;
  return {
    ...(requestNamespace ?? {}),
    ...(principalNamespace ?? {}),
    source: principalSource && principalSource !== DEFAULT_NAMESPACE_SOURCE
      ? principalSource
      : requestNamespace?.source ?? DEFAULT_NAMESPACE_SOURCE,
    profileId: principalNamespace?.profileId ?? requestNamespace?.profileId ?? "default"
  };
}

function assertNamespaceScope(
  requestNamespace: RuntimeNamespace | undefined,
  principalNamespace: RuntimeNamespace | undefined
): void {
  if (!requestNamespace || !principalNamespace) return;
  const requested = normalizeNamespace(requestNamespace);
  const allowed = normalizeNamespace(principalNamespace);
  const checks: Array<[string, string | undefined, string | undefined]> = [
    ["tenantId", requestNamespace.tenantId, principalNamespace.tenantId],
    ["userId", requestNamespace.userId, principalNamespace.userId],
    ["projectId", requested.projectId, allowed.projectId],
    ["workspaceId", requested.workspaceId, allowed.workspaceId]
  ];
  for (const [field, actual, expected] of checks) {
    if (actual && expected && actual !== expected) {
      throw new MemoryServiceError("forbidden", `request namespace exceeds token scope: ${field}`);
    }
  }
}

function requireStringField(record: object, field: string, routeName: string): void {
  const value = (record as Record<string, unknown>)[field];
  if (typeof value !== "string" || value.trim().length === 0) {
    throw new MemoryServiceError("invalid_argument", `${routeName} requires ${field}`);
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value && typeof value === "object" && !Array.isArray(value));
}

function setCors(response: ServerResponse): void {
  response.setHeader("access-control-allow-origin", "*");
  response.setHeader("access-control-allow-methods", "GET,POST,DELETE,OPTIONS");
  response.setHeader(
    "access-control-allow-headers",
    [
      "content-type",
      "authorization",
      "x-api-key",
      "x-request-id",
      "x-correlation-id",
      "x-memmy-user-id",
      "x-memmy-tenant-id",
      "x-memmy-project-id",
      "x-memmy-workspace-id",
      "x-memmy-workspace-path",
      "x-memmy-profile-id",
      "x-memmy-profile-label",
      "x-memmy-session-key"
    ].join(",")
  );
}

function match(path: string, pattern: RegExp): RegExpMatchArray | null {
  return path.match(pattern);
}

function decodeMatchSegment(matchResult: RegExpMatchArray, index: number): string {
  const segment = matchResult[index];
  if (segment === undefined) {
    throw new MemoryServiceError("invalid_argument", "missing path segment");
  }
  return decodeURIComponent(segment);
}

function parseNumber(value: string | null): number | undefined {
  if (value === null || value === "") {
    return undefined;
  }
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : undefined;
}

function parseNumberValue(value: unknown): number | undefined {
  if (typeof value === "number" && Number.isFinite(value)) {
    return value;
  }
  return typeof value === "string" ? parseNumber(value) : undefined;
}

function parseOptionalStringArray(value: unknown, field: string): string[] | undefined {
  if (value === undefined) {
    return undefined;
  }
  if (!Array.isArray(value) || value.some((item) => typeof item !== "string" || item.length === 0)) {
    throw new MemoryServiceError("invalid_argument", `${field} must be an array of non-empty strings`);
  }
  return [...new Set(value)];
}

function parseApiLogTools(value: string | null): Array<"memory_add" | "memory_search" | "skill_generate" | "skill_evolve"> | undefined {
  if (!value) {
    return undefined;
  }
  const allowed = new Set(["memory_add", "memory_search", "skill_generate", "skill_evolve"]);
  return value
    .split(",")
    .map((item) => item.trim())
    .filter((item): item is "memory_add" | "memory_search" | "skill_generate" | "skill_evolve" => allowed.has(item));
}

function parseLayer(value: string | null): MemoryLayer | undefined {
  return parseLayerValue(value);
}

function parseLayerValue(value: unknown): MemoryLayer | undefined {
  if (value === "L1" || value === "L2" || value === "L3" || value === "Skill") {
    return value;
  }
  return undefined;
}

function normalizeLayers(value: unknown): MemoryLayer[] | undefined {
  if (!Array.isArray(value)) {
    return undefined;
  }
  const layers = value
    .map(parseLayerValue)
    .filter((layer): layer is MemoryLayer => Boolean(layer));
  return layers.length > 0 ? layers : undefined;
}

function parseStatus(value: string | null): "activated" | "resolving" | "archived" | "deleted" | undefined {
  if (value === "activated" || value === "resolving" || value === "archived" || value === "deleted") {
    return value;
  }
  return undefined;
}
