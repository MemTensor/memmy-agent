/** Target module. */
import { mkdir, readFile, rename, rm, writeFile } from "node:fs/promises";
import { homedir } from "node:os";
import { basename, dirname, join } from "node:path";
import { createNodeHookCommand } from "../hook-command.js";
import { isInstalledMemmyHookCurrent, memmyHookRevisionField } from "../hook-revision.js";
import { readMemmyMemoryServiceConfig } from "../memmy-runtime-config.js";
import {
  PROJECT_HOOK_SCRIPT_FILE_NAME,
  installProjectHookBundle,
  isInstalledProjectHookCurrent,
  isProjectHookBundleInstalled,
  removeProjectHookBundle,
  renderMemmyProjectHookConfig
} from "../project-hook/install.js";
import {
  removeMemmyResumeSkillDirectory,
  removeMemmyProjectSkillDirectory,
  removeMemmySkillDirectory,
  replaceMemmyResumeSkillDirectory,
  replaceMemmyProjectSkillDirectory,
  replaceMemmySkillDirectory
} from "../skill-directory.js";
import { renderMemmyPluginSkillManifest } from "../templates/memmy-plugin.js";
import { renderMemmyResumeHookScript } from "../templates/memmy-resume-hook.js";
import type { SkillManifest, SkillTarget } from "../types.js";
import { loadMemmyWorkspaceBridgeRuntimeAsset } from "../workspace-bridge/runtime-loader.js";

