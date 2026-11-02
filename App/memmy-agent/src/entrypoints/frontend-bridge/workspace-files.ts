import fs from "node:fs";
import path from "node:path";

const DEFAULT_MAX_ENTRIES = 500;
const MAX_RELATIVE_PATH_LENGTH = 4_096;
const DEFAULT_MAX_PREVIEW_BYTES = 100 * 1024 * 1024;

export type WorkspaceFilesRootKind = "project" | "task";
export type WorkspaceFileEntryKind = "directory" | "file";

export type WorkspaceFileEntry = {
  name: string;
  path: string;
  kind: WorkspaceFileEntryKind;
  size: number | null;
  modifiedAt: string | null;
};

export type WorkspaceFilesListing = {
  root: {
    kind: WorkspaceFilesRootKind;
    label: string;
  };
  path: string;
  entries: WorkspaceFileEntry[];
  truncated: boolean;
};

export type WorkspaceFileLocation = {
  path: string;
  absolutePath: string;
  name: string;
  size: number;
  modifiedAt: string | null;
};

export type WorkspaceFileContent = WorkspaceFileLocation & {
  body: Buffer;
};

export class WorkspaceFilesError extends Error {
  readonly code: string;
  readonly status: number;

  constructor(code: string, status: number) {
    super(code);
    this.name = "WorkspaceFilesError";
    this.code = code;
    this.status = status;
  }
}

type WorkspaceFilesListOptions = {
  rootKind: WorkspaceFilesRootKind;
  rootLabel: string;
  relativePath?: string | null;
  maxEntries?: number;
};

function apiPath(parts: string[]): string {
  return parts.join("/");
}

function relativePathParts(value: string | null | undefined): string[] {
  const raw = value ?? "";
  if (
    typeof raw !== "string"
    || raw.length > MAX_RELATIVE_PATH_LENGTH
    || raw.includes("\0")
    || raw.includes("\\")
    || path.isAbsolute(raw)
    || path.posix.isAbsolute(raw)
    || path.win32.isAbsolute(raw)
  ) {
    throw new WorkspaceFilesError("workspace_files_path_invalid", 400);
  }
  if (!raw || raw === ".") return [];
  const parts = raw.split("/");
  if (parts.some((part) => !part || part === "." || part === "..")) {
    throw new WorkspaceFilesError("workspace_files_path_invalid", 400);
  }
  return parts;
}

function isContainedPath(root: string, candidate: string): boolean {
  const rel = path.relative(root, candidate);
  return rel === "" || (!rel.startsWith(`..${path.sep}`) && rel !== ".." && !path.isAbsolute(rel));
}

function canonicalRoot(rootPath: string): string {
  try {
    const rootLstat = fs.lstatSync(rootPath);
    if (rootLstat.isSymbolicLink() || !rootLstat.isDirectory()) {
      throw new WorkspaceFilesError("workspace_files_root_unavailable", 422);
    }
    return fs.realpathSync(rootPath);
  } catch (error) {
    if (error instanceof WorkspaceFilesError) throw error;
    throw new WorkspaceFilesError("workspace_files_root_unavailable", 422);
  }
}

function resolveDirectory(root: string, parts: string[]): string {
  let current = root;
  for (const part of parts) {
    current = path.join(current, part);
    let entry: fs.Stats;
    try {
      entry = fs.lstatSync(current);
    } catch {
      throw new WorkspaceFilesError("workspace_files_directory_not_found", 404);
    }
    if (entry.isSymbolicLink()) {
      throw new WorkspaceFilesError("workspace_files_symlink_not_expandable", 400);
    }
    if (!entry.isDirectory()) {
      throw new WorkspaceFilesError("workspace_files_directory_not_found", 404);
    }
  }
  let canonical: string;
  try {
    canonical = fs.realpathSync(current);
  } catch {
    throw new WorkspaceFilesError("workspace_files_directory_not_found", 404);
  }
  if (!isContainedPath(root, canonical)) {
    throw new WorkspaceFilesError("workspace_files_path_invalid", 400);
  }
  return canonical;
}

function entryKind(entry: fs.Dirent): WorkspaceFileEntryKind | null {
  if (entry.isDirectory()) return "directory";
  if (entry.isFile()) return "file";
  return null;
}

function compareEntries(left: WorkspaceFileEntry, right: WorkspaceFileEntry): number {
  const order: Record<WorkspaceFileEntryKind, number> = {
    directory: 0,
    file: 1,
  };
  return order[left.kind] - order[right.kind]
    || left.name.localeCompare(right.name, undefined, { numeric: true, sensitivity: "base" });
}

