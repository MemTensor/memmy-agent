import { mkdir, mkdtemp, realpath } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import { describe, expect, it } from "vitest";
import {
  normalizeWorkspaceRoot,
  workspaceHostIdFromInstallationId,
  workspaceUriFromRoot
} from "../../src/memmy-memory/workspace-identity.js";

describe("workspace identity", () => {
  it("canonicalizes a local project directory and derives its URI", async () => {
    const parent = await mkdtemp(join(tmpdir(), "memmy-workspace-identity-"));
    const project = join(parent, "project folder");
    await mkdir(project);
    const canonical = await realpath(project);
    expect(await normalizeWorkspaceRoot(project)).toBe(canonical);
    expect(workspaceUriFromRoot(canonical)).toBe(pathToFileURL(canonical).href);
  });

  it("rejects relative paths and filesystem roots", async () => {
    expect(await normalizeWorkspaceRoot("relative/project")).toBeNull();
    expect(await normalizeWorkspaceRoot("/")).toBeNull();
  });

  it("derives a stable host identity", () => {
    const first = workspaceHostIdFromInstallationId("installation-a");
    expect(first).toMatch(/^[a-f0-9]{64}$/u);
    expect(workspaceHostIdFromInstallationId("installation-a")).toBe(first);
    expect(workspaceHostIdFromInstallationId("installation-b")).not.toBe(first);
  });
});
