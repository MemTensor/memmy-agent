/**
 * DeepSeek Harness（下称 DSH）的启动入口。
 *
 * <p>DSH 有两处入口，能跑 ACP 的条件不一样：</p>
 *
 * <ul>
 *   <li>桌面版：{@code /Applications/DeepSeek Harness.app} 自带完整的 dsh（在 app.asar 里）。它的 Node
 *   能读 asar，所以用包内的 {@code bin.js} 作为参数、把应用本身当 Node 跑（{@code ELECTRON_RUN_AS_NODE=1}）。
 *   桌面版的版本都带内置的 {@code acp} profile。</li>
 *   <li>命令行：全局 {@code dsh} 需要 0.2.0 及以上才有 {@code acp} profile；更早的版本执行
 *   {@code --profile acp} 会直接报 profile 不存在并退出。</li>
 * </ul>
 *
 * <p>更麻烦的是模型：{@code acp} profile 里的 {@code @deepseek-ai/dsh-acp} 自带
 * {@code deepseek-official / deepseek-v4-flash}，没有官方 Key 时会报「no API key」。而用户在桌面版里
 * 选的模型写在 {@code ~/.dsh/profiles/desktop/cordis.patch.yml} 的 {@code agent-default-model} 里，
 * {@code acp} profile 读不到这份补丁。因此这里把桌面版的补丁层叠上去，并另外生成一小段补丁，把 acp 插件的
 * 模型改成桌面版的默认模型——用户不用装命令行、也不用改任何配置。</p>
 *
 * <p>凭据由 dsh 自己从 {@code ~/.dsh/.credentials.yaml} 读，Memmy 不碰。</p>
 */
import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, readFileSync, realpathSync, statSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join } from "node:path";
import { parse as parseYaml, stringify as stringifyYaml } from "yaml";

import { ASSIST_COMMAND_ENV, findExecutable, shellLaunch } from "./executables.js";

/** 与内置来源的标识一致，协作项目的执行方就按它记录。 */
export const DEEPSEEK_HARNESS_SOURCE_ID = "deepseek_harness";

/** 桌面版包内的 dsh 入口：相对 {@code Contents/Resources/app.asar}。 */
const DESKTOP_DSH_BIN = join("dsh", "node_modules", "@deepseek-ai", "dsh", "lib", "bin.js");

/** 读版本不能让界面卡住：命令行慢或卡死时按「读不到版本」处理。 */
const VERSION_TIMEOUT_MS = 5_000;

export interface DeepSeekHarnessOptions {
  env?: NodeJS.ProcessEnv;
  /** Memmy 自己的目录：生成的模型补丁写在这下面。默认 {@code MEMMY_HOME}，再退回 {@code ~/.memmy}。 */
  home?: string;
  /** dsh 的主目录。默认 {@code DSH_HOME}，再退回 {@code ~/.dsh}。 */
  dshHome?: string;
  /** 桌面版的位置，按顺序找。默认 {@code /Applications} 与 {@code ~/Applications}，测试可注入。 */
  appDirs?: readonly string[];
}

export type DeepSeekHarnessResolution =
  | {
      ok: true;
      /** 入口从哪来：桌面版、命令行、还是环境变量覆盖。 */
      via: "desktop" | "cli" | "override";
      command: string;
      args: string[];
      /** 需要补的环境变量（桌面版要 {@code ELECTRON_RUN_AS_NODE=1}）。 */
      env: Record<string, string>;
    }
  | { ok: false; reason: string };

/**
 * 桌面版的默认位置。
 *
 * <p>只认 macOS 的 `.app` 包：Windows 桌面版的可执行文件位置与资源布局都没有核实过（不是 `.app`
 * 结构，包内 dsh 的路径也不同），不猜。Windows 上返回空数组，{@link resolveDeepSeekHarness} 会直接
 * 去找命令行 `dsh`，都没找到时失败原因说的是「没有找到桌面版，也没有找到 dsh 命令行」。</p>
 */
export function defaultHarnessAppDirs(platform: NodeJS.Platform = process.platform): string[] {
  if (platform === "win32") return [];
  return ["/Applications/DeepSeek Harness.app", join(homedir(), "Applications", "DeepSeek Harness.app")];
}

