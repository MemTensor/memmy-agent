import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { GitStore } from "../../src/utils/gitstore.js";

const roots: string[] = [];

function tmpRoot(): string {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "memmy-utils-gitstore-"));
  roots.push(root);
  return root;
}

function gitStore(): GitStore {
  const store = new GitStore(tmpRoot(), ["MEMORY.md", "SOUL.md"]);
  expect(store.init()).toBe(true);
  return store;
}

afterEach(() => {
  vi.useRealTimers();
  for (const root of roots.splice(0)) fs.rmSync(root, { recursive: true, force: true });
});

describe("GitStore line ages", () => {
  it("returns empty when the git store is not initialized", () => {
    const store = new GitStore(tmpRoot(), ["MEMORY.md"]);

    expect(store.lineAges("MEMORY.md")).toEqual([]);
  });

  it("returns empty for a missing file", () => {
    const store = gitStore();

    expect(store.lineAges("SOUL.md")).toEqual([]);
  });

  it("returns empty for an empty tracked file", () => {
    const store = gitStore();
    fs.writeFileSync(path.join(store.workspace, "SOUL.md"), "", "utf8");
    store.autoCommit("empty soul");

    expect(store.lineAges("SOUL.md")).toEqual([]);
  });

  it("returns one age entry per file line", () => {
    const store = gitStore();
    const content = "# Memory\n\n## Section A\n- item 1\n";
    fs.writeFileSync(path.join(store.workspace, "MEMORY.md"), content, "utf8");
    store.autoCommit("initial");

    const ages = store.lineAges("MEMORY.md");

    expect(ages).toHaveLength(
      content.split(/\r?\n/).filter((line, idx, arr) => idx < arr.length - 1 || line).length,
    );
  });

  it("reports age zero for freshly committed lines", () => {
    const store = gitStore();
    fs.writeFileSync(path.join(store.workspace, "MEMORY.md"), "## A\n- x\n", "utf8");
    store.autoCommit("initial");

    const ages = store.lineAges("MEMORY.md");

    expect(ages.every((age) => age.ageDays === 0)).toBe(true);
  });

  it("differentiates age across days", () => {
    const store = gitStore();
    fs.writeFileSync(path.join(store.workspace, "MEMORY.md"), "## A\n- x\n", "utf8");
    store.autoCommit("initial");

    vi.useFakeTimers({ now: Date.now() + 30 * 86_400_000 });
    const ages = store.lineAges("MEMORY.md");

    expect(ages).toHaveLength(2);
    expect(ages.every((age) => age.ageDays === 30)).toBe(true);
  });

  it("returns empty when annotate fails", () => {
    const store = new GitStore(tmpRoot(), ["MEMORY.md"]);

    expect(store.lineAges("MEMORY.md")).toEqual([]);
  });

  it("keeps one age entry per line after a partial edit", () => {
    const store = gitStore();
    fs.writeFileSync(
      path.join(store.workspace, "MEMORY.md"),
      "# Memory\n\n## A\n- old\n\n## B\n- keep\n",
      "utf8",
    );
    store.autoCommit("commit1");

    fs.writeFileSync(
      path.join(store.workspace, "MEMORY.md"),
      "# Memory\n\n## A\n- new\n\n## B\n- keep\n",
      "utf8",
    );
    store.autoCommit("commit2");

    expect(store.lineAges("MEMORY.md")).toHaveLength(7);
  });
});

describe("GitStore nested repository protection", () => {
  it("refuses to initialize inside an existing git repository", () => {
    const project = path.join(tmpRoot(), "project");
    fs.mkdirSync(path.join(project, ".git"), { recursive: true });
    const workspace = path.join(project, "workspace");
    fs.mkdirSync(workspace);

    const store = new GitStore(workspace, ["MEMORY.md"]);

    expect(store.init()).toBe(false);
    expect(fs.existsSync(path.join(workspace, ".git"))).toBe(false);
  });

  it("preserves existing gitignore entries and appends tracked-file rules", () => {
    const workspace = path.join(tmpRoot(), "workspace");
    fs.mkdirSync(workspace);
    fs.writeFileSync(path.join(workspace, ".gitignore"), "*.tsbuildinfo\ncoverage/\n", "utf8");
    const store = new GitStore(workspace, ["MEMORY.md"]);

    expect(store.init()).toBe(true);
    const gitignore = fs.readFileSync(path.join(workspace, ".gitignore"), "utf8");
    expect(gitignore).toContain("*.tsbuildinfo");
    expect(gitignore).toContain("coverage/");
    expect(gitignore).toContain("!MEMORY.md");
    expect(gitignore).toContain("!.gitignore");
  });

  it("creates a new gitignore when none exists", () => {
    const workspace = path.join(tmpRoot(), "workspace");
    fs.mkdirSync(workspace);
    const store = new GitStore(workspace, ["MEMORY.md"]);

    expect(store.init()).toBe(true);
    expect(fs.readFileSync(path.join(workspace, ".gitignore"), "utf8")).toBe(
      store.buildGitignore(),
    );
  });

  it("merges gitignore rules idempotently", () => {
    const workspace = path.join(tmpRoot(), "workspace");
    fs.mkdirSync(workspace);
    fs.writeFileSync(path.join(workspace, ".gitignore"), "*.tsbuildinfo\n/*\n!MEMORY.md\n", "utf8");
    const store = new GitStore(workspace, ["MEMORY.md"]);

    expect(store.init()).toBe(true);
    const gitignore = fs.readFileSync(path.join(workspace, ".gitignore"), "utf8");
    const lines = gitignore.split(/\r?\n/);
    expect(lines.filter((line) => line === "/*")).toHaveLength(1);
    expect(lines.filter((line) => line === "!MEMORY.md")).toHaveLength(1);
    expect(gitignore).toContain("*.tsbuildinfo");
    expect(gitignore).toContain("!.gitignore");
  });

  it("initializes normally outside an existing git repository", () => {
    const workspace = path.join(tmpRoot(), "workspace");
    fs.mkdirSync(workspace);
    const store = new GitStore(workspace, ["MEMORY.md"]);

    expect(store.init()).toBe(true);
    expect(fs.statSync(path.join(workspace, ".git")).isDirectory()).toBe(true);
  });

  it("refuses to initialize inside a git worktree", () => {
    const worktree = path.join(tmpRoot(), "worktree");
    fs.mkdirSync(worktree);
    fs.writeFileSync(
      path.join(worktree, ".git"),
      "gitdir: /tmp/repo/.git/worktrees/worktree\n",
      "utf8",
    );
    expect(fs.statSync(path.join(worktree, ".git")).isFile()).toBe(true);
    const workspace = path.join(worktree, "workspace");
    fs.mkdirSync(workspace);

    const store = new GitStore(workspace, ["MEMORY.md"]);

    expect(store.init()).toBe(false);
    expect(fs.existsSync(path.join(workspace, ".git"))).toBe(false);
  });
});
