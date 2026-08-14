import { resolveQwenworkHomeDirectory } from "../../agent-paths.js";
import { createSkillOnlyTarget } from "../skill-only-target.js";
import type { SkillTarget } from "../types.js";

export interface CreateQwenworkSkillTargetDeps {
  rootDirectory?: string;
}

export function createQwenworkSkillTarget(deps: CreateQwenworkSkillTargetDeps = {}): SkillTarget {
  return createSkillOnlyTarget({
    targetId: "qwenwork",
    displayName: "QwenWork",
    rootDirectory: deps.rootDirectory ?? resolveQwenworkHomeDirectory()
  });
}
