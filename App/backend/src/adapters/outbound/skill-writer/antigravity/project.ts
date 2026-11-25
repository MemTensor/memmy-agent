import { lstat, mkdir, mkdtemp, readFile, rename, rm, rmdir } from "node:fs/promises";
import { dirname, join } from "node:path";
import {
  PROJECT_HOOK_SCRIPT_FILE_NAME,
  installProjectHookBundle,
  isInstalledProjectHookCurrent,
  isProjectHookBundleInstalled,
  removeProjectHookBundle,
  renderMemmyProjectHookConfig,
  writeFileAtomically
} from "../project-hook/install.js";
import {
  renderMemmyProjectBootstrapBlock,
  removeMemmyProjectBootstrapBlock,
  upsertMemmyProjectBootstrapBlock
} from "../templates/memmy-project-skill.js";

const PROJECT_PLUGIN_ID = "memmy-project-context";
const OWNED = "MemTensor";
const RULE_HEADER = "---\ntrigger: always_on\n---\n\n";

export function createAntigravityProjectIntegration(input: {
  root: string;
  memmyConfigPath: string;
  resolveRootDirectory(): Promise<string | null>;
  hookCommand(path: string): string;
}) {
  const plugin = join(input.root, "plugins", PROJECT_PLUGIN_ID);
  const manifestPath = join(plugin, "plugin.json");
  const manifest = JSON.stringify({
    name: PROJECT_PLUGIN_ID,
    displayName: "Memmy Project Context",
    version: "1.0.0",
    description: "Load Memmy project instructions and authorized project context.",
    author: OWNED
  }, null, 2) + "\n";
  const hooksPath = join(plugin, "hooks.json");
  const hooks = JSON.stringify({
    [PROJECT_PLUGIN_ID]: {
      PreInvocation: [{
        type: "command",
        command: input.hookCommand(join(plugin, PROJECT_HOOK_SCRIPT_FILE_NAME)) + " pre-invocation",
        timeout: 30
      }]
    }
  }, null, 2) + "\n";
  const bundle = {
    source: "antigravity",
    mode: "antigravity" as const,
    config: renderMemmyProjectHookConfig({ memmyConfigPath: input.memmyConfigPath })
  };
  const rulePath = join(input.root, "rules", "memmy-project-activation.md");
  const bootstrap = { skillFilePath: join(input.root, "skills", "memmy-project", "SKILL.md") };

  async function ownsPlugin(): Promise<boolean> {
    const contents = await readOptional(manifestPath);
    if (!contents) return false;
    try {
      const value = JSON.parse(contents);
      return value?.name === PROJECT_PLUGIN_ID && value.author === OWNED;
    } catch {
      return false;
    }
  }

  return {
    async writeProjectSkillBootstrap() {
      const text = await readOptional(rulePath);
      await writeFileAtomically(rulePath, upsertMemmyProjectBootstrapBlock(text || RULE_HEADER, bootstrap));
    },
    async removeProjectSkillBootstrap() {
      const text = await readOptional(rulePath);
      const remaining = removeMemmyProjectBootstrapBlock(text);
      if (text === remaining) return;
      if (remaining.trim() === RULE_HEADER.trim() || !remaining.trim()) await rm(rulePath, { force: true });
      else await writeFileAtomically(rulePath, remaining);
    },
    async isProjectSkillBootstrapCurrent() {
      return (await readOptional(rulePath)).includes(renderMemmyProjectBootstrapBlock(bootstrap));
    },
    async installProjectHook() {
      if (!await input.resolveRootDirectory()) throw new Error("Antigravity App is unavailable");
      const current = await lstat(plugin).catch(missing);
      if (current && (!current.isDirectory() || !await ownsPlugin())) {
        throw new Error("The Antigravity project plugin directory is already in use");
      }
      if (current) {
        await installProjectHookBundle(plugin, bundle);
        await writeFileAtomically(hooksPath, hooks);
        await writeFileAtomically(manifestPath, manifest);
        return;
      }
      await mkdir(dirname(plugin), { recursive: true });
      const staging = await mkdtemp(join(input.root, ".memmy-project-install-"));
      try {
        await installProjectHookBundle(staging, bundle);
        await writeFileAtomically(join(staging, "hooks.json"), hooks);
        await writeFileAtomically(join(staging, "plugin.json"), manifest);
        await rename(staging, plugin);
      } finally {
        await rm(staging, { force: true, recursive: true });
      }
    },
    async uninstallProjectHook() {
      if (!await ownsPlugin()) return;
      await rm(hooksPath, { force: true });
      await removeProjectHookBundle(plugin);
      await rm(manifestPath, { force: true });
      await rmdir(plugin).catch(() => undefined);
    },
    async isProjectHookInstalled() {
      return await ownsPlugin() && !!await readOptional(hooksPath) && await isProjectHookBundleInstalled(plugin);
    },
    async isProjectHookCurrent() {
      return await readOptional(manifestPath) === manifest
        && await readOptional(hooksPath) === hooks
        && await isInstalledProjectHookCurrent(plugin, bundle);
    }
  };
}

function readOptional(path: string): Promise<string> {
  return readFile(path, "utf8").catch((error: unknown) => {
    missing(error);
    return "";
  });
}

function missing(error: unknown): undefined {
  if (error instanceof Error && "code" in error && error.code === "ENOENT") return undefined;
  throw error;
}
