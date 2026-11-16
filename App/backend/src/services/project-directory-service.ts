/**
 * The folder a project without a chosen directory runs its tasks in. It lives next to the project cache, so a
 * project can be created by name alone without asking for a folder first.
 */
import { homedir } from "node:os";
import { join } from "node:path";
import { createProjectDirectory } from "./project-directory.js";

export interface ProjectDirectoryService {
  /** Creates a managed empty folder named after the project, numbered (`<name> 2`) when the name is taken. */
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
      return { path: await createProjectDirectory(root, name) };
    }
  };
}
