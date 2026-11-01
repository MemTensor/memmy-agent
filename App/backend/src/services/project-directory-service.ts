/**
 * The folder a project without a chosen directory runs its tasks in. It lives next to the project cache, so a
 * project can be created by name alone without asking for a folder first.
 */
import { randomUUID } from "node:crypto";
import { homedir } from "node:os";
import { join } from "node:path";
import { ensureDirectory, uniqueProjectDirectory } from "./project-directory.js";

export interface ProjectDirectoryService {
  /** Creates (or reuses) a managed empty folder named after the project. */
  prepareManagedDirectory(name: string): Promise<{ path: string }>;
}

export interface ProjectDirectoryServiceOptions {
  /** Root of the managed folders; defaults to `~/.memmy/local-projects`. */
  root?: string;
}

export function createProjectDirectoryService(options: ProjectDirectoryServiceOptions = {}): ProjectDirectoryService {
  const memmyHome = process.env.MEMMY_HOME?.trim() || join(homedir(), ".memmy");
  const root = options.root ?? join(memmyHome, "local-projects");
  return {
    async prepareManagedDirectory(name) {
      const target = await uniqueProjectDirectory(root, name, randomUUID());
      return { path: await ensureDirectory(target) };
    }
  };
}