/**
 * 找到 DSH 的入口，不带任何与 profile 有关的参数；找不到时说明原因。
 *
 * <p>顺序：环境变量覆盖 → 桌面版 → 命令行（且版本支持 acp）。环境变量覆盖保持原有行为，值按空格切成
 * 命令与参数，不再追加任何东西。</p>
 */
export function resolveDeepSeekHarness(options: DeepSeekHarnessOptions = {}): DeepSeekHarnessResolution {
  const env = options.env ?? process.env;
  const override = env[ASSIST_COMMAND_ENV(DEEPSEEK_HARNESS_SOURCE_ID)]?.trim();
  if (override) {
    const [command, ...args] = override.split(/\s+/u);
    if (!command) return { ok: false, reason: "启动命令是空的" };
    return { ok: true, via: "override", command, args, env: {} };
  }

  const desktop = findDesktopHarness(options);
  if (desktop) return { ok: true, via: "desktop", ...desktop };

  const cli = findExecutable("dsh", env);
  if (!cli) {
    return { ok: false, reason: "没有找到 DeepSeek Harness 桌面版，也没有找到 dsh 命令行" };
  }
  if (!supportsAcpProfile(cli, env)) {
    return { ok: false, reason: "dsh 命令行版本太旧：0.2.0 及以上才支持协助要用的 acp 模式" };
  }
  return { ok: true, via: "cli", command: cli, args: [], env: {} };
}

/**
 * 真正拉起时要用的命令、参数与环境变量：在入口后补 {@code --profile acp}，再把手上的模型补丁叠上去。
 * 找不到 DSH 时返回原因。
 */
export function deepSeekHarnessLaunch(options: DeepSeekHarnessOptions = {}): DeepSeekHarnessResolution {
  const resolved = resolveDeepSeekHarness(options);
  if (!resolved.ok) return resolved;
  // 环境变量覆盖由使用者自己写全，不再替他加参数（保持原有行为）。
  if (resolved.via === "override") return resolved;
  return { ...resolved, args: [...resolved.args, "--profile", "acp", ...acpArgs(options)] };
}

/** 桌面版自带的 dsh：用应用本身当 Node，包内的 bin.js 作为第一个参数。 */
function findDesktopHarness(
  options: DeepSeekHarnessOptions
): { command: string; args: string[]; env: Record<string, string> } | null {
  for (const appDir of options.appDirs ?? defaultHarnessAppDirs()) {
    const bundle = appDir.replace(/[\\/]+$/u, "");
    const executable = join(bundle, "Contents", "MacOS", "DeepSeek Harness");
    const asar = join(bundle, "Contents", "Resources", "app.asar");
    // 普通 Node 在 asar 里 existsSync 一定是 false，所以只判断「应用在」与「asar 在」这两件事；
    // 包内路径随版本稳定，作为参数交给桌面版自己的 Node 就能读。
    if (!existsSync(executable) || !existsSync(asar)) continue;
    return { command: executable, args: [join(asar, DESKTOP_DSH_BIN)], env: { ELECTRON_RUN_AS_NODE: "1" } };
  }
  return null;
}

/**
 * acp profile 要叠的补丁：桌面版的补丁层（里面有用户的模型渠道配置）与 Memmy 生成的模型补丁。
 * 没有桌面版补丁时不加参数，让 DSH 用它自己的默认。
 */
function acpArgs(options: DeepSeekHarnessOptions): string[] {
  const desktopPatch = join(dshHome(options), "profiles", "desktop", "cordis.patch.yml");
  if (!existsSync(desktopPatch)) return [];
  const args = ["--patch", desktopPatch];
  const model = readDefaultModel(desktopPatch);
  const generated = model ? writeAcpModelPatch(options, model) : null;
  if (generated) args.push("--patch", generated);
  return args;
}

/** dsh 主目录：尊重 {@code DSH_HOME}。 */
function dshHome(options: DeepSeekHarnessOptions): string {
  const env = options.env ?? process.env;
  return options.dshHome?.trim() || env.DSH_HOME?.trim() || join(homedir(), ".dsh");
}

/** Memmy 自己的目录：与适配器放在一起（见 ./adapters），卸载 Memmy 时一起清掉。 */
function memmyHome(options: DeepSeekHarnessOptions): string {
  const env = options.env ?? process.env;
  return options.home?.trim() || env.MEMMY_HOME?.trim() || join(homedir(), ".memmy");
}

