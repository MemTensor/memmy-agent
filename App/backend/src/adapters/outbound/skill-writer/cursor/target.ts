/** Target module. */
import { mkdir, readFile, rename, rm, writeFile } from "node:fs/promises";
import { homedir } from "node:os";
import { basename, dirname, join } from "node:path";
import { createNodeHookCommand } from "../hook-command.js";
import { readMemmyMemoryServiceConfig } from "../memmy-runtime-config.js";
import { removeMemmySkillDirectory, replaceMemmySkillDirectory } from "../skill-directory.js";
import { renderMemmyPluginSkillManifest } from "../templates/memmy-plugin.js";
import { renderMemmyResumeHookScript } from "../templates/memmy-resume-hook.js";
import type { SkillManifest, SkillTarget } from "../types.js";

const CURSOR_TARGET_ID = "cursor";
const CURSOR_DISPLAY_NAME = "Cursor";
const HOOKS_FILE_NAME = "hooks.json";
const HOOK_DIRECTORY_NAME = "hooks";
const HOOK_SCRIPT_FILE_NAME = "memmy-resume-hook.mjs";
const LEGACY_HOOK_SCRIPT_FILE_NAME = "memmy-memory-resume-hook.mjs";
const HOOK_CONFIG_FILE_NAME = "memmy-memory-config.json";
const HOOK_TIMEOUT_SECONDS = 60;

/** Contract for create cursor skill target deps. */
export interface CreateCursorSkillTargetDeps {
  rootDirectory?: string;
  memmyConfigPath?: string;
}

/** Creates create cursor skill target. */
export function createCursorSkillTarget(deps: CreateCursorSkillTargetDeps = {}): SkillTarget {
  const cursorRootDirectory = deps.rootDirectory ?? join(homedir(), ".cursor");
  const memmyConfigPath = deps.memmyConfigPath ?? join(homedir(), ".memmy", "config.yaml");

  return {
    targetId: CURSOR_TARGET_ID,
    displayName: CURSOR_DISPLAY_NAME,

    async resolveRootDirectory() {
      return cursorRootDirectory;
    },

    async install(manifest) {
      await mkdir(cursorRootDirectory, { recursive: true });
      await replaceMemmySkillDirectory(cursorRootDirectory, manifest);
    },

    async uninstall(_targetId) {
      await removeMemmySkillDirectory(cursorRootDirectory);
    },

    async isInstalled(_targetId) {
      return (await readTextFile(join(cursorRootDirectory, "skills", "memmy-memory", "SKILL.md"))).includes("name: memmy-memory");
    },

    async installPlugin(_targetId) {
      await mkdir(cursorRootDirectory, { recursive: true });

      const hookDirectory = join(cursorRootDirectory, HOOK_DIRECTORY_NAME);
      const hookScriptPath = join(hookDirectory, HOOK_SCRIPT_FILE_NAME);
      await mkdir(hookDirectory, { recursive: true });
      await writeFileAtomically(
        join(hookDirectory, HOOK_CONFIG_FILE_NAME),
        `${JSON.stringify({ memmy_config_path: memmyConfigPath, ...(await readMemmyMemoryServiceConfig(memmyConfigPath)) }, null, 2)}\n`
      );
      await writeFileAtomically(
        hookScriptPath,
        renderMemmyResumeHookScript({ source: CURSOR_TARGET_ID, mode: "cursor" })
      );
      await upsertCursorHookConfig(join(cursorRootDirectory, HOOKS_FILE_NAME), hookScriptPath);
      await rm(join(cursorRootDirectory, HOOK_DIRECTORY_NAME, LEGACY_HOOK_SCRIPT_FILE_NAME), { force: true });

      const manifest = renderMemmyPluginSkillManifest(_targetId);
      await replaceMemmySkillDirectory(cursorRootDirectory, manifest);
    },

    async uninstallPlugin(_targetId) {
      await removeCursorHookConfig(join(cursorRootDirectory, HOOKS_FILE_NAME));
      await rm(join(cursorRootDirectory, HOOK_DIRECTORY_NAME, HOOK_SCRIPT_FILE_NAME), { force: true });
      await rm(join(cursorRootDirectory, HOOK_DIRECTORY_NAME, LEGACY_HOOK_SCRIPT_FILE_NAME), { force: true });
      await rm(join(cursorRootDirectory, HOOK_DIRECTORY_NAME, HOOK_CONFIG_FILE_NAME), { force: true });
      await removeMemmySkillDirectory(cursorRootDirectory);
    }
  };
}

