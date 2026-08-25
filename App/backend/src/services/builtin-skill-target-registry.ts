import { createClaudeCodeSkillTarget } from "../adapters/outbound/skill-writer/claude-code/index.js";
import { createCodexSkillTarget } from "../adapters/outbound/skill-writer/codex/index.js";
import { createCursorSkillTarget } from "../adapters/outbound/skill-writer/cursor/index.js";
import { createDeepseekHarnessSkillTarget } from "../adapters/outbound/skill-writer/deepseek-harness/index.js";
import { createHermesSkillTarget } from "../adapters/outbound/skill-writer/hermes/index.js";
import { createOpenclawSkillTarget } from "../adapters/outbound/skill-writer/openclaw/index.js";
import { createOpencodeSkillTarget } from "../adapters/outbound/skill-writer/opencode/index.js";
import { createPiSkillTarget } from "../adapters/outbound/skill-writer/pi/index.js";
import { createQwenworkSkillTarget } from "../adapters/outbound/skill-writer/qwenwork/index.js";
import { createWorkbuddySkillTarget } from "../adapters/outbound/skill-writer/workbuddy/index.js";
import { createSkillTargetRegistry, type SkillTargetRegistry } from "../adapters/outbound/skill-writer/target-registry.js";

export function createBuiltinSkillTargetRegistry(memmyConfigPath?: string): SkillTargetRegistry {
  return createSkillTargetRegistry([
    createCursorSkillTarget({ memmyConfigPath }),
    createClaudeCodeSkillTarget({ memmyConfigPath }),
    createCodexSkillTarget({ memmyConfigPath }),
    createOpencodeSkillTarget(),
    createOpenclawSkillTarget({ memmyConfigPath }),
    createHermesSkillTarget({ memmyConfigPath }),
    createDeepseekHarnessSkillTarget({ memmyConfigPath }),
    createWorkbuddySkillTarget(),
    createPiSkillTarget(),
    createQwenworkSkillTarget()
  ]);
}
