/** Target module. */
import { mkdir, readFile, rename, rm, stat, writeFile } from "node:fs/promises";
import { homedir } from "node:os";
import { basename, dirname, join } from "node:path";
import { createNodeHookCommand } from "../hook-command.js";
import { readMemmyMemoryServiceConfig } from "../memmy-runtime-config.js";
import { removeMemmySkillDirectory, replaceMemmySkillDirectory } from "../skill-directory.js";
import { renderMemmyPluginSkillManifest } from "../templates/memmy-plugin.js";
import { renderMemmyResumeHookScript } from "../templates/memmy-resume-hook.js";
import { renderMemmySkillBootstrapManifest } from "../templates/memmy-skill-directory.js";
import type { SkillManifest, SkillTarget } from "../types.js";
import { resolveCodexHomeDirectory } from "../../agent-paths.js";

const CODEX_TARGET_ID = "codex";
const CODEX_DISPLAY_NAME = "Codex";
const TARGET_FILE_NAME = "AGENTS.md";
const HOOKS_FILE_NAME = "hooks.json";
const HOOK_DIRECTORY_NAME = "hooks";
const HOOK_SCRIPT_FILE_NAME = "memmy-resume-hook.mjs";
const LEGACY_HOOK_SCRIPT_FILE_NAME = "memmy-memory-resume-hook.mjs";
const HOOK_CONFIG_FILE_NAME = "memmy-memory-config.json";
const HOOK_TIMEOUT_SECONDS = 60;
const START_MARKER = "<!-- memmy:start v=1 -->";
const END_MARKER = "<!-- memmy:end v=1 -->";
const LEGACY_CLI_START_MARKER = "<!-- memmy-memory cli : start -->";
const LEGACY_CLI_END_MARKER = "<!-- memmy-memory cli : end -->";

export interface CreateCodexSkillTargetDeps {
  /** Root directory. */
  rootDirectory?: string;
  /** Memmy config path. */
  memmyConfigPath?: string;
}

