import type { MemoryRow, RuntimeNamespace, SessionOpenRequest } from "../../types.js";
import { DEFAULT_NAMESPACE_SOURCE } from "../../types.js";
import type { RawTurnRecord, SessionRecord } from "../../storage/repositories.js";

export function normalizeNamespace(namespace?: RuntimeNamespace): RuntimeNamespace & { userId: string; source: string; profileId: string } {
  return {
    source: namespace?.source ?? DEFAULT_NAMESPACE_SOURCE,
    profileId: namespace?.profileId ?? "default",
    profileLabel: namespace?.profileLabel,
    projectId: namespace?.projectId,
    workspaceId: namespace?.workspaceId,
    workspacePath: namespace?.workspacePath,
    sessionKey: namespace?.sessionKey,
    userId: namespace?.userId ?? "local-user",
    tenantId: namespace?.tenantId
  };
}

export function sessionScopeForOpenRequest(request: SessionOpenRequest, namespace: RuntimeNamespace): Partial<Pick<SessionRecord, "source" | "profileId" | "projectId" | "workspaceId" | "workspacePath">> {
  return {
    source: request.source ?? request.namespace?.source,
    profileId: request.profileId ?? request.namespace?.profileId,
    projectId: request.projectId ?? request.namespace?.projectId ?? request.namespace?.workspaceId,
    workspaceId: request.workspaceId ?? request.namespace?.workspaceId,
    workspacePath: request.workspacePath ?? request.namespace?.workspacePath ?? namespace.workspacePath
  };
}

export function namespaceForSession(session: SessionRecord): RuntimeNamespace {
  return { source: session.source, profileId: session.profileId, profileLabel: session.profileLabel, projectId: session.projectId, workspaceId: session.workspaceId, workspacePath: session.workspacePath, sessionKey: session.hostSessionKey, userId: session.userId };
}

export function namespaceForMemory(memory: MemoryRow): RuntimeNamespace {
  return { source: memory.agentId ?? DEFAULT_NAMESPACE_SOURCE, profileId: profileIdFromMemory(memory) ?? "default", projectId: projectIdFromMemory(memory), workspaceId: memory.appId, userId: memory.userId };
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
