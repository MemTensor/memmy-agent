import { readFileSync } from "node:fs";
import { mkdtemp, mkdir, realpath, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, parse } from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, describe, expect, it } from "vitest";
import { readWorkspaceDirectory, writeWorkspaceTextFile } from "../src/main/workspace-directory.js";

const temporaryDirectories: string[] = [];

async function temporaryDirectory(): Promise<string> {
  const path = await mkdtemp(join(tmpdir(), "memmy-workspace-tree-"));
  temporaryDirectories.push(path);
  return path;
}

function readSource(relativePath: string): string {
  return readFileSync(fileURLToPath(new URL(relativePath, import.meta.url)), "utf8");
}

afterEach(async () => {
  await Promise.all(temporaryDirectories.splice(0).map((path) => rm(path, { recursive: true, force: true })));
});

describe("readWorkspaceDirectory", () => {
  it("returns a lazy, directory-first workspace listing and skips generated internals", async () => {
    const root = await temporaryDirectory();
    await Promise.all([
      mkdir(join(root, "src")),
      mkdir(join(root, "node_modules")),
      mkdir(join(root, ".git")),
      writeFile(join(root, "README.md"), "# Memmy"),
      writeFile(join(root, "2.txt"), "two"),
      writeFile(join(root, "10.txt"), "ten"),
      writeFile(join(root, ".DS_Store"), ""),
    ]);
    await writeFile(join(root, "src", "index.ts"), "export {};");

    const listing = await readWorkspaceDirectory(root);
    const canonicalRoot = await realpath(root);
    expect(listing.rootPath).toBe(canonicalRoot);
    expect(listing.entries.map((entry) => entry.name)).toEqual(["src", "2.txt", "10.txt", "README.md"]);
    expect(listing.entries.some((entry) => entry.name === "node_modules" || entry.name === ".git")).toBe(false);

    const child = await readWorkspaceDirectory(root, "src");
    expect(child.relativePath).toBe("src");
    expect(child.entries).toEqual([{
      name: "index.ts",
      path: join(canonicalRoot, "src", "index.ts"),
      relativePath: "src/index.ts",
      kind: "file",
    }]);
  });

  it("hides agent profile internals only at the root of the agent home", async () => {
    const root = await temporaryDirectory();
    await Promise.all([
      mkdir(join(root, ".memmy-migrations")),
      mkdir(join(root, ".memmy")),
      mkdir(join(root, "cron")),
      mkdir(join(root, "memory")),
      mkdir(join(root, "sessions")),
      mkdir(join(root, "skills")),
      mkdir(join(root, "yeebo", "memory"), { recursive: true }),
      writeFile(join(root, "AGENTS.md"), "agents"),
      writeFile(join(root, "HEARTBEAT.md"), "heartbeat"),
      writeFile(join(root, "SOUL.md"), "soul"),
      writeFile(join(root, "USER.md"), "user"),
      writeFile(join(root, "notes.md"), "notes"),
    ]);
    await writeFile(join(root, "yeebo", "SOUL.md"), "project file");

    const agentHome = await readWorkspaceDirectory(root, "", { agentHomePath: root });
    expect(agentHome.entries.map((entry) => entry.name)).toEqual(["yeebo", "notes.md"]);

    const nested = await readWorkspaceDirectory(root, "yeebo", { agentHomePath: root });
    expect(nested.entries.map((entry) => entry.name)).toEqual(["memory", "SOUL.md"]);

    const otherWorkspace = await readWorkspaceDirectory(root, "", { agentHomePath: join(root, "yeebo") });
    expect(otherWorkspace.entries.map((entry) => entry.name)).toEqual([
      ".memmy-migrations",
      "cron",
      "memory",
      "sessions",
      "skills",
      "yeebo",
      "AGENTS.md",
      "HEARTBEAT.md",
      "notes.md",
      "SOUL.md",
      "USER.md",
    ]);
  });

  it("rejects paths that escape the selected workspace", async () => {
    const root = await temporaryDirectory();

    await expect(readWorkspaceDirectory(root, "../")).rejects.toThrow("invalid");
    await expect(readWorkspaceDirectory("relative/path")).rejects.toThrow("absolute");
    await expect(readWorkspaceDirectory(parse(root).root)).rejects.toThrow("filesystem root");
  });

  it.skipIf(process.platform === "win32")("keeps symlinks only when they resolve inside the workspace", async () => {
    const root = await temporaryDirectory();
    const outside = await temporaryDirectory();
    await Promise.all([
      mkdir(join(root, "docs")),
      writeFile(join(root, "notes.md"), "inside"),
      mkdir(join(outside, "secrets")),
      writeFile(join(outside, "token.txt"), "outside"),
    ]);
    await Promise.all([
      symlink(join(root, "docs"), join(root, "docs-link")),
      symlink(join(root, "notes.md"), join(root, "notes-link.md")),
      symlink(join(outside, "secrets"), join(root, "outside-dir")),
      symlink(join(outside, "token.txt"), join(root, "outside-file.txt")),
      symlink(join(root, "missing.txt"), join(root, "broken.txt")),
    ]);

    const listing = await readWorkspaceDirectory(root);

    expect(listing.entries.map((entry) => [entry.name, entry.kind])).toEqual([
      ["docs", "directory"],
      ["docs-link", "directory"],
      ["notes-link.md", "file"],
      ["notes.md", "file"],
    ]);
    await expect(readWorkspaceDirectory(root, "outside-dir")).rejects.toThrow("escapes");
  });

  it("exposes the directory reader to the main window only, through the typed preload bridge", () => {
    const interfaceSource = readSource("../interface/src/index.ts");
    const preloadSource = readSource("../src/preload/preload.cts");
    const mainSource = readSource("../src/main/main.ts");

    expect(interfaceSource).toContain("export interface DesktopWorkspaceDirectoryResult");
    expect(preloadSource).toContain("readWorkspaceDirectory(rootPath: string, relativePath?: string)");
    expect(preloadSource).toContain('ipcRenderer.invoke("memmy:read-workspace-directory", rootPath, relativePath)');
    expect(mainSource).toContain('ipcMain.handle(\n    "memmy:read-workspace-directory"');
    expect(mainSource).toContain("BrowserWindow.fromWebContents(event.sender) !== mainWindow");
    expect(mainSource).toContain('ipcMain.removeHandler("memmy:read-workspace-directory")');
  });

  it("writes an existing workspace file and refuses paths outside that root", async () => {
    const root = await temporaryDirectory();
    const outside = await temporaryDirectory();
    await mkdir(join(root, "src"));
    await writeFile(join(root, "src", "pg.py"), "print('old')\n");
    await writeFile(join(root, "SOUL.md"), "soul");
    await writeFile(join(outside, "token.txt"), "secret");
    await symlink(join(outside, "token.txt"), join(root, "outside.txt"));
    await symlink(join(root, "src", "pg.py"), join(root, "pg-link.py"));

    await writeWorkspaceTextFile(root, join(root, "src", "pg.py"), "print('new')\n");
    expect(readFileSync(join(root, "src", "pg.py"), "utf8")).toBe("print('new')\n");

    await writeWorkspaceTextFile(root, join(root, "pg-link.py"), "print('linked')\n");
    expect(readFileSync(join(root, "src", "pg.py"), "utf8")).toBe("print('linked')\n");

    await expect(writeWorkspaceTextFile(root, join(outside, "token.txt"), "nope")).rejects.toThrow("escapes");
    expect(readFileSync(join(outside, "token.txt"), "utf8")).toBe("secret");
    await expect(writeWorkspaceTextFile(root, join(root, "outside.txt"), "nope")).rejects.toThrow("escapes");
    await expect(writeWorkspaceTextFile(root, join(root, "missing.py"), "nope")).rejects.toThrow("not available");
    await expect(writeWorkspaceTextFile(root, join(root, "src"), "nope")).rejects.toThrow("not a file");
    await expect(writeWorkspaceTextFile(root, join(root, "SOUL.md"), "edited", { agentHomePath: root })).rejects.toThrow("not editable");
    expect(readFileSync(join(root, "SOUL.md"), "utf8")).toBe("soul");
    await expect(writeWorkspaceTextFile(parse(root).root, join(root, "src", "pg.py"), "nope")).rejects.toThrow("filesystem root");
  });

  it("exposes workspace file saving through the main-window preload bridge", () => {
    const preloadSource = readSource("../src/preload/preload.cts");
    const mainSource = readSource("../src/main/main.ts");

    expect(preloadSource).toContain("writeWorkspaceFile(rootPath: string, filePath: string, contents: string)");
    expect(preloadSource).toContain('ipcRenderer.invoke("memmy:write-workspace-file", rootPath, filePath, contents)');
    expect(mainSource).toContain('ipcMain.handle(\n    "memmy:write-workspace-file"');
    expect(mainSource).toContain('ipcMain.removeHandler("memmy:write-workspace-file")');
  });
});
