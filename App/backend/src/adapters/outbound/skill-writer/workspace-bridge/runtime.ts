import { createHash, randomUUID } from "node:crypto";
import { lstat, readFile, realpath, stat } from "node:fs/promises";
import { homedir } from "node:os";
import { isAbsolute, parse, resolve } from "node:path";
import { pathToFileURL } from "node:url";
import YAML from "yaml";
import {
  normalizeWorkspaceUri,
  renderL3WorldModelContext,
  type L3WorldModelRequestEnvelope,
} from "@memmy/local-api-contracts";

const DEFAULT_ENDPOINT = "http://127.0.0.1:18960";

export interface RuntimeConfig {
  endpoint: string;
  token: string;
  userId: string;
  workspaceHostId: string;
}

export interface RuntimeSession {
  protocol: "legacy" | "v2";
  sessionId: string;
  projectId: string | null;
  sessionKey: string;
  source: string;
  adapterId: string;
  profileId: string;
  workspaceRoot: string | null;
  config: RuntimeConfig;
}

export interface OpenRuntimeSessionInput {
  configUrl: URL;
  source: string;
  sessionKey: string;
  workspaceRoot?: string | null;
  transition: "allow_legacy_rollover" | "resume_only";
  pinnedOwner?: boolean;
  adapterId?: string;
  profileId?: string;
}

export interface LoadedRuntimeSession extends RuntimeSession {
  additionalContext: string;
  renderedContext: string;
  memoryVersion: number | null;
}

export async function readRuntimeConfig(configUrl: URL, pinnedOwner = false): Promise<RuntimeConfig> {
  const snapshot = objectValue(await readJson(configUrl));
  const configPath = text(snapshot.memmy_config_path) || resolve(homedir(), ".memmy", "config.yaml");
  const yaml = objectValue(YAML.parse(await readFile(configPath, "utf8").catch(() => "{}")));
  const memory = objectValue(yaml.memmyMemory);
  const storage = objectValue(memory.storage);
  const legacyStorage = objectValue(yaml.storage);
  const app = objectValue(yaml.app);
  return {
    endpoint: text(storage.endpoint) || text(memory.endpoint) || text(legacyStorage.endpoint) || text(snapshot.endpoint) || DEFAULT_ENDPOINT,
    token: text(storage.token) || text(memory.token) || text(legacyStorage.token) || text(snapshot.token),
    userId: pinnedOwner
      ? text(snapshot.userId) || "local-user"
      : text(app.userId) || text(memory.userId) || text(snapshot.userId) || "local-user",
    workspaceHostId: text(snapshot.workspaceHostId),
  };
}

export async function openRuntimeSession(input: OpenRuntimeSessionInput): Promise<RuntimeSession | null> {
  const config = await readRuntimeConfig(input.configUrl, input.pinnedOwner === true);
  const client = new RuntimeHttpClient(config);
  const health = await client.get("/api/v1/health").catch(() => null);
  if (!health && input.pinnedOwner === true) return null;
  const features = objectValue(objectValue(health).features);
  const supportsV2 = numberArray(features.l3WorldModelProtocolVersions).includes(2);
  const adapterId = input.adapterId || `memmy-${input.source}-adapter`;
  const profileId = input.profileId || "default";
  if (!supportsV2) return openLegacyRuntimeSession(client, config, input, adapterId, profileId);

  const resolvedWorkspaceRoot = input.workspaceRoot ? await canonicalWorkspaceRoot(input.workspaceRoot) : null;
  const workspaceRoot = resolvedWorkspaceRoot && config.workspaceHostId ? resolvedWorkspaceRoot : null;
  const envelope = runtimeEnvelope(input.source, input.sessionKey, config.userId, null, adapterId, profileId);
  const workspaceUri = workspaceRoot ? normalizeWorkspaceUri(pathToFileURL(workspaceRoot).href) : null;
  let opened: Record<string, any>;
  try {
    opened = objectValue(await client.post("/api/v1/sessions/open", compact({
      ...envelope,
      l3WorldModelProtocolVersion: 2,
      l3WorldModelTransition: input.transition,
      workspaceUri: workspaceUri || undefined,
      workspaceHostId: workspaceUri ? config.workspaceHostId : undefined,
    })));
  } catch (error) {
    if (input.transition !== "resume_only" || !isV2ResumeConflict(error)) throw error;
    return openLegacyRuntimeSession(client, config, input, adapterId, profileId);
  }
  const sessionId = text(opened.sessionId);
  if (!sessionId) return null;
  return {
    protocol: "v2",
    sessionId,
    projectId: text(opened.projectId) || null,
    sessionKey: input.sessionKey,
    source: input.source,
    adapterId,
    profileId,
    workspaceRoot,
    config,
  };
}

