import { mkdir, readFile, rename, rm, stat, writeFile } from "node:fs/promises";
import { homedir } from "node:os";
import { basename, dirname, join } from "node:path";
import { resolveDeepseekHarnessHomeDirectory } from "../../agent-paths.js";
import { removeMemmySkillDirectory, replaceMemmySkillDirectory } from "../skill-directory.js";
import {
  createDeepseekHarnessPluginPackageManifest,
  DEEPSEEK_HARNESS_PLUGIN_CLIENT,
  DEEPSEEK_HARNESS_PLUGIN_INDEX
} from "../templates/memmy-deepseek-harness-plugin.js";
import { renderMemmyPluginSkillManifest } from "../templates/memmy-plugin.js";
import type { SkillTarget } from "../types.js";

const TARGET_ID = "deepseek_harness";
const DISPLAY_NAME = "DeepSeek Harness";
const PATCH_START = "# memmy-memory plugin:start";
const PATCH_END = "# memmy-memory plugin:end";
const PLUGIN_PACKAGE_NAME = "@memmy/memmy-memory";

export interface CreateDeepseekHarnessSkillTargetDeps {
  rootDirectory?: string;
  memmyConfigPath?: string;
}

export function createDeepseekHarnessSkillTarget(
  deps: CreateDeepseekHarnessSkillTargetDeps = {}
): SkillTarget {
  const rootDirectory = deps.rootDirectory ?? resolveDeepseekHarnessHomeDirectory();
  const memmyConfigPath = deps.memmyConfigPath ?? join(homedir(), ".memmy", "config.yaml");
  const pluginDirectory = join(rootDirectory, "profiles", "node_modules", "@memmy", "memmy-memory");
  const patchPath = join(rootDirectory, "cordis.patch.yml");

  return {
    targetId: TARGET_ID,
    displayName: DISPLAY_NAME,

    async resolveRootDirectory() {
      return resolveExistingDirectory(rootDirectory);
    },

    async install(manifest) {
      if (!(await this.resolveRootDirectory())) {
        throw new Error("DeepSeek Harness is not installed or its directory is unavailable");
      }
      await replaceMemmySkillDirectory(rootDirectory, manifest);
    },

    async uninstall() {
      await removeMemmySkillDirectory(rootDirectory);
    },

    async isInstalled() {
      if (!(await this.resolveRootDirectory())) return false;
      const patch = await readTextFile(patchPath);
      const pluginSource = await readTextFile(join(pluginDirectory, "index.mjs"));
      const clientSource = await readTextFile(join(pluginDirectory, "client.js"));
      const packageSource = await readTextFile(join(pluginDirectory, "package.json"));
      return patch.includes("name: " + yamlString(PLUGIN_PACKAGE_NAME)) &&
        pluginSource === DEEPSEEK_HARNESS_PLUGIN_INDEX &&
        clientSource === DEEPSEEK_HARNESS_PLUGIN_CLIENT &&
        packageSource === JSON.stringify(createDeepseekHarnessPluginPackageManifest(), null, 2) + "\n";
    },

    async installPlugin() {
      if (!(await this.resolveRootDirectory())) {
        throw new Error("DeepSeek Harness is not installed or its directory is unavailable");
      }
      await mkdir(pluginDirectory, { recursive: true });
      await writeFileAtomically(
        join(pluginDirectory, "package.json"),
        JSON.stringify(createDeepseekHarnessPluginPackageManifest(), null, 2) + "\n"
      );
      await writeFileAtomically(join(pluginDirectory, "index.mjs"), DEEPSEEK_HARNESS_PLUGIN_INDEX);
      await writeFileAtomically(join(pluginDirectory, "client.js"), DEEPSEEK_HARNESS_PLUGIN_CLIENT);
      await upsertPatch(patchPath, renderPluginPatch(memmyConfigPath));
      await replaceMemmySkillDirectory(rootDirectory, renderMemmyPluginSkillManifest(TARGET_ID));
    },

    async uninstallPlugin() {
      if (!(await this.resolveRootDirectory())) return;
      await removePatch(patchPath);
      await rm(pluginDirectory, { recursive: true, force: true });
      await removeMemmySkillDirectory(rootDirectory);
    }
  };
}

function renderPluginPatch(memmyConfigPath: string): string {
  return [
    PATCH_START,
    "- insert:",
    "    - id: memmy-memory",
    "      name: " + yamlString(PLUGIN_PACKAGE_NAME),
    "      config:",
    "        memmyConfigPath: " + yamlString(memmyConfigPath),
    PATCH_END
  ].join("\n");
}

async function upsertPatch(filePath: string, block: string): Promise<void> {
  const existing = removePatchBlock(await readTextFile(filePath));
  const lines = existing.split(/\r?\n/u);
  const contentLines = lines.filter((line) => {
    const trimmed = line.trim();
    return trimmed && !trimmed.startsWith("#");
  });
  const base = contentLines.length === 1 && contentLines[0] === "[]"
    ? lines.filter((line) => line.trim() !== "[]").join("\n").trimEnd()
    : existing.trimEnd();
  await writeFileAtomically(filePath, [base, block, ""].filter((part, index) => part || index === 2).join("\n"));
}

async function removePatch(filePath: string): Promise<void> {
  const existing = await readTextFile(filePath);
  if (!existing.includes(PATCH_START)) return;
  const without = removePatchBlock(existing).trimEnd();
  const hasEntries = without.split(/\r?\n/u).some((line) => {
    const trimmed = line.trim();
    return trimmed && !trimmed.startsWith("#");
  });
  await writeFileAtomically(filePath, without + (without ? "\n" : "") + (hasEntries ? "" : "[]\n"));
}

function removePatchBlock(value: string): string {
  let result = value;
  while (true) {
    const start = result.indexOf(PATCH_START);
    if (start < 0) return result;
    const end = result.indexOf(PATCH_END, start);
    if (end < 0) throw new Error("Invalid Memmy patch block starting at " + PATCH_START);
    const lineEnd = result.indexOf("\n", end + PATCH_END.length);
    const after = lineEnd < 0 ? result.length : lineEnd + 1;
    result = result.slice(0, start).trimEnd() + "\n" + result.slice(after).trimStart();
  }
}

function yamlString(value: string): string {
  return "'" + value.replaceAll("'", "''") + "'";
}

async function readTextFile(filePath: string): Promise<string> {
  try {
    return await readFile(filePath, "utf8");
  } catch (error) {
    if (isNodeError(error) && error.code === "ENOENT") return "";
    throw error;
  }
}

async function resolveExistingDirectory(directory: string): Promise<string | null> {
  try {
    return (await stat(directory)).isDirectory() ? directory : null;
  } catch (error) {
    if (isNodeError(error) && error.code === "ENOENT") return null;
    throw error;
  }
}

async function writeFileAtomically(filePath: string, content: string): Promise<void> {
  await mkdir(dirname(filePath), { recursive: true });
  const tempPath = join(
    dirname(filePath),
    "." + basename(filePath) + "." + process.pid + "." + Date.now() + "." + Math.random().toString(16).slice(2) + ".tmp"
  );
  try {
    await writeFile(tempPath, content, "utf8");
    await rename(tempPath, filePath);
  } catch (error) {
    await rm(tempPath, { force: true });
    throw error;
  }
}

function isNodeError(error: unknown): error is NodeJS.ErrnoException {
  return error instanceof Error && "code" in error;
}
