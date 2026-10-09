type JsonRecord = Record<string, unknown>;

export interface PreparedViewerRequest {
  method: string;
  path: string;
  body?: unknown;
}

let overviewCounts: JsonRecord = {};
const episodeTimeline = new Map<string, JsonRecord>();

export function prepareViewerRequest(method: string, path: string, body?: unknown): PreparedViewerRequest {
  const url = localUrl(path);
  if (!url) return { method, path, body };
  const originalPath = url.pathname;

  if (method === "GET" && listPath(originalPath)) {
    const limit = positiveInt(url.searchParams.get("limit"), 20);
    const offset = nonNegativeInt(url.searchParams.get("offset"), 0);
    url.searchParams.set("limit", String(limit));
    url.searchParams.set("page", String(Math.floor(offset / limit) + 1));
    const status = url.searchParams.get("status");
    if (status === "active") url.searchParams.set("status", "activated");
    if (status === "candidate") url.searchParams.set("status", "resolving");
  }
  if (method === "GET" && (originalPath === "/api/v1/metrics" || originalPath === "/api/v1/metrics/tools")) {
    url.pathname = "/api/v1/analytics";
  }
  if (method === "GET" && originalPath === "/api/v1/hub/admin") {
    url.pathname = "/api/v1/hub/status";
  }

  const detail = originalPath.match(/^\/api\/v1\/(traces|policies|world-models|skills)\/([^/]+)$/);
  if (detail && (method === "GET" || method === "DELETE")) {
    url.pathname = `/api/v1/memory/${detail[2]}`;
  }

  if (method === "POST" && originalPath === "/api/v1/admin/clear-data") {
    return { method: "DELETE", path: "/api/v1/admin/data", body: {} };
  }
  if (method === "PATCH" && originalPath === "/api/v1/config") {
    return { method, path: url.pathname + url.search, body: { config: memmyConfigPatch(record(body)) } };
  }
  return { method, path: url.pathname + url.search, body };
}

export function localViewerResponse(method: string, path: string): { handled: boolean; payload?: unknown } {
  const pathname = localUrl(path)?.pathname ?? path;
  if (method === "GET" && pathname === "/api/v1/auth/status") {
    return { handled: true, payload: { enabled: false, needsSetup: false, authenticated: true } };
  }
  if (method === "POST" && (pathname === "/api/v1/auth/logout" || pathname === "/api/v1/auth/reset")) {
    return { handled: true, payload: { ok: true } };
  }
  if (method === "POST" && pathname === "/api/v1/admin/restart") {
    return { handled: true, payload: { ok: true, restarting: false, hotReloaded: true } };
  }
  const timeline = pathname.match(/^\/api\/v1\/episodes\/([^/]+)\/timeline$/);
  if (method === "GET" && timeline?.[1]) {
    return {
      handled: true,
      payload: episodeTimeline.get(decodeURIComponent(timeline[1])) ?? { episodeId: decodeURIComponent(timeline[1]), traces: [] }
    };
  }
  const emptyUsage = pathname.match(/^\/api\/v1\/(policies|world-models|skills)\/[^/]+\/(usage|timeline)$/);
  if (method === "GET" && emptyUsage) {
    return { handled: true, payload: emptyUsage[1] === "skills" ? { events: [], uses: [] } : { skills: [], worldModels: [], policies: [], sourceEpisodes: [] } };
  }
  return { handled: false };
}

