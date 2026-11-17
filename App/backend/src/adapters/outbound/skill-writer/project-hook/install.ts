/**
 * 项目钩子的安装与版本指纹：脚本、运行时副本、自己的配置文件，三样一起算一个指纹。
 *
 * <p>与记忆钩子的指纹（`hook-revision.ts`）分开：项目协作改读取逻辑只让这一份变旧，
 * 记忆钩子照旧是当前版本。</p>
 */
import { createHash } from "node:crypto";
import { mkdir, readFile, rename, rm, writeFile } from "node:fs/promises";
import { basename, dirname, join } from "node:path";
import { renderMemmyProjectHookScript } from "../templates/memmy-project-hook.js";
import type { MemmyProjectHookMode } from "./mode.js";
import { loadMemmyProjectHookRuntimeAsset } from "./runtime-loader.js";

export const PROJECT_HOOK_SCRIPT_FILE_NAME = "memmy-project-hook.mjs";
export const PROJECT_HOOK_RUNTIME_FILE_NAME = "memmy-project-runtime.mjs";
export const PROJECT_HOOK_CONFIG_FILE_NAME = "memmy-project-config.json";
export const PROJECT_HOOK_REVISION_FIELD = "project_hook_revision";

/** 安装一份项目钩子需要知道的东西：谁、哪种宿主、它自己的配置内容。 */
export interface ProjectHookBundle {
  /** 与这个目标一致的来源 id：claude_code / codex / cursor。 */
  source: string;
  mode: MemmyProjectHookMode;
  /** 写进 `memmy-project-config.json` 的内容，不含版本指纹。 */
  config: Record<string, unknown>;
}

/** 项目钩子自己的配置文件内容：只放运行时需要的路径，不含记忆服务的连接信息。 */
export function renderMemmyProjectHookConfig(input: {
  memmyConfigPath: string;
  codexHome?: string;
}): Record<string, unknown> {
  return {
    memmy_config_path: input.memmyConfigPath,
    ...(input.codexHome ? { codex_home: input.codexHome } : {})
  };
}

const revisionByKey = new Map<string, Promise<string>>();

/** 脚本、运行时与配置三样一起的指纹。 */
export function projectHookRevision(script: string, runtime: string, config: string): string {
  return createHash("sha256")
    .update(script)
    .update("\0")
    .update(runtime)
    .update("\0")
    .update(config)
    .digest("hex");
}

/** 这一份项目钩子应有的指纹；同一份 bundle 只算一次。 */
export function currentProjectHookRevision(bundle: ProjectHookBundle): Promise<string> {
  const configText = `${JSON.stringify(bundle.config, null, 2)}\n`;
  const key = `${bundle.mode}\0${bundle.source}\0${configText}`;
  const cached = revisionByKey.get(key);
  if (cached) return cached;

  const pending = (async () => {
    const script = renderMemmyProjectHookScript({ source: bundle.source, mode: bundle.mode });
    const runtime = await loadMemmyProjectHookRuntimeAsset();
    return projectHookRevision(script, runtime, configText);
  })().catch((error: unknown) => {
    revisionByKey.delete(key);
    throw error;
  });
  revisionByKey.set(key, pending);
  return pending;
}

/**
 * 安装（或原地更新）：先写脚本、运行时与配置，最后才把指纹写回配置。
 *
 * <p>顺序与记忆钩子一致：指纹写在文件之后，中途失败时磁盘上的指纹与文件对不上，
 * 下次会被判成需要更新，不会把一次中断的安装当成已完成。</p>
 */
export async function installProjectHookBundle(
  hookDirectory: string,
  bundle: ProjectHookBundle
): Promise<void> {
  await mkdir(hookDirectory, { recursive: true });
  const scriptPath = join(hookDirectory, PROJECT_HOOK_SCRIPT_FILE_NAME);
  const runtimePath = join(hookDirectory, PROJECT_HOOK_RUNTIME_FILE_NAME);
  const configPath = join(hookDirectory, PROJECT_HOOK_CONFIG_FILE_NAME);
  await writeFileAtomically(scriptPath, renderMemmyProjectHookScript({ source: bundle.source, mode: bundle.mode }));
  await writeFileAtomically(runtimePath, await loadMemmyProjectHookRuntimeAsset());
  await writeFileAtomically(configPath, `${JSON.stringify(bundle.config, null, 2)}\n`);
  const revision = await currentProjectHookRevision(bundle);
  await writeFileAtomically(
    configPath,
    `${JSON.stringify({ ...bundle.config, [PROJECT_HOOK_REVISION_FIELD]: revision }, null, 2)}\n`
  );
}

/** 移除项目钩子自己的三份文件；记忆钩子的文件一个都不碰。 */
export async function removeProjectHookBundle(hookDirectory: string): Promise<void> {
  await rm(join(hookDirectory, PROJECT_HOOK_SCRIPT_FILE_NAME), { force: true });
  await rm(join(hookDirectory, PROJECT_HOOK_RUNTIME_FILE_NAME), { force: true });
  await rm(join(hookDirectory, PROJECT_HOOK_CONFIG_FILE_NAME), { force: true });
}

/** 钩子文件是否已经落在磁盘上。 */
export async function isProjectHookBundleInstalled(hookDirectory: string): Promise<boolean> {
  const [script, runtime] = await Promise.all([
    readOptionalText(join(hookDirectory, PROJECT_HOOK_SCRIPT_FILE_NAME)),
    readOptionalText(join(hookDirectory, PROJECT_HOOK_RUNTIME_FILE_NAME))
  ]);
  return Boolean(script.trim() && runtime.trim());
}

/**
 * 已装的项目钩子是否就是这一份：三份文件都在，配置里记的指纹一致，且三份文件合起来的指纹也对得上。
 * 记录在文件替换之前写下的指纹说明上一次安装被打断了。
 */
export async function isInstalledProjectHookCurrent(
  hookDirectory: string,
  bundle: ProjectHookBundle
): Promise<boolean> {
  const [script, runtime, configText] = await Promise.all([
    readOptionalText(join(hookDirectory, PROJECT_HOOK_SCRIPT_FILE_NAME)),
    readOptionalText(join(hookDirectory, PROJECT_HOOK_RUNTIME_FILE_NAME)),
    readOptionalText(join(hookDirectory, PROJECT_HOOK_CONFIG_FILE_NAME))
  ]);
  if (!script.trim() || !runtime.trim()) return false;
  const stored = readStoredRevision(configText);
  if (!stored) return false;
  const expected = await currentProjectHookRevision(bundle);
  return stored === expected && projectHookRevision(script, runtime, `${JSON.stringify(bundle.config, null, 2)}\n`) === expected;
}

function readStoredRevision(configText: string): string | null {
  if (!configText.trim()) return null;
  try {
    const parsed = JSON.parse(configText) as unknown;
    if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) return null;
    const value = (parsed as Record<string, unknown>)[PROJECT_HOOK_REVISION_FIELD];
    return typeof value === "string" && value.trim() ? value : null;
  } catch {
    return null;
  }
}

async function readOptionalText(filePath: string): Promise<string> {
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
  try {
    await writeFile(tempPath, content, "utf8");
    await rename(tempPath, filePath);
  } finally {
    await rm(tempPath, { force: true });
  }
}

function isNodeError(error: unknown): error is NodeJS.ErrnoException {
  return error instanceof Error && "code" in error;
}
