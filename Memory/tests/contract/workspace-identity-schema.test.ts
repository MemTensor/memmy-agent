import { describe, expect, it } from "vitest";
import {
  MEMORY_WORKSPACE_IDENTITY_FIXTURES,
  WorkspaceIdentityFieldsSchema,
  WorkspaceUriSchema,
  deriveWorkspaceHostId,
  isLocalWorkspaceUri,
  normalizeWorkspaceUri
} from "@memmy/local-api-contracts";

describe("workspace identity contract", () => {
  it("normalizes local and remote absolute URIs deterministically", () => {
    expect(normalizeWorkspaceUri("file:///workspace/project")).toBe("file:///workspace/project");
    expect(normalizeWorkspaceUri("file://localhost/workspace/project")).toBe("file:///workspace/project");
    expect(normalizeWorkspaceUri("SSH://Example.Test/workspace/project")).toBe("ssh://example.test/workspace/project");
    expect(isLocalWorkspaceUri("file:///workspace/project")).toBe(true);
    expect(isLocalWorkspaceUri("ssh://example.test/workspace/project")).toBe(false);
  });

  it("rejects ambiguous, unsafe, and non-canonical URIs", () => {
    for (const value of [
      "relative/path",
      "file:///",
      "file:///C:/",
      "file:///workspace/project?query=1",
      "file:///workspace/project#fragment",
      "ssh://user:password@example.test/workspace",
      "SSH://Example.Test/workspace/project"
    ]) {
      expect(WorkspaceUriSchema.safeParse(value).success).toBe(false);
    }
  });

  it("requires a host identity exactly for local workspaces", () => {
    const hostId = deriveWorkspaceHostId(MEMORY_WORKSPACE_IDENTITY_FIXTURES.installationId);
    expect(hostId).toBe(MEMORY_WORKSPACE_IDENTITY_FIXTURES.workspaceHostId);
    expect(WorkspaceIdentityFieldsSchema.safeParse({
      workspaceUri: MEMORY_WORKSPACE_IDENTITY_FIXTURES.localUri,
      workspaceHostId: hostId
    }).success).toBe(true);
    expect(WorkspaceIdentityFieldsSchema.safeParse({ workspaceUri: MEMORY_WORKSPACE_IDENTITY_FIXTURES.localUri }).success).toBe(false);
    expect(WorkspaceIdentityFieldsSchema.safeParse({ workspaceHostId: hostId }).success).toBe(false);
    expect(WorkspaceIdentityFieldsSchema.safeParse({
      workspaceUri: MEMORY_WORKSPACE_IDENTITY_FIXTURES.remoteUri,
      workspaceHostId: hostId
    }).success).toBe(false);
    expect(WorkspaceIdentityFieldsSchema.safeParse({ workspaceUri: MEMORY_WORKSPACE_IDENTITY_FIXTURES.remoteUri }).success).toBe(true);
    expect(WorkspaceIdentityFieldsSchema.safeParse({}).success).toBe(true);
  });
});
