import { mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import { fileURLToPath } from "node:url";
import {
  API_ROUTES,
  DEFAULT_MEMMY_CONFIG,
  MemoryDb,
  MemoryRestClient,
  MemoryService,
  listenMemoryHttpServer,
  type Embedder
} from "../../Memory/src/index.js";
import { createLocalBackend, type LocalBackend } from "../../App/backend/src/index.js";
import { createHttpMemoryClient } from "../../App/backend/src/adapters/outbound/memory-client/index.js";

const MEMORY_TOKEN = "memory-layer-smoke-token";
const BACKEND_TOKEN = "backend-smoke-token";

export interface MemoryLayerSmokeResult {
  healthRouteCount: number;
  backendChecks: number;
  memoryId: string;
  recallHitCount: number;
  panelItemCount: number;
}

export async function runMemoryLayerSmoke(): Promise<MemoryLayerSmokeResult> {
  const root = mkdtempSync(join(tmpdir(), "memmy-memory-layer-smoke-"));
  const configPath = join(root, "config.yaml");
  const adapterDirectory = join(root, "empty-agent-adapters");
  mkdirSync(adapterDirectory, { recursive: true });
  const db = new MemoryDb({ path: join(root, "memory.sqlite") });
  const service = new MemoryService({
    db,
    mode: "dev",
    configPath,
    configLoader: () => ({ config: DEFAULT_MEMMY_CONFIG, path: configPath }),
    config: DEFAULT_MEMMY_CONFIG,
    embedder: createSmokeEmbedder()
  });
  let server: Awaited<ReturnType<typeof listenMemoryHttpServer>> | undefined;
  let backend: LocalBackend | undefined;
  let primaryError: unknown;
  const previousCloudService = process.env.MEMMY_CLOUD_SERVICE;
  process.env.MEMMY_CLOUD_SERVICE = "http://127.0.0.1:9";

  try {
    server = await listenMemoryHttpServer({
      service,
      host: "127.0.0.1",
      port: 0,
      apiKey: MEMORY_TOKEN,
      workerStartupFallbackMs: 60_000,
      workerPostHealthDelayMs: 60_000,
      configPath,
      startAgentSourceAutomation: false
    });
    const directClient = new MemoryRestClient({ endpoint: server.url, token: MEMORY_TOKEN });
    const health = await directClient.health();
    assert(health.ok, "Direct Memory health must be ready");
    assert(
      health.capabilities.routes.length === API_ROUTES.length,
      "Memory health must expose the complete public route contract"
    );

    backend = await createLocalBackend({
      databasePath: join(root, "backend.sqlite"),
      runtimeConfigPath: join(root, "runtime.json"),
      memmyConfigPath: configPath,
      memoryBaseUrl: server.url,
      localToken: BACKEND_TOKEN,
      heartbeatIntervalMs: 60_000,
      memoryClient: createHttpMemoryClient({
        baseUrl: server.url,
        token: MEMORY_TOKEN,
        timeoutMs: 5_000,
        maxRetries: 0
      }),
      agentAdapterPluginDirectories: [adapterDirectory]
    });

    const backendHealth = await backendRequest<{ ok?: boolean }>(
      backend.runtimeConfig.baseUrl,
      "GET",
      "/api/v1/health"
    );
    assert(backendHealth.ok, "Backend must proxy Memory health through the typed client");

    const sessionId = "backend-memory-smoke-session";
    const opened = await backendRequest<{ sessionId?: string; status?: string }>(
      backend.runtimeConfig.baseUrl,
      "POST",
      "/api/v1/sessions/open",
      { sessionId, source: "backend-smoke", adapterId: "backend-smoke" }
    );
    assert(opened.sessionId === sessionId && opened.status === "open", "Backend must open the Memory session");

    const turnId = "backend-memory-smoke-turn";
    const started = await backendRequest<{ turnId?: string }>(
      backend.runtimeConfig.baseUrl,
      "POST",
      "/api/v1/turns/start",
      {
        requestId: "backend-smoke-start",
        adapterId: "backend-smoke",
        source: "backend-smoke",
        sessionId,
        turnId,
        query: "Verify the Memmy v1.1.2 release attachment contract",
        layers: ["L1"]
      }
    );
    assert(started.turnId === turnId, "Backend must start the requested turn");

    const completed = await backendRequest<{ l1MemoryId?: string }>(
      backend.runtimeConfig.baseUrl,
      "POST",
      `/api/v1/turns/${encodeURIComponent(turnId)}/complete`,
      {
        requestId: "backend-smoke-complete",
        adapterId: "backend-smoke",
        source: "backend-smoke",
        sessionId,
        query: "Verify the Memmy v1.1.2 release attachment contract",
        answer: "Run every release check and publish only after every attachment is verified.",
        status: "succeeded"
      }
    );
    const memoryId = completed.l1MemoryId;
    assert(memoryId, "Backend completion must return an L1 Memory id");
    await waitForProcessingReady(backend.runtimeConfig.baseUrl, memoryId);

    const queryId = "backend-smoke-query";
    const recall = await backendRequest<{
      debug?: { searchEventId?: string; hits?: Array<{ id?: string }> };
    }>(backend.runtimeConfig.baseUrl, "POST", "/api/v1/memory/search", {
      requestId: "backend-smoke-search",
      adapterId: "backend-smoke",
      source: "backend-smoke",
      sessionId,
      turnId: queryId,
      query: "v1.1.2 release attachments",
      layers: ["L1"],
      verbose: true
    });
    const hits = recall.debug?.hits ?? [];
    assert(hits.some((hit) => hit.id === memoryId), "Backend search must recall the completed turn");
    assert(recall.debug?.searchEventId, "Verbose Backend search must expose a search event id");
    const evidence = await backendRequest<{ queryId?: string }>(
      backend.runtimeConfig.baseUrl,
      "GET",
      `/api/v1/memory/recalls/${encodeURIComponent(queryId)}`
    );
    assert(evidence.queryId === queryId, "Backend must expose recall evidence for the query id");

    const detail = await backendRequest<{ item?: { id?: string } }>(
      backend.runtimeConfig.baseUrl,
      "GET",
      `/api/v1/memory/${encodeURIComponent(memoryId)}`
    );
    assert(detail.item?.id === memoryId, "Backend detail must return the completed turn");
    await backendRequest(backend.runtimeConfig.baseUrl, "GET", "/api/v1/panel/overview");
    const panel = await backendRequest<{ items?: Array<{ id?: string }> }>(
      backend.runtimeConfig.baseUrl,
      "GET",
      "/api/v1/panel/items?layer=L1&status=activated&page=1"
    );
    const panelItems = panel.items ?? [];
    assert(panelItems.some((item) => item.id === memoryId), "Backend panel must expose the completed turn");

    const closeSessionId = "backend-memory-smoke-close-session";
    await backendRequest(backend.runtimeConfig.baseUrl, "POST", "/api/v1/sessions/open", {
      sessionId: closeSessionId,
      source: "backend-smoke"
    });
    const closed = await backendRequest<{
      closedEpisodeIds?: string[];
      changeSeq?: number;
      syncCursor?: string;
    }>(
      backend.runtimeConfig.baseUrl,
      "POST",
      `/api/v1/sessions/${encodeURIComponent(closeSessionId)}/close`,
      {}
    );
    assert(Array.isArray(closed.closedEpisodeIds), "Backend close must preserve closedEpisodeIds");
    assert(typeof closed.changeSeq === "number", "Backend close must preserve changeSeq");
    assert(typeof closed.syncCursor === "string", "Backend close must preserve syncCursor");

    const deleted = await backendRequest<{ ok?: boolean; id?: string; status?: string }>(
      backend.runtimeConfig.baseUrl,
      "DELETE",
      `/api/v1/memory/${encodeURIComponent(memoryId)}`,
      {}
    );
    assert(deleted.ok && deleted.id === memoryId && deleted.status === "deleted", "Backend must delete the smoke Memory");

    return {
      healthRouteCount: health.capabilities.routes.length,
      backendChecks: 12,
      memoryId,
      recallHitCount: hits.length,
      panelItemCount: panelItems.length
    };
  } catch (error) {
    primaryError = error;
    throw error;
  } finally {
    const cleanupErrors: unknown[] = [];
    if (backend) {
      try {
        await backend.close();
      } catch (error) {
        cleanupErrors.push(error);
      }
    }
    if (server) {
      try {
        await new Promise<void>((resolveClose) => server?.server.close(() => resolveClose()));
      } catch (error) {
        cleanupErrors.push(error);
      }
    }
    try {
      db.close();
    } catch (error) {
      cleanupErrors.push(error);
    }
    try {
      restoreEnv("MEMMY_CLOUD_SERVICE", previousCloudService);
    } catch (error) {
      cleanupErrors.push(error);
    }
    try {
      rmSync(root, { recursive: true, force: true, maxRetries: 5, retryDelay: 50 });
    } catch (error) {
      cleanupErrors.push(error);
    }
    if (cleanupErrors.length > 0) {
      if (primaryError === undefined) {
        throw new AggregateError(cleanupErrors, "Memory-layer smoke cleanup failed");
      }
      console.error(`Memory-layer smoke cleanup also failed: ${cleanupErrors.map(errorMessage).join("; ")}`);
    }
  }
}

async function waitForProcessingReady(baseUrl: string, memoryId: string): Promise<void> {
  const deadline = Date.now() + 5_000;
  while (Date.now() < deadline) {
    const status = await backendRequest<{
      items?: Array<{ memoryId?: string; state?: string; errorMessage?: string | null }>;
    }>(baseUrl, "POST", "/api/v1/memory/processing/status", { memoryIds: [memoryId] });
    const item = status.items?.find((candidate) => candidate.memoryId === memoryId);
    if (item?.state === "ready" || item?.state === "ready_text_only") return;
    if (item?.state === "failed") {
      throw new Error(`Memory processing failed: ${item.errorMessage ?? "unknown error"}`);
    }
    await delay(25);
  }
  throw new Error(`Memory processing did not become ready: ${memoryId}`);
}

async function backendRequest<T = unknown>(
  baseUrl: string,
  method: "GET" | "POST" | "DELETE",
  path: string,
  body?: unknown
): Promise<T> {
  const response = await fetch(`${baseUrl}${path}`, {
    method,
    headers: {
      "x-memmy-local-token": BACKEND_TOKEN,
      ...(body === undefined ? {} : { "content-type": "application/json" })
    },
    body: body === undefined ? undefined : JSON.stringify(body)
  });
  const text = await response.text();
  if (!response.ok) {
    throw new Error(`Backend ${method} ${path} failed (${response.status}): ${text}`);
  }
  return (text ? JSON.parse(text) : undefined) as T;
}

function restoreEnv(name: string, value: string | undefined): void {
  if (value === undefined) delete process.env[name];
  else process.env[name] = value;
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function createSmokeEmbedder(): Embedder {
  return {
    config: {
      ...DEFAULT_MEMMY_CONFIG.embedding,
      provider: "local",
      model: "memory-layer-smoke-embedding"
    },
    isRemote: () => false,
    async embed(texts: string[]) {
      return texts.map(() => [1, 0, 0]);
    },
    async embedOne() {
      return [1, 0, 0];
    },
    status() {
      return {
        provider: "local",
        model: "memory-layer-smoke-embedding",
        configured: true,
        remote: false
      };
    }
  };
}

function assert(condition: unknown, message: string): asserts condition {
  if (!condition) throw new Error(message);
}

const entrypoint = process.argv[1] ? resolve(process.argv[1]) : "";
if (entrypoint === fileURLToPath(import.meta.url)) {
  runMemoryLayerSmoke()
    .then((result) => process.stdout.write(`${JSON.stringify(result)}\n`))
    .catch((error: unknown) => {
      console.error(error instanceof Error ? error.stack ?? error.message : String(error));
      process.exitCode = 1;
    });
}
