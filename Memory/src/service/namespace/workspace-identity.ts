import {
  WorkspaceIdentityFieldsSchema,
  isLocalWorkspaceUri,
  sha256Hex,
  type WorkspaceHostId,
  type WorkspaceIdentityFields,
  type WorkspaceUri
} from "@memmy/local-api-contracts";

export interface ResolvedWorkspaceIdentity {
  workspaceUri: WorkspaceUri | null;
  workspaceHostId: WorkspaceHostId | null;
  workspaceId: string | null;
  projectId: string | null;
}

/**
 * Resolves the server-owned workspace/project identity for L3 World Model v2.
 * This function is intentionally pure: filesystem canonicalization belongs to
 * the Agent Adapter that owns the workspace.
 */
export function resolveWorkspaceIdentity(
  effectiveUserId: string,
  input: WorkspaceIdentityFields
): ResolvedWorkspaceIdentity {
  const userId = effectiveUserId.trim();
  if (!userId) throw new TypeError("effectiveUserId must be non-empty");
  const parsed = WorkspaceIdentityFieldsSchema.parse(input);
  if (!parsed.workspaceUri) {
    return {
      workspaceUri: null,
      workspaceHostId: null,
      workspaceId: null,
      projectId: null
    };
  }

  const workspaceIdentity = isLocalWorkspaceUri(parsed.workspaceUri)
    ? `local\0${parsed.workspaceHostId}\0${parsed.workspaceUri}`
    : `remote\0${parsed.workspaceUri}`;
  const workspaceId = sha256Hex(`${userId}\0${workspaceIdentity}`);
  return {
    workspaceUri: parsed.workspaceUri,
    workspaceHostId: parsed.workspaceHostId ?? null,
    workspaceId,
    projectId: `ws_${workspaceId}`
  };
}
