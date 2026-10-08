import type { Dirent } from "node:fs";
import { lstat, readdir, realpath, stat, writeFile } from "node:fs/promises";
import { dirname, isAbsolute, join, relative, resolve, sep } from "node:path";
import type { DesktopWorkspaceDirectoryResult } from "@memmy/desktop-interface";

const MAX_DIRECTORY_ENTRIES = 500;
const MAX_WORKSPACE_TEXT_BYTES = 2 * 1024 * 1024;
const HIDDEN_WORKSPACE_DIRECTORIES = new Set([".git", ".hg", ".svn", ".memmy", "node_modules"]);
const HIDDEN_WORKSPACE_FILES = new Set([".DS_Store"]);
const AGENT_HOME_INTERNAL_ENTRIES = new Set([
  ".memmy-migrations",
  "AGENTS.md",
  "HEARTBEAT.md",
  "SOUL.md",
  "USER.md",
  "cron",
  "memory",
  "sessions",
  "skills",
]);

type WorkspaceEntryKind = "directory" | "file";

export async function readWorkspaceDirectory(
  rootPath: string,
  relativePath = "",
  options: { agentHomePath?: string | null } = {},
): Promise<DesktopWorkspaceDirectoryResult> {
  if (typeof rootPath !== "string" || !rootPath.trim() || !isAbsolute(rootPath)) {
    throw new Error("workspace root must be an absolute path");
  }

  const normalizedRelativePath = normalizeRelativePath(relativePath);
  const resolvedRoot = await realpath(rootPath);
  if (dirname(resolvedRoot) === resolvedRoot) {
    throw new Error("workspace root cannot be a filesystem root");
  }
  const rootStats = await stat(resolvedRoot);
  if (!rootStats.isDirectory()) {
    throw new Error("workspace root is not a directory");
  }

  const requestedPath = resolve(resolvedRoot, normalizedRelativePath);
  const resolvedRequestedPath = await realpath(requestedPath);
  if (!isPathInsideRoot(resolvedRoot, resolvedRequestedPath)) {
    throw new Error("workspace directory escapes its root");
  }
  const requestedStats = await stat(resolvedRequestedPath);
  if (!requestedStats.isDirectory()) {
    throw new Error("workspace path is not a directory");
  }

  const hideAgentInternals = !normalizedRelativePath && await isSameDirectory(resolvedRoot, options.agentHomePath);
  const dirents = await readdir(resolvedRequestedPath, { withFileTypes: true });
  const visibleEntries = (await Promise.all(dirents.map(async (entry) => {
    if (hideAgentInternals && AGENT_HOME_INTERNAL_ENTRIES.has(entry.name)) return null;
    const kind = await workspaceEntryKind(resolvedRoot, join(resolvedRequestedPath, entry.name), entry);
    return kind && !shouldHideWorkspaceEntry(entry.name, kind) ? { name: entry.name, kind } : null;
  })))
    .filter((entry): entry is { name: string; kind: WorkspaceEntryKind } => entry !== null)
    .sort((left, right) => {
      const directoryRank = Number(right.kind === "directory") - Number(left.kind === "directory");
      return directoryRank || left.name.localeCompare(right.name, undefined, { sensitivity: "base", numeric: true });
    });
  const entryPrefix = normalizedRelativePath ? `${normalizedRelativePath.replace(/\\/gu, "/")}/` : "";
  const entries = visibleEntries.slice(0, MAX_DIRECTORY_ENTRIES).map((entry) => ({
    name: entry.name,
    path: join(resolvedRequestedPath, entry.name),
    relativePath: `${entryPrefix}${entry.name}`,
    kind: entry.kind,
  }));

  return {
    rootPath: resolvedRoot,
    relativePath: normalizedRelativePath.replace(/\\/gu, "/"),
    entries,
    truncated: visibleEntries.length > MAX_DIRECTORY_ENTRIES,
  };
}

