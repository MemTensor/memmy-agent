import { existsSync, realpathSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { readGitIdentity } from "./git-identity.js";
import type { L3UserProject, ResolvedProject } from "./types.js";

export interface ResolverContext {
  homeDir: string;
  /** Folders the user picked in the desktop app. */
  userProjects: readonly L3UserProject[];
  /** Roots of throwaway task folders created by Memmy itself (default `~/Memmy`). */
  standaloneRoots: readonly string[];
  /** System temporary directories; defaults to the usual macOS/Linux locations. */
  tempRoots?: readonly string[];
  /** Remote workspaces are never resolved: the Memory service cannot see their files. */
  workspaceIsLocal: boolean;
}

export interface ResolveProjectInput {
  path: string;
  /** A session folder may be a plain-folder project; a tool path only joins a project it lands in. */
  role: "session_dir" | "tool_path";
  sessionCwd: string | null;
  sessionProjectRoot: string | null;
}

type PathApi = Pick<typeof path, "resolve" | "relative" | "isAbsolute" | "sep">;

export function defaultTempRoots(): string[] {
  return [tmpdir(), "/tmp", "/private/tmp", "/var/folders", "/private/var/folders"];
}

/** True when `child` is `parent` or inside it, compared by path components (case-insensitive on Windows). */
export function isPathWithin(parent: string, child: string, api: PathApi = path): boolean {
  const caseInsensitive = api.sep === "\\";
  const from = api.resolve(caseInsensitive ? parent.toLowerCase() : parent);
  const to = api.resolve(caseInsensitive ? child.toLowerCase() : child);
  const relative = api.relative(from, to);
  return relative === "" || (!relative.startsWith("..") && !api.isAbsolute(relative));
}

/**
 * Decides which project a path belongs to: the nearer of a user-selected
 * folder and a git repository, otherwise (for a session folder) the folder
 * itself. Temporary and container folders never become projects.
 */
export function resolveProject(input: ResolveProjectInput, ctx: ResolverContext): ResolvedProject | null {
  if (!ctx.workspaceIsLocal || !path.isAbsolute(input.path)) return null;
  const target = lenientRealpath(input.path);
  const home = lenientRealpath(ctx.homeDir);
  if (isThrowawayLocation(target, home, ctx)) return null;

  const startDir = existingDirectory(target);
  const selected = nearestUserProject(target, ctx.userProjects);
  // A folder the user chose is a project wherever it is; otherwise tool install folders never are.
  if (!selected && isToolLocation(target, home)) return null;
  // A dependency that is its own git clone belongs to the project that contains it.
  const gitStart = startDir ? outsidePackageDirectory(startDir) : null;
  const gitRaw = gitStart ? readGitIdentity(gitStart) : null;
  const git = gitRaw && isUsableRoot(gitRaw.repoRoot, home, ctx) && !isToolLocation(gitRaw.repoRoot, home) ? gitRaw : null;

  if (selected && isUsableRoot(selected.root, home, ctx)) {
    const gitIsNearer = git && git.repoRoot.length > selected.root.length;
    if (!gitIsNearer) {
      const sameRoot = git?.repoRoot === selected.root;
      return {
        identity: sameRoot ? git!.identity : `dir:${selected.root}`,
        checkoutRoot: selected.root,
        source: "user_selected",
        displayName: selected.name
      };
    }
  }
  if (git) {
    return {
      identity: git.identity,
      checkoutRoot: git.repoRoot,
      source: "git",
      // Named after the remote repository so every checkout shows the same name.
      displayName: git.identity.startsWith("gitdir:")
        ? path.basename(git.repoRoot)
        : git.identity.split("/").at(-1)!
    };
  }

  if (input.role === "session_dir") {
    const root = startDir ?? path.dirname(target);
    if (!isUsableRoot(root, home, ctx) || hasPackageDirectory(root)) return null;
    return { identity: `dir:${root}`, checkoutRoot: root, source: "folder", displayName: path.basename(root) };
  }
  const sessionFolder = input.sessionProjectRoot ?? input.sessionCwd;
  if (sessionFolder && isPathWithin(lenientRealpath(sessionFolder), target)) {
    return resolveProject({ ...input, path: sessionFolder, role: "session_dir" }, ctx);
  }
  return null;
}

function nearestUserProject(
  target: string,
  projects: readonly L3UserProject[]
): { root: string; name: string } | null {
  let best: { root: string; name: string } | null = null;
  for (const project of projects) {
    const root = lenientRealpath(project.rootPath);
    if (isPathWithin(root, target) && (!best || root.length > best.root.length)) {
      best = { root, name: project.name };
    }
  }
  return best;
}

/** Inside a temp, Codex dated, Claude scratch, `~/.codex/memories*` or Memmy task folder. */
function isThrowawayLocation(target: string, home: string, ctx: ResolverContext): boolean {
  const roots = [
    ...(ctx.tempRoots ?? defaultTempRoots()),
    ...ctx.standaloneRoots,
    path.join(home, "Library", "Application Support", "Claude", "scratch-workspaces")
  ].map(lenientRealpath);
  if (roots.some((root) => isPathWithin(root, target))) return true;
  const relativeToHome = isPathWithin(home, target) ? path.relative(home, target).split(path.sep) : [];
  if (relativeToHome[0] === ".codex" && relativeToHome[1]?.startsWith("memories")) return true;
  if (relativeToHome[0] === "Documents" && relativeToHome[1] === "Codex" && /^\d{4}-\d{2}-\d{2}$/.test(relativeToHome[2] ?? "")) {
    return true;
  }
  return false;
}

// Temp folders (/var/folders, /tmp) are handled as throwaway locations; /etc resolves to /private/etc on macOS.
const SYSTEM_ROOTS = [
  "/usr", "/bin", "/sbin", "/etc", "/private/etc", "/System", "/Library", "/Applications",
  "/opt/homebrew", "/opt/local", "/nix"
];
const WINDOWS_TOOL_DIRS = /\\(program files( \(x86\))?|programdata|appdata)(\\|$)/i;
const PACKAGE_DIRS = new Set(["node_modules", "site-packages", "dist-packages", "vendor", "bower_components"]);

/**
 * Where tools and the system live, not projects: system and package-manager folders, Windows
 * program folders, ~/Library, and hidden folders right under home (~/.nvm, ~/.oh-my-zsh, ~/.pyenv, ...).
 * Many of these are git clones, so the git check alone would turn them into projects.
 */
function isToolLocation(target: string, home: string): boolean {
  if (WINDOWS_TOOL_DIRS.test(target)) return true;
  if (isPathWithin(home, target)) {
    const first = path.relative(home, target).split(path.sep)[0] ?? "";
    return first.startsWith(".") || first === "Library";
  }
  return SYSTEM_ROOTS.some((root) => isPathWithin(root, target, path.posix));
}

/** A root inside a dependency folder is a downloaded package, not the user's project. */
function hasPackageDirectory(root: string): boolean {
  return root.split(/[\\/]/).some((part) => PACKAGE_DIRS.has(part));
}

/** The directory just above the first dependency folder on the path, or the path itself. */
function outsidePackageDirectory(target: string): string {
  const parts = target.split(path.sep);
  const index = parts.findIndex((part) => PACKAGE_DIRS.has(part));
  return index > 0 ? parts.slice(0, index).join(path.sep) || path.sep : target;
}

/** A project root may not be the home folder, a top-level container folder, a filesystem root or a throwaway location. */
function isUsableRoot(root: string, home: string, ctx: ResolverContext): boolean {
  if (path.dirname(root) === root) return false;
  const containers = [home, ...["Desktop", "Documents", "Downloads"].map((name) => path.join(home, name))];
  if (containers.includes(root)) return false;
  return !isThrowawayLocation(root, home, ctx);
}

/** realpath that tolerates a missing tail: resolves the nearest existing ancestor and re-appends the rest. */
function lenientRealpath(target: string): string {
  const absolute = path.resolve(target);
  const missing: string[] = [];
  let current = absolute;
  for (;;) {
    try {
      const real = realpathSync(current);
      return missing.length ? path.join(real, ...missing.reverse()) : real;
    } catch {
      const parent = path.dirname(current);
      if (parent === current) return absolute;
      missing.push(path.basename(current));
      current = parent;
    }
  }
}

/** The path itself when it is a directory, otherwise its nearest existing parent directory. */
function existingDirectory(target: string): string | null {
  let current = target;
  for (;;) {
    try {
      if (existsSync(current) && statSync(current).isDirectory()) return current;
    } catch {
      // fall through to the parent
    }
    const parent = path.dirname(current);
    if (parent === current) return null;
    current = parent;
  }
}