/** Creates create codex skill target. */
export function createCodexSkillTarget(deps: CreateCodexSkillTargetDeps = {}): SkillTarget {
  const rootDirectory = deps.rootDirectory ?? resolveCodexHomeDirectory();
  const memmyConfigPath = deps.memmyConfigPath ?? join(homedir(), ".memmy", "config.yaml");

  return {
    targetId: CODEX_TARGET_ID,
    displayName: CODEX_DISPLAY_NAME,

    async resolveRootDirectory() {
      return resolveExistingDirectory(rootDirectory);
    },

    async install(manifest) {
      const root = await this.resolveRootDirectory();
      if (!root) {
        throw new Error("Codex is not installed or its directory is unavailable");
      }

      const filePath = join(root, TARGET_FILE_NAME);
      const existing = removeLegacyMarkerBlock(await readTextFile(filePath));
      await writeFileAtomically(filePath, upsertMarkerBlock(existing, renderMemmySkillBootstrapManifest(manifest)));
      await replaceMemmySkillDirectory(root, manifest);
    },

    async uninstall(_targetId) {
      const root = await this.resolveRootDirectory();
      if (!root) {
        return;
      }

      const filePath = join(root, TARGET_FILE_NAME);
      const existing = await readTextFile(filePath);
      await writeFileAtomically(filePath, removeMarkerBlock(removeLegacyMarkerBlock(existing)));
      await removeMemmySkillDirectory(root);
    },

    async isInstalled(_targetId) {
      const root = await this.resolveRootDirectory();
      if (!root) {
        return false;
      }

      return (await readTextFile(join(root, TARGET_FILE_NAME))).includes(START_MARKER);
    },

    async installPlugin(_targetId) {
      const root = await this.resolveRootDirectory();
      if (!root) {
        throw new Error("Codex is not installed or its directory is unavailable");
      }

      const hookDirectory = join(root, HOOK_DIRECTORY_NAME);
      const hookScriptPath = join(hookDirectory, HOOK_SCRIPT_FILE_NAME);
      await mkdir(hookDirectory, { recursive: true });
      await writeFileAtomically(
        join(hookDirectory, HOOK_CONFIG_FILE_NAME),
        `${JSON.stringify({ memmy_config_path: memmyConfigPath, ...(await readMemmyMemoryServiceConfig(memmyConfigPath)) }, null, 2)}\n`
      );
      await writeFileAtomically(hookScriptPath, renderMemmyResumeHookScript({ source: CODEX_TARGET_ID, mode: "codex" }));
      await upsertCodexHookConfig(join(root, HOOKS_FILE_NAME), hookScriptPath);
      await rm(join(root, HOOK_DIRECTORY_NAME, LEGACY_HOOK_SCRIPT_FILE_NAME), { force: true });

      const manifest = renderMemmyPluginSkillManifest(_targetId);
      const filePath = join(root, TARGET_FILE_NAME);
      await writeFileAtomically(
        filePath,
        upsertMarkerBlock(await readTextFile(filePath), renderMemmySkillBootstrapManifest(manifest))
      );
      await replaceMemmySkillDirectory(root, manifest);
    },

    async uninstallPlugin(_targetId) {
      const root = await this.resolveRootDirectory();
      if (!root) {
        return;
      }

      await removeCodexHookConfig(join(root, HOOKS_FILE_NAME));
      await rm(join(root, HOOK_DIRECTORY_NAME, HOOK_SCRIPT_FILE_NAME), { force: true });
      await rm(join(root, HOOK_DIRECTORY_NAME, LEGACY_HOOK_SCRIPT_FILE_NAME), { force: true });
      await rm(join(root, HOOK_DIRECTORY_NAME, HOOK_CONFIG_FILE_NAME), { force: true });
      const filePath = join(root, TARGET_FILE_NAME);
      await writeFileAtomically(filePath, removeMarkerBlock(removeLegacyMarkerBlock(await readTextFile(filePath))));
      await removeMemmySkillDirectory(root);
    }
  };
}

async function readTextFile(filePath: string): Promise<string> {
  try {
    return await readFile(filePath, "utf8");
  } catch (error) {
    if (isNodeError(error) && error.code === "ENOENT") {
      return "";
    }

    throw error;
  }
}

async function readJsonConfig(filePath: string): Promise<Record<string, unknown>> {
  const content = await readTextFile(filePath);
  if (!content.trim()) {
    return {};
  }

  const parsed = JSON.parse(content) as unknown;
  return isRecord(parsed) ? { ...parsed } : {};
}

async function resolveExistingDirectory(directory: string): Promise<string | null> {
  try {
    const stats = await stat(directory);
    return stats.isDirectory() ? directory : null;
  } catch (error) {
    if (isNodeError(error) && error.code === "ENOENT") {
      return null;
    }

    throw error;
  }
}

function upsertMarkerBlock(existing: string, manifest: SkillManifest): string {
  const block = renderMarkerBlock(manifest);
  const pattern = createMarkerBlockPattern(manifest.marker);
  if (pattern.test(existing)) {
    return existing.replace(pattern, block);
  }

  const separator = existing.length > 0 && !existing.endsWith("\n") ? "\n" : "";
  return `${existing}${separator}${block}`;
}

function removeMarkerBlock(existing: string): string {
  return existing.replace(createMarkerBlockPattern(START_MARKER), "");
}

function removeLegacyMarkerBlock(existing: string): string {
  return existing.replace(createMarkerBlockPattern(LEGACY_CLI_START_MARKER, LEGACY_CLI_END_MARKER), "");
}

