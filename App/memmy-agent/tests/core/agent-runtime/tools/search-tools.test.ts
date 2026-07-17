import fs from "node:fs/promises";
import fsSync from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { AgentLoop } from "../../../../src/core/agent-runtime/loop.js";
import { SubagentManager, SubagentStatus } from "../../../../src/core/agent-runtime/subagent.js";
import {
  FindFilesTool,
  GrepTool,
  isBinary,
  matchGlob,
  normalizePattern,
  paginate,
  paginationNote,
} from "../../../../src/core/agent-runtime/tools/search.js";
import { WebSearchTool } from "../../../../src/core/agent-runtime/tools/web.js";
import { MessageBus } from "../../../../src/core/runtime-messages/queue.js";
import { WebSearchConfig } from "../../../../src/config/schema.js";

const roots: string[] = [];

function workspace(): string {
  const root = fsSync.mkdtempSync(path.join(os.tmpdir(), "memmy-search-"));
  roots.push(root);
  return root;
}

async function mkdirp(filePath: string): Promise<void> {
  await fs.mkdir(path.dirname(filePath), { recursive: true });
}

afterEach(() => {
  GrepTool.MAX_FILE_BYTES = 1_000_000;
  for (const root of roots.splice(0)) {
    fsSync.rmSync(root, { recursive: true, force: true });
  }
});