async function openLegacyRuntimeSession(
  client: RuntimeHttpClient,
  config: RuntimeConfig,
  input: OpenRuntimeSessionInput,
  adapterId: string,
  profileId: string,
): Promise<RuntimeSession> {
  const externalSessionId = input.sessionKey;
  const opened = objectValue(await client.post("/api/v1/sessions/open", {
    sessionId: externalSessionId,
    source: input.source,
    profileId: profileId !== "default" ? profileId : undefined,
    workspacePath: input.workspaceRoot || undefined,
  }));
  return {
    protocol: "legacy",
    sessionId: text(opened.sessionId) || externalSessionId,
    projectId: null,
    sessionKey: input.sessionKey,
    source: input.source,
    adapterId,
    profileId,
    workspaceRoot: null,
    config,
  };
}

export async function loadRuntimeL3(session: RuntimeSession): Promise<LoadedRuntimeSession> {
  if (session.protocol !== "v2") return { ...session, additionalContext: "", renderedContext: "", memoryVersion: null };
  const client = new RuntimeHttpClient(session.config);
  const envelope = runtimeEnvelope(session.source, session.sessionKey, session.config.userId, session.projectId, session.adapterId, session.profileId);
  const result = objectValue(await client.get(
    `/api/v1/l3-world-model/sessions/${encodeURIComponent(session.sessionId)}/context`,
    envelopeGetTransport(envelope),
  ));
  const renderedContext = text(result.renderedContext);
  return {
    ...session,
    additionalContext: renderedContext ? renderL3WorldModelContext(renderedContext) : "",
    renderedContext,
    memoryVersion: typeof result.memoryVersion === "number" ? result.memoryVersion : null,
  };
}

export async function notifyRuntimeBoundary(
  session: RuntimeSession,
  trigger: "token_compaction" | "token_compaction_attempt",
): Promise<boolean> {
  if (session.protocol !== "v2") return false;
  const client = new RuntimeHttpClient(session.config);
  const envelope = runtimeEnvelope(session.source, session.sessionKey, session.config.userId, session.projectId, session.adapterId, session.profileId);
  const head = objectValue(await client.get(
    `/api/v1/sessions/${encodeURIComponent(session.sessionId)}/l3-world-model-trace-head`,
    envelopeGetTransport(envelope),
  ));
  const throughL1MemoryId = text(head.throughL1MemoryId);
  if (!throughL1MemoryId) return false;
  await client.post(`/api/v1/sessions/${encodeURIComponent(session.sessionId)}/l3-world-model-boundary`, {
    ...envelope,
    trigger,
    throughL1MemoryId,
  });
  return true;
}

export async function closeRuntimeSession(session: RuntimeSession): Promise<void> {
  const client = new RuntimeHttpClient(session.config);
  const body = session.protocol === "v2"
    ? runtimeEnvelope(session.source, session.sessionKey, session.config.userId, session.projectId, session.adapterId, session.profileId)
    : { source: session.source };
  await client.post(`/api/v1/sessions/${encodeURIComponent(session.sessionId)}/close`, body);
}

export async function startRuntimeTurn(
  session: RuntimeSession,
  turnId: string,
  query: string,
): Promise<Record<string, unknown>> {
  const client = new RuntimeHttpClient(session.config);
  const body = session.protocol === "v2"
    ? { ...runtimeEnvelope(session.source, session.sessionKey, session.config.userId, session.projectId, session.adapterId, session.profileId), sessionId: session.sessionId, turnId, query }
    : { source: session.source, adapterId: session.adapterId, requestId: `${session.source}-start:${turnId}`, sessionId: session.sessionId, turnId, query };
  return objectValue(await client.post("/api/v1/turns/start", body));
}

export async function completeRuntimeTurn(
  session: RuntimeSession,
  input: {
    turnId: string;
    episodeId?: string;
    query: string;
    answer: string;
    status: "succeeded" | "failed";
    sourceMemoryIds?: string[];
    reasoningSummary?: string;
    toolCalls?: unknown[];
    toolResults?: unknown[];
  },
): Promise<void> {
  const client = new RuntimeHttpClient(session.config);
  const body = session.protocol === "v2"
    ? {
        ...runtimeEnvelope(session.source, session.sessionKey, session.config.userId, session.projectId, session.adapterId, session.profileId),
        sessionId: session.sessionId,
        episodeId: input.episodeId,
        query: input.query,
        answer: input.answer,
        status: input.status,
        sourceMemoryIds: input.sourceMemoryIds,
        reasoningSummary: input.reasoningSummary,
        toolCalls: input.toolCalls,
        toolResults: input.toolResults,
      }
    : {
        source: session.source,
        adapterId: session.adapterId,
        requestId: `${session.source}-complete:${input.turnId}:${hashText([input.status, input.query, input.answer].join("\u0000"))}`,
        sessionId: session.sessionId,
        ...input,
      };
  await client.post(`/api/v1/turns/${encodeURIComponent(input.turnId)}/complete`, compact(body));
}

