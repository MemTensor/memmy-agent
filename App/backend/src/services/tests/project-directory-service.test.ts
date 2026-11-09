/** Managed project directories: the folder a project created by name alone runs its tasks in. */
import { mkdtemp, readdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { ensureDirectory, safeProjectDirectoryName, uniqueProjectDirectory } from "../project-directory.js";
import { createProjectDirectoryService } from "../project-directory-service.js";

const roots: string[] = [];

async function tempRoot(): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), "memmy-project-dirs-"));
  roots.push(root);
  return root;
}

afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

describe("project directory helpers", () => {
  it("keeps letters from any script and replaces only what a filesystem minds", () => {
    expect(safeProjectDirectoryName("MemOS 产品/2026")).toBe("MemOS 产品_2026");
    expect(safeProjectDirectoryName("..hidden")).toBe("hidden");
    expect(safeProjectDirectoryName("   ")).toBe("project");
  });

  it("suffixes a name another project already uses", async () => {
    const root = await tempRoot();
    await ensureDirectory(join(root, "demo"));

    const next = await uniqueProjectDirectory(root, "demo", "abcdef12-3456-7890");

    expect(next).toBe(join(root, "demo-abcdef12"));
  });

  it("refuses a path that exists as a file", async () => {
    const root = await tempRoot();
    const file = join(root, "demo");
    await writeFile(file, "not a directory");

    await expect(ensureDirectory(file)).rejects.toThrow();
  });
});

describe("project directory service", () => {
  it("creates one managed folder per project name", async () => {
    const root = await tempRoot();
    const service = createProjectDirectoryService({ root });

    const first = await service.prepareManagedDirectory("周报整理");
    const second = await service.prepareManagedDirectory("周报整理");

    expect(first.path).toBe(join(root, "周报整理"));
    expect(second.path).not.toBe(first.path);
    expect(second.path.startsWith(join(root, "周报整理-"))).toBe(true);
    expect(await readdir(root)).toHaveLength(2);
  });
});