describe("search tools", () => {
  it("exposes memmy-compatible search helper behavior", () => {
    expect(normalizePattern(" src\\**\\*.ts ")).toBe("src/**/*.ts");
    expect(matchGlob("tests/unit/example.test.ts", "example.test.ts", "tests/**/*.ts")).toBe(true);
    expect(matchGlob("tests/unit/example.test.ts", "example.test.ts", "*.ts")).toBe(true);
    expect(isBinary(Buffer.from([0, 1, 2]))).toBe(true);
    expect(isBinary(Buffer.from("plain text\n"))).toBe(false);
    expect(paginate(["a", "b", "c"], 1, 1)).toEqual([["b"], true]);
    expect(paginationNote(1, 1, true)).toBe("(pagination: limit=1, offset=1)");
  });

  it("refreshes dynamic WebSearchTool config loaders", async () => {
    const tool = new WebSearchTool({
      config: new WebSearchConfig({ provider: "brave" }),
      configLoader: () => new WebSearchConfig({ provider: "duckduckgo", maxResults: 3 }),
    });
    (tool as any).searchDuckduckgo = async function searchDuckduckgo(query: string, n: number): Promise<string> {
      return `${this.config.provider}:${query}:${n}`;
    };

    await expect(tool.execute("memmy")).resolves.toBe("duckduckgo:memmy:3");
  });

  it("finds files by query, glob, and type", async () => {
    const root = workspace();
    await mkdirp(path.join(root, "src", "settings_view.tsx"));
    await fs.writeFile(path.join(root, "src", "settings_view.tsx"), "export {}\n");
    await fs.writeFile(path.join(root, "src", "settings_api.js"), "export {}\n");
    await fs.writeFile(path.join(root, "README.md"), "settings\n");

    const result = await new FindFilesTool({ workspace: root, allowedDir: root }).execute({
      path: ".",
      query: "settings",
      glob: "src/**",
      type: "ts",
    });

    expect(result.split("\n")).toEqual(["src/settings_view.tsx"]);
  });

  it("uses memmy file type aliases and all query terms", async () => {
    const root = workspace();
    await mkdirp(path.join(root, "types", "models.ts"));
    await fs.writeFile(path.join(root, "types", "models.ts"), "export type User = { id: string };\n");
    await fs.writeFile(path.join(root, "types", "guide.mdx"), "# User Guide\n");
    await fs.writeFile(path.join(root, "types", "script.bash"), "echo user\n");

    await expect(new FindFilesTool({ workspace: root, allowedDir: root }).execute({
      path: ".",
      query: "types models",
      type: "ts",
    })).resolves.toBe("types/models.ts");
    await expect(new FindFilesTool({ workspace: root, allowedDir: root }).execute({
      path: ".",
      type: "markdown",
    })).resolves.toBe("types/guide.mdx");
    await expect(new FindFilesTool({ workspace: root, allowedDir: root }).execute({
      path: ".",
      type: "sh",
    })).resolves.toBe("types/script.bash");
  });

  it("can include directories", async () => {
    const root = workspace();
    await mkdirp(path.join(root, "src", "settings", "index.ts"));
    await fs.writeFile(path.join(root, "src", "settings", "index.ts"), "export {}\n");

    const result = await new FindFilesTool({ workspace: root, allowedDir: root }).execute({
      path: "src",
      query: "settings",
      include_dirs: true,
    });

    expect(result.split("\n")).toContain("src/settings/");
    expect(result.split("\n")).toContain("src/settings/index.ts");
  });

  it("supports modified sort and pagination", async () => {
    const root = workspace();
    await fs.mkdir(path.join(root, "src"), { recursive: true });
    for (const [idx, name] of ["a.ts", "b.ts", "c.ts"].entries()) {
      const filePath = path.join(root, "src", name);
      await fs.writeFile(filePath, "export {}\n");
      fsSync.utimesSync(filePath, idx + 1, idx + 1);
    }

    const result = await new FindFilesTool({ workspace: root, allowedDir: root }).execute({
      path: "src",
      type: "ts",
      sort: "modified",
      head_limit: 1,
      offset: 1,
    });

    expect(result.split("\n")[0]).toBe("src/b.ts");
    expect(result).toContain("pagination: limit=1, offset=1");
  });

  it("rejects find paths outside the workspace", async () => {
    const root = workspace();
    const outside = path.join(path.dirname(root), `outside-find-${Date.now()}.txt`);
    await fs.writeFile(outside, "secret\n");
    roots.push(outside);

    const result = await new FindFilesTool({ workspace: root, allowedDir: root }).execute({ path: outside });

    expect(result).toMatch(/^Error:/);
  });

  it("allows unrestricted find_files to search absolute paths outside the workspace", async () => {
    const root = workspace();
    const outsideDir = path.join(path.dirname(root), `outside-find-dir-${Date.now()}`);
    roots.push(outsideDir);
    await fs.mkdir(outsideDir, { recursive: true });
    await fs.writeFile(path.join(outsideDir, "target-note.txt"), "outside\n");

    const result = await new FindFilesTool({ workspace: root }).execute({
      path: outsideDir,
      query: "target",
    });

    expect(result.split("\n")).toContain("target-note.txt");
    expect(result).not.toContain("outside workspace");
  });

  it("allows restricted find_files to search extra allowed directories", async () => {
    const root = workspace();
    const extra = path.join(path.dirname(root), `extra-find-${Date.now()}`);
    roots.push(extra);
    await fs.mkdir(extra, { recursive: true });
    await fs.writeFile(path.join(extra, "allowed-note.txt"), "allowed\n");

    const result = await new FindFilesTool({ workspace: root, allowedDir: root, extraAllowedDirs: [extra] }).execute({
      path: extra,
      query: "allowed",
    });

    expect(result.split("\n")).toContain("allowed-note.txt");
    expect(result).not.toContain("outside workspace");
  });

  it("greps with glob filters and context", async () => {
    const root = workspace();
    await mkdirp(path.join(root, "src", "main.ts"));
    await fs.writeFile(path.join(root, "src", "main.ts"), "alpha\nbeta\nmatch_here\ngamma\n");
    await fs.writeFile(path.join(root, "README.md"), "match_here\n");

    const result = await new GrepTool({ workspace: root, allowedDir: root }).execute({
      pattern: "match_here",
      path: ".",
      glob: "*.ts",
      output_mode: "content",
      context_before: 1,
      context_after: 1,
    });

    expect(result).toContain("src/main.ts:3");
    expect(result).toContain("  2| beta");
    expect(result).toContain("> 3| match_here");
    expect(result).toContain("  4| gamma");
    expect(result).not.toContain("README.md");
  });

  it("reports invalid regex and supports max_matches in content mode", async () => {
    const root = workspace();
    await mkdirp(path.join(root, "src", "main.ts"));
    await fs.writeFile(path.join(root, "src", "main.ts"), "needle one\nneedle two\n");

    await expect(new GrepTool({ workspace: root, allowedDir: root }).execute({
      pattern: "[",
      path: "src",
    })).resolves.toContain("invalid regex pattern");
    const result = await new GrepTool({ workspace: root, allowedDir: root }).execute({
      pattern: "needle",
      path: "src",
      output_mode: "content",
      max_matches: 1,
    });
    expect(result.split("\n").filter((line) => line.startsWith("src/"))).toHaveLength(1);
    expect(result).toContain("pagination: limit=1, offset=0");
  });

  it("defaults grep to files_with_matches", async () => {
    const root = workspace();
    await mkdirp(path.join(root, "src", "main.ts"));
    await fs.writeFile(path.join(root, "src", "main.ts"), "match_here\n");

    const result = await new GrepTool({ workspace: root, allowedDir: root }).execute({
      pattern: "match_here",
      path: "src",
    });

    expect(result.split("\n")).toEqual(["src/main.ts"]);
    expect(result).not.toContain("1|");
  });

  it("supports case-insensitive grep", async () => {
    const root = workspace();
    await mkdirp(path.join(root, "memory", "HISTORY.md"));
    await fs.writeFile(path.join(root, "memory", "HISTORY.md"), "[2026-04-02 10:00] OAuth token rotated\n");

    const result = await new GrepTool({ workspace: root, allowedDir: root }).execute({
      pattern: "oauth",
      path: "memory/HISTORY.md",
      case_insensitive: true,
      output_mode: "content",
    });

    expect(result).toContain("memory/HISTORY.md:1");
    expect(result).toContain("OAuth token rotated");
  });

  it("limits grep files by type", async () => {
    const root = workspace();
    await mkdirp(path.join(root, "src", "a.ts"));
    await fs.writeFile(path.join(root, "src", "a.ts"), "needle\n");
    await fs.writeFile(path.join(root, "src", "b.md"), "needle\n");

    const result = await new GrepTool({ workspace: root, allowedDir: root }).execute({
      pattern: "needle",
      path: "src",
      type: "ts",
    });

    expect(result.split("\n")).toEqual(["src/a.ts"]);
  });

  it("treats regex characters literally in fixed string mode", async () => {
    const root = workspace();
    await mkdirp(path.join(root, "memory", "HISTORY.md"));
    await fs.writeFile(path.join(root, "memory", "HISTORY.md"), "[2026-04-02 10:00] OAuth token rotated\n");

    const result = await new GrepTool({ workspace: root, allowedDir: root }).execute({
      pattern: "[2026-04-02 10:00]",
      path: "memory/HISTORY.md",
      fixed_strings: true,
      output_mode: "content",
    });

    expect(result).toContain("memory/HISTORY.md:1");
    expect(result).toContain("[2026-04-02 10:00] OAuth token rotated");
  });

  it("returns unique paths in files_with_matches mode", async () => {
    const root = workspace();
    await fs.mkdir(path.join(root, "src"), { recursive: true });
    const a = path.join(root, "src", "a.ts");
    const b = path.join(root, "src", "b.ts");
    await fs.writeFile(a, "needle\nneedle\n");
    await fs.writeFile(b, "needle\n");
    fsSync.utimesSync(a, 1, 1);
    fsSync.utimesSync(b, 2, 2);

    const result = await new GrepTool({ workspace: root, allowedDir: root }).execute({
      pattern: "needle",
      path: "src",
      output_mode: "files_with_matches",
    });

    expect(result.split("\n")).toEqual(["src/b.ts", "src/a.ts"]);
  });

  it("supports head limit and offset in files_with_matches mode", async () => {
    const root = workspace();
    await fs.mkdir(path.join(root, "src"), { recursive: true });
    for (const name of ["a.ts", "b.ts", "c.ts"]) {
      await fs.writeFile(path.join(root, "src", name), "needle\n");
    }

    const result = await new GrepTool({ workspace: root, allowedDir: root }).execute({
      pattern: "needle",
      path: "src",
      head_limit: 1,
      offset: 1,
    });

    expect(result).toContain("pagination: limit=1, offset=1");
    expect(result.split("\n").filter((line) => line.startsWith("src/"))).toHaveLength(1);
  });

  it("reports counts per file", async () => {
    const root = workspace();
    await mkdirp(path.join(root, "logs", "one.log"));
    await fs.writeFile(path.join(root, "logs", "one.log"), "warn\nok\nwarn\n");
    await fs.writeFile(path.join(root, "logs", "two.log"), "warn\n");

    const result = await new GrepTool({ workspace: root, allowedDir: root }).execute({
      pattern: "warn",
      path: "logs",
      output_mode: "count",
    });

    expect(result).toContain("logs/one.log: 2");
    expect(result).toContain("logs/two.log: 1");
    expect(result).toContain("total matches: 3 in 2 files");
  });

  it("respects max_results in files_with_matches mode", async () => {
    const root = workspace();
    await fs.mkdir(path.join(root, "src"), { recursive: true });
    for (const [idx, name] of ["a.ts", "b.ts", "c.ts"].entries()) {
      const filePath = path.join(root, "src", name);
      await fs.writeFile(filePath, "needle\n");
      fsSync.utimesSync(filePath, idx + 1, idx + 1);
    }

    const result = await new GrepTool({ workspace: root, allowedDir: root }).execute({
      pattern: "needle",
      path: "src",
      output_mode: "files_with_matches",
      max_results: 2,
    });

    expect(result.split("\n").slice(0, 2)).toEqual(["src/c.ts", "src/b.ts"]);
    expect(result).toContain("pagination: limit=2, offset=0");
  });

  it("reports skipped binary and large files", async () => {
    const root = workspace();
    await fs.writeFile(path.join(root, "binary.bin"), Buffer.from([0, 1, 2]));
    await fs.writeFile(path.join(root, "large.txt"), "x".repeat(20));
    GrepTool.MAX_FILE_BYTES = 10;

    const result = await new GrepTool({ workspace: root, allowedDir: root }).execute({
      pattern: "needle",
      path: ".",
    });

    expect(result).toContain("No matches found");
    expect(result).toContain("skipped 1 binary/unreadable files");
    expect(result).toContain("skipped 1 large files");
  });

  it("rejects grep paths outside the workspace", async () => {
    const root = workspace();
    const outside = path.join(path.dirname(root), `outside-search-${Date.now()}.txt`);
    await fs.writeFile(outside, "secret\n");
    roots.push(outside);

    const result = await new GrepTool({ workspace: root, allowedDir: root }).execute({
      pattern: "secret",
      path: outside,
    });

    expect(result).toMatch(/^Error:/);
  });

  it("allows unrestricted grep to search absolute paths outside the workspace", async () => {
    const root = workspace();
    const outsideDir = path.join(path.dirname(root), `outside-grep-dir-${Date.now()}`);
    roots.push(outsideDir);
    await fs.mkdir(outsideDir, { recursive: true });
    await fs.writeFile(path.join(outsideDir, "match.txt"), "needle outside\n");

    const result = await new GrepTool({ workspace: root }).execute({
      pattern: "needle",
      path: outsideDir,
      output_mode: "content",
    });

    expect(result).toContain("match.txt:1");
    expect(result).toContain("needle outside");
    expect(result).not.toContain("outside workspace");
  });

  it("allows restricted grep to search extra allowed directories", async () => {
    const root = workspace();
    const extra = path.join(path.dirname(root), `extra-grep-${Date.now()}`);
    roots.push(extra);
    await fs.mkdir(extra, { recursive: true });
    await fs.writeFile(path.join(extra, "allowed.txt"), "needle allowed\n");

    const result = await new GrepTool({ workspace: root, allowedDir: root, extraAllowedDirs: [extra] }).execute({
      pattern: "needle",
      path: extra,
      output_mode: "content",
    });

    expect(result).toContain("allowed.txt:1");
    expect(result).toContain("needle allowed");
    expect(result).not.toContain("outside workspace");
  });

  it("registers search tools in AgentLoop", () => {
    const root = workspace();
    const provider = { getDefaultModel: () => "test-model" };
    const loop = new AgentLoop({ bus: new MessageBus(), provider, workspace: root, model: "test-model" });

    expect(loop.tools.toolNames).toContain("find_files");
    expect(loop.tools.toolNames).toContain("grep");
  });

  it("registers search tools in subagents", async () => {
    const root = workspace();
    const provider = { getDefaultModel: () => "test-model" };
    const manager = new SubagentManager({
      provider,
      workspace: root,
      bus: new MessageBus(),
      maxToolResultChars: 4096,
    });
    const captured: Record<string, string[]> = {};
    (manager.runner as any).run = async (spec: any) => {
      captured.toolNames = spec.tools.toolNames;
      return { stopReason: "ok", finalContent: "done", toolEvents: [], error: null };
    };
    (manager as any).announceResult = async () => undefined;

    const status = new SubagentStatus({
      taskId: "sub-1",
      label: "label",
      taskDescription: "search task",
      startedAt: Date.now() / 1000,
    });
    await (manager as any).runSubagent("sub-1", "search task", "label", { channel: "cli", chatId: "direct" }, status);

    expect(captured.toolNames).toContain("find_files");
    expect(captured.toolNames).toContain("grep");
  });
});