export async function writeWorkspaceTextFile(
  rootPath: string,
  filePath: string,
  contents: string,
  options: { agentHomePath?: string | null } = {},
): Promise<void> {
  if (typeof contents !== "string") throw new Error("workspace file contents must be a string");
  if (Buffer.byteLength(contents, "utf8") > MAX_WORKSPACE_TEXT_BYTES) throw new Error("workspace file is too large");
  if (typeof rootPath !== "string" || !rootPath.trim() || !isAbsolute(rootPath)) {
    throw new Error("workspace root must be an absolute path");
  }
  if (typeof filePath !== "string" || !filePath.trim() || !isAbsolute(filePath)) {
    throw new Error("workspace file must be an absolute path");
  }

  const resolvedRoot = await realpath(rootPath);
  if (dirname(resolvedRoot) === resolvedRoot) throw new Error("workspace root cannot be a filesystem root");
  const rootStats = await stat(resolvedRoot);
  if (!rootStats.isDirectory()) throw new Error("workspace root is not a directory");

  let canonicalFile: string;
  try {
    const linked = await lstat(filePath);
    if (!linked.isFile() && !linked.isSymbolicLink()) throw new Error("workspace path is not a file");
    canonicalFile = await realpath(filePath);
  } catch (error) {
    if (error instanceof Error && error.message === "workspace path is not a file") throw error;
    throw new Error("workspace file is not available");
  }
  if (!isPathInsideRoot(resolvedRoot, canonicalFile)) throw new Error("workspace file escapes its root");
  const fileStats = await stat(canonicalFile);
  if (!fileStats.isFile()) throw new Error("workspace path is not a file");
  if (await isProtectedWorkspaceFile(resolvedRoot, canonicalFile, options.agentHomePath)) {
    throw new Error("workspace file is not editable");
  }

  await writeFile(canonicalFile, contents, "utf8");
}

async function workspaceEntryKind(rootPath: string, entryPath: string, entry: Dirent): Promise<WorkspaceEntryKind | null> {
  if (entry.isDirectory()) return "directory";
  if (entry.isFile()) return "file";
  if (!entry.isSymbolicLink()) return null;
  try {
    const target = await realpath(entryPath);
    if (!isPathInsideRoot(rootPath, target)) return null;
    const targetStats = await stat(target);
    if (targetStats.isDirectory()) return "directory";
    return targetStats.isFile() ? "file" : null;
  } catch {
    return null;
  }
}

function normalizeRelativePath(value: string): string {
  if (typeof value !== "string") throw new Error("workspace relative path must be a string");
  const parts = value.split(/[\\/]+/u).filter((part) => part && part !== ".");
  if (parts.some((part) => part === "..") || isAbsolute(value)) {
    throw new Error("workspace relative path is invalid");
  }
  return parts.join(sep);
}

function isPathInsideRoot(rootPath: string, candidatePath: string): boolean {
  const relativePath = relative(rootPath, candidatePath);
  return relativePath === ""
    || (!relativePath.startsWith(`..${sep}`) && relativePath !== ".." && !isAbsolute(relativePath));
}

function shouldHideWorkspaceEntry(name: string, kind: WorkspaceEntryKind): boolean {
  return kind === "directory" ? HIDDEN_WORKSPACE_DIRECTORIES.has(name) : HIDDEN_WORKSPACE_FILES.has(name);
}

async function isProtectedWorkspaceFile(
  resolvedRoot: string,
  canonicalFile: string,
  agentHomePath: string | null | undefined,
): Promise<boolean> {
  const segments = relative(resolvedRoot, canonicalFile).split(sep).filter(Boolean);
  if (segments.some((segment) => HIDDEN_WORKSPACE_DIRECTORIES.has(segment))) return true;
  if (segments.length !== 1 || !await isSameDirectory(resolvedRoot, agentHomePath)) return false;
  return AGENT_HOME_INTERNAL_ENTRIES.has(segments[0] ?? "");
}

async function isSameDirectory(resolvedRoot: string, candidate: string | null | undefined): Promise<boolean> {
  if (!candidate || !isAbsolute(candidate)) return false;
  try {
    return await realpath(candidate) === resolvedRoot;
  } catch {
    return false;
  }
}
