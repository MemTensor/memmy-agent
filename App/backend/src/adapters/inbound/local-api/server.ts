/** Memmy local API contract. */
import { SseEventSchema, type SseEvent } from "@memmy/local-api-contracts";
import Fastify, { type FastifyInstance, type FastifyReply, type FastifyRequest } from "fastify";
import { randomUUID } from "node:crypto";
import { KnowledgeError, ManagedKnowledgeClient, parseEvidence, type ManagedKnowledgeOptions } from "@memmy/knowledge";
import { registerKnowledgeRoutes } from "@memmy/knowledge/routes";
import type { PermissionManager } from "../../../permission/index.js";
import type { BackendServices } from "../../../services/index.js";
import type { CollabService } from "../../../services/collab-service.js";
import type { CollabAgentAccessService } from "../../../services/collab-agent-access-service.js";
import type { CollabAssistService } from "../../../services/collab-assist-service.js";
import type { ProjectDirectoryService } from "../../../services/project-directory-service.js";
import { registerAccountRoutes } from "./routes/account.js";
import { registerCollabRoutes } from "./routes/collab.js";
import { registerCollabAssistRoutes } from "./routes/collab-assist.js";
import { registerTokenQuotaRoutes } from "./routes/token-quota.js";
import { registerAppConfigRoutes } from "./routes/app-config.js";
import { registerAgentSourceRoutes } from "./routes/agent-sources.js";
import { registerAgentRuntimeRoutes } from "./routes/agent-runtime/index.js";
import { registerAsrRoutes } from "./routes/asr.js";
import { registerByokTokenUsageRoutes } from "./routes/byok-token-usage.js";
import { registerChannelRoutes } from "./routes/channels.js";
import { registerComposioMcpRoutes } from "./routes/composio-mcp.js";
import { registerIntegrationRoutes } from "./routes/integrations.js";
import { registerLocalDataRoutes } from "./routes/local-data.js";
import { registerOnboardingInsightRoutes } from "./routes/onboarding-insight.js";
import { registerProjectRoutes } from "./routes/projects.js";
import { registerPluginRoutes } from "./routes/plugins.js";
import { registerPluginMcpRoutes } from "./routes/plugin-mcp.js";

const DEFAULT_HEARTBEAT_INTERVAL_MS = 15_000;
const LOCAL_API_SERVICE_NAME = "memmy-local-api";
const RUNTIME_TOKEN_HEADER = "x-memmy-local-token";
const CORS_ALLOWED_METHODS = "GET,POST,PUT,PATCH,DELETE,OPTIONS";
const CORS_ALLOWED_HEADERS = `content-type,${RUNTIME_TOKEN_HEADER},x-memmy-time-zone`;
const DEFAULT_ALLOWED_LOCAL_HOSTS = new Set(["127.0.0.1", "localhost", "::1", "[::1]"]);
const OPAQUE_ORIGIN = "null";
const FILE_ORIGIN = "file://";

export interface CreateLocalApiServerOptions {
  knowledge?: ManagedKnowledgeOptions;
  /** Online projects; absent in tests that do not exercise them. */
  collab?: CollabService;
  /** 「在其他 Agent 中使用协作项目」的授权状态；absent 时那几个接口不可用。 */
  collabAgentAccess?: CollabAgentAccessService;
  /** 成员协助：执行方的收件箱与授权、发起方的请求卡片；absent 时那几个接口不可用。 */
  collabAssist?: CollabAssistService;
  /** The managed folder a project created by name alone runs its tasks in. */
  projectDirectory?: ProjectDirectoryService;
  permissionManager: PermissionManager;
  services: BackendServices;
  /** Configured agent timezone. Renderer headers are used only when absent. */
  timeZone?: string;
  /**
   * Local validation token shared by Memmy's loopback MCP bridges.
   */
  composioMcpToken: string;
  heartbeatIntervalMs?: number;
  allowedOrigins?: readonly string[];
  pluginCapabilitiesChanged?: () => Promise<void>;
}

