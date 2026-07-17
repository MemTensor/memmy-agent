/** Target module. */
import { mkdir, readFile, rename, rm, stat, writeFile } from "node:fs/promises";
import { homedir } from "node:os";
import { basename, dirname, join } from "node:path";
import { resolveOpencodeConfigDirectory } from "../../agent-paths.js";
import { readMemmyMemoryServiceConfig } from "../memmy-runtime-config.js";
import { removeMemmySkillDirectory, replaceMemmySkillDirectory } from "../skill-directory.js";
import { renderMemmyOpencodePlugin, renderMemmyOpencodeResumeCommand } from "../templates/memmy-opencode-plugin.js";
import { renderMemmyPluginSkillManifest } from "../templates/memmy-plugin.js";
import { renderMemmySkillBootstrapManifest } from "../templates/memmy-skill-directory.js";
import type { SkillManifest, SkillTarget } from "../types.js";

const OPENCODE_TARGET_ID = "opencode";
const OPENCODE_DISPLAY_NAME = "Opencode";
const TARGET_FILE_NAME = "AGENTS.md";
const PLUGIN_DIRECTORY_NAME = "plugins";
const PLUGIN_FILE_NAME = "memmy-memory.js";
const PLUGIN_CONFIG_FILE_NAME = "memmy-memory-config.json";
const COMMAND_DIRECTORY_NAME = "commands";
const RESUME_COMMAND_FILE_NAME = "memmy-resume.md";
const START_MARKER = "<!-- memmy:start v=1 -->";
const END_MARKER = "<!-- memmy:end v=1 -->";
const LEGACY_CLI_START_MARKER = "<!-- memmy-memory cli : start -->";
const LEGACY_CLI_END_MARKER = "<!-- memmy-memory cli : end -->";

/** Contract for create opencode skill target deps. */
export interface CreateOpencodeSkillTargetDeps {
  rootDirectory?: string;
  memmyConfigPath?: string;
}

/** Creates create opencode skill target. */
export function createOpencodeSkillTarget(deps: CreateOpencodeSkillTargetDeps = {}): SkillTarget {
  const rootDirectory = deps.rootDirectory ?? resolveOpencodeConfigDirectory();
  const memmyConfigPath = deps.memmyConfigPath ?? join(homedir(), ".memmy", "config.yaml");

  return {
    targetId: OPENCODE_TARGET_ID,
    displayName: OPENCODE_DISPLAY_NAME,

    async resolveRootDirectory() {
      return rootDirectory;
    },

    async install(manifest) {
      await mkdir(rootDirectory, { recursive: true });
      const filePath = join(rootDirectory, TARGET_FILE_NAME);
      const existing = removeCliMarkerBlock(await readTextFile(filePath));
      await writeFileAtomically(filePath, upsertMarkerBlock(existing, renderMemmySkillBootstrapManifest(manifest)));
      await replaceMemmySkillDirectory(rootDirectory, manifest);
    },

    async uninstall(_targetId) {
      const root = await resolveExistingDirectory(rootDirectory);
      if (!root) {
        return;
      }

      const filePath = join(root, TARGET_FILE_NAME);
      const existing = await readTextFile(filePath);
      if (existing.includes(START_MARKER)) {
        await writeFileAtomically(filePath, removeMarkerBlock(existing));
      }
      await removeMemmySkillDirectory(root);
    },

    async isInstalled(_targetId) {
      return (await readTextFile(join(rootDirectory, TARGET_FILE_NAME))).includes(START_MARKER);
    },

    async installPlugin(_targetId) {
      await mkdir(rootDirectory, { recursive: true });
      const pluginDirectory = join(rootDirectory, PLUGIN_DIRECTORY_NAME);
      const commandDirectory = join(rootDirectory, COMMAND_DIRECTORY_NAME);
      await mkdir(pluginDirectory, { recursive: true });
      await mkdir(commandDirectory, { recursive: true });
      await writeFileAtomically(
        join(pluginDirectory, PLUGIN_CONFIG_FILE_NAME),
        `${JSON.stringify({
          memmy_config_path: memmyConfigPath,
          ...(await readMemmyMemoryServiceConfig(memmyConfigPath))
        }, null, 2)}\n`
      );
      await writeFileAtomically(join(pluginDirectory, PLUGIN_FILE_NAME), renderMemmyOpencodePlugin());
      await writeFileAtomically(join(commandDirectory, RESUME_COMMAND_FILE_NAME), renderMemmyOpencodeResumeCommand());

      const manifest = renderMemmyPluginSkillManifest(_targetId);
      const filePath = join(rootDirectory, TARGET_FILE_NAME);
      await writeFileAtomically(
        filePath,
        upsertMarkerBlock(
          removeCliMarkerBlock(await readTextFile(filePath)),
          renderMemmySkillBootstrapManifest(manifest)
        )
      );
      await replaceMemmySkillDirectory(rootDirectory, manifest);
    },

    async uninstallPlugin(_targetId) {
      const root = await resolveExistingDirectory(rootDirectory);
      if (!root) {
        return;
      }

      await rm(join(root, PLUGIN_DIRECTORY_NAME, PLUGIN_FILE_NAME), { force: true });
      await rm(join(root, PLUGIN_DIRECTORY_NAME, PLUGIN_CONFIG_FILE_NAME), { force: true });
      await rm(join(root, COMMAND_DIRECTORY_NAME, RESUME_COMMAND_FILE_NAME), { force: true });
      const filePath = join(root, TARGET_FILE_NAME);
      const existing = await readTextFile(filePath);
      if (existing.includes(START_MARKER)) {
        await writeFileAtomically(filePath, removeMarkerBlock(existing));
      }
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

function removeCliMarkerBlock(existing: string): string {
  return existing.replace(createMarkerBlockPattern(LEGACY_CLI_START_MARKER, LEGACY_CLI_END_MARKER), "");
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

function isNodeError(error: unknown): error is NodeJS.ErrnoException {
  return error instanceof Error && "code" in error;
}