async function upsertCodexHookConfig(filePath: string, hookScriptPath: string): Promise<void> {
  const config = await readJsonConfig(filePath);
  const hooks = toMutableRecord(config.hooks);
  hooks.UserPromptSubmit = [
    ...removeCodexResumeHookEntries(hooks.UserPromptSubmit),
    {
      hooks: [
        {
          type: "command",
          command: createNodeHookCommand(hookScriptPath),
          timeout: HOOK_TIMEOUT_SECONDS,
          statusMessage: "Searching Memmy resume candidates"
        }
      ]
    }
  ];
  hooks.Stop = [
    ...removeCodexResumeHookEntries(hooks.Stop),
    {
      hooks: [
        {
          type: "command",
          command: createNodeHookCommand(hookScriptPath),
          timeout: HOOK_TIMEOUT_SECONDS,
          statusMessage: "Saving Memmy turn"
        }
      ]
    }
  ];
  config.hooks = hooks;
  await writeFileAtomically(filePath, `${JSON.stringify(config, null, 2)}\n`);
}

async function removeCodexHookConfig(filePath: string): Promise<void> {
  const existing = await readTextFile(filePath);
  if (!existing.trim()) {
    return;
  }

  const config = await readJsonConfig(filePath);
  const hooks = toMutableRecord(config.hooks);
  const userPromptSubmitEntries = removeCodexResumeHookEntries(hooks.UserPromptSubmit);
  if (userPromptSubmitEntries.length > 0) {
    hooks.UserPromptSubmit = userPromptSubmitEntries;
  } else {
    delete hooks.UserPromptSubmit;
  }
  const stopEntries = removeCodexResumeHookEntries(hooks.Stop);
  if (stopEntries.length > 0) {
    hooks.Stop = stopEntries;
  } else {
    delete hooks.Stop;
  }

  if (Object.keys(hooks).length > 0) {
    config.hooks = hooks;
  } else {
    delete config.hooks;
  }

  await writeFileAtomically(filePath, `${JSON.stringify(config, null, 2)}\n`);
}

function removeCodexResumeHookEntries(value: unknown): Record<string, unknown>[] {
  if (!Array.isArray(value)) {
    return [];
  }

  const entries: Record<string, unknown>[] = [];
  for (const item of value) {
    if (!isRecord(item)) {
      continue;
    }
    const hookItems = Array.isArray(item.hooks) ? item.hooks : [];
    const filteredHooks = hookItems.filter((hook) => !isMemmyResumeHook(hook));
    if (filteredHooks.length > 0 || hookItems.length === 0) {
      entries.push(hookItems.length === 0 ? { ...item } : { ...item, hooks: filteredHooks });
    }
  }
  return entries;
}

function isMemmyResumeHook(value: unknown): boolean {
  if (!isRecord(value)) {
    return false;
  }
  return typeof value.command === "string" &&
    (value.command.includes(HOOK_SCRIPT_FILE_NAME) || value.command.includes(LEGACY_HOOK_SCRIPT_FILE_NAME));
}

function renderMarkerBlock(manifest: SkillManifest): string {
  return `${manifest.marker}\n${manifest.content.trimEnd()}\n${END_MARKER}\n`;
}

function createMarkerBlockPattern(startMarker: string, endMarker = END_MARKER): RegExp {
  return new RegExp(`${escapeRegExp(startMarker)}\\n[\\s\\S]*?${escapeRegExp(endMarker)}\\n?`, "m");
}

async function writeFileAtomically(filePath: string, content: string): Promise<void> {
  await mkdir(dirname(filePath), { recursive: true });
  const tempPath = join(dirname(filePath), `.${basename(filePath)}.${process.pid}.${Date.now()}.tmp`);
  await writeFile(tempPath, content, "utf8");
  await rename(tempPath, filePath);
}

function escapeRegExp(input: string): string {
  return input.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

function toMutableRecord(value: unknown): Record<string, unknown> {
  return isRecord(value) ? { ...value } : {};
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function isNodeError(error: unknown): error is NodeJS.ErrnoException {
  return error instanceof Error && "code" in error;
}
