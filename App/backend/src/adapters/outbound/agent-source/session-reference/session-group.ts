/**
 * Groups local sessions the way each agent organizes them, so a person can associate a whole group with an online
 * project: Codex projects, Cursor workspaces, WorkBuddy workspaces, and the working directory everywhere else.
 */
import { readdirSync, readFileSync } from "node:fs";
import { basename, dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { DatabaseSync } from "node:sqlite";
import type { SourceAdapter } from "../types.js";

/** The organizing unit a session belongs to. Sessions outside every unit have no group. */
export interface LocalSessionGroup {
  /** Stable within one agent: a project ID or a directory path. */
  id: string;
  label: string;
  /** Full directory or workspace file, shown on hover; null for units that span several directories. */
  path: string | null;
}

/** Decides each session's group for one agent; built once per scan. */
export type SessionGrouper = (session: { workspacePath: string | null; conversationId: string }) => LocalSessionGroup | null;

export interface CodexProject {
  id: string;
  name: string;
  roots: string[];
}

/** WorkBuddy runs one-off tasks in ~/WorkBuddy/<date-time>; they are not a workspace. */
const WORKBUDDY_PLAYGROUND = /\/WorkBuddy\/\d{4}-\d{2}-\d{2}-\d{2}-\d{2}-\d{2}\/?$/u;
const CODE_WORKSPACE_SUFFIX = ".code-workspace";
/** Cursor's id for chats opened without a folder. */
const CURSOR_EMPTY_WINDOW = "empty-window";

/** Returns the grouping rule for an agent. A store that cannot be read falls back to grouping by directory. */
export function createSessionGrouper(adapter: SourceAdapter): SessionGrouper {
  const directory = createDirectoryResolver();
  switch (adapter.descriptor.sourceId) {
    case "codex": {
      const projects = readCodexProjects(dirname(adapter.descriptor.dataPath));
      return ({ workspacePath }) => {
        const path = directory(workspacePath);
        return projects ? codexProjectGroup(projects, path) : directoryGroup(path);
      };
    }
    case "workbuddy":
      return ({ workspacePath }) => (workspacePath && WORKBUDDY_PLAYGROUND.test(workspacePath) ? null : directoryGroup(directory(workspacePath)));
    case "cursor": {
      // Chats in Cursor's global store carry no folder; their header names the workspace they were opened in.
      const workspaceOf = readCursorWorkspaces(adapter.descriptor.dataPath);
      return ({ workspacePath, conversationId }) => cursorWorkspaceGroup(workspacePath ?? workspaceOf(conversationId));
    }
    default:
      return ({ workspacePath }) => directoryGroup(directory(workspacePath));
  }
}

/** One group per working directory, named after the folder. */
export function directoryGroup(path: string | null): LocalSessionGroup | null {
  const trimmed = path?.replace(/\/+$/u, "");
  if (!trimmed) {
    return null;
  }
  return { id: trimmed, label: basename(trimmed) || trimmed, path: trimmed };
}

/** Cursor 3 saves multi-folder workspaces as <name>.code-workspace; the name is what Cursor shows. */
export function cursorWorkspaceGroup(path: string | null): LocalSessionGroup | null {
  const group = directoryGroup(path);
  if (group?.label.endsWith(CODE_WORKSPACE_SUFFIX)) {
    return { ...group, label: group.label.slice(0, -CODE_WORKSPACE_SUFFIX.length) };
  }
  return group;
}

/** The project whose root contains the directory; the longest root wins when projects nest. */
export function codexProjectGroup(projects: readonly CodexProject[], path: string | null): LocalSessionGroup | null {
  if (!path) {
    return null;
  }
  let best: { project: CodexProject; length: number } | null = null;
  for (const project of projects) {
    for (const root of project.roots) {
      const base = root.replace(/\/+$/u, "");
      if ((path === base || path.startsWith(`${base}/`)) && base.length > (best?.length ?? -1)) {
        best = { project, length: base.length };
      }
    }
  }
  return best ? { id: best.project.id, label: best.project.name, path: null } : null;
}

/** The main checkout of a git worktree, read from the `gitdir: <repo>/.git/worktrees/<name>` line in its .git file. */
export function mainCheckoutOf(gitFileContent: string): string | null {
  const gitdir = /^gitdir:\s*(.+?)\s*$/mu.exec(gitFileContent)?.[1];
  const match = gitdir ? /^(.*)\/\.git\/worktrees\/[^/]+\/?$/u.exec(gitdir) : null;
  return match?.[1] || null;
}

/**
 * Agents run tasks in git worktrees (WorkBuddy, Claude Code, Codex); those belong with the repository they were
 * created from, not one group per worktree.
 */
function createDirectoryResolver(): (path: string | null) => string | null {
  const resolved = new Map<string, string>();
  return (path) => {
    if (!path) {
      return null;
    }
    let main = resolved.get(path);
    if (main === undefined) {
      try {
        main = mainCheckoutOf(readFileSync(join(path, ".git"), "utf8")) ?? path;
      } catch {
        main = path;
      }
      resolved.set(path, main);
    }
    return main;
  };
}

/** Maps a Cursor chat to the folder or .code-workspace file of the workspace it belongs to, read-only. */
function readCursorWorkspaces(workspaceStorage: string): (conversationId: string) => string | null {
  const workspaceIds = new Map<string, string>();
  let db: DatabaseSync | null = null;
  try {
    db = new DatabaseSync(join(dirname(workspaceStorage), "globalStorage", "state.vscdb"), { readOnly: true });
    const rows = db.prepare("SELECT composerId, workspaceId FROM composerHeaders WHERE isSubagent = 0").all() as unknown as Array<{ composerId: string; workspaceId: string | null }>;
    for (const row of rows) {
      if (row.workspaceId && row.workspaceId !== CURSOR_EMPTY_WINDOW) workspaceIds.set(row.composerId, row.workspaceId);
    }
  } catch {
    // No global store, or a format this version does not know: those chats stay outside every workspace.
  } finally {
    db?.close();
  }
  const paths = new Map<string, string | null>();
  return (conversationId) => {
    const workspaceId = workspaceIds.get(conversationId);
    if (!workspaceId) {
      return null;
    }
    if (!paths.has(workspaceId)) {
      paths.set(workspaceId, readCursorWorkspacePath(join(workspaceStorage, workspaceId)));
    }
    return paths.get(workspaceId) ?? null;
  };
}

function readCursorWorkspacePath(storagePath: string): string | null {
  try {
    const parsed = JSON.parse(readFileSync(join(storagePath, "workspace.json"), "utf8")) as { folder?: unknown; workspace?: unknown };
    const value = typeof parsed.folder === "string" ? parsed.folder : typeof parsed.workspace === "string" ? parsed.workspace : null;
    if (!value) {
      return null;
    }
    return value.startsWith("file://") ? fileURLToPath(value) : value;
  } catch {
    return null;
  }
}

/** Reads Codex projects from the newest state database, read-only; null when there is none. */
export function readCodexProjects(codexHome: string): CodexProject[] | null {
  let db: DatabaseSync | null = null;
  try {
    const file = readdirSync(codexHome)
      .map((name) => ({ name, version: Number(/^state_(\d+)\.sqlite$/u.exec(name)?.[1] ?? Number.NaN) }))
      .filter((entry) => Number.isFinite(entry.version))
      .sort((left, right) => right.version - left.version)[0];
    if (!file) {
      return null;
    }
    db = new DatabaseSync(join(codexHome, file.name), { readOnly: true });
    const rows = db.prepare(
      "SELECT p.id AS id, p.name AS name, r.path AS path FROM projects p JOIN project_roots r ON r.project_id = p.id ORDER BY p.position, r.position"
    ).all() as unknown as Array<{ id: string; name: string; path: string }>;
    const projects = new Map<string, CodexProject>();
    for (const row of rows) {
      const project = projects.get(row.id) ?? { id: row.id, name: row.name, roots: [] };
      project.roots.push(row.path);
      projects.set(row.id, project);
    }
    return [...projects.values()];
  } catch {
    return null;
  } finally {
    db?.close();
  }
}

/**
 * The folders a multi-root Cursor workspace covers. Paths inside a .code-workspace file are usually relative to
 * the file, so they are resolved here; a file that cannot be read covers nothing.
 */
export function readWorkspaceRoots(workspaceFile: string): string[] {
  try {
    const parsed = JSON.parse(readFileSync(workspaceFile, "utf8")) as { folders?: Array<{ path?: unknown }> };
    const roots: string[] = [];
    for (const folder of parsed.folders ?? []) {
      const value = typeof folder?.path === "string" ? folder.path : null;
      if (!value) continue;
      const resolved = value.startsWith("/") || /^[A-Za-z]:[\\/]/u.test(value) ? value : join(dirname(workspaceFile), value);
      roots.push(resolved.replace(/\/+$/u, ""));
    }
    return roots;
  } catch {
    return [];
  }
}