interface EventsQuerystring {
  token?: string;
}

export function createLocalApiServer(options: CreateLocalApiServerOptions): FastifyInstance {
  // This only creates the Fastify instance and does not listen; port binding and lifecycle are managed by the upstream backend launcher.
  const app = Fastify({ logger: false });
  const heartbeatIntervalMs = options.heartbeatIntervalMs ?? DEFAULT_HEARTBEAT_INTERVAL_MS;
  const authenticateRuntimeToken = createRuntimeTokenPreHandler(options.permissionManager);
  const eventStreams = new Set<() => void>();
  let closing = false;
  const registerEventStream = (stop: () => void) => {
    // Authentication may finish after preClose has already drained existing streams.
    if (closing) stop();
    else eventStreams.add(stop);
    return () => { eventStreams.delete(stop); };
  };
  app.addHook("preClose", async () => {
    closing = true;
    // The renderer closes after this server; do not wait for its EventSource to
    // disconnect. End only our notification streams, preserving ordinary writes.
    for (const stop of eventStreams) stop();
  });
  app.addHook("onResponse", async () => {
    // A request already running at preClose can become idle after Fastify's
    // initial idle sweep. Preserve its response, then retire the idle socket.
    if (closing) app.server.closeIdleConnections();
  });

  if (options.knowledge) {
    registerKnowledgeRoutes(app, {
      ...options.knowledge,
      authenticate: authenticateRuntimeToken,
      // 会话目录属于某个协作项目时，项目关联的知识库与该成员自己的库一起检索。
      projectForWorkspace: async (workspace) =>
        (await options.collab?.cloudProjectForDirectory(workspace)) ?? null,
    });
  }

  app.addHook("onRequest", async (request, reply) => {
    // The desktop renderer process may run under Vite or file://, so handle CORS and preflight uniformly at the entry layer.
    const origin = getSingleHeaderValue(request.headers.origin);
    const originAllowed = applyCorsHeaders(reply, origin, options.allowedOrigins);

    if (origin && !originAllowed) {
      return reply.code(403).send({ error: "forbidden_origin" });
    }

    reply.header("access-control-allow-methods", CORS_ALLOWED_METHODS);
    reply.header("access-control-allow-headers", CORS_ALLOWED_HEADERS);

    if (request.method === "OPTIONS") {
      return reply.code(204).send();
    }

    return undefined;
  });

  app.get("/api/health", async () => ({
    ok: true,
    service: LOCAL_API_SERVICE_NAME
  }));

  app.get("/api/app/bootstrap", { preHandler: authenticateRuntimeToken }, async (_request, reply) => {
    // bootstrap exposes user settings, privacy preferences, and health status, so it must be protected with the runtime token.
    const response = await options.services.bootstrap.getBootstrap();
    return reply.send(response);
  });

  registerAgentSourceRoutes(app, {
    agentSources: options.services.agentSources,
    agentSourceAutoInject: options.services.agentSourceAutoInject,
    progressBus: options.services.progressBus,
    permissionManager: options.permissionManager,
    authenticateRuntimeToken,
    scanClient: options.services.memoryClient?.agentSources
  });
  registerAppConfigRoutes(app, {
    appConfig: options.services.appConfig,
    authenticateRuntimeToken
  });
  registerAccountRoutes(app, {
    account: options.services.account,
    appConfig: options.services.appConfig,
    authenticateRuntimeToken
  });
  registerTokenQuotaRoutes(app, {
    tokenQuota: options.services.tokenQuota,
    authenticateRuntimeToken
  });
  registerIntegrationRoutes(app, {
    integrations: options.services.integrations,
    authenticateRuntimeToken
  });
  // The MCP bridge validates with its own x-memmy-mcp-token (the agent has no runtime token), so authenticateRuntimeToken is not attached.
  registerComposioMcpRoutes(app, {
    integrations: options.services.integrations,
    mcpToken: options.composioMcpToken
  });
  registerPluginMcpRoutes(app, {
    skillContent: options.services.pluginSkillContent,
    plugins: options.services.plugins,
    progressBus: options.services.progressBus,
    mcpToken: options.composioMcpToken
  });
  registerChannelRoutes(app, {
    channels: options.services.channels,
    authenticateRuntimeToken
  });
  registerLocalDataRoutes(app, {
    localData: options.services.localData,
    authenticateRuntimeToken
  });
  if (options.collab) {
    const knowledge = options.knowledge ? new ManagedKnowledgeClient(options.knowledge) : null;
    registerCollabRoutes(app, {
      collab: options.collab, authenticateRuntimeToken,
      ...(options.collabAgentAccess ? { agentAccess: options.collabAgentAccess } : {}),
      ...(knowledge ? { recallProjectKnowledge: (query: string, projectId: string) => recallProjectBases(knowledge, query, projectId) } : {})
    });
  }
  // 成员协助与协作项目共生：它挂在项目与成员上，没有协作项目就没有可协助的对象。
  if (options.collabAssist) {
    registerCollabAssistRoutes(app, { assist: options.collabAssist, authenticateRuntimeToken });
  }
  // 项目指令与托管目录都是项目自己的接口，任一需要时都注册：指令不依赖托管目录。
  if (options.projectDirectory || options.services.projectInstructions) {
    registerProjectRoutes(app, {
      projectDirectory: options.projectDirectory,
      projectInstructions: options.services.projectInstructions,
      authenticateRuntimeToken
    });
  }
  registerByokTokenUsageRoutes(app, {
    byokTokenUsage: options.services.byokTokenUsage,
    authenticateRuntimeToken
  });
  registerAsrRoutes(app, {
    asr: options.services.asr,
    authenticateRuntimeToken
  });
  registerOnboardingInsightRoutes(app, {
    onboardingInsight: options.services.onboardingInsight,
    permissionManager: options.permissionManager,
    authenticateRuntimeToken
  });
  registerPluginRoutes(app, {
    plugins: options.services.plugins,
    progressBus: options.services.progressBus,
    authenticateRuntimeToken,
    refreshAgentTools: options.pluginCapabilitiesChanged
  });
  registerAgentRuntimeRoutes(app, {
    services: options.services,
    timeZone: options.timeZone,
    authenticateRuntimeToken
  });

  app.get<{ Querystring: EventsQuerystring }>("/api/events", async (request, reply) => {
    // EventSource cannot reliably carry custom headers, so the SSE channel validates the same runtime token via a query parameter.
    const { token } = request.query;
    if (!token || !(await options.permissionManager.verifyRuntimeToken(token))) {
      return reply.code(401).send({ error: "unauthorized" });
    }

    startSse(reply, heartbeatIntervalMs, getSingleHeaderValue(request.headers.origin), options.services.progressBus, registerEventStream);
  });

  // The live ASR stream is a WebSocket, which Fastify's router never sees: an
  // Upgrade request bypasses routing and lands on the raw HTTP server. The
  // handshake is authenticated with the same runtime token the SSE channel
  // takes as a query parameter, for the same reason — a browser WebSocket
  // cannot carry custom headers. Origin is checked with the HTTP rules so a
  // page that could not fetch the API cannot open a socket to it either.
  app.server.on("upgrade", (request, socket, head) => {
    const url = new URL(request.url ?? "/", "http://localhost");
    if (url.pathname !== ASR_STREAM_PATH) {
      socket.destroy();
      return;
    }
    const origin = getSingleHeaderValue(request.headers.origin);
    if (origin && !isAllowedOrigin(origin, options.allowedOrigins)) {
      rejectUpgrade(socket, 403);
      return;
    }
    const token = url.searchParams.get("token");
    void (async () => {
      if (!token || !(await options.permissionManager.verifyRuntimeToken(token))) {
        rejectUpgrade(socket, 401);
        return;
      }
      const relay = options.services.asrStream;
      if (!relay) {
        // Same partial-services allowance as the close hook: a test server
        // without the relay answers 404 instead of throwing on a live socket.
        rejectUpgrade(socket, 404);
        return;
      }
      relay.handleUpgrade(request, socket, head);
    })();
  });
  app.addHook("onClose", async () => {
    // Route tests build a partial services object; the relay is only there in
    // the real wiring, so its absence must not fail teardown.
    await options.services.asrStream?.close();
  });

  return app;
}