class RuntimeHttpClient {
  constructor(private readonly config: RuntimeConfig) {}

  async get(path: string, transport: { query?: Record<string, string>; headers?: Record<string, string> } = {}): Promise<unknown> {
    const url = new URL(path, `${this.config.endpoint.replace(/\/+$/u, "")}/`);
    for (const [key, value] of Object.entries(transport.query ?? {})) url.searchParams.set(key, value);
    return this.request(url, { method: "GET", headers: transport.headers });
  }

  async post(path: string, body: unknown): Promise<unknown> {
    const url = new URL(path, `${this.config.endpoint.replace(/\/+$/u, "")}/`);
    return this.request(url, {
      method: "POST",
      body: JSON.stringify(body),
      headers: { "content-type": "application/json" },
    });
  }

  private async request(url: URL, init: RequestInit): Promise<unknown> {
    const headers = new Headers(init.headers);
    headers.set("accept", "application/json");
    if (this.config.token) headers.set("authorization", `Bearer ${this.config.token}`);
    const response = await fetch(url, { ...init, headers, signal: AbortSignal.timeout(45_000) });
    const textValue = await response.text();
    const parsed = textValue.trim() ? JSON.parse(textValue) : null;
    if (!response.ok) {
      const body = objectValue(parsed);
      const nested = objectValue(body.error);
      throw new RuntimeHttpError(
        response.status,
        text(body.code) || text(nested.code),
        text(body.message) || text(nested.message) || `Memory request failed: ${response.status}`,
      );
    }
    return parsed;
  }
}

class RuntimeHttpError extends Error {
  constructor(readonly status: number, readonly code: string, message: string) {
    super(message);
    this.name = "RuntimeHttpError";
  }
}

function isV2ResumeConflict(error: unknown): boolean {
  return error instanceof RuntimeHttpError && error.status === 409 &&
    (error.code === "l3_world_model_v2_session_not_open" || error.message === "l3_world_model_v2_session_not_open");
}

function runtimeEnvelope(
  source: string,
  sessionKey: string,
  userId: string,
  projectId: string | null,
  adapterId: string,
  profileId: string,
): L3WorldModelRequestEnvelope {
  return {
    requestId: randomUUID(),
    adapterId,
    source,
    namespace: compact({ source, profileId, userId, sessionKey, projectId: projectId || undefined }),
  } as L3WorldModelRequestEnvelope;
}

function envelopeGetTransport(
  envelope: L3WorldModelRequestEnvelope,
): { query: Record<string, string>; headers: Record<string, string> } {
  const query = { adapterId: envelope.adapterId, source: envelope.namespace.source };
  const headers: Record<string, string> = { "x-request-id": envelope.requestId };
  const pairs = [
    ["x-memmy-user-id", envelope.namespace.userId],
    ["x-memmy-project-id", envelope.namespace.projectId],
    ["x-memmy-profile-id", envelope.namespace.profileId],
    ["x-memmy-session-key", envelope.namespace.sessionKey],
  ];
  for (const [key, value] of pairs) if (value) headers[key!] = value;
  return { query, headers };
}

async function canonicalWorkspaceRoot(value: string): Promise<string | null> {
  if (!value || !isAbsolute(value)) return null;
  const canonical = await realpath(value).catch(() => "");
  if (!canonical) return null;
  const details = await stat(canonical).catch(() => null);
  if (!details?.isDirectory() || canonical === parse(canonical).root || canonical === await realpath(homedir())) return null;
  const observed = await lstat(canonical).catch(() => null);
  return observed?.isDirectory() && !observed.isSymbolicLink() ? canonical : null;
}

function compact<T extends Record<string, any>>(value: T): T {
  return Object.fromEntries(
    Object.entries(value).filter(([, item]) => item !== undefined && item !== null && item !== ""),
  ) as T;
}

function objectValue(value: unknown): Record<string, any> {
  return typeof value === "object" && value !== null && !Array.isArray(value) ? value as Record<string, any> : {};
}

function numberArray(value: unknown): number[] {
  return Array.isArray(value) ? value.filter((item): item is number => typeof item === "number") : [];
}

function text(value: unknown): string {
  return typeof value === "string" ? value.trim() : "";
}

function hashText(value: string): string {
  return createHash("sha256").update(value).digest("hex").slice(0, 24);
}

async function readJson(url: URL): Promise<unknown> {
  const content = await readFile(url, "utf8").catch(() => "{}");
  try {
    return JSON.parse(content);
  } catch {
    return {};
  }
}
