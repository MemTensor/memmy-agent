import { createHash } from "node:crypto";
import { mkdir, readFile, rename, rm, stat, writeFile } from "node:fs/promises";
import { homedir } from "node:os";
import { basename, dirname, join } from "node:path";
import YAML from "yaml";
import { resolveDeepseekHarnessHomeDirectory } from "../../agent-paths.js";
import {
  pathExists,
  removeMemmyResumeSkillDirectory,
  removeMemmySkillDirectory,
  replaceMemmyResumeSkillDirectory,
  replaceMemmySkillDirectory
} from "../skill-directory.js";
import { readMemmyMemoryServiceConfig } from "../memmy-runtime-config.js";
import {
  createDeepseekHarnessPluginPackageManifest,
  DEEPSEEK_HARNESS_PLUGIN_CLIENT,
  DEEPSEEK_HARNESS_PLUGIN_INDEX
} from "../templates/memmy-deepseek-harness-plugin.js";
import { renderMemmyPluginSkillManifest } from "../templates/memmy-plugin.js";
import type { SkillTarget } from "../types.js";
import { loadMemmyWorkspaceBridgeRuntimeAsset } from "../workspace-bridge/runtime-loader.js";

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
  const bridgePath = join(pluginDirectory, "memmy-workspace-bridge.mjs");
  const configPath = join(pluginDirectory, "memmy-memory-config.json");
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
      await replaceMemmyResumeSkillDirectory(rootDirectory, TARGET_ID);
    },

    async uninstall() {
      await removeMemmyResumeSkillDirectory(rootDirectory);
      await removeMemmySkillDirectory(rootDirectory);
    },

    async isInstalled() {
      const patch = await readTextFile(patchPath);
      if (!hasPluginRegistration(patch)) return false;
      const manifest = parseManifest(await readTextFile(join(pluginDirectory, "package.json")));
      if (manifest?.name !== PLUGIN_PACKAGE_NAME || manifest.type !== "module"
        || manifest.exports?.["."] !== "./index.mjs" || manifest.exports?.["./client"] !== "./client.js") return false;
      // Both installers own this layout, but their bridge bundles can differ.
      const files = [join(pluginDirectory, "index.mjs"), join(pluginDirectory, "client.js"), bridgePath, configPath];
      return (await Promise.all(files.map(isNonemptyFile))).every(Boolean);
    },

    async isInstalledHookCurrent() {
      if (!(await this.isInstalled(TARGET_ID))) return false;
      const index = await readTextFile(join(pluginDirectory, "index.mjs"));
      const client = await readTextFile(join(pluginDirectory, "client.js"));
      const manifest = await readTextFile(join(pluginDirectory, "package.json"));
      if (index !== DEEPSEEK_HARNESS_PLUGIN_INDEX || client !== DEEPSEEK_HARNESS_PLUGIN_CLIENT
        || manifest !== JSON.stringify(createDeepseekHarnessPluginPackageManifest(), null, 2) + "\n") return false;
      const config = parseDeepseekHarnessPluginConfig(await readTextFile(configPath));
      if (!config) return false;
      const bridge = await readTextFile(bridgePath);
      // Older installs have no recorded digest. Their installing runtime can still verify them.
      return config.bridgeIntegrity === undefined
        ? bridge === await loadMemmyWorkspaceBridgeRuntimeAsset()
        : config.bridgeIntegrity === bridgeIntegrity(bridge);
    },

    async isPluginInstalled() {
      return await pathExists(join(pluginDirectory, "index.mjs"))
        || (await readTextFile(patchPath)).includes(PATCH_START);
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
      const bridge = await loadMemmyWorkspaceBridgeRuntimeAsset();
      const config = { memmy_config_path: memmyConfigPath, ...(await readMemmyMemoryServiceConfig(memmyConfigPath)) };
      await writeFileAtomically(bridgePath, bridge);
      await upsertPatch(patchPath, renderPluginPatch(memmyConfigPath));
      await replaceMemmySkillDirectory(rootDirectory, renderMemmyPluginSkillManifest(TARGET_ID));
      await replaceMemmyResumeSkillDirectory(rootDirectory, TARGET_ID);
      await writeFileAtomically(configPath, JSON.stringify({ ...config, bridge_integrity: bridgeIntegrity(bridge) }, null, 2) + "\n");
    },

    async uninstallPlugin() {
      if (!(await this.resolveRootDirectory())) return;
      await removePatch(patchPath);
      await rm(pluginDirectory, { recursive: true, force: true });
      await removeMemmyResumeSkillDirectory(rootDirectory);
      await removeMemmySkillDirectory(rootDirectory);
    }
  };
}

function hasPluginRegistration(patch: string): boolean {
  try {
    const entries = YAML.parse(patch);
    return Array.isArray(entries) && entries.some((entry) => Array.isArray(entry?.insert)
      && entry.insert.some((plugin: { name?: string; id?: string } | null) =>
        plugin?.id === "memmy-memory" && plugin.name === PLUGIN_PACKAGE_NAME));
  } catch {
    return false;
  }
}

function parseManifest(text: string): { name?: string; type?: string; exports?: Record<string, string> } | null {
  try {
    return JSON.parse(text);
  } catch {
    return null;
  }
}

function parseDeepseekHarnessPluginConfig(text: string): { bridgeIntegrity?: string } | null {
  let value: unknown;
  try {
    value = JSON.parse(text);
  } catch {
    return null;
  }
  if (!isRecord(value)
    || typeof value.memmy_config_path !== "string" || !value.memmy_config_path.trim()
    || typeof value.endpoint !== "string" || !value.endpoint.trim()
    || typeof value.token !== "string") return null;
  if (("userId" in value && typeof value.userId !== "string")
    || ("workspaceHostId" in value && typeof value.workspaceHostId !== "string")) return null;
  if ("bridge_integrity" in value
    && (typeof value.bridge_integrity !== "string" || !/^\d+:[0-9a-f]{64}$/u.test(value.bridge_integrity))) return null;
  return typeof value.bridge_integrity === "string" ? { bridgeIntegrity: value.bridge_integrity } : {};
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

async function isNonemptyFile(path: string): Promise<boolean> {
  try {
    const info = await stat(path);
    return info.isFile() && info.size > 0;
  } catch (error) {
    if (isNodeError(error) && error.code === "ENOENT") return false;
    throw error;
  }
}

// Bump the revision when a bridge change needs to be distributed to existing DSH installs.
function bridgeIntegrity(bridge: string): string {
  return "1:" + createHash("sha256").update(bridge).digest("hex");
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
