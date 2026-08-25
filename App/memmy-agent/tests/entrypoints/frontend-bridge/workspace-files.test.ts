import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
  listWorkspaceFiles,
  WorkspaceFilesError,
} from "../../../src/entrypoints/frontend-bridge/workspace-files.js";

const roots: string[] = [];

function makeRoot(): string {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "memmy-workspace-files-"));
  roots.push(root);
  return fs.realpathSync(root);
}

afterEach(() => {
  for (const root of roots.splice(0)) fs.rmSync(root, { recursive: true, force: true });
});

describe("workspace files", () => {
  it("lists one real directory level and sorts folders first", () => {
    const root = makeRoot();
    fs.mkdirSync(path.join(root, "src"));
    fs.mkdirSync(path.join(root, ".git"));
    fs.mkdirSync(path.join(root, "node_modules"));
    fs.writeFileSync(path.join(root, "README.md"), "hello", "utf8");

    const listing = listWorkspaceFiles(root, {
      rootKind: "project",
      rootLabel: "Memmy",
    });
    expect(listing).toMatchObject({
      root: { kind: "project", label: "Memmy" },
      path: "",
      truncated: false,
    });
    expect(listing.entries.map((entry) => [entry.name, entry.kind])).toEqual([
      [".git", "directory"],
      ["node_modules", "directory"],
      ["src", "directory"],
      ["README.md", "file"],
    ]);
  });

  it("loads a nested directory lazily and reports truncation", () => {
    const root = makeRoot();
    fs.mkdirSync(path.join(root, "src", "nested"), { recursive: true });
    fs.writeFileSync(path.join(root, "src", "a.ts"), "a", "utf8");
    fs.writeFileSync(path.join(root, "src", "b.ts"), "b", "utf8");

    const listing = listWorkspaceFiles(root, {
      rootKind: "task",
      rootLabel: "task-1",
      relativePath: "src",
      maxEntries: 2,
    });
    expect(listing.path).toBe("src");
    expect(listing.entries.map((entry) => entry.path)).toEqual(["src/nested", "src/a.ts"]);
    expect(listing.truncated).toBe(true);
  });

  it.skipIf(process.platform === "win32")("lists a read-only workspace without requiring write access", () => {
    const root = makeRoot();
    fs.writeFileSync(path.join(root, "read-only.txt"), "visible", "utf8");
    fs.chmodSync(root, 0o555);
    try {
      expect(listWorkspaceFiles(root, {
        rootKind: "task",
        rootLabel: "read-only",
      }).entries).toContainEqual(expect.objectContaining({
        name: "read-only.txt",
        kind: "file",
      }));
    } finally {
      fs.chmodSync(root, 0o755);
    }
  });

  it.each(["../secret", "src/../secret", "/etc", "C:/Windows", "src\\nested", "bad\0path"])(
    "rejects an unsafe relative path: %s",
    (relativePath) => {
      const root = makeRoot();
      expect(() => listWorkspaceFiles(root, {
        rootKind: "task",
        rootLabel: "task",
        relativePath,
      })).toThrowError(expect.objectContaining<Partial<WorkspaceFilesError>>({
        code: "workspace_files_path_invalid",
        status: 400,
      }));
    },
  );

  it.skipIf(process.platform === "win32")("does not expose or expand symlinks", () => {
    const root = makeRoot();
    const outside = makeRoot();
    fs.writeFileSync(path.join(outside, "secret.txt"), "secret", "utf8");
    fs.symlinkSync(outside, path.join(root, "linked"));

    const listing = listWorkspaceFiles(root, {
      rootKind: "task",
      rootLabel: "task",
    });
    expect(listing.entries).not.toContainEqual(expect.objectContaining({ name: "linked" }));
    expect(() => listWorkspaceFiles(root, {
      rootKind: "task",
      rootLabel: "task",
      relativePath: "linked",
    })).toThrowError(expect.objectContaining<Partial<WorkspaceFilesError>>({
      code: "workspace_files_symlink_not_expandable",
      status: 400,
    }));
  });
});
