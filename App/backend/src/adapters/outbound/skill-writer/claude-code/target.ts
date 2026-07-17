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
import { resolveClaudeCodeHomeDirectory } from "../../agent-paths.js";

const CLAUDE_CODE_TARGET_ID = "claude_code";
const CLAUDE_CODE_DISPLAY_NAME = "Claude Code";
const TARGET_FILE_NAME = "CLAUDE.md";
const SETTINGS_FILE_NAME = "settings.json";
const HOOK_DIRECTORY_NAME = "hooks";
const HOOK_SCRIPT_FILE_NAME = "memmy-resume-hook.mjs";
const LEGACY_HOOK_SCRIPT_FILE_NAME = "memmy-memory-resume-hook.mjs";
const HOOK_CONFIG_FILE_NAME = "memmy-memory-config.json";
const HOOK_TIMEOUT_SECONDS = 60;
const COMMAND_DIRECTORY_NAME = "commands";
const RESUME_COMMAND_FILE_NAME = "memmy-resume.md";
const LEGACY_TARGET_FILE_NAMES = ["claude.md"];
const START_MARKER = "<!-- memmy:start v=1 -->";
const END_MARKER = "<!-- memmy:end v=1 -->";
const LEGACY_CLI_START_MARKER = "<!-- memmy-memory cli : start -->";
const LEGACY_CLI_END_MARKER = "<!-- memmy-memory cli : end -->";

export interface CreateClaudeCodeSkillTargetDeps {
  /** Root directory. */
  rootDirectory?: string;
  /** Memmy config path. */
  memmyConfigPath?: string;
}

