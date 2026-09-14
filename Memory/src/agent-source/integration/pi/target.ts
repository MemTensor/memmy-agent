import { resolvePiAgentDirectory } from "../../agent-paths.js";
import { createSkillOnlyTarget } from "../skill-only-target.js";
import type { SkillTarget } from "../types.js";

export interface CreatePiSkillTargetDeps {
  rootDirectory?: string;
}

export function createPiSkillTarget(deps: CreatePiSkillTargetDeps = {}): SkillTarget {
  return createSkillOnlyTarget({
    targetId: "pi",
    displayName: "Pi",
    rootDirectory: deps.rootDirectory ?? resolvePiAgentDirectory()
  });
}
