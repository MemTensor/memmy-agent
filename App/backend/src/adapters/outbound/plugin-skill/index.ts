/** Host-managed registration of skills contributed by active MPP plugins. */
import { cp, lstat, mkdir, mkdtemp, readFile, readdir, realpath, rename, rm, writeFile } from "node:fs/promises";
import { dirname, isAbsolute, join, relative, resolve, sep } from "node:path";
import type { PluginRuntimeRecord } from "../plugin-runtime/types.js";

const OWNER_FILE = ".memmy-plugin-owner.json";

export interface PluginSkillManager {
  activate(plugin: PluginRuntimeRecord): Promise<void>;
  deactivate(pluginId: string): Promise<void>;
}

export interface CreatePluginSkillManagerOptions {
  skillsRoot: string;
}

export function createPluginSkillManager(options: CreatePluginSkillManagerOptions): PluginSkillManager {
  const configuredRoot = resolve(options.skillsRoot);
  return {
    async activate(plugin) {
      await mkdir(configuredRoot, { recursive: true });
      const skillsRoot = await realpath(configuredRoot);
      await this.deactivate(plugin.id);
      for (const skill of plugin.manifest.skills ?? []) {
        if (!plugin.rootPath) throw new Error(`Plugin skill requires an installed artifact: ${plugin.id}`);
        const pluginRoot = await realpath(plugin.rootPath);
        const sourceEntry = resolve(pluginRoot, skill.entry);
        assertDescendant(pluginRoot, sourceEntry);
        const entryInfo = await lstat(sourceEntry);
        if (!entryInfo.isFile() || entryInfo.isSymbolicLink() || await realpath(sourceEntry) !== sourceEntry) {
          throw new Error(`Plugin skill entry must be a regular file: ${skill.entry}`);
        }
        const sourceDirectory = dirname(sourceEntry);
        const target = resolve(skillsRoot, skill.id);
        assertDescendant(skillsRoot, target);
        await assertAvailableTarget(target, plugin.id);
        const temp = await mkdtemp(join(skillsRoot, ".plugin-skill-"));
        try {
          await cp(sourceDirectory, temp, { recursive: true, errorOnExist: true, force: false, verbatimSymlinks: true });
          const copiedEntry = join(temp, "SKILL.md");
          if (!(await lstat(copiedEntry)).isFile()) throw new Error(`Plugin skill directory does not contain SKILL.md: ${skill.entry}`);
          await writeFile(join(temp, OWNER_FILE), JSON.stringify({ pluginId: plugin.id, skillId: skill.id, version: plugin.version }), "utf8");
          await rm(target, { recursive: true, force: true });
          await rename(temp, target);
        } catch (error) {
          await rm(temp, { recursive: true, force: true });
          throw error;
        }
      }
    },

    async deactivate(pluginId) {
      const entries = await readdir(configuredRoot, { withFileTypes: true }).catch((error: NodeJS.ErrnoException) => {
        if (error.code === "ENOENT") return [];
        throw error;
      });
      for (const entry of entries) {
        if (!entry.isDirectory() || entry.name.startsWith(".plugin-skill-")) continue;
        const target = resolve(configuredRoot, entry.name);
        const owner = await readOwner(target);
        if (owner?.pluginId === pluginId) await rm(target, { recursive: true, force: true });
      }
    }
  };
}

export const noopPluginSkillManager: PluginSkillManager = {
  async activate() {},
  async deactivate() {}
};

async function assertAvailableTarget(target: string, pluginId: string): Promise<void> {
  const info = await lstat(target).catch((error: NodeJS.ErrnoException) => {
    if (error.code === "ENOENT") return null;
    throw error;
  });
  if (!info) return;
  if (!info.isDirectory() || info.isSymbolicLink()) throw new Error(`Plugin skill target is not a safe directory: ${target}`);
  const owner = await readOwner(target);
  if (owner?.pluginId !== pluginId) throw new Error(`Plugin skill id is already registered: ${target}`);
}

async function readOwner(directory: string): Promise<{ pluginId: string } | null> {
  try {
    const value = JSON.parse(await readFile(join(directory, OWNER_FILE), "utf8")) as { pluginId?: unknown };
    return typeof value.pluginId === "string" ? { pluginId: value.pluginId } : null;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT" || error instanceof SyntaxError) return null;
    throw error;
  }
}

function assertDescendant(parent: string, child: string): void {
  const path = relative(resolve(parent), resolve(child));
  if (!path || path === ".." || path.startsWith(`..${sep}`) || isAbsolute(path)) {
    throw new Error("Plugin skill path escapes its artifact root");
  }
}
