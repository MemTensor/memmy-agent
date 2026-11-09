import { createClaudeCodeSourceAdapter } from "@memmy/agent-source-readers/adapters/claude-code/index";
import { createCodexSourceAdapter } from "@memmy/agent-source-readers/adapters/codex/index";
import { createCursorSourceAdapter } from "@memmy/agent-source-readers/adapters/cursor/index";
import { createHermesSourceAdapter } from "@memmy/agent-source-readers/adapters/hermes/index";
import { createDeepseekHarnessSourceAdapter } from "@memmy/agent-source-readers/adapters/deepseek-harness/index";
import { createOpenclawSourceAdapter } from "@memmy/agent-source-readers/adapters/openclaw/index";
import { createOpencodeSourceAdapter } from "@memmy/agent-source-readers/adapters/opencode/index";
import { createPiSourceAdapter } from "@memmy/agent-source-readers/adapters/pi/index";
import { createQwenworkSourceAdapter } from "@memmy/agent-source-readers/adapters/qwenwork/index";
import { createSourceRegistry, type SourceRegistry } from "@memmy/agent-source-readers/adapters/source-registry";
import { createWorkbuddySourceAdapter } from "@memmy/agent-source-readers/adapters/workbuddy/index";

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
