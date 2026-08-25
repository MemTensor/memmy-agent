/** Skill distribution service module. */
import { createHash } from "node:crypto";
import { readdir, readFile, stat } from "node:fs/promises";
import { join, relative } from "node:path";
import { renderMemmyDefaultSkillManifest } from "../adapters/outbound/skill-writer/templates/memmy-default.js";
import type { MemoryPluginConflict } from "../adapters/outbound/skill-writer/types.js";
import type { SkillTargetRegistry } from "../adapters/outbound/skill-writer/target-registry.js";
import { AgentSourceUnavailableError } from "./runtime-errors.js";

export interface ScannedAgentSkill {
  sourceAgentId: string;
  sourceSkillId: string;
  sourceSkillPath: string;
  sourceSkillVersion: string;
  sourceContentHash: string;
  title: string;
  content: string;
  updatedAt: string;
}

/** Contract for skill distribution service. */
export interface SkillDistributionService {
  listSkills?(sourceId: string): Promise<ScannedAgentSkill[]>;
  install(sourceId: string): Promise<void>;
  uninstall(sourceId: string): Promise<void>;
  installPlugin(sourceId: string): Promise<void>;
  uninstallPlugin(sourceId: string): Promise<void>;
  detectMemoryPluginConflicts?(): Promise<MemoryPluginConflict[]>;
}

/** Contract for create skill distribution service options. */
export interface CreateSkillDistributionServiceOptions {
  targetRegistry: SkillTargetRegistry;
}

/** Creates create skill distribution service. */
export function createSkillDistributionService(
  options: CreateSkillDistributionServiceOptions
): SkillDistributionService {
  return {
    async listSkills(sourceId) {
      const target = options.targetRegistry.get(sourceId);
      const root = await target?.resolveRootDirectory();
      if (!root) return [];

      const skillsRoot = join(root, "skills");
      const skillFiles = await findSkillFiles(skillsRoot);
      return await Promise.all(skillFiles.map(async (filePath) => {
        const content = await readFile(filePath, "utf8");
        const contentHash = createHash("sha256").update(content).digest("hex");
        const sourceSkillId = relative(skillsRoot, filePath)
          .replace(/[/\\]SKILL\.md$/i, "")
          .replaceAll("\\", "/");
        const fileStat = await stat(filePath);
        return {
          sourceAgentId: sourceId,
          sourceSkillId,
          sourceSkillPath: filePath,
          sourceSkillVersion: frontmatterValue(content, "version") ?? contentHash,
          sourceContentHash: contentHash,
          title: frontmatterValue(content, "name") ?? sourceSkillId,
          content,
          updatedAt: fileStat.mtime.toISOString()
        };
      }));
    },

    async install(sourceId) {
      const target = options.targetRegistry.require(sourceId);
      if (!(await target.resolveRootDirectory())) {
        throw new AgentSourceUnavailableError(target.displayName);
      }

      await target.install(renderMemmyDefaultSkillManifest(sourceId));
    },

    async uninstall(sourceId) {
      const target = options.targetRegistry.require(sourceId);
      await target.uninstall(sourceId);
    },

    async installPlugin(sourceId) {
      const target = options.targetRegistry.require(sourceId);
      if (!target.installPlugin) {
        throw new Error(`Native plugin installation is not supported for ${target.displayName}`);
      }
      if (!(await target.resolveRootDirectory())) {
        throw new AgentSourceUnavailableError(target.displayName);
      }

      await target.installPlugin(sourceId);
    },

    async uninstallPlugin(sourceId) {
      const target = options.targetRegistry.require(sourceId);
      if (!target.uninstallPlugin) {
        throw new Error(`Native plugin uninstallation is not supported for ${target.displayName}`);
      }

      await target.uninstallPlugin(sourceId);
      await target.uninstall(sourceId);
    },

    async detectMemoryPluginConflicts() {
      const conflicts: MemoryPluginConflict[] = [];
      for (const target of options.targetRegistry.list()) {
        const conflict = await target.detectMemoryPluginConflict?.();
        if (conflict) {
          conflicts.push(conflict);
        }
      }
      return conflicts;
    }
  };
}

async function findSkillFiles(skillsRoot: string): Promise<string[]> {
  const files: string[] = [];
  await visit(skillsRoot, 0);
  return files.sort();

  async function visit(directory: string, depth: number): Promise<void> {
    let entries;
    try {
      entries = await readdir(directory, { withFileTypes: true });
    } catch (error) {
      if (isNodeError(error) && error.code === "ENOENT") return;
      throw error;
    }

    for (const entry of entries) {
      if (entry.name === "memmy-memory" || entry.name === "node_modules" || entry.name === ".git") continue;
      const entryPath = join(directory, entry.name);
      if (entry.isFile() && entry.name.toLowerCase() === "skill.md") {
        files.push(entryPath);
      } else if (depth < 2 && (entry.isDirectory() || entry.isSymbolicLink())) {
        const entryStat = await stat(entryPath);
        if (entryStat.isDirectory()) await visit(entryPath, depth + 1);
      }
    }
  }
}

function frontmatterValue(content: string, key: string): string | undefined {
  if (!content.startsWith("---")) return undefined;
  const end = content.indexOf("\n---", 3);
  if (end < 0) return undefined;
  const match = content.slice(3, end).match(new RegExp(`^${key}:\\s*["']?([^\\n"']+)["']?\\s*$`, "im"));
  return match?.[1]?.trim();
}

function isNodeError(error: unknown): error is NodeJS.ErrnoException {
  return error instanceof Error && "code" in error;
}
