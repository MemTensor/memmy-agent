import { existsSync } from "node:fs";
import { dirname, resolve } from "node:path";

export interface CliWorkspaceNamespace {
  projectId?: string;
  workspaceId?: string;
  workspacePath?: string;
}

export function workspaceNamespaceFromOptions(options: {
  projectId?: string;
  workspaceId?: string;
  workspacePath?: string;
  noWorkspace?: boolean;
  cwd?: string;
}): CliWorkspaceNamespace {
  if (options.noWorkspace) return {};
  const explicitWorkspacePath = cleanPath(options.workspacePath);
  const workspacePath = explicitWorkspacePath ?? discoverWorkspacePath(options.cwd ?? process.cwd());
  return {
    projectId: clean(options.projectId),
    workspaceId: clean(options.workspaceId),
    workspacePath
  };
}

export function discoverWorkspacePath(cwd = process.cwd()): string | undefined {
  let current = resolve(cwd);
  for (;;) {
    if (isProjectRoot(current)) return current;
    const parent = dirname(current);
    if (parent === current) return undefined;
    current = parent;
  }
}

function isProjectRoot(path: string): boolean {
  return existsSync(`${path}/.git`) ||
    existsSync(`${path}/package.json`) ||
    existsSync(`${path}/pyproject.toml`) ||
    existsSync(`${path}/go.mod`) ||
    existsSync(`${path}/Cargo.toml`);
}

function clean(value: string | undefined): string | undefined {
  const trimmed = value?.trim();
  return trimmed || undefined;
}

function cleanPath(value: string | undefined): string | undefined {
  const trimmed = clean(value);
  return trimmed ? resolve(trimmed) : undefined;
}