export interface DshDefaultModel {
  provider: string;
  model: string;
}

/**
 * 从桌面版的补丁层里读默认模型：{@code agent-default-model} 的 {@code provider} 与 {@code model}。
 * 读不出来（文件坏了、没配、或格式变了）时返回 null，此时不生成模型补丁。
 */
export function readDefaultModel(path: string): DshDefaultModel | null {
  let entries: unknown;
  try {
    // 桌面版补丁里允许 `!!js` 表达式：解析成字符串即可，不必求值，也不要把警告打到日志里。
    entries = parseYaml(readFileSync(path, "utf8"), { logLevel: "silent" });
  } catch {
    return null;
  }
  if (!Array.isArray(entries)) return null;
  for (const entry of entries) {
    if (!entry || typeof entry !== "object") continue;
    const record = entry as { id?: unknown; config?: unknown };
    if (record.id !== "agent-default-model") continue;
    const config = record.config as { provider?: unknown; model?: unknown } | undefined;
    const provider = typeof config?.provider === "string" ? config.provider.trim() : "";
    const model = typeof config?.model === "string" ? config.model.trim() : "";
    return provider && model ? { provider, model } : null;
  }
  return null;
}

/** 把 acp 插件的模型改成桌面版的默认模型，写进 Memmy 自己的目录；内容没变不重写。 */
function writeAcpModelPatch(options: DeepSeekHarnessOptions, model: DshDefaultModel): string | null {
  const file = join(memmyHome(options), "assist", "dsh-acp.patch.yml");
  const content = stringifyYaml([
    {
      id: "acp",
      name: "@deepseek-ai/dsh-acp",
      config: { provider: model.provider, model: model.model }
    }
  ]);
  try {
    if (existsSync(file) && readFileSync(file, "utf8") === content) return file;
    mkdirSync(dirname(file), { recursive: true });
    writeFileSync(file, content, "utf8");
    return file;
  } catch {
    // 写不了就退回 DSH 自己的默认模型：至少执行能起来，失败原因也会由它自己给出。
    return null;
  }
}

/** 版本够不够的判断结果缓存：每个可执行文件（按真实路径与修改时间）只跑一次 {@code dsh --version}。 */
const VERSION_CACHE = new Map<string, boolean>();

/** 这个命令行 dsh 有没有 {@code acp} profile：0.2.0 起才内置；读不到版本按没有处理。 */
function supportsAcpProfile(command: string, env: NodeJS.ProcessEnv): boolean {
  const key = versionCacheKey(command);
  const cached = VERSION_CACHE.get(key);
  if (cached !== undefined) return cached;
  const version = readVersion(command, env);
  const ok = version !== null && versionAtLeast(version, [0, 2, 0]);
  VERSION_CACHE.set(key, ok);
  return ok;
}

function versionCacheKey(command: string): string {
  try {
    const real = realpathSync(command);
    const stat = statSync(real);
    return `${real}:${stat.mtimeMs}:${stat.size}`;
  } catch {
    return command;
  }
}

function readVersion(command: string, env: NodeJS.ProcessEnv): number[] | null {
  try {
    // Windows 上命令行 dsh 可能是 `dsh.cmd`，execFile 不能直接跑批处理，同样交给 cmd.exe。
    const launch = shellLaunch(command, ["--version"], { env });
    const output = execFileSync(launch.command, launch.args, {
      encoding: "utf8",
      timeout: VERSION_TIMEOUT_MS,
      env,
      stdio: ["ignore", "pipe", "ignore"],
      ...(launch.windowsVerbatimArguments ? { windowsVerbatimArguments: true } : {})
    });
    const match = /(\d+)\.(\d+)\.(\d+)/u.exec(String(output));
    if (!match) return null;
    return [Number(match[1]), Number(match[2]), Number(match[3])];
  } catch {
    return null;
  }
}

function versionAtLeast(version: readonly number[], minimum: readonly number[]): boolean {
  for (let index = 0; index < minimum.length; index += 1) {
    const actual = version[index] ?? 0;
    const required = minimum[index] ?? 0;
    if (actual !== required) return actual > required;
  }
  return true;
}
