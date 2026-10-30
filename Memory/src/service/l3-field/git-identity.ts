import { existsSync, readFileSync, realpathSync, statSync } from "node:fs";
import path from "node:path";

export interface GitIdentity {
  /** Working-tree root of this checkout (main clone or linked worktree). */
  repoRoot: string;
  /** Git directory shared by every worktree of the clone. */
  commonDir: string;
  /** Normalized origin URL, or `gitdir:<commonDir>` when there is no usable origin. */
  identity: string;
}

/**
 * Finds the repository containing `startDir` by reading files only (no git
 * process). include/includeIf/insteadOf are not resolved; when origin cannot
 * be read the clone is identified by its common git directory, so worktrees
 * of one clone still match but separate clones do not.
 */
export function readGitIdentity(startDir: string): GitIdentity | null {
  let current = startDir;
  for (;;) {
    const located = locateGitDir(current);
    if (located) {
      const commonDir = safeRealpath(readCommonDir(located.gitDir));
      const origin = readOriginUrl(commonDir);
      const normalized = origin ? normalizeRemoteUrl(origin) : null;
      return {
        repoRoot: current,
        commonDir,
        identity: normalized ?? `gitdir:${commonDir}`
      };
    }
    const parent = path.dirname(current);
    if (parent === current) return null;
    current = parent;
  }
}

/** Maps ssh, scp-like and http(s) remotes to `host[:port]/path`; local remotes return null. */
export function normalizeRemoteUrl(url: string): string | null {
  const trimmed = url.trim();
  if (!trimmed || trimmed.startsWith("/") || /^[A-Za-z]:[\\/]/.test(trimmed) || trimmed.startsWith("file:")) {
    return null;
  }
  let host: string;
  let port = "";
  let repoPath: string;
  const scpLike = /^(?:[^@/]+@)?([^:/]+):(?!\/\/)(.+)$/.exec(trimmed);
  if (/^[a-z][a-z0-9+.-]*:\/\//i.test(trimmed)) {
    let parsed: URL;
    try {
      parsed = new URL(trimmed);
    } catch {
      return null;
    }
    if (!parsed.hostname) return null;
    host = parsed.hostname;
    port = parsed.port;
    repoPath = decodeURIComponent(parsed.pathname);
  } else if (scpLike) {
    host = scpLike[1]!;
    repoPath = scpLike[2]!;
  } else {
    return null;
  }
  const cleanedPath = repoPath
    .replace(/^\/+/, "")
    .replace(/\/+$/, "")
    .replace(/\.git$/i, "")
    .toLowerCase();
  if (!cleanedPath) return null;
  return `${host.toLowerCase()}${port ? `:${port}` : ""}/${cleanedPath}`;
}

function locateGitDir(dir: string): { gitDir: string } | null {
  const dotGit = path.join(dir, ".git");
  if (!existsSync(dotGit)) return null;
  try {
    if (statSync(dotGit).isDirectory()) return { gitDir: dotGit };
    const match = /^gitdir:\s*(.+)$/m.exec(readFileSync(dotGit, "utf8"));
    if (!match) return null;
    return { gitDir: path.resolve(dir, match[1]!.trim()) };
  } catch {
    return null;
  }
}

function readCommonDir(gitDir: string): string {
  try {
    const relative = readFileSync(path.join(gitDir, "commondir"), "utf8").trim();
    return relative ? path.resolve(gitDir, relative) : gitDir;
  } catch {
    return gitDir;
  }
}

function readOriginUrl(commonDir: string): string | null {
  let text: string;
  try {
    text = readFileSync(path.join(commonDir, "config"), "utf8");
  } catch {
    return null;
  }
  let inOrigin = false;
  for (const rawLine of text.split(/\r?\n/)) {
    const line = rawLine.trim();
    if (line.startsWith("[")) {
      inOrigin = /^\[remote\s+"origin"\]$/i.test(line);
      continue;
    }
    if (!inOrigin) continue;
    const match = /^url\s*=\s*(.+)$/i.exec(line);
    if (match) return match[1]!.trim().replace(/^"(.*)"$/, "$1");
  }
  return null;
}

function safeRealpath(target: string): string {
  try {
    return realpathSync(target);
  } catch {
    return target;
  }
}
