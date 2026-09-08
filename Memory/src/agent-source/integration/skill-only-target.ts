import { readFile, stat } from "node:fs/promises";
import { join } from "node:path";
import { removeMemmySkillDirectory, replaceMemmySkillDirectory } from "./skill-directory.js";
import type { SkillTarget } from "./types.js";

export function createSkillOnlyTarget(input: {
  targetId: string;
  displayName: string;
  rootDirectory: string;
}): SkillTarget {
  return {
    targetId: input.targetId,
    displayName: input.displayName,
    async resolveRootDirectory() {
      try {
        return (await stat(input.rootDirectory)).isDirectory() ? input.rootDirectory : null;
      } catch (error) {
        if (isNodeError(error) && error.code === "ENOENT") return null;
        throw error;
      }
    },
    async install(manifest) {
      const root = await this.resolveRootDirectory();
      if (!root) {
        throw new Error(`${input.displayName} is not installed or its directory is unavailable`);
      }
      await replaceMemmySkillDirectory(root, manifest);
    },
    async uninstall() {
      const root = await this.resolveRootDirectory();
      if (root) await removeMemmySkillDirectory(root);
    },
    async isInstalled() {
      const root = await this.resolveRootDirectory();
      if (!root) return false;
      const content = await readTextFile(join(root, "skills", "memmy-memory", "SKILL.md"));
      return content.includes("name: memmy-memory") && content.includes("## Agent Loop");
    }
  };
}

async function readTextFile(filePath: string): Promise<string> {
  try {
    return await readFile(filePath, "utf8");
  } catch (error) {
    if (isNodeError(error) && error.code === "ENOENT") return "";
    throw error;
  }
}

function isNodeError(error: unknown): error is NodeJS.ErrnoException {
  return error instanceof Error && "code" in error;
}