export function adaptViewerResponse(method: string, path: string, requestBody: unknown, payload: unknown): unknown {
  const pathname = localUrl(path)?.pathname ?? path;
  const data = record(payload);

  if (method === "GET" && (pathname === "/health" || pathname === "/api/v1/health")) return health(data);
  if (method === "GET" && pathname === "/api/v1/overview") return overview(data);
  if (method === "GET" && pathname === "/api/v1/memories") return list(data, "userMemories", userMemory);
  if (method === "GET" && pathname === "/api/v1/traces") return list(data, "traces", trace);
  if (method === "GET" && pathname === "/api/v1/policies") return list(data, "policies", policy);
  if (method === "GET" && pathname === "/api/v1/world-models") return list(data, "worldModels", worldModel);
  if (method === "GET" && pathname === "/api/v1/skills") return list(data, "skills", skill);
  if (method === "GET" && pathname === "/api/v1/episodes") return episodes(data);
  if (method === "GET" && pathname === "/api/v1/api-logs") return apiLogs(data);
  if (method === "GET" && (pathname === "/api/v1/metrics" || pathname === "/api/v1/metrics/tools")) return metrics(data, pathname);
  if (method === "GET" && pathname === "/api/v1/config") return config(data);
  if (method === "PATCH" && pathname === "/api/v1/config") return config(data);
  if (method === "GET" && pathname === "/api/v1/hub/admin") return hub(data);
  if (method === "POST" && pathname === "/api/v1/models/test") return modelTest(data, record(requestBody));
  if (method === "POST" && pathname === "/api/v1/import") return importResult(data);
  if (method === "POST" && pathname === "/api/v1/embeddings/rebuild") return embeddingRun(data);

  const detail = pathname.match(/^\/api\/v1\/(traces|policies|world-models|skills)\/[^/]+$/);
  if (method === "GET" && detail) {
    const item = memoryDetail(data);
    if (detail[1] === "traces") return trace(item);
    if (detail[1] === "policies") return policy(item);
    if (detail[1] === "world-models") return worldModel(item);
    if (detail[1] === "skills") return skill(item);
  }
  return payload;
}

function health(value: JsonRecord): JsonRecord {
  const models = record(value.models);
  const summary = record(models.summary);
  const evolution = record(models.evolution);
  const embedding = record(models.embedding);
  const serviceVersion = string(value.serviceVersion) || string(value.version);
  return {
    ...value,
    instanceId: string(value.instanceId) || (serviceVersion ? `memmy-memory-${serviceVersion}` : "memmy-memory"),
    version: serviceVersion,
    agent: "memmy",
    llm: modelInfo(summary),
    skillEvolver: {
      ...modelInfo(evolution),
      inherited: string(evolution.routing) === "follow"
    },
    embedder: { ...modelInfo(embedding), dim: number(embedding.dimension) }
  };
}

function overview(value: JsonRecord): JsonRecord {
  const stats = record(value.stats);
  const layers = record(stats.byLayer ?? value.counts);
  const episodeStats = record(stats.episodes);
  const panelSummary = record(value.summary);
  const summaryCounts = record(panelSummary.counts);
  const userMemories = number(summaryCounts.userMemories);
  overviewCounts = { ...layers, UserMemory: userMemories };
  const skillTotal = number(layers.Skill);
  const policyTotal = number(layers.L2);
  return {
    ok: true,
    version: string(value.serviceVersion) || string(value.version),
    traces: number(layers.L1),
    userMemories,
    episodes: Object.values(episodeStats).reduce<number>((sum, item) => sum + number(item), 0),
    skills: { total: skillTotal, active: skillTotal, candidate: 0, archived: 0 },
    policies: { total: policyTotal, active: policyTotal, candidate: 0, archived: 0 },
    worldModels: number(layers.L3),
    sourceDistribution: array(panelSummary.sourceDistribution).map((item) => {
      const entry = record(item);
      return { source: string(entry.source), count: number(entry.count) };
    }),
    dailyActivity: array(panelSummary.dailyActivity).map((item) => {
      const entry = record(item);
      return { date: string(entry.date), count: number(entry.count) };
    })
  };
}

