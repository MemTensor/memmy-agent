import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { MemoryStore } from "../../../src/core/agent-runtime/memory.js";
import { CommitInfo, GitStore } from "../../../src/utils/gitstore.js";

const TRACKED = ["SOUL.md", "USER.md", "memory/MEMORY.md"];
const roots: string[] = [];

function workspace(): string {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "memmy-agent-git-store-"));
  roots.push(root);
  return root;
}

function gitStore(tracked = TRACKED): GitStore {
  return new GitStore(workspace(), tracked);
}

function readyStore(tracked = TRACKED): GitStore {
  const store = gitStore(tracked);
  expect(store.init()).toBe(true);
  return store;
}

afterEach(() => {
  for (const root of roots.splice(0)) fs.rmSync(root, { recursive: true, force: true });
});

describe("GitStore init", () => {
  it("is not initialized by default", () => {
    const store = gitStore();

    expect(store.isInitialized()).toBe(false);
    expect(fs.existsSync(path.join(store.workspace, ".git"))).toBe(false);
  });

  it("creates a git directory", () => {
    const store = gitStore();

    expect(store.init()).toBe(true);
    expect(fs.statSync(path.join(store.workspace, ".git")).isDirectory()).toBe(true);
  });

  it("is idempotent after initialization", () => {
    const store = readyStore();

    expect(store.init()).toBe(false);
  });

  it("creates a gitignore with tracked file exceptions", () => {
    const store = readyStore();
    const gitignore = fs.readFileSync(path.join(store.workspace, ".gitignore"), "utf8");

    for (const file of TRACKED) expect(gitignore).toContain(`!${file}`);
  });

  it("touches tracked files", () => {
    const store = readyStore();

    for (const file of TRACKED) expect(fs.existsSync(path.join(store.workspace, file))).toBe(true);
  });

  it("makes an initial commit", () => {
    const store = readyStore();
    const commits = store.log();

    expect(commits).toHaveLength(1);
    expect(commits[0].message).toContain("init");
  });
});

describe("GitStore gitignore generation", () => {
  it("includes subdirectory exceptions", () => {
    const content = gitStore().buildGitignore();

    expect(content).toContain("!memory/\n");
    for (const file of TRACKED) expect(content).toContain(`!${file}\n`);
    expect(content.startsWith("/*\n")).toBe(true);
  });

  it("does not add directory exceptions for root-level files", () => {
    const content = new GitStore(workspace(), ["a.md", "b.md"]).buildGitignore();
    const dirLines = content.split("\n").filter((line) => line.startsWith("!") && line.endsWith("/"));

    expect(content).toContain("!a.md\n");
    expect(content).toContain("!b.md\n");
    expect(dirLines).toEqual([]);
  });
});

describe("GitStore auto commit", () => {
  it("returns null when not initialized", () => {
    expect(gitStore().autoCommit("test")).toBeNull();
  });

  it("commits tracked file changes", () => {
    const store = readyStore();
    fs.writeFileSync(path.join(store.workspace, "SOUL.md"), "updated", "utf8");

    const sha = store.autoCommit("update soul");

    expect(sha).toMatch(/^[0-9a-f]{8}$/);
  });

  it("returns null when there are no changes", () => {
    expect(readyStore().autoCommit("no change")).toBeNull();
  });

  it("shows new commits in the log", () => {
    const store = readyStore();
    fs.writeFileSync(path.join(store.workspace, "SOUL.md"), "v2", "utf8");
    const sha = store.autoCommit("update soul");
    const commits = store.log();

    expect(commits).toHaveLength(2);
    expect(commits[0].sha).toBe(sha);
  });

  it("does not create empty commits", () => {
    const store = readyStore();
    store.autoCommit("nothing 1");
    store.autoCommit("nothing 2");

    expect(store.log()).toHaveLength(1);
  });
});

describe("GitStore log", () => {
  it("is empty when not initialized", () => {
    expect(gitStore().log()).toEqual([]);
  });

  it("returns newest commits first", () => {
    const store = readyStore();
    for (let i = 0; i < 3; i += 1) {
      fs.writeFileSync(path.join(store.workspace, "SOUL.md"), `v${i}`, "utf8");
      store.autoCommit(`commit ${i}`);
    }

    const commits = store.log();

    expect(commits).toHaveLength(4);
    expect(commits[0].message).toContain("commit 2");
    expect(commits.at(-1)?.message).toContain("init");
  });

  it("respects max entries", () => {
    const store = readyStore();
    for (let i = 0; i < 10; i += 1) {
      fs.writeFileSync(path.join(store.workspace, "SOUL.md"), `v${i}`, "utf8");
      store.autoCommit(`c${i}`);
    }

    expect(store.log(3)).toHaveLength(3);
  });

  it("returns CommitInfo fields", () => {
    const commit = readyStore().log()[0];

    expect(commit).toBeInstanceOf(CommitInfo);
    expect(commit.sha).toHaveLength(8);
    expect(commit.timestamp).toBeTruthy();
    expect(commit.message).toBeTruthy();
  });
});

