/** Skill distribution service module. */
import { renderMemmyDefaultSkillManifest } from "../adapters/outbound/skill-writer/templates/memmy-default.js";
import type { MemoryPluginConflict } from "../adapters/outbound/skill-writer/types.js";
import type { SkillTargetRegistry } from "../adapters/outbound/skill-writer/target-registry.js";
import { AgentSourceUnavailableError } from "./runtime-errors.js";

/** Contract for skill distribution service. */
export interface SkillDistributionService {
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