/** Creates create claude code skill target. */
export function createClaudeCodeSkillTarget(deps: CreateClaudeCodeSkillTargetDeps = {}): SkillTarget {
  const rootDirectory = deps.rootDirectory ?? resolveClaudeCodeHomeDirectory();
  const memmyConfigPath = deps.memmyConfigPath ?? join(homedir(), ".memmy", "config.yaml");

  return {
    targetId: CLAUDE_CODE_TARGET_ID,
    displayName: CLAUDE_CODE_DISPLAY_NAME,

    async resolveRootDirectory() {
      return resolveExistingDirectory(rootDirectory);
    },

    async install(manifest) {
      const root = await this.resolveRootDirectory();
      if (!root) {
        throw new Error("Claude Code is not installed or its directory is unavailable");
      }

      await removeLegacyAgentInstructions(root);
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
      await removeLegacyAgentInstructions(root);
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
        throw new Error("Claude Code is not installed or its directory is unavailable");
      }

      const hookDirectory = join(root, HOOK_DIRECTORY_NAME);
      const hookScriptPath = join(hookDirectory, HOOK_SCRIPT_FILE_NAME);
      await mkdir(hookDirectory, { recursive: true });
      await writeFileAtomically(
        join(hookDirectory, HOOK_CONFIG_FILE_NAME),
        `${JSON.stringify({ memmy_config_path: memmyConfigPath, ...(await readMemmyMemoryServiceConfig(memmyConfigPath)) }, null, 2)}\n`
      );
      await writeFileAtomically(
        hookScriptPath,
        renderMemmyResumeHookScript({ source: CLAUDE_CODE_TARGET_ID, mode: "claude-code" })
      );
      await writeFileAtomically(join(root, COMMAND_DIRECTORY_NAME, RESUME_COMMAND_FILE_NAME), CLAUDE_CODE_RESUME_COMMAND);
      await upsertClaudeCodeHookSettings(join(root, SETTINGS_FILE_NAME), hookScriptPath);
      await rm(join(root, HOOK_DIRECTORY_NAME, LEGACY_HOOK_SCRIPT_FILE_NAME), { force: true });

      const manifest = renderMemmyPluginSkillManifest(_targetId);
      const filePath = join(root, TARGET_FILE_NAME);
      await removeLegacyAgentInstructions(root);
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

      await removeClaudeCodeHookSettings(join(root, SETTINGS_FILE_NAME));
      await rm(join(root, HOOK_DIRECTORY_NAME, HOOK_SCRIPT_FILE_NAME), { force: true });
      await rm(join(root, HOOK_DIRECTORY_NAME, LEGACY_HOOK_SCRIPT_FILE_NAME), { force: true });
      await rm(join(root, HOOK_DIRECTORY_NAME, HOOK_CONFIG_FILE_NAME), { force: true });
      await rm(join(root, COMMAND_DIRECTORY_NAME, RESUME_COMMAND_FILE_NAME), { force: true });
      const filePath = join(root, TARGET_FILE_NAME);
      await writeFileAtomically(filePath, removeMarkerBlock(removeLegacyMarkerBlock(await readTextFile(filePath))));
      await removeLegacyAgentInstructions(root);
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

async function removeLegacyAgentInstructions(rootDirectory: string): Promise<void> {
  for (const fileName of LEGACY_TARGET_FILE_NAMES) {
    if (await isSameFile(join(rootDirectory, TARGET_FILE_NAME), join(rootDirectory, fileName))) {
      continue;
    }
    const filePath = join(rootDirectory, fileName);
    const existing = await readTextFile(filePath);
    const next = removeMarkerBlock(removeLegacyMarkerBlock(existing));
    if (next !== existing) {
      await writeFileAtomically(filePath, next);
    }
  }
}

async function isSameFile(leftPath: string, rightPath: string): Promise<boolean> {
  try {
    const [left, right] = await Promise.all([stat(leftPath), stat(rightPath)]);
    return left.dev === right.dev && left.ino === right.ino;
  } catch (error) {
    if (isNodeError(error) && error.code === "ENOENT") {
      return false;
    }
    throw error;
  }
}

function removeLegacyMarkerBlock(existing: string): string {
  return existing.replace(createMarkerBlockPattern(LEGACY_CLI_START_MARKER, LEGACY_CLI_END_MARKER), "");
}

async function upsertClaudeCodeHookSettings(filePath: string, hookScriptPath: string): Promise<void> {
  const config = await readJsonConfig(filePath);
  const hooks = toMutableRecord(config.hooks);
  hooks.UserPromptSubmit = [
    ...removeClaudeCodeResumeHookEntries(hooks.UserPromptSubmit),
    {
      matcher: "",
      hooks: [
        {
          type: "command",
          command: createNodeHookCommand(hookScriptPath),
          timeout: HOOK_TIMEOUT_SECONDS
        }
      ]
    }
  ];
  hooks.Stop = [
    ...removeClaudeCodeResumeHookEntries(hooks.Stop),
    {
      matcher: "",
      hooks: [
        {
          type: "command",
          command: createNodeHookCommand(hookScriptPath),
          timeout: HOOK_TIMEOUT_SECONDS
        }
      ]
    }
  ];
  config.hooks = hooks;
  await writeFileAtomically(filePath, `${JSON.stringify(config, null, 2)}\n`);
}

async function removeClaudeCodeHookSettings(filePath: string): Promise<void> {
  const existing = await readTextFile(filePath);
  if (!existing.trim()) {
    return;
  }

  const config = await readJsonConfig(filePath);
  const hooks = toMutableRecord(config.hooks);
  const entries = removeClaudeCodeResumeHookEntries(hooks.UserPromptSubmit);
  if (entries.length > 0) {
    hooks.UserPromptSubmit = entries;
  } else {
    delete hooks.UserPromptSubmit;
  }
  const stopEntries = removeClaudeCodeResumeHookEntries(hooks.Stop);
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

function removeClaudeCodeResumeHookEntries(value: unknown): Record<string, unknown>[] {
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

const CLAUDE_CODE_RESUME_COMMAND = `---
description: Fast Memmy resume lookup handled by the installed hook.
argument-hint: <query | 1-5 | cancel>
---

MEMMY_RESUME_COMMAND_ARGUMENTS:
$ARGUMENTS
MEMMY_RESUME_COMMAND_END

This slash command is a parser shim for the installed Memmy UserPromptSubmit hook.
If this text reaches the model, respond only with: Memmy resume hook did not intercept this command; reinstall the Memmy Claude Code hook.
`;