/** Reads read text file. */
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

async function upsertCursorHookConfig(filePath: string, hookScriptPath: string): Promise<void> {
  const config = await readJsonConfig(filePath);
  const hooks = toMutableRecord(config.hooks);
  hooks.beforeSubmitPrompt = [
    ...removeCursorResumeHookEntries(hooks.beforeSubmitPrompt),
    {
      command: createNodeHookCommand(hookScriptPath),
      timeout: HOOK_TIMEOUT_SECONDS
    }
  ];
  hooks.afterAgentResponse = [
    ...removeCursorResumeHookEntries(hooks.afterAgentResponse),
    {
      command: createNodeHookCommand(hookScriptPath),
      timeout: HOOK_TIMEOUT_SECONDS
    }
  ];
  hooks.stop = [
    ...removeCursorResumeHookEntries(hooks.stop),
    {
      command: createNodeHookCommand(hookScriptPath),
      timeout: HOOK_TIMEOUT_SECONDS
    }
  ];
  config.version = 1;
  config.hooks = hooks;
  await writeFileAtomically(filePath, `${JSON.stringify(config, null, 2)}\n`);
}

async function removeCursorHookConfig(filePath: string): Promise<void> {
  const existing = await readTextFile(filePath);
  if (!existing.trim()) {
    return;
  }

  const config = await readJsonConfig(filePath);
  const hooks = toMutableRecord(config.hooks);
  const entries = removeCursorResumeHookEntries(hooks.beforeSubmitPrompt);
  if (entries.length > 0) {
    hooks.beforeSubmitPrompt = entries;
  } else {
    delete hooks.beforeSubmitPrompt;
  }
  const afterAgentResponseEntries = removeCursorResumeHookEntries(hooks.afterAgentResponse);
  if (afterAgentResponseEntries.length > 0) {
    hooks.afterAgentResponse = afterAgentResponseEntries;
  } else {
    delete hooks.afterAgentResponse;
  }
  const stopEntries = removeCursorResumeHookEntries(hooks.stop);
  if (stopEntries.length > 0) {
    hooks.stop = stopEntries;
  } else {
    delete hooks.stop;
  }

  if (Object.keys(hooks).length > 0) {
    config.hooks = hooks;
  } else {
    delete config.hooks;
  }

  await writeFileAtomically(filePath, `${JSON.stringify(config, null, 2)}\n`);
}

function removeCursorResumeHookEntries(value: unknown): Record<string, unknown>[] {
  if (!Array.isArray(value)) {
    return [];
  }

  return value.filter((item): item is Record<string, unknown> => isRecord(item) && !isMemmyResumeHook(item));
}

function isMemmyResumeHook(value: unknown): boolean {
  return isRecord(value) &&
    typeof value.command === "string" &&
    (value.command.includes(HOOK_SCRIPT_FILE_NAME) || value.command.includes(LEGACY_HOOK_SCRIPT_FILE_NAME));
}

/**
 * Writes a text file atomically.
 *
 * @param filePath the target file path.
 * @param content the full file content.
 */
async function writeFileAtomically(filePath: string, content: string): Promise<void> {
  await mkdir(dirname(filePath), { recursive: true });
  const tempPath = join(dirname(filePath), `.${basename(filePath)}.${process.pid}.${Date.now()}.tmp`);
  await writeFile(tempPath, content, "utf8");
  await rename(tempPath, filePath);
}

function toMutableRecord(value: unknown): Record<string, unknown> {
  return isRecord(value) ? { ...value } : {};
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/** Checks is node error. */
function isNodeError(error: unknown): error is NodeJS.ErrnoException {
  return error instanceof Error && "code" in error;
}
