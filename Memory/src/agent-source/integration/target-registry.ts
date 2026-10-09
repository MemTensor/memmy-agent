/** Target registry module. */
import type { SkillTarget } from "./types.js";

/** Contract for skill target registry. */
export interface SkillTargetRegistry {
  list(): readonly SkillTarget[];
  get(targetId: string): SkillTarget | undefined;
  require(targetId: string): SkillTarget;
}

/** Creates create skill target registry. */
export function createSkillTargetRegistry(targets: readonly SkillTarget[]): SkillTargetRegistry {
  const targetMap = new Map(targets.map((target) => [target.targetId, target]));

  return Object.freeze({
    list() {
      return [...targetMap.values()];
    },

    get(targetId: string) {
      return targetMap.get(targetId);
    },

    require(targetId: string) {
      const target = targetMap.get(targetId);
      if (!target) {
        throw new Error(`Unknown skill target: ${targetId}`);
      }

      return target;
    }
  });
}
