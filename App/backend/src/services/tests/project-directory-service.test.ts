/** Managed project directories: the folder a project created by name alone runs its tasks in. */
import { mkdir, mkdtemp, readdir, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { createProjectDirectory, ensureDirectory, safeProjectDirectoryName } from "../project-directory.js";
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

  it("uses the plain name first, then numbers it like a new folder in a file manager", async () => {
    const root = await tempRoot();

    expect(await createProjectDirectory(root, "MemOS")).toBe(join(root, "MemOS"));
    expect(await createProjectDirectory(root, "MemOS")).toBe(join(root, "MemOS 2"));
    expect(await createProjectDirectory(root, "MemOS")).toBe(join(root, "MemOS 3"));
    expect((await stat(join(root, "MemOS 3"))).isDirectory()).toBe(true);
  });

  it("creates the root when it is missing", async () => {
    const root = join(await tempRoot(), "local-projects");

    expect(await createProjectDirectory(root, "demo")).toBe(join(root, "demo"));
  });

  it("skips a name a file already uses", async () => {
    const root = await tempRoot();
    await writeFile(join(root, "demo"), "not a directory");

    expect(await createProjectDirectory(root, "demo")).toBe(join(root, "demo 2"));
  });

  it("fills the first free number rather than counting past the highest", async () => {
    const root = await tempRoot();
    await mkdir(join(root, "demo"));
    await mkdir(join(root, "demo 3"));

    expect(await createProjectDirectory(root, "demo")).toBe(join(root, "demo 2"));
    expect(await createProjectDirectory(root, "demo")).toBe(join(root, "demo 4"));
  });

  it("numbers Chinese names the same way", async () => {
    const root = await tempRoot();

    expect(await createProjectDirectory(root, "测试")).toBe(join(root, "测试"));
    expect(await createProjectDirectory(root, "测试")).toBe(join(root, "测试 2"));
  });

  it("treats names differing only in case or Unicode form as the same folder", async () => {
    const root = await tempRoot();
    await mkdir(join(root, "MemOS"));
    await mkdir(join(root, "Cafe\u0301"));

    expect(await createProjectDirectory(root, "memos")).toBe(join(root, "memos 2"));
    expect(await createProjectDirectory(root, "Caf\u00e9")).toBe(join(root, "Caf\u00e9 2"));
  });

  it("numbers the cleaned name, after the visible text of a name cut to length", async () => {
    const root = await tempRoot();
    const long = `${"a".repeat(59)} tail`;
    await mkdir(join(root, safeProjectDirectoryName(long)));

    expect(await createProjectDirectory(root, long)).toBe(join(root, `${"a".repeat(59)} 2`));
    expect(await createProjectDirectory(root, "a/b")).toBe(join(root, "a_b"));
    expect(await createProjectDirectory(root, "a/b")).toBe(join(root, "a_b 2"));
  });

  it("gives projects created at the same moment folders of their own", async () => {
    const root = await tempRoot();

    const created = await Promise.all(Array.from({ length: 5 }, () => createProjectDirectory(root, "并发")));

    expect(new Set(created).size).toBe(5);
    expect((await readdir(root)).sort()).toEqual(["并发", "并发 2", "并发 3", "并发 4", "并发 5"]);
  });

  it("refuses a path that exists as a file", async () => {
    const root = await tempRoot();
    const file = join(root, "demo");
    await writeFile(file, "not a directory");

    await expect(ensureDirectory(file)).rejects.toThrow();
  });
});

describe("project directory service", () => {
  it("creates one managed folder per project, numbered when the name repeats", async () => {
    const root = await tempRoot();
    const service = createProjectDirectoryService({ root });

    const first = await service.prepareManagedDirectory("周报整理");
    const second = await service.prepareManagedDirectory("周报整理");

    expect(first.path).toBe(join(root, "周报整理"));
    expect(second.path).toBe(join(root, "周报整理 2"));
    expect(await readdir(root)).toHaveLength(2);
  });

  it("leaves folders named the earlier way alone", async () => {
    const root = await tempRoot();
    await mkdir(join(root, "MemOS"));
    await mkdir(join(root, "MemOS-493ba850"));
    const service = createProjectDirectoryService({ root });

    expect((await service.prepareManagedDirectory("MemOS")).path).toBe(join(root, "MemOS 2"));
    expect((await readdir(root)).sort()).toEqual(["MemOS", "MemOS 2", "MemOS-493ba850"]);
  });
});