describe("GitStore commit diffs", () => {
  it("returns empty diff when not initialized", () => {
    expect(gitStore().diffCommits("a", "b")).toBe("");
  });

  it("returns the diff between two commits", () => {
    const store = readyStore();
    fs.writeFileSync(path.join(store.workspace, "SOUL.md"), "original", "utf8");
    store.autoCommit("v1");
    fs.writeFileSync(path.join(store.workspace, "SOUL.md"), "modified", "utf8");
    store.autoCommit("v2");

    const commits = store.log();
    const diff = store.diffCommits(commits[1].sha, commits[0].sha);

    expect(diff).toContain("modified");
  });

  it("returns empty diff for invalid SHAs", () => {
    expect(readyStore().diffCommits("deadbeef", "cafebabe")).toBe("");
  });
});

describe("GitStore commit lookup", () => {
  it("finds commits by prefix", () => {
    const store = readyStore();
    fs.writeFileSync(path.join(store.workspace, "SOUL.md"), "v2", "utf8");
    const sha = store.autoCommit("v2");

    const found = store.findCommit(sha!.slice(0, 4));

    expect(found?.sha).toBe(sha);
  });

  it("returns null for unknown commit prefixes", () => {
    expect(readyStore().findCommit("deadbeef")).toBeNull();
  });
});

describe("GitStore show commit diff", () => {
  it("returns a commit with its diff", () => {
    const store = readyStore();
    fs.writeFileSync(path.join(store.workspace, "SOUL.md"), "content", "utf8");
    const sha = store.autoCommit("add content");

    const result = store.showCommitDiff(sha!);

    expect(result).not.toBeNull();
    expect(result?.[0].sha).toBe(sha);
    expect(result?.[1]).toContain("content");
  });

  it("returns an empty diff for the first commit", () => {
    const store = readyStore();
    const initSha = store.log().at(-1)!.sha;

    const result = store.showCommitDiff(initSha);

    expect(result).not.toBeNull();
    expect(result?.[1]).toBe("");
  });

  it("returns null for unknown commit prefixes", () => {
    expect(readyStore().showCommitDiff("deadbeef")).toBeNull();
  });
});

describe("CommitInfo formatting", () => {
  it("formats commits with diffs", () => {
    const commit = new CommitInfo({ sha: "abcd1234", message: "test commit\nsecond line", timestamp: "2026-04-02 12:00" });

    const result = commit.format("some diff");

    expect(result).toContain("test commit");
    expect(result).toContain("`abcd1234`");
    expect(result).toContain("some diff");
  });

  it("formats commits without diffs", () => {
    expect(new CommitInfo({ sha: "abcd1234", message: "test", timestamp: "2026-04-02 12:00" }).format()).toContain(
      "(no file changes)",
    );
  });
});

describe("GitStore revert", () => {
  it("returns null when not initialized", () => {
    expect(gitStore().revert("abc")).toBeNull();
  });

  it("undoes commit changes by restoring from the parent", () => {
    const store = readyStore();
    const file = path.join(store.workspace, "SOUL.md");
    fs.writeFileSync(file, "v2 content", "utf8");
    const sha = store.autoCommit("v2");

    const newSha = store.revert(sha!);

    expect(newSha).toMatch(/^[0-9a-f]{8}$/);
    expect(fs.readFileSync(file, "utf8")).toBe("");
  });

  it("returns null for the root commit", () => {
    const store = readyStore();
    const commits = store.log();

    expect(commits).toHaveLength(1);
    expect(store.revert(commits[0].sha)).toBeNull();
  });

  it("returns null for invalid SHAs", () => {
    expect(readyStore().revert("deadbeef")).toBeNull();
  });
});

describe("MemoryStore GitStore property", () => {
  it("exposes GitStore from MemoryStore.git", () => {
    expect(new MemoryStore(workspace()).git).toBeInstanceOf(GitStore);
  });

  it("returns the same GitStore object", () => {
    const store = new MemoryStore(workspace());

    expect(store.git).toBe(store.gitStore);
  });
});