const ASR_STREAM_PATH = "/api/asr/stream";

/** Answers a rejected upgrade with a bare HTTP status before the socket is dropped. */
function rejectUpgrade(socket: import("node:stream").Duplex, status: 401 | 403 | 404): void {
  const text = status === 401 ? "Unauthorized" : status === 403 ? "Forbidden" : "Not Found";
  socket.write(`HTTP/1.1 ${status} ${text}\r\nConnection: close\r\nContent-Length: 0\r\n\r\n`);
  socket.destroy();
}

function createRuntimeTokenPreHandler(permissionManager: PermissionManager) {
  return async (request: FastifyRequest, reply: FastifyReply) => {
    if (!(await isAuthorized(request, permissionManager))) {
      return reply.code(401).send({ error: "unauthorized" });
    }

    return undefined;
  };
}

async function isAuthorized(request: FastifyRequest, permissionManager: PermissionManager): Promise<boolean> {
  const token = getSingleHeaderValue(request.headers[RUNTIME_TOKEN_HEADER]);
  return typeof token === "string" && (await permissionManager.verifyRuntimeToken(token));
}

/**
 * 项目知识库检索：只要项目关联的知识库，不把个人知识库的个人资料混进项目资料里。
 * 云端还不认识 `projectOnly` 时（HTTP 400 参数无效）退回按项目检索的旧范围，并在结果里标明范围更宽，
 * 让调用方、进而让 Agent 知道自己拿到的可能不全是项目资料。
 */
