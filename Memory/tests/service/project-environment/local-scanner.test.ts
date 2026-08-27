import { mkdir, mkdtemp, realpath, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import { describe, expect, it } from "vitest";
import type { WorkspaceUri } from "@memmy/local-api-contracts";
import {
  resolveLocalWorkspaceRoot,
  scanLocalProject
} from "../../../src/service/project-environment/local-scanner.js";

async function fixture(): Promise<{ root: string; uri: WorkspaceUri }> {
  const root = await realpath(await mkdtemp(join(tmpdir(), "memmy-local-project-")));
  return { root, uri: pathToFileURL(root).href as WorkspaceUri };
}

describe("local project scanner", () => {
  it("returns a stable sorted inventory and reads deterministic config only", async () => {
    const { root, uri } = await fixture();
    await mkdir(join(root, "src"));
    await writeFile(join(root, "package.json"), JSON.stringify({
      engines: { node: ">=22" },
      packageManager: "pnpm@10.0.0",
      scripts: { build: "tsc", test: "vitest", lint: "eslint ." }
    }));
    await writeFile(join(root, "src", "index.ts"), "export const value = 1;\n");

    const result = await scanLocalProject(uri);
    expect(result.entries.map((entry) => entry.relativePath)).toEqual([
      "package.json",
      "src",
      "src/index.ts"
    ]);
    expect(result.textFiles).toEqual([
      expect.objectContaining({ relativePath: "package.json", text: expect.stringContaining("packageManager") })
    ]);
    expect(result.runtimeProbes).toContainEqual(
      expect.objectContaining({ probe: "node_version", exitCode: 0 })
    );
  });

  it("excludes gitignored, fixed, sensitive, binary, and symlink paths from the inventory", async () => {
    const { root, uri } = await fixture();
    await mkdir(join(root, "node_modules"));
    await mkdir(join(root, "ignored"));
    await writeFile(join(root, ".gitignore"), "ignored/\n");
    await writeFile(join(root, "node_modules", "dependency.js"), "ignored");
    await writeFile(join(root, "ignored", "note.txt"), "ignored");
    await writeFile(join(root, ".env.local"), "SECRET=value");
    await writeFile(join(root, "image.png"), "not really an image");
    await writeFile(join(root, "visible.txt"), "visible");
    await symlink(join(root, "visible.txt"), join(root, "linked.txt"));

    const result = await scanLocalProject(uri);
    expect(result.entries.map((entry) => entry.relativePath)).toEqual([".gitignore", "visible.txt"]);
    expect(result.textFiles).toEqual([]);
  });

  it("does not decode oversized or invalid UTF-8 deterministic files", async () => {
    const { root, uri } = await fixture();
    await writeFile(join(root, "package.json"), Buffer.alloc(1024 * 1024 + 1, 0x61));
    await writeFile(join(root, "pyproject.toml"), Buffer.from([0xff, 0xfe, 0xfd]));

    const result = await scanLocalProject(uri);
    const packageEntry = result.entries.find((entry) => entry.relativePath === "package.json");
    const pythonEntry = result.entries.find((entry) => entry.relativePath === "pyproject.toml");
    expect(packageEntry).toMatchObject({ type: "file", size: 1024 * 1024 + 1 });
    expect(packageEntry).not.toHaveProperty("sha256");
    expect(pythonEntry).toEqual(expect.objectContaining({ type: "file", sha256: expect.any(String) }));
    expect(result.textFiles).toEqual([]);
  });

  it("rejects non-local, non-canonical, home, and filesystem-root URIs", async () => {
    const { root } = await fixture();
    await expect(resolveLocalWorkspaceRoot("ssh://example.test/project" as WorkspaceUri))
      .rejects.toThrow("not_local");
    await expect(resolveLocalWorkspaceRoot(`${pathToFileURL(root).href}/` as WorkspaceUri))
      .rejects.toThrow("not_canonical");
    await expect(resolveLocalWorkspaceRoot("file:///" as WorkspaceUri)).rejects.toThrow();
  });
});
