/** Skill distribution service module. */
import { createHash } from "node:crypto";
import { readdir, readFile, stat } from "node:fs/promises";
import { join, relative } from "node:path";
import {
  isMemmyProjectSkillDirectoryCurrent,
  isMemmySkillDirectoryCurrent,
  readInstalledSkillKind,
  replaceMemmyProjectSkillDirectory,
  replaceMemmySkillDirectory
} from "../adapters/outbound/skill-writer/skill-directory.js";
import { renderMemmyDefaultSkillManifest } from "../adapters/outbound/skill-writer/templates/memmy-default.js";
import { renderMemmyPluginSkillManifest } from "../adapters/outbound/skill-writer/templates/memmy-plugin.js";
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
  isInstalledHookCurrent?(sourceId: string): Promise<boolean>;
  detectMemoryPluginConflicts?(): Promise<MemoryPluginConflict[]>;
  /**
   * Rewrites the Memmy skill an agent already has when this build ships different instructions. The installed
   * file decides which variant to keep, so an agent whose connection status was lost is still refreshed.
   * Returns whether anything was written.
   */
  refreshInstalledSkill(sourceId: string, mode?: "skill" | "plugin"): Promise<boolean>;
  /**
   * Writes the `memmy-project` skill into every agent home that already exists. A new install has no
   * memory skill yet, and auto-inject is off unless the person turns it on, so this is what puts the
   * project skill on disk after the app is installed.
   */
  ensureProjectSkills(): Promise<string[]>;
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

    async isInstalledHookCurrent(sourceId) {
      const target = options.targetRegistry.get(sourceId);
      if (!target?.isInstalledHookCurrent) return true;
      return target.isInstalledHookCurrent();
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
    },

    async refreshInstalledSkill(sourceId, mode) {
      const target = options.targetRegistry.get(sourceId);
      if (!target) return false;
      const root = await target.resolveRootDirectory();
      if (!root) return false;

      // A skill on disk is what Memmy installed before; only its variant is inferred from its own text.
      const installed = await readInstalledSkillKind(root);
      if (!installed) return false;
      const kind = mode ?? installed;
      if (kind === "plugin" && !target.installPlugin) return false;

      const manifest = kind === "plugin"
        ? renderMemmyPluginSkillManifest(sourceId)
        : renderMemmyDefaultSkillManifest(sourceId);
      const memoryCurrent = await isMemmySkillDirectoryCurrent(root, manifest);
      if (memoryCurrent && await isMemmyProjectSkillDirectoryCurrent(root, sourceId)) return false;

      if (!memoryCurrent) {
        if (kind === "plugin") await target.installPlugin!(sourceId);
        // Skill-only agents get the skill directory alone: their instructions file must not gain memory guidance.
        else await replaceMemmySkillDirectory(root, manifest);
      }
      // The project skill is installed with the memory skill; an agent connected before it existed gets it here.
      if (!(await isMemmyProjectSkillDirectoryCurrent(root, sourceId))) await replaceMemmyProjectSkillDirectory(root, sourceId);
      return true;
    },

    async ensureProjectSkills() {
      const written: string[] = [];
      for (const target of options.targetRegistry.list()) {
        const root = await target.resolveRootDirectory();
        if (!root || !(await directoryExists(root))) continue;
        if (await isMemmyProjectSkillDirectoryCurrent(root, target.targetId)) continue;
        await replaceMemmyProjectSkillDirectory(root, target.targetId);
        written.push(target.targetId);
      }
      return written;
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
        let entryStat;
        try {
          entryStat = await stat(entryPath);
        } catch (error) {
          if (isNodeError(error) && error.code === "ENOENT") continue;
          throw error;
        }
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

async function directoryExists(path: string): Promise<boolean> {
  try {
    return (await stat(path)).isDirectory();
  } catch (error) {
    if (isNodeError(error) && error.code === "ENOENT") return false;
    throw error;
  }
}

function isNodeError(error: unknown): error is NodeJS.ErrnoException {
  return error instanceof Error && "code" in error;
}
