import fs from "node:fs";
import path from "node:path";
import { AgentHook, SDKCaptureHook } from "./core/agent-runtime/hook.js";
import { AgentLoop } from "./core/agent-runtime/loop.js";
import { getConfigPath, loadConfig as loadConfigFromFile } from "./config/loader.js";
import { Config } from "./config/schema.js";
import { makeReloadingProviderSnapshotLoader } from "./providers/snapshot-loader.js";

export class RunResult {
  content: string;
  toolsUsed: string[];
  messages: Record<string, any>[];

  constructor(init: { content: string; toolsUsed?: string[]; messages?: Record<string, any>[] }) {
    this.content = init.content;
    this.toolsUsed = init.toolsUsed ?? [];
    this.messages = init.messages ?? [];
  }
}

function loadConfig(configPath?: string | null): Config {
  if (!configPath) return loadConfigFromFile(null);
  const resolved = path.resolve(configPath);
  if (!fs.existsSync(resolved)) throw new FileNotFoundError(`Config not found: ${resolved}`);
  return loadConfigFromFile(resolved);
}

function resolveConfigPath(configPath?: string | null): string {
  return configPath ? path.resolve(configPath) : getConfigPath();
}

export class FileNotFoundError extends Error {}

export class MemmyAgent {
  agentLoop: AgentLoop;
  loop: AgentLoop;

  constructor(loopOrConfig: AgentLoop | Config = new Config()) {
    this.agentLoop = this.loop = loopOrConfig instanceof AgentLoop ? loopOrConfig : new AgentLoop({ config: loopOrConfig });
  }

  static fromConfig(config?: Config | string | null, optsOrWorkspace: { workspace?: string } | string = {}): MemmyAgent {
    const opts = typeof optsOrWorkspace === "string" ? { workspace: optsOrWorkspace } : optsOrWorkspace;
    const configPath = config instanceof Config ? null : resolveConfigPath(config ?? null);
    const cfg = config instanceof Config ? config : loadConfig(config ?? null);
    if (opts.workspace) cfg.agents.defaults.workspace = path.resolve(opts.workspace);
    return new MemmyAgent(AgentLoop.fromConfig(cfg, undefined, {
      workspace: cfg.agents.defaults.workspace,
      providerSnapshotLoader: makeReloadingProviderSnapshotLoader({ configPath })
    }));
  }

  async run(
    message: string,
    {
      sessionKey = "sdk:default",
      hooks = null,
    }: {
      sessionKey?: string;
      hooks?: AgentHook[] | null;
    } = {},
  ): Promise<RunResult> {
    const capture = new SDKCaptureHook();
    const previous = this.agentLoop.extraHooks;
    const baseHooks = hooks ? [...hooks] : [...(previous ?? [])];
    this.agentLoop.extraHooks = [capture, ...baseHooks];
    try {
      const response = await this.agentLoop.processDirect(message, { sessionKey });
      return new RunResult({
        content: response?.content ?? "",
        toolsUsed: capture.toolsUsed,
        messages: capture.messages,
      });
    } finally {
      this.agentLoop.extraHooks = previous;
    }
  }
}

export { MemmyAgent as Memmy };
