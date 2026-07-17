import path from "node:path";

export function resolveWorkspacePath(workspace: string, requested?: string | null): string {
  const base = path.resolve(workspace);
  if (!requested || requested === ".") return base;
  return path.isAbsolute(requested) ? path.resolve(requested) : path.resolve(base, requested);
}

export function isPathInside(child: string, parent: string): boolean {
  const rel = path.relative(path.resolve(parent), path.resolve(child));
  return rel === "" || (!rel.startsWith("..") && !path.isAbsolute(rel));
}

export function workspaceRelative(workspace: string, target: string): string {
  const rel = path.relative(path.resolve(workspace), path.resolve(target));
  return rel || ".";
}