const CURSOR_TARGET_ID = "cursor";
const CURSOR_DISPLAY_NAME = "Cursor";
const HOOKS_FILE_NAME = "hooks.json";
const HOOK_DIRECTORY_NAME = "hooks";
const HOOK_SCRIPT_FILE_NAME = "memmy-resume-hook.mjs";
const LEGACY_HOOK_SCRIPT_FILE_NAME = "memmy-memory-resume-hook.mjs";
const HOOK_CONFIG_FILE_NAME = "memmy-memory-config.json";
const WORKSPACE_BRIDGE_FILE_NAME = "memmy-workspace-bridge.mjs";
const HOOK_TIMEOUT_SECONDS = 60;
// Cursor 只有会话开始，没有压缩后事件；提交提示词时补一次项目指令。
const PROJECT_HOOK_EVENTS = ["sessionStart", "beforeSubmitPrompt"] as const;

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
      await replaceMemmyProjectSkillDirectory(cursorRootDirectory);
      await replaceMemmyResumeSkillDirectory(cursorRootDirectory, CURSOR_TARGET_ID);
    },

    async uninstall(_targetId) {
      await removeMemmyResumeSkillDirectory(cursorRootDirectory);
      await removeMemmySkillDirectory(cursorRootDirectory);
      await removeMemmyProjectSkillDirectory(cursorRootDirectory);
    },

    async isInstalled(_targetId) {
      return (await readTextFile(join(cursorRootDirectory, "skills", "memmy-memory", "SKILL.md"))).includes("name: memmy-memory");
    },

    async isInstalledHookCurrent() {
      const hookDirectory = join(cursorRootDirectory, HOOK_DIRECTORY_NAME);
      return isInstalledMemmyHookCurrent({
        source: CURSOR_TARGET_ID,
        mode: "cursor",
        hookScriptPath: join(hookDirectory, HOOK_SCRIPT_FILE_NAME),
        bridgePath: join(hookDirectory, WORKSPACE_BRIDGE_FILE_NAME),
        configPath: join(hookDirectory, HOOK_CONFIG_FILE_NAME)
      });
    },

    async isMemoryHookInstalled() {
      const hookDirectory = join(cursorRootDirectory, HOOK_DIRECTORY_NAME);
      const [script, bridge] = await Promise.all([
        readTextFile(join(hookDirectory, HOOK_SCRIPT_FILE_NAME)),
        readTextFile(join(hookDirectory, WORKSPACE_BRIDGE_FILE_NAME))
      ]);
      return Boolean(script.trim() && bridge.trim());
    },

    async installProjectHook() {
      await mkdir(cursorRootDirectory, { recursive: true });
      const hookDirectory = join(cursorRootDirectory, HOOK_DIRECTORY_NAME);
      await installProjectHookBundle(hookDirectory, {
        source: CURSOR_TARGET_ID,
        mode: "cursor",
        config: renderMemmyProjectHookConfig({ memmyConfigPath })
      });
      await upsertCursorProjectHookConfig(
        join(cursorRootDirectory, HOOKS_FILE_NAME),
        join(hookDirectory, PROJECT_HOOK_SCRIPT_FILE_NAME)
      );
    },

    async uninstallProjectHook() {
      await removeCursorProjectHookConfig(join(cursorRootDirectory, HOOKS_FILE_NAME));
      await removeProjectHookBundle(join(cursorRootDirectory, HOOK_DIRECTORY_NAME));
    },

    async isProjectHookInstalled() {
      return await isProjectHookBundleInstalled(join(cursorRootDirectory, HOOK_DIRECTORY_NAME));
    },

    async isProjectHookCurrent() {
      const hookDirectory = join(cursorRootDirectory, HOOK_DIRECTORY_NAME);
      const current = await isInstalledProjectHookCurrent(hookDirectory, {
        source: CURSOR_TARGET_ID,
        mode: "cursor",
        config: renderMemmyProjectHookConfig({ memmyConfigPath })
      });
      if (!current) return false;
      return await hasCursorProjectHookConfig(join(cursorRootDirectory, HOOKS_FILE_NAME));
    },

    async installPlugin(_targetId) {
      await mkdir(cursorRootDirectory, { recursive: true });

      const hookDirectory = join(cursorRootDirectory, HOOK_DIRECTORY_NAME);
      const hookScriptPath = join(hookDirectory, HOOK_SCRIPT_FILE_NAME);
      const hookConfigPath = join(hookDirectory, HOOK_CONFIG_FILE_NAME);
      const hookConfig = {
        memmy_config_path: memmyConfigPath,
        ...(await readMemmyMemoryServiceConfig(memmyConfigPath))
      };
      await mkdir(hookDirectory, { recursive: true });
      await writeFileAtomically(hookConfigPath, `${JSON.stringify(hookConfig, null, 2)}\n`);
      await writeFileAtomically(
        hookScriptPath,
        renderMemmyResumeHookScript({ source: CURSOR_TARGET_ID, mode: "cursor" })
      );
      await writeFileAtomically(
        join(hookDirectory, WORKSPACE_BRIDGE_FILE_NAME),
        await loadMemmyWorkspaceBridgeRuntimeAsset()
      );
      await upsertCursorHookConfig(join(cursorRootDirectory, HOOKS_FILE_NAME), hookScriptPath);
      await rm(join(cursorRootDirectory, HOOK_DIRECTORY_NAME, LEGACY_HOOK_SCRIPT_FILE_NAME), { force: true });

      const manifest = renderMemmyPluginSkillManifest(_targetId);
      await replaceMemmySkillDirectory(cursorRootDirectory, manifest);
      await replaceMemmyProjectSkillDirectory(cursorRootDirectory);
      await replaceMemmyResumeSkillDirectory(cursorRootDirectory, CURSOR_TARGET_ID);
      await writeFileAtomically(
        hookConfigPath,
        `${JSON.stringify({ ...hookConfig, ...(await memmyHookRevisionField(CURSOR_TARGET_ID, "cursor")) }, null, 2)}\n`
      );
    },

    async uninstallPlugin(_targetId) {
      await removeCursorHookConfig(join(cursorRootDirectory, HOOKS_FILE_NAME));
      await rm(join(cursorRootDirectory, HOOK_DIRECTORY_NAME, HOOK_SCRIPT_FILE_NAME), { force: true });
      await rm(join(cursorRootDirectory, HOOK_DIRECTORY_NAME, LEGACY_HOOK_SCRIPT_FILE_NAME), { force: true });
      await rm(join(cursorRootDirectory, HOOK_DIRECTORY_NAME, HOOK_CONFIG_FILE_NAME), { force: true });
      await rm(join(cursorRootDirectory, HOOK_DIRECTORY_NAME, WORKSPACE_BRIDGE_FILE_NAME), { force: true });
      await removeMemmyResumeSkillDirectory(cursorRootDirectory);
      await removeMemmySkillDirectory(cursorRootDirectory);
      await removeMemmyProjectSkillDirectory(cursorRootDirectory);
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
  hooks.sessionStart = cursorHookEntries(hooks.sessionStart, hookScriptPath);
  hooks.preCompact = cursorHookEntries(hooks.preCompact, hookScriptPath);
  hooks.sessionEnd = cursorHookEntries(hooks.sessionEnd, hookScriptPath);
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
  for (const event of ["sessionStart", "preCompact", "sessionEnd"] as const) {
    const eventEntries = removeCursorResumeHookEntries(hooks[event]);
    if (eventEntries.length > 0) hooks[event] = eventEntries;
    else delete hooks[event];
  }

  if (Object.keys(hooks).length > 0) {
    config.hooks = hooks;
  } else {
    delete config.hooks;
  }

  await writeFileAtomically(filePath, `${JSON.stringify(config, null, 2)}\n`);
}