async function recallProjectBases(
  knowledge: ManagedKnowledgeClient,
  query: string,
  projectId: string
): Promise<{ enabled: boolean; evidence: unknown[]; projectOnly: boolean }> {
  const read = (data: unknown) => {
    const result = data && typeof data === "object" ? data as Record<string, unknown> : {};
    return { enabled: result.enabled === true, evidence: parseEvidence(result.evidence) };
  };
  try {
    return { ...read(await knowledge.request("/recall", "POST", { query, projectId, projectOnly: true })), projectOnly: true };
  } catch (error) {
    // Only a rejected parameter means an older cloud; auth, timeout and service errors must reach the caller.
    if (!(error instanceof KnowledgeError) || !error.message.startsWith("[HTTP 400]")) throw error;
    return { ...read(await knowledge.request("/recall", "POST", { query, projectId })), projectOnly: false };
  }
}

function applyCorsHeaders(
  reply: FastifyReply,
  origin: string | undefined,
  allowedOrigins: readonly string[] | undefined
): boolean {
  reply.header("vary", "Origin");

  if (!origin) {
    return true;
  }

  if (!isAllowedOrigin(origin, allowedOrigins)) {
    return false;
  }

  reply.header("access-control-allow-origin", origin);
  return true;
}

function isAllowedOrigin(origin: string, allowedOrigins: readonly string[] | undefined): boolean {
  if (allowedOrigins) {
    return allowedOrigins.includes(origin);
  }

  if (origin === FILE_ORIGIN || origin === OPAQUE_ORIGIN) {
    return true;
  }

  try {
    const url = new URL(origin);
    return (url.protocol === "http:" || url.protocol === "https:") && DEFAULT_ALLOWED_LOCAL_HOSTS.has(url.hostname);
  } catch {
    return false;
  }
}

