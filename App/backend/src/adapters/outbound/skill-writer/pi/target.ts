/** Pi skill target module. */
import { mkdir, readFile, rename, rm, stat, writeFile } from "node:fs/promises";
import { homedir } from "node:os";
import { basename, dirname, join } from "node:path";
import { resolvePiHomeDirectory } from "../../agent-paths.js";
import { readMemmyMemoryServiceConfig } from "../memmy-runtime-config.js";
import { removeMemmySkillDirectory, replaceMemmySkillDirectory } from "../skill-directory.js";
import { renderMemmyPiExtension } from "../templates/memmy-pi-extension.js";
import { renderMemmyPluginSkillManifest } from "../templates/memmy-plugin.js";
import { renderMemmySkillBootstrapManifest } from "../templates/memmy-skill-directory.js";
import type { SkillManifest, SkillTarget } from "../types.js";

const PI_TARGET_ID = "pi";
const START_MARKER = "<!-- memmy:start v=1 -->";
const END_MARKER = "<!-- memmy:end v=1 -->";
const TARGET_FILE_NAME = "AGENTS.md";
const EXTENSION_DIRECTORY_NAME = "extensions";
const EXTENSION_FILE_NAME = "memmy-memory.ts";
const CONFIG_FILE_NAME = "memmy-memory-config.json";

export interface CreatePiSkillTargetDeps {
  rootDirectory?: string;
  memmyConfigPath?: string;
}

export function createPiSkillTarget(deps: CreatePiSkillTargetDeps = {}): SkillTarget {
  const rootDirectory = deps.rootDirectory ?? resolvePiHomeDirectory();
  const memmyConfigPath = deps.memmyConfigPath ?? join(homedir(), ".memmy", "config.yaml");

  return {
    targetId: PI_TARGET_ID,
    displayName: "Pi",
    async resolveRootDirectory() {
      return resolveExistingDirectory(rootDirectory);
    },
    async install(manifest) {
      const root = await requirePiRoot(rootDirectory);
      await installSkill(root, manifest);
    },
    async uninstall() {
      const root = await resolveExistingDirectory(rootDirectory);
      if (!root) return;
      await removeBootstrap(root);
      await removeMemmySkillDirectory(root);
    },
    async isInstalled() {
      const root = await resolveExistingDirectory(rootDirectory);
      if (!root) return false;
      return (await readTextFile(join(root, TARGET_FILE_NAME))).includes(START_MARKER);
    },
    async installPlugin() {
      const root = await requirePiRoot(rootDirectory);
      const extensionDirectory = join(root, EXTENSION_DIRECTORY_NAME);
      await mkdir(extensionDirectory, { recursive: true });
      await writeFileAtomically(join(extensionDirectory, EXTENSION_FILE_NAME), renderMemmyPiExtension());
      await writeFileAtomically(
        join(extensionDirectory, CONFIG_FILE_NAME),
        `${JSON.stringify({
          memmy_config_path: memmyConfigPath,
          ...(await readMemmyMemoryServiceConfig(memmyConfigPath))
        }, null, 2)}\n`
      );
      await installSkill(root, renderMemmyPluginSkillManifest(PI_TARGET_ID));
    },
    async uninstallPlugin() {
      const root = await resolveExistingDirectory(rootDirectory);
      if (!root) return;
      await rm(join(root, EXTENSION_DIRECTORY_NAME, EXTENSION_FILE_NAME), { force: true });
      await rm(join(root, EXTENSION_DIRECTORY_NAME, CONFIG_FILE_NAME), { force: true });
      await removeBootstrap(root);
      await removeMemmySkillDirectory(root);
    }
  };
}

async function installSkill(root: string, manifest: SkillManifest): Promise<void> {
  const filePath = join(root, TARGET_FILE_NAME);
  const existing = await readTextFile(filePath);
  await writeFileAtomically(filePath, upsertMarkerBlock(existing, renderMemmySkillBootstrapManifest(manifest)));
  await replaceMemmySkillDirectory(root, manifest);
}

async function removeBootstrap(root: string): Promise<void> {
  const filePath = join(root, TARGET_FILE_NAME);
  const existing = await readTextFile(filePath);
  if (existing.includes(START_MARKER)) {
    await writeFileAtomically(filePath, existing.replace(markerPattern(), ""));
  }
}

function upsertMarkerBlock(existing: string, manifest: SkillManifest): string {
  const block = `${manifest.marker}\n${manifest.content.trimEnd()}\n${END_MARKER}\n`;
  if (markerPattern().test(existing)) {
    return existing.replace(markerPattern(), block);
  }
  const separator = existing && !existing.endsWith("\n") ? "\n" : "";
  return `${existing}${separator}${block}`;
}

function markerPattern(): RegExp {
  return new RegExp(`${escapeRegExp(START_MARKER)}\\n[\\s\\S]*?${escapeRegExp(END_MARKER)}\\n?`, "m");
}

async function requirePiRoot(directory: string): Promise<string> {
  const root = await resolveExistingDirectory(directory);
  if (!root) throw new Error("Pi is not installed or its directory is unavailable");
  return root;
}

async function resolveExistingDirectory(directory: string): Promise<string | null> {
  try {
    return (await stat(directory)).isDirectory() ? directory : null;
  } catch (error) {
    if (isNodeError(error) && error.code === "ENOENT") return null;
    throw error;
  }
}

async function readTextFile(filePath: string): Promise<string> {
  try {
    return await readFile(filePath, "utf8");
  } catch (error) {
    if (isNodeError(error) && error.code === "ENOENT") return "";
    throw error;
  }
}

async function writeFileAtomically(filePath: string, content: string): Promise<void> {
  await mkdir(dirname(filePath), { recursive: true });
  const tempPath = join(dirname(filePath), `.${basename(filePath)}.${process.pid}.${Date.now()}.tmp`);
  await writeFile(tempPath, content, "utf8");
  await rename(tempPath, filePath);
}

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

function isNodeError(error: unknown): error is NodeJS.ErrnoException {
  return error instanceof Error && "code" in error;
}