function userMemory(item: JsonRecord): JsonRecord {
  const meta = record(item.metadata);
  return {
    id: string(item.id),
    title: string(item.title),
    content: string(item.summary ?? item.body ?? item.title),
    memoryTypes: strings(meta.memoryTypes ?? item.tags),
    status: item.status === "archived" || item.status === "deleted" ? item.status : "active",
    sourceTurnId: string(meta.sourceTurnId),
    sourceTurnRefs: strings(meta.sourceTurnRefs),
    replacesMemoryId: string(meta.replacesMemoryId),
    replacedByMemoryId: string(meta.replacedByMemoryId),
    archiveReason: string(meta.archiveReason),
    createdAt: epoch(item.createdAt),
    updatedAt: epoch(item.updatedAt)
  };
}

function list(value: JsonRecord, key: string, map: (item: JsonRecord) => JsonRecord): JsonRecord {
  const items = array(value.items).map((item) => map(record(item)));
  const offset = (positiveInt(value.page, 1) - 1) * positiveInt(value.pageSize, 20);
  return {
    [key]: items,
    limit: positiveInt(value.pageSize, 20),
    offset,
    total: number(value.total),
    ...(value.hasNext === true ? { nextOffset: offset + items.length } : {})
  };
}

function trace(item: JsonRecord): JsonRecord {
  const meta = record(item.metadata);
  const internal = record(meta.internal_info ?? meta.internalInfo);
  const createdAt = epoch(item.createdAt);
  return {
    id: string(item.id),
    episodeId: string(meta.episodeId ?? internal.episode_id ?? item.episodeId),
    sessionId: string(meta.sessionId ?? internal.session_id ?? item.sessionId),
    ts: createdAt,
    turnId: epoch(meta.turnId ?? internal.turn_id ?? createdAt),
    userText: string(meta.userText ?? internal.user_text ?? item.title),
    agentText: string(meta.agentText ?? internal.assistant_text ?? item.summary ?? item.body),
    summary: string(item.summary ?? item.body),
    tags: strings(item.tags),
    toolCalls: array(meta.toolCalls ?? internal.tool_calls),
    reflection: string(meta.reflection ?? internal.reflection),
    value: number(meta.value ?? internal.value),
    alpha: number(meta.alpha ?? internal.alpha),
    priority: number(meta.priority ?? internal.priority),
    ownerAgentKind: string(meta.sourceAgent ?? meta.source ?? "memmy"),
    share: null
  };
}

function policy(item: JsonRecord): JsonRecord {
  const meta = record(item.metadata);
  return {
    id: string(item.id),
    title: string(item.title),
    trigger: string(meta.trigger ?? item.title),
    procedure: string(meta.procedure ?? item.summary ?? item.body),
    verification: string(meta.verification),
    boundary: string(meta.boundary),
    support: number(meta.support),
    gain: number(meta.gain),
    status: lifecycle(item.status),
    createdAt: epoch(item.createdAt),
    updatedAt: epoch(item.updatedAt),
    preference: strings(meta.preference),
    antiPattern: strings(meta.antiPattern ?? meta.anti_pattern),
    sourceEpisodeIds: strings(meta.sourceEpisodeIds ?? meta.source_episode_ids),
    sourceTraceIds: strings(meta.sourceTraceIds ?? meta.source_memory_ids),
    share: null,
    ownerAgentKind: string(meta.sourceAgent ?? "memmy")
  };
}

function worldModel(item: JsonRecord): JsonRecord {
  const meta = record(item.metadata);
  return {
    id: string(item.id),
    title: string(item.title),
    body: string(item.body ?? item.summary),
    structure: structure(meta.structure),
    policyIds: strings(meta.policyIds ?? meta.source_memory_ids),
    createdAt: epoch(item.createdAt),
    updatedAt: epoch(item.updatedAt),
    version: positiveInt(item.version, 1),
    status: item.status === "archived" ? "archived" : "active",
    share: null,
    ownerAgentKind: string(meta.sourceAgent ?? "memmy")
  };
}

