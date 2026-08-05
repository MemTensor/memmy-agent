import type { MemoryFilter, MemoryRow, RuntimeNamespace, SessionOpenRequest } from "../../types.js";
import { DEFAULT_NAMESPACE_SOURCE } from "../../types.js";
import type { RawTurnRecord, SessionRecord } from "../../storage/repositories.js";
import { stableHash } from "../../utils/id.js";

export const GLOBAL_PROJECT_ID = "global";

export function normalizeNamespace(namespace?: RuntimeNamespace): RuntimeNamespace & { userId: string; source: string; profileId: string } {
  const workspacePath = normalizeWorkspacePath(namespace?.workspacePath);
  const workspaceId = clean(namespace?.workspaceId) ?? (workspacePath ? workspaceIdFromPath(workspacePath) : undefined);
  return {
    source: namespace?.source ?? DEFAULT_NAMESPACE_SOURCE,
    profileId: namespace?.profileId ?? "default",
    profileLabel: namespace?.profileLabel,
    projectId: clean(namespace?.projectId) ?? workspaceId,
    workspaceId,
    workspacePath,
    sessionKey: namespace?.sessionKey,
    userId: namespace?.userId ?? "local-user",
    tenantId: namespace?.tenantId
  };
}

export function sessionScopeForOpenRequest(request: SessionOpenRequest, namespace: RuntimeNamespace): Partial<Pick<SessionRecord, "source" | "profileId" | "projectId" | "workspaceId" | "workspacePath">> {
  const resolved = normalizeNamespace({
    ...namespace,
    source: request.source ?? namespace.source,
    profileId: request.profileId ?? namespace.profileId,
    projectId: request.projectId ?? namespace.projectId,
    workspaceId: request.workspaceId ?? namespace.workspaceId,
    workspacePath: request.workspacePath ?? namespace.workspacePath
  });
  return {
    source: resolved.source,
    profileId: resolved.profileId,
    projectId: resolved.projectId,
    workspaceId: resolved.workspaceId,
    workspacePath: resolved.workspacePath
  };
}

export function namespaceForSession(session: SessionRecord): RuntimeNamespace {
  return { source: session.source, profileId: session.profileId, profileLabel: session.profileLabel, projectId: session.projectId, workspaceId: session.workspaceId, workspacePath: session.workspacePath, sessionKey: session.hostSessionKey, userId: session.userId, tenantId: tenantIdFromSession(session) };
}

export function namespaceForMemory(memory: MemoryRow): RuntimeNamespace {
  return { source: memory.agentId ?? DEFAULT_NAMESPACE_SOURCE, profileId: profileIdFromMemory(memory) ?? "default", projectId: projectIdFromMemory(memory), workspaceId: memory.appId, userId: memory.userId, tenantId: tenantIdFromMemory(memory) };
}

export function tenantIdFromSession(session: SessionRecord): string | undefined {
  const value = session.meta.tenant_id ?? session.meta.tenantId;
  return typeof value === "string" && value.trim() ? value.trim() : undefined;
}

export function tenantIdFromMemory(memory: MemoryRow): string | undefined {
  const direct = memory.info.tenant_id ?? memory.info.tenantId;
  if (typeof direct === "string" && direct.trim()) return direct.trim();
  const nested = memory.properties.info?.tenant_id ?? memory.properties.info?.tenantId;
  return typeof nested === "string" && nested.trim() ? nested.trim() : undefined;
}

export function projectIdFromMemory(memory: MemoryRow): string | undefined {
  const direct = memory.info.project_id;
  if (typeof direct === "string" && direct.trim()) return direct.trim();
  const camel = memory.info.projectId;
  if (typeof camel === "string" && camel.trim()) return camel.trim();
  const nested = memory.properties.info?.project_id ?? memory.properties.info?.projectId;
  return typeof nested === "string" && nested.trim() ? nested.trim() : undefined;
}

export function profileIdFromMemory(memory: MemoryRow): string | undefined {
  const direct = memory.info.profile_id;
  if (typeof direct === "string" && direct.trim()) return direct.trim();
  const nested = memory.properties.info?.profile_id;
  return typeof nested === "string" && nested.trim() ? nested.trim() : undefined;
}

export function namespaceForRawTurn(rawTurn: RawTurnRecord): RuntimeNamespace {
  return { source: DEFAULT_NAMESPACE_SOURCE, profileId: "default", sessionKey: rawTurn.sessionId, userId: rawTurn.userId };
}

/**
 * Stable project boundary shared by every agent adapter. Agent source and
 * profile are provenance, not isolation keys.
 */
export function namespaceIdFromContext(namespace: RuntimeNamespace): string {
  const normalized = normalizeNamespace(namespace);
  return [
    normalized.tenantId ?? "local",
    normalized.projectId ?? "unscoped"
  ].join(":");
}

export function workspaceIdFromPath(workspacePath: string): string {
  const normalized = normalizeWorkspacePath(workspacePath);
  if (!normalized) return "";
  return `workspace_${stableHash({ path: normalized }).slice(0, 24)}`;
}

export function sameProjectScope(
  actual: RuntimeNamespace,
  requested: RuntimeNamespace | undefined
): boolean {
  if (!requested) return true;
  const expected = normalizeNamespace(requested);
  const observed = normalizeNamespace(actual);
  if ((observed.tenantId ?? "local") !== (expected.tenantId ?? "local")) return false;

  // A scoped request never inherits legacy/unscoped memories. Unscoped
  // callers remain limited to the unscoped quarantine.
  return (observed.projectId ?? "unscoped") === (expected.projectId ?? "unscoped");
}

export function hasProjectScope(namespace: RuntimeNamespace | undefined): boolean {
  if (!namespace) return false;
  return Boolean(
    clean(namespace.projectId) ||
    clean(namespace.workspaceId) ||
    normalizeWorkspacePath(namespace.workspacePath)
  );
}

export function memoryFilterForNamespace(namespace: RuntimeNamespace): MemoryFilter {
  const normalized = normalizeNamespace(namespace);
  return {
    tenantId: normalized.tenantId ?? "local",
    projectId: normalized.projectId ?? "unscoped"
  };
}

function normalizeWorkspacePath(value: string | undefined): string | undefined {
  const trimmed = clean(value);
  if (!trimmed) return undefined;
  let normalized = trimmed.replace(/\\/g, "/").replace(/\/{2,}/g, "/");
  if (/^[A-Z]:\//.test(normalized)) {
    normalized = normalized[0]!.toLowerCase() + normalized.slice(1);
  }
  if (normalized.length > 1) normalized = normalized.replace(/\/+$/, "");
  return normalized || "/";
}

function clean(value: string | undefined): string | undefined {
  const trimmed = value?.trim();
  return trimmed || undefined;
}
