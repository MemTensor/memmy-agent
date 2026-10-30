import { mkdirSync, mkdtempSync, realpathSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path, { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { normalizeRemoteUrl, readGitIdentity } from "../../../src/service/l3-field/git-identity.js";
import {
  isPathWithin,
  resolveProject,
  type ResolverContext
} from "../../../src/service/l3-field/project-resolver.js";

let home: string;
let ctx: ResolverContext;

beforeEach(() => {
  home = realpathSync(mkdtempSync(join(tmpdir(), "l3-resolver-home-")));
  ctx = {
    homeDir: home,
    userProjects: [],
    standaloneRoots: [join(home, "Memmy")],
    tempRoots: [join(home, "tmp")],
    workspaceIsLocal: true
  };
});

afterEach(() => {
  rmSync(home, { recursive: true, force: true });
});

function dir(...parts: string[]): string {
  const target = join(home, ...parts);
  mkdirSync(target, { recursive: true });
  return target;
}

function gitRepo(root: string, origin?: string): void {
  mkdirSync(join(root, ".git"), { recursive: true });
  const remote = origin ? `[remote "origin"]\n\turl = ${origin}\n\tfetch = +refs/heads/*:refs/remotes/origin/*\n` : "";
  writeFileSync(join(root, ".git", "config"), `[core]\n\tbare = false\n${remote}`);
}

function worktree(mainRoot: string, worktreeRoot: string, name: string): void {
  const gitDir = join(mainRoot, ".git", "worktrees", name);
  mkdirSync(gitDir, { recursive: true });
  writeFileSync(join(gitDir, "commondir"), "../..\n");
  mkdirSync(worktreeRoot, { recursive: true });
  writeFileSync(join(worktreeRoot, ".git"), `gitdir: ${path.relative(worktreeRoot, gitDir)}\n`);
}

const asSession = (p: string) => ({ path: p, role: "session_dir" as const, sessionCwd: p, sessionProjectRoot: null });

describe("normalizeRemoteUrl", () => {
  it("maps ssh, scp-like and https forms of the same repository to one identity", () => {
    const expected = "github.com/memtensor/memmy-agent";
    expect(normalizeRemoteUrl("git@github.com:MemTensor/memmy-agent.git")).toBe(expected);
    expect(normalizeRemoteUrl("ssh://git@GitHub.com/MemTensor/memmy-agent.git")).toBe(expected);
    expect(normalizeRemoteUrl("https://github.com/MemTensor/memmy-agent")).toBe(expected);
    expect(normalizeRemoteUrl("https://user@github.com/MemTensor/memmy-agent.git/")).toBe(expected);
  });

  it("keeps a non-default port and ignores local remotes", () => {
    expect(normalizeRemoteUrl("ssh://git@git.example.test:2222/team/repo.git")).toBe("git.example.test:2222/team/repo");
    expect(normalizeRemoteUrl("/srv/git/repo.git")).toBeNull();
    expect(normalizeRemoteUrl("file:///srv/git/repo.git")).toBeNull();
  });
});

describe("readGitIdentity", () => {
  it("gives a worktree, its main clone and a subdirectory the same identity", () => {
    const main = dir("code", "repo");
    gitRepo(main, "git@github.com:Org/Repo.git");
    const sub = dir("code", "repo", "src", "deep");
    const wt = join(home, "code", "repo-wt");
    worktree(main, wt, "repo-wt");
    const a = readGitIdentity(main)!;
    expect(readGitIdentity(sub)!.identity).toBe(a.identity);
    expect(readGitIdentity(sub)!.repoRoot).toBe(main);
    expect(readGitIdentity(wt)!.identity).toBe(a.identity);
    expect(readGitIdentity(wt)!.repoRoot).toBe(wt);
    expect(a.identity).toBe("github.com/org/repo");
  });

  it("falls back to the common git directory when there is no origin or the config is broken", () => {
    const repo = dir("code", "local-only");
    gitRepo(repo);
    expect(readGitIdentity(repo)!.identity).toBe(`gitdir:${join(repo, ".git")}`);
    writeFileSync(join(repo, ".git", "config"), "\u0000not a config");
    expect(readGitIdentity(repo)!.identity).toBe(`gitdir:${join(repo, ".git")}`);
  });

  it("returns null outside any repository", () => {
    expect(readGitIdentity(dir("plain"))).toBeNull();
  });
});

describe("resolveProject", () => {
  it("resolves a git repository by its origin, named after the remote repository", () => {
    const repo = dir("code", "memmy-agent-feature-x");
    gitRepo(repo, "https://github.com/MemTensor/memmy-agent.git");
    expect(resolveProject(asSession(join(repo, "Memory")), ctx)).toEqual({
      identity: "github.com/memtensor/memmy-agent",
      checkoutRoot: repo,
      source: "git",
      displayName: "memmy-agent"
    });
  });

  it("treats a plain session folder as a folder project", () => {
    const folder = dir("Desktop", "reviews");
    expect(resolveProject(asSession(folder), ctx)).toEqual({
      identity: `dir:${folder}`,
      checkoutRoot: folder,
      source: "folder",
      displayName: "reviews"
    });
  });

  it("does not treat temporary, Codex dated, Claude scratch or Memmy task folders as projects", () => {
    expect(resolveProject(asSession(dir("tmp", "x")), ctx)).toBeNull();
    expect(resolveProject(asSession(dir("Documents", "Codex", "2026-10-22", "na")), ctx)).toBeNull();
    expect(resolveProject(asSession(dir("Library", "Application Support", "Claude", "scratch-workspaces", "a", "b")), ctx)).toBeNull();
    expect(resolveProject(asSession(dir(".codex", "memories_v2")), ctx)).toBeNull();
    expect(resolveProject(asSession(dir("Memmy", "20261022-101010")), ctx)).toBeNull();
  });

  it("does not treat tool installs as projects even when they are git clones", () => {
    const nvm = dir(".nvm");
    gitRepo(nvm, "https://github.com/nvm-sh/nvm.git");
    const toolPath = (p: string) => ({ path: p, role: "tool_path" as const, sessionCwd: null, sessionProjectRoot: null });
    expect(resolveProject(toolPath(join(nvm, "nvm.sh")), ctx)).toBeNull();
    expect(resolveProject(asSession(nvm), ctx)).toBeNull();
    expect(resolveProject(toolPath("/opt/homebrew/bin/git"), ctx)).toBeNull();
    expect(resolveProject(toolPath("/usr/local/Homebrew/Library/Homebrew/brew.sh"), ctx)).toBeNull();
    expect(resolveProject(toolPath("C:\\Program Files\\Git\\bin\\git.exe"), ctx)).toBeNull();

    const app = dir("code", "app");
    gitRepo(app, "git@github.com:me/app.git");
    const pkg = dir("code", "app", "node_modules", "left-pad");
    gitRepo(pkg, "https://github.com/x/left-pad.git");
    expect(resolveProject(toolPath(join(pkg, "index.js")), ctx)).toMatchObject({ identity: "github.com/me/app" });
  });

  it("still takes a folder the user selected inside a hidden folder", () => {
    const notes = dir(".config", "notes");
    ctx.userProjects = [{ rootPath: notes, name: "notes" }];
    expect(resolveProject(asSession(notes), ctx)).toMatchObject({ source: "user_selected", checkoutRoot: notes });
  });

  it("does not treat the home directory, Desktop, Documents or Downloads themselves as projects", () => {
    for (const container of [home, dir("Desktop"), dir("Documents"), dir("Downloads")]) {
      expect(resolveProject(asSession(container), ctx)).toBeNull();
    }
  });

  it("ignores a git repository rooted at the home directory and falls back to the folder", () => {
    gitRepo(home, "git@github.com:me/dotfiles.git");
    const notes = dir("notes");
    expect(resolveProject(asSession(notes), ctx)).toMatchObject({ source: "folder", checkoutRoot: notes });
    expect(resolveProject(asSession(home), ctx)).toBeNull();
  });

  it("prefers the nearer root when a user-selected folder and a repository overlap", () => {
    const repo = dir("code", "mono");
    gitRepo(repo, "git@github.com:org/mono.git");
    const selectedInside = dir("code", "mono", "packages", "app");
    const outer = dir("work");
    const repoInside = dir("work", "lib");
    gitRepo(repoInside, "git@github.com:org/lib.git");
    const withSelections: ResolverContext = {
      ...ctx,
      userProjects: [{ rootPath: selectedInside, name: "App" }, { rootPath: outer, name: "Work" }]
    };
    expect(resolveProject(asSession(join(selectedInside, "src")), withSelections)).toMatchObject({
      source: "user_selected", checkoutRoot: selectedInside, displayName: "App"
    });
    expect(resolveProject(asSession(repoInside), withSelections)).toMatchObject({
      source: "git", identity: "github.com/org/lib"
    });
  });

  it("counts a user-selected folder that is also the repository root once, with the git identity", () => {
    const repo = dir("code", "same");
    gitRepo(repo, "git@github.com:org/same.git");
    const withSelection: ResolverContext = { ...ctx, userProjects: [{ rootPath: repo, name: "我的项目" }] };
    expect(resolveProject(asSession(repo), withSelection)).toEqual({
      identity: "github.com/org/same",
      checkoutRoot: repo,
      source: "user_selected",
      displayName: "我的项目"
    });
  });

  it("compares by path components, so /repo does not contain /repo2", () => {
    const repo = dir("code", "repo");
    gitRepo(repo, "git@github.com:org/repo.git");
    const sibling = dir("code", "repo2");
    expect(resolveProject(asSession(sibling), ctx)).toMatchObject({ source: "folder", checkoutRoot: sibling });
  });

  it("resolves a tool path that does not exist yet through its nearest existing parent", () => {
    const repo = dir("code", "repo");
    gitRepo(repo, "git@github.com:org/repo.git");
    expect(resolveProject({
      path: join(repo, "src", "new-dir", "new-file.ts"), role: "tool_path", sessionCwd: repo, sessionProjectRoot: repo
    }, ctx)).toMatchObject({ identity: "github.com/org/repo" });
  });

  it("falls back to the session project for a tool path under the session folder and ignores unrelated tool paths", () => {
    const folder = dir("Desktop", "reviews");
    const file = join(folder, "paper-1", "notes.md");
    expect(resolveProject({ path: file, role: "tool_path", sessionCwd: folder, sessionProjectRoot: folder }, ctx))
      .toMatchObject({ source: "folder", checkoutRoot: folder });
    expect(resolveProject({ path: join(dir("elsewhere"), "x.txt"), role: "tool_path", sessionCwd: folder, sessionProjectRoot: folder }, ctx))
      .toBeNull();
  });

  it("resolves a symlinked path to the same project as its target", () => {
    const repo = dir("code", "real");
    gitRepo(repo, "git@github.com:org/real.git");
    const link = join(home, "link-to-real");
    symlinkSync(repo, link);
    expect(resolveProject(asSession(link), ctx)).toMatchObject({ identity: "github.com/org/real", checkoutRoot: repo });
  });

  it("returns null for a remote workspace", () => {
    expect(resolveProject(asSession(dir("Desktop", "x")), { ...ctx, workspaceIsLocal: false })).toBeNull();
  });
});

describe("isPathWithin", () => {
  it("compares Windows paths by drive and components", () => {
    expect(isPathWithin("C:\\work\\repo", "C:\\work\\repo\\src\\a.ts", path.win32)).toBe(true);
    expect(isPathWithin("C:\\work\\repo", "c:\\work\\repo\\src", path.win32)).toBe(true);
    expect(isPathWithin("C:\\work\\repo", "C:\\work\\repo2\\a.ts", path.win32)).toBe(false);
    expect(isPathWithin("C:\\work\\repo", "D:\\work\\repo\\a.ts", path.win32)).toBe(false);
  });

  it("compares POSIX paths by components", () => {
    expect(isPathWithin("/work/repo", "/work/repo")).toBe(true);
    expect(isPathWithin("/work/repo", "/work/repo2")).toBe(false);
  });
});
