/**
 * Maps an absolute (or already relative) path into a workspace-relative path.
 * Returns null when the path is outside the workspace or names the root itself.
 */
export function toWorkspaceRelativePath(
  candidatePath: string,
  workspaceRoot: string | null | undefined
): string | null {
  const path = normalizePathSeparators(stripFileUrl(candidatePath)).replace(/\/+$/, "");
  if (!path) return null;

  if (!isAbsolutePath(path)) {
    const relative = path.replace(/^\.\/+/, "");
    return relative && relative !== "." ? relative : null;
  }

  const root = normalizePathSeparators(workspaceRoot ?? "").replace(/\/+$/, "");
  if (!root) return null;
  if (pathsEqual(path, root)) return null;

  const prefix = `${root}/`;
  if (path.startsWith(prefix) || (isWindowsPath(root) && path.toLowerCase().startsWith(prefix.toLowerCase()))) {
    const relative = path.slice(root.length + 1);
    return relative || null;
  }
  return null;
}

function stripFileUrl(value: string): string {
  const trimmed = value.trim();
  if (!/^file:/i.test(trimmed)) return trimmed;
  try {
    const url = new URL(trimmed);
    let pathname = decodeURIComponent(url.pathname);
    // Node/Chromium file URLs on Windows look like /C:/Users/...
    if (/^\/[A-Za-z]:\//.test(pathname)) pathname = pathname.slice(1);
    return pathname;
  } catch {
    return trimmed.replace(/^file:\/\//i, "");
  }
}

function normalizePathSeparators(value: string): string {
  return value.replace(/\\/g, "/");
}

function isAbsolutePath(value: string): boolean {
  return value.startsWith("/") || isWindowsPath(value);
}

function isWindowsPath(value: string): boolean {
  return /^[A-Za-z]:\//.test(value);
}

function pathsEqual(left: string, right: string): boolean {
  if (isWindowsPath(left) || isWindowsPath(right)) {
    return left.toLowerCase() === right.toLowerCase();
  }
  return left === right;
}
