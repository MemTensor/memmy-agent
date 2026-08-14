import { createClaudeCodeSourceAdapter } from "../adapters/outbound/agent-source/claude-code/index.js";
import { createCodexSourceAdapter } from "../adapters/outbound/agent-source/codex/index.js";
import { createCursorSourceAdapter } from "../adapters/outbound/agent-source/cursor/index.js";
import { createHermesSourceAdapter } from "../adapters/outbound/agent-source/hermes/index.js";
import { createDeepseekHarnessSourceAdapter } from "../adapters/outbound/agent-source/deepseek-harness/index.js";
import { createOpenclawSourceAdapter } from "../adapters/outbound/agent-source/openclaw/index.js";
import { createOpencodeSourceAdapter } from "../adapters/outbound/agent-source/opencode/index.js";
import { createPiSourceAdapter } from "../adapters/outbound/agent-source/pi/index.js";
import { createQwenworkSourceAdapter } from "../adapters/outbound/agent-source/qwenwork/index.js";
import { createSourceRegistry, type SourceRegistry } from "../adapters/outbound/agent-source/source-registry.js";
import { createWorkbuddySourceAdapter } from "../adapters/outbound/agent-source/workbuddy/index.js";

export function createBuiltinAgentSourceRegistry(): SourceRegistry {
  return createSourceRegistry([
    createCursorSourceAdapter(),
    createClaudeCodeSourceAdapter(),
    createCodexSourceAdapter(),
    createOpencodeSourceAdapter(),
    createOpenclawSourceAdapter(),
    createHermesSourceAdapter(),
    createDeepseekHarnessSourceAdapter(),
    createWorkbuddySourceAdapter(),
    createPiSourceAdapter(),
    createQwenworkSourceAdapter()
  ]);
}