function cursorHookEntries(value: unknown, hookScriptPath: string): Record<string, unknown>[] {
  return [
    ...removeCursorResumeHookEntries(value),
    { command: createNodeHookCommand(hookScriptPath), timeout: HOOK_TIMEOUT_SECONDS },
  ];
}

function removeCursorResumeHookEntries(value: unknown): Record<string, unknown>[] {
  return removeCursorHookEntries(value, isMemmyResumeHook);
}

/**
 * 两个钩子共用 `hooks.json`，各自只删自己的条目：记忆钩子按 `memmy-resume-hook.mjs` 认，
 * 项目钩子按 `memmy-project-hook.mjs` 认，文件名不同，互不误删。
 */
function removeCursorHookEntries(
  value: unknown,
  isOwn: (value: unknown) => boolean
): Record<string, unknown>[] {
  if (!Array.isArray(value)) {
    return [];
  }

  return value.filter((item): item is Record<string, unknown> => isRecord(item) && !isOwn(item));
}

function isMemmyResumeHook(value: unknown): boolean {
  return isRecord(value) &&
    typeof value.command === "string" &&
    (value.command.includes(HOOK_SCRIPT_FILE_NAME) || value.command.includes(LEGACY_HOOK_SCRIPT_FILE_NAME));
}

function isMemmyProjectHook(value: unknown): boolean {
  return isRecord(value) &&
    typeof value.command === "string" &&
    value.command.includes(PROJECT_HOOK_SCRIPT_FILE_NAME);
}

async function upsertCursorProjectHookConfig(filePath: string, hookScriptPath: string): Promise<void> {
  const config = await readJsonConfig(filePath);
  const hooks = toMutableRecord(config.hooks);
  for (const event of PROJECT_HOOK_EVENTS) {
    hooks[event] = [
      ...removeCursorProjectHookEntries(hooks[event]),
      { command: createNodeHookCommand(hookScriptPath), timeout: HOOK_TIMEOUT_SECONDS }
    ];
  }
  config.version = 1;
  config.hooks = hooks;
  await writeFileAtomically(filePath, `${JSON.stringify(config, null, 2)}\n`);
}

async function removeCursorProjectHookConfig(filePath: string): Promise<void> {
  const existing = await readTextFile(filePath);
  if (!existing.trim()) {
    return;
  }

  const config = await readJsonConfig(filePath);
  const hooks = toMutableRecord(config.hooks);
  for (const event of PROJECT_HOOK_EVENTS) {
    const entries = removeCursorProjectHookEntries(hooks[event]);
    if (entries.length > 0) hooks[event] = entries;
    else delete hooks[event];
  }

  if (Object.keys(hooks).length > 0) {
    config.hooks = hooks;
  } else {
    delete config.hooks;
  }
  await writeFileAtomically(filePath, `${JSON.stringify(config, null, 2)}\n`);
}

/** `hooks.json` 里是否还写着项目钩子的条目：文件对得上但条目被删掉也算没装好。 */
async function hasCursorProjectHookConfig(filePath: string): Promise<boolean> {
  const config = await readJsonConfig(filePath);
  const hooks = toMutableRecord(config.hooks);
  return PROJECT_HOOK_EVENTS.every((event) => {
    const entries = Array.isArray(hooks[event]) ? hooks[event] as unknown[] : [];
    return entries.some(isMemmyProjectHook);
  });
}

function removeCursorProjectHookEntries(value: unknown): Record<string, unknown>[] {
  return removeCursorHookEntries(value, isMemmyProjectHook);
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