function skill(item: JsonRecord): JsonRecord {
  const meta = record(item.metadata);
  const guide = string(meta.invocationGuide ?? meta.procedure ?? item.body ?? item.summary);
  return {
    id: string(item.id),
    name: string(meta.name ?? item.title),
    title: string(item.title),
    status: lifecycle(item.status),
    invocationGuide: guide,
    decisionGuidance: {
      preference: strings(meta.preference),
      antiPattern: strings(meta.antiPattern ?? meta.anti_pattern)
    },
    evidenceAnchors: strings(meta.evidenceAnchors ?? meta.source_memory_ids),
    eta: number(meta.eta),
    support: number(meta.support),
    gain: number(meta.gain),
    sourcePolicyIds: strings(meta.sourcePolicyIds),
    sourceWorldModelIds: strings(meta.sourceWorldModelIds),
    createdAt: epoch(item.createdAt),
    updatedAt: epoch(item.updatedAt),
    version: positiveInt(item.version, 1),
    usageCount: number(meta.usageCount),
    share: null,
    ownerAgentKind: string(meta.sourceAgent ?? "memmy")
  };
}

function episodes(value: JsonRecord): JsonRecord {
  const tasks = array(value.tasks).map(record);
  const rows = tasks.map((task) => {
    const ep = record(task.episode);
    const turns = array(task.turns).map(record);
    const startedAt = epoch(ep.startedAt ?? turns[0]?.createdAt ?? task.updatedAt);
    const endedAt = ep.status === "closed" ? epoch(ep.endedAt ?? task.updatedAt) : undefined;
    const id = string(task.id ?? ep.id);
    const firstUserText = turns.map((turn) => optionalString(turn.userText)).find(Boolean) ?? null;
    const firstAssistantText = turns.map((turn) => optionalString(turn.assistantText)).find(Boolean) ?? null;
    const title = truncate(optionalString(ep.title) ?? optionalString(ep.summary) ?? firstUserText ?? id, 100);
    const summary = truncate(optionalString(ep.summary) ?? firstAssistantText ?? title, 180);
    const timeline = {
      episodeId: id,
      traces: turns.map((turn, index) => ({
        id: string(turn.rawTurnId ?? `${id}:${index}`),
        episodeId: id,
        sessionId: string(ep.sessionId),
        ts: epoch(turn.createdAt),
        turnId: epoch(turn.createdAt),
        userText: string(turn.userText),
        agentText: string(turn.assistantText),
        summary: string(turn.reasoningSummary),
        tags: [],
        toolCalls: array(turn.toolCalls),
        value: 0,
        alpha: 0,
        priority: 0
      }))
    };
    episodeTimeline.set(id, timeline);
    return {
      id,
      sessionId: string(ep.sessionId),
      startedAt,
      ...(endedAt ? { endedAt } : {}),
      status: ep.status === "closed" ? "closed" : "open",
      rTask: ep.rTask == null ? null : number(ep.rTask),
      turnCount: ep.turnCount == null ? turns.length : number(ep.turnCount),
      preview: title,
      summary,
      tags: strings(ep.tags),
      skillStatus: optionalString(ep.skillStatus),
      skillReason: optionalString(ep.skillReason),
      linkedSkillId: optionalString(ep.linkedSkillId),
      closeReason: optionalString(ep.closeReason),
      topicState: optionalString(ep.topicState),
      pauseReason: optionalString(ep.pauseReason),
      abandonReason: optionalString(ep.abandonReason),
      rewardSkipped: ep.rewardSkipped === true,
      rewardReason: optionalString(ep.rewardReason),
      hasAssistantReply: turns.some((turn) => Boolean(string(turn.assistantText))),
      ownerAgentKind: "memmy"
    };
  });
  const page = positiveInt(value.page, 1);
  const limit = positiveInt(value.pageSize, 20);
  return {
    episodes: rows,
    total: number(value.total),
    ...(value.hasNext === true ? { nextOffset: page * limit } : {})
  };
}