function getSingleHeaderValue(header: string | string[] | undefined): string | undefined {
  return Array.isArray(header) ? header[0] : header;
}

function startSse(
  reply: FastifyReply,
  heartbeatIntervalMs: number,
  origin: string | undefined,
  progressBus: BackendServices["progressBus"],
  registerEventStream: (stop: () => void) => () => void
): void {
  // SSE is a long-lived response, so we take over the raw response to prevent Fastify from automatically ending the request.
  reply.hijack();
  const headers: Record<string, string> = {
    "content-type": "text/event-stream; charset=utf-8",
    "cache-control": "no-cache, no-transform",
    connection: "keep-alive",
    "x-accel-buffering": "no"
  };

  if (origin) {
    headers["access-control-allow-origin"] = origin;
    headers.vary = "Origin";
  }

  reply.raw.writeHead(200, {
    ...headers
  });
  reply.raw.flushHeaders?.();

  const send = (event: SseEvent) => {
    if (reply.raw.destroyed || reply.raw.writableEnded) {
      return;
    }

    // Validate the event against the shared contract before sending, keeping backend output and frontend parsing consistent.
    const parsed = SseEventSchema.parse(event);
    reply.raw.write(`id: ${parsed.id}\n`);
    reply.raw.write(`event: ${parsed.type}\n`);
    reply.raw.write(`data: ${JSON.stringify(parsed)}\n\n`);
  };

  const connectedAt = new Date().toISOString();
  send({
    id: randomUUID(),
    type: "app.connected",
    timestamp: connectedAt,
    payload: { connectedAt }
  });

  const interval = setInterval(() => {
    const sentAt = new Date().toISOString();
    send({
      id: randomUUID(),
      type: "app.heartbeat",
      timestamp: sentAt,
      payload: { sentAt }
    });
  }, heartbeatIntervalMs);

  const unsubscribeScanProgress = progressBus.on("agent_source.scan_progress", (event) => {
    send({
      id: randomUUID(),
      type: "agent_source.scan_progress",
      timestamp: new Date().toISOString(),
      payload: event
    });
  });
  const unsubscribeScanCompleted = progressBus.on("agent_source.scan_completed", (event) => {
    send({
      id: randomUUID(),
      type: "agent_source.scan_completed",
      timestamp: new Date().toISOString(),
      payload: event
    });
  });
  const unsubscribePluginCapability = progressBus.on("plugin.capability_event", (event) => {
    send({
      id: randomUUID(),
      type: "plugin.capability_event",
      timestamp: new Date().toISOString(),
      payload: event
    });
  });
  for (const payload of progressBus.pendingPluginEvents()) {
    send({ id: randomUUID(), type: "plugin.capability_event", timestamp: new Date().toISOString(), payload });
  }
  const pendingCalls = [...new Map(progressBus.pendingPluginEvents().map(({ pluginId, capabilityId, callId, conversationId }) =>
    [JSON.stringify([pluginId, capabilityId, callId, conversationId]), { pluginId, capabilityId, callId, conversationId }])).values()];
  send({ id: randomUUID(), type: "plugin.capability_snapshot", timestamp: new Date().toISOString(), payload: { calls: pendingCalls } });

  let cleanedUp = false;
  let unregister = () => {};
  const cleanup = () => {
    if (cleanedUp) return;
    cleanedUp = true;
    // Clean up the heartbeat timer promptly after the client disconnects, avoiding orphaned tasks lingering in the background.
    clearInterval(interval);
    unsubscribeScanProgress();
    unsubscribeScanCompleted();
    unsubscribePluginCapability();
    unregister();
  };

  reply.raw.once("close", cleanup);
  reply.raw.once("error", cleanup);
  unregister = registerEventStream(() => {
    cleanup();
    reply.raw.end();
  });
}
