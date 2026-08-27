import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { AgentLoop } from "../../../src/core/agent-runtime/loop.js";
import { MessageBus } from "../../../src/core/runtime-messages/queue.js";
import { Config } from "../../../src/config/schema.js";

export function makeProvider(
  defaultModel = "test-model",
  { maxTokens = 4096 }: { maxTokens?: number } = {},
): Record<string, any> {
  return {
    generation: {
      maxTokens,
      temperature: 0.1,
      reasoningEffort: null,
    },
    getDefaultModel: () => defaultModel,
    estimatePromptTokens: () => [10_000, "test"],
  };
}

export function makeLoop(
  workspace: string | null = null,
  {
    model = "test-model",
    contextWindowTokens = 128_000,
    sessionTtlMinutes = 0,
    maxMessages = 120,
    unifiedSession = false,
    toolsConfig = null,
    modelPresets = null,
    provider = null,
  }: {
    model?: string;
    contextWindowTokens?: number;
    sessionTtlMinutes?: number;
    maxMessages?: number;
    unifiedSession?: boolean;
    toolsConfig?: any;
    modelPresets?: Record<string, any> | null;
    provider?: any;
  } = {},
): AgentLoop {
  const root = workspace ?? fs.mkdtempSync(path.join(os.tmpdir(), "memmy-agent-loop-"));
  const init: Record<string, any> = {
    bus: new MessageBus(),
    provider: provider ?? makeProvider(model),
    workspace: root,
    model,
    contextWindowTokens,
    sessionTtlMinutes,
    maxMessages,
    unifiedSession,
    modelPresets: modelPresets ?? undefined,
  };
  if (toolsConfig) init.config = new Config({ tools: toolsConfig });
  return new AgentLoop(init);
}

export function makeLoopFactory(workspace: string): (options?: Parameters<typeof makeLoop>[1]) => AgentLoop {
  return (options = {}) => makeLoop(workspace, options);
}

export function waitTick(): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, 0));
}