function apiLogs(value: JsonRecord): JsonRecord {
  const logs = array(value.logs).map((entry, index) => {
    const row = record(entry);
    const sourceAgent = string(row.sourceAgent);
    return {
      id: number(row.id) || index + 1,
      toolName: string(row.toolName),
      ...(sourceAgent ? { sourceAgent } : {}),
      inputJson: jsonText(row.inputJson),
      outputJson: jsonText(row.outputJson),
      durationMs: number(row.durationMs),
      success: row.success !== false,
      calledAt: epoch(row.calledAt ?? row.createdAt)
    };
  });
  return { ...value, logs };
}

function metrics(value: JsonRecord, pathname: string): JsonRecord {
  const toolLatency = record(value.toolLatency);
  if (pathname.endsWith("/tools")) {
    return { tools: array(toolLatency.tools), series: array(toolLatency.series) };
  }
  const activeSkills = number(record(value.metrics).activeSkills) || number(overviewCounts.Skill);
  return {
    total: number(overviewCounts.L1),
    writesToday: array(value.dailyMemoryWrites).at(-1) ? number(record(array(value.dailyMemoryWrites).at(-1)).count) : 0,
    sessions: 0,
    embeddings: number(overviewCounts.L1),
    dailyWrites: array(value.dailyMemoryWrites),
    dailySkillEvolutions: array(value.dailySkillEvolutions),
    skillStats: { total: number(overviewCounts.Skill), active: activeSkills, candidate: 0, archived: 0, evolutionRate: 0 },
    policyStats: { total: number(overviewCounts.L2), active: number(overviewCounts.L2), candidate: 0, archived: 0, avgGain: 0, avgQuality: 0 },
    worldModelCount: number(overviewCounts.L3),
    decisionRepairCount: 0,
    recentEvolutions: []
  };
}

function config(value: JsonRecord): JsonRecord {
  const raw = record(value.config ?? value);
  const routing = record(raw.roleRouting);
  return {
    version: number(value.version),
    viewer: { port: 18960, bindHost: "127.0.0.1" },
    embedding: record(raw.embedding),
    llm: roleConfig(raw.summary ?? raw.llm, routing.summary),
    skillEvolver: roleConfig(raw.evolution ?? raw.skillEvolver, routing.evolution),
    algorithm: record(raw.algorithm),
    hub: record(raw.hub),
    telemetry: record(raw.telemetry),
    agentAccess: record(raw.agentAccess),
  };
}

function hub(value: JsonRecord): JsonRecord {
  return {
    enabled: value.enabled === true,
    role: value.role,
    status: value.configured === true ? "connected" : value.enabled === true ? "starting" : "disabled",
    url: value.address,
    pending: [],
    users: []
  };
}

function modelTest(value: JsonRecord, request: JsonRecord): JsonRecord {
  const type = string(request.type);
  const models = record(value.models);
  const selected = record(type === "embedding" ? models.embedding : type === "skillEvolver" ? models.evolution : models.summary);
  return selected.ok === true
    ? { ok: true, latencyMs: number(selected.latencyMs), ...(type === "embedding" ? { dimensions: number(selected.dimensions) } : { responseChars: 2 }) }
    : { ok: false, error: string(selected.error) || "model test failed" };
}

function importResult(value: JsonRecord): JsonRecord {
  const imported = record(value.inserted ?? value.imported ?? value.counts);
  const skipped = record(value.skipped);
  return {
    imported: Object.values(imported).reduce<number>((sum, item) => sum + number(item), 0),
    skipped: Object.values(skipped).reduce<number>((sum, item) => sum + number(item), 0)
  };
}

function embeddingRun(value: JsonRecord): JsonRecord {
  const enqueued = number(value.enqueued);
  return {
    mode: "rebuild",
    processed: enqueued,
    updated: enqueued,
    failed: 0,
    offset: enqueued,
    nextOffset: enqueued,
    done: true,
    statsAfter: { dimension: 0, available: true, totalSlots: enqueued, ready: 0, missing: enqueued, dimMismatch: 0, needsRepair: enqueued }
  };
}

