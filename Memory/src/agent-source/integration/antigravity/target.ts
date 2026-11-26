import { readFile } from "node:fs/promises";
import { homedir } from "node:os";
import { join } from "node:path";
import {
  ANTIGRAVITY_SOURCE_ID, antigravityAppDirectory, antigravityConfigDirectory,
  createAntigravityHookCommand, createAntigravityMemoryPlugin
} from "@memmy/agent-source-core";
import { createNodeHookCommand } from "../hook-command.js";
import { readMemmyMemoryServiceConfig } from "../memmy-runtime-config.js";
import { renderMemmyPluginSkillManifest } from "../templates/memmy-plugin.js";
import { renderMemmyResumeHookScript } from "../templates/memmy-resume-hook.js";
import { renderMemmyResumeSkillFile } from "../templates/memmy-skill-directory.js";
import type { SkillTarget } from "../types.js";
import { loadMemmyWorkspaceBridgeRuntimeAsset } from "../workspace-bridge/runtime-loader.js";

export function createAntigravitySkillTarget(options: {
  appDirectory?: string;
  rootDirectory?: string;
  memmyConfigPath?: string;
} = {}): SkillTarget {
  const targetId = ANTIGRAVITY_SOURCE_ID;
  const root = options.rootDirectory ?? antigravityConfigDirectory();
  const memmyConfigPath = options.memmyConfigPath ?? join(homedir(), ".memmy", "config.yaml");
  const plugin = createAntigravityMemoryPlugin({
    appDirectory: options.appDirectory ?? antigravityAppDirectory(),
    configDirectory: root,
    hookCommand: (path) => createAntigravityHookCommand(path, createNodeHookCommand),
    loadBridge: loadMemmyWorkspaceBridgeRuntimeAsset,
    loadLogo: () => readFile(new URL("./memmy-app-icon.png", import.meta.url)),
    async loadConfig() {
      return { memmy_config_path: memmyConfigPath, ...await readMemmyMemoryServiceConfig(memmyConfigPath) };
    },
    skillContent: renderMemmyPluginSkillManifest(targetId).content,
    resumeSkill: renderMemmyResumeSkillFile(targetId),
    resumeHook: renderMemmyResumeHookScript({ source: targetId, mode: "antigravity" })
  });
  return {
    ...plugin,
    targetId,
    displayName: "Antigravity"
  };
}