export function listWorkspaceFiles(
  rootPath: string,
  options: WorkspaceFilesListOptions,
): WorkspaceFilesListing {
  const root = canonicalRoot(rootPath);
  const parts = relativePathParts(options.relativePath);
  const directory = resolveDirectory(root, parts);
  const maxEntries = Number.isInteger(options.maxEntries) && Number(options.maxEntries) > 0
    ? Number(options.maxEntries)
    : DEFAULT_MAX_ENTRIES;
  let directoryEntries: fs.Dirent[];
  try {
    directoryEntries = fs.readdirSync(directory, { withFileTypes: true });
  } catch {
    throw new WorkspaceFilesError("workspace_files_directory_unavailable", 403);
  }

  const entries: WorkspaceFileEntry[] = [];
  for (const directoryEntry of directoryEntries) {
    const kind = entryKind(directoryEntry);
    if (!kind) continue;
    const entryParts = [...parts, directoryEntry.name];
    const candidate = path.join(directory, directoryEntry.name);
    let metadata: fs.Stats;
    try {
      metadata = fs.lstatSync(candidate);
    } catch {
      // The entry may disappear between readdir and lstat. Keep the listing stable by skipping it.
      continue;
    }
    entries.push({
      name: directoryEntry.name,
      path: apiPath(entryParts),
      kind,
      size: kind === "file" ? metadata.size : null,
      modifiedAt: Number.isFinite(metadata.mtimeMs) ? metadata.mtime.toISOString() : null,
    });
  }
  entries.sort(compareEntries);

  return {
    root: {
      kind: options.rootKind,
      label: options.rootLabel,
    },
    path: apiPath(parts),
    entries: entries.slice(0, maxEntries),
    truncated: entries.length > maxEntries,
  };
}

/**
 * Resolves one regular file below a workspace root without following symlinks.
 *
 * The same relative-path grammar as directory listings is used so callers
 * cannot switch to an absolute path or escape the selected project/task root.
 */
export function resolveWorkspaceFile(
  rootPath: string,
  relativePath: string,
): WorkspaceFileLocation {
  const root = canonicalRoot(rootPath);
  const parts = relativePathParts(relativePath);
  if (!parts.length) {
    throw new WorkspaceFilesError("workspace_file_not_found", 404);
  }

  let candidate = root;
  let metadata: fs.Stats | null = null;
  for (const part of parts) {
    candidate = path.join(candidate, part);
    try {
      metadata = fs.lstatSync(candidate);
    } catch {
      throw new WorkspaceFilesError("workspace_file_not_found", 404);
    }
    if (metadata.isSymbolicLink()) {
      throw new WorkspaceFilesError("workspace_files_symlink_not_expandable", 400);
    }
  }

  if (!metadata?.isFile()) {
    throw new WorkspaceFilesError("workspace_file_not_found", 404);
  }

  let canonical: string;
  try {
    canonical = fs.realpathSync(candidate);
  } catch {
    throw new WorkspaceFilesError("workspace_file_not_found", 404);
  }
  if (!isContainedPath(root, canonical)) {
    throw new WorkspaceFilesError("workspace_files_path_invalid", 400);
  }
  return {
    path: apiPath(parts),
    absolutePath: canonical,
    name: parts.at(-1) ?? path.basename(canonical),
    size: metadata.size,
    modifiedAt: Number.isFinite(metadata.mtimeMs) ? metadata.mtime.toISOString() : null,
  };
}

/** Reads one resolved workspace file while enforcing the preview byte limit. */
export function readWorkspaceFile(
  rootPath: string,
  relativePath: string,
  maxBytes = DEFAULT_MAX_PREVIEW_BYTES,
): WorkspaceFileContent {
  const file = resolveWorkspaceFile(rootPath, relativePath);
  if (!Number.isInteger(maxBytes) || maxBytes <= 0 || file.size > maxBytes) {
    throw new WorkspaceFilesError("workspace_file_too_large", 413);
  }
  try {
    const body = fs.readFileSync(file.absolutePath);
    // Re-check after reading to close the lstat/read race if the file grew.
    if (body.byteLength > maxBytes) {
      throw new WorkspaceFilesError("workspace_file_too_large", 413);
    }
    return { ...file, size: body.byteLength, body };
  } catch (error) {
    if (error instanceof WorkspaceFilesError) throw error;
    throw new WorkspaceFilesError("workspace_file_unavailable", 403);
  }
}