function memoryDetail(value: JsonRecord): JsonRecord {
  const item = record(value.memory ?? value.item ?? value);
  return { ...item, body: item.body ?? value.body, metadata: item.metadata ?? value.metadata };
}

function modelInfo(value: JsonRecord): JsonRecord {
  return {
    available: value.configured === true,
    provider: string(value.provider),
    model: string(value.model),
    lastOkAt: value.lastOkAt ? epoch(value.lastOkAt) : null,
    lastError: value.lastError ? { at: Date.now(), message: string(value.lastError) } : null
  };
}

function memmyConfigPatch(value: JsonRecord): JsonRecord {
  const patch: JsonRecord = {};
  const roleRouting: JsonRecord = {};
  for (const [key, next] of Object.entries(value)) {
    if (key === "llm") {
      const role = record(next);
      roleRouting.summary = string(role.provider) ? "fixed" : "follow";
      if (roleRouting.summary === "fixed") patch.summary = role;
    }
    else if (key === "skillEvolver") {
      const role = record(next);
      roleRouting.evolution = string(role.provider) ? "fixed" : "follow";
      if (roleRouting.evolution === "fixed") patch.evolution = role;
    }
    else if (key === "embedding") {
      const embedding = record(next);
      patch.embedding = {
        ...embedding,
        mode: string(embedding.provider) === "local" ? "local" : "custom"
      };
    }
    else if (key === "viewer") continue;
    else patch[key] = next;
  }
  if (Object.keys(roleRouting).length) {
    patch.roleRouting = { ...record(patch.roleRouting), ...roleRouting };
  }
  return patch;
}

function roleConfig(value: unknown, routing: unknown): JsonRecord {
  const config = record(value);
  return routing === "follow" ? { ...config, provider: "" } : config;
}

function structure(value: unknown): JsonRecord {
  const input = record(value);
  return {
    environment: array(input.environment),
    inference: array(input.inference),
    constraints: array(input.constraints)
  };
}

function lifecycle(value: unknown): "candidate" | "active" | "archived" {
  if (value === "archived") return "archived";
  if (value === "resolving") return "candidate";
  return "active";
}

function listPath(path: string): boolean {
  return ["/api/v1/memories", "/api/v1/traces", "/api/v1/policies", "/api/v1/world-models", "/api/v1/skills", "/api/v1/episodes"].includes(path);
}

function localUrl(path: string): URL | null {
  if (/^[a-z][a-z0-9+.-]*:\/\//i.test(path)) return null;
  return new URL(path, "http://127.0.0.1");
}

function record(value: unknown): JsonRecord {
  return value && typeof value === "object" && !Array.isArray(value) ? value as JsonRecord : {};
}

function array(value: unknown): unknown[] { return Array.isArray(value) ? value : []; }
function strings(value: unknown): string[] { return array(value).filter((item): item is string => typeof item === "string"); }
function string(value: unknown): string { return typeof value === "string" ? value : ""; }
function optionalString(value: unknown): string | null { return typeof value === "string" && value.length > 0 ? value : null; }
function truncate(value: string, maxLength: number): string { return value.length > maxLength ? `${value.slice(0, maxLength - 3)}...` : value; }
function number(value: unknown): number { return typeof value === "number" && Number.isFinite(value) ? value : typeof value === "string" && Number.isFinite(Number(value)) ? Number(value) : 0; }
function positiveInt(value: unknown, fallback: number): number { const parsed = Math.floor(number(value)); return parsed > 0 ? parsed : fallback; }
function nonNegativeInt(value: unknown, fallback: number): number { const parsed = Math.floor(number(value)); return parsed >= 0 ? parsed : fallback; }
function epoch(value: unknown): number { if (typeof value === "number") return value; const parsed = Date.parse(string(value)); return Number.isFinite(parsed) ? parsed : Date.now(); }
function jsonText(value: unknown): string { return typeof value === "string" ? value : JSON.stringify(value ?? {}); }
