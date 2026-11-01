/** Folder names and directories a project's tasks run in, shared by the cloud and local project paths. */
import { mkdir, stat } from "node:fs/promises";
import { join } from "node:path";

/** `‹root›/<name>`, suffixed with a short id only when another project already uses that name. */
export async function uniqueProjectDirectory(root: string, name: string, projectId: string): Promise<string> {
  const base = join(root, safeProjectDirectoryName(name));
  if (!(await pathExists(base))) return base;
  return join(root, `${safeProjectDirectoryName(name)}-${projectId.replace(/[^A-Za-z0-9._-]+/gu, "_").slice(0, 8)}`);
}

/**
 * A folder name people read in a task page and the project picker, so letters in any script survive; only
 * characters a filesystem or a shell would mind are replaced.
 */
export function safeProjectDirectoryName(value: string): string {
  const cleaned = value
    .replace(/[/\\:*?"<>|\u0000-\u001f]+/gu, "_")
    .replace(/^\.+/u, "")
    .trim()
    .slice(0, 60);
  return cleaned || "project";
}

/** Creates the folder when it is missing, and refuses a path that exists as a file. */
export async function ensureDirectory(target: string): Promise<string> {
  try {
    const info = await stat(target);
    if (!info.isDirectory()) throw new Error("not a directory");
  } catch {
    await mkdir(target, { recursive: true });
  }
  return target;
}

async function pathExists(target: string): Promise<boolean> {
  try {
    await stat(target);
    return true;
  } catch {
    return false;
  }
}
