/**
 * 执行方的运行组件（ACP 适配器）：按需安装，用户不需要自己动手。
 *
 * <p>六个内置 Agent 原生支持 ACP（Cursor、OpenCode、OpenClaw、Hermes、QwenWork、
 * DeepSeek Harness），直接拉起它们自己的程序即可。另外三个——Claude Code、Codex、Pi——需要一层
 * 适配器把 ACP 翻成它们各自的接口。适配器不随安装包分发：授权之后由 Memmy 自己装到
 * {@code ~/.memmy/assist/adapters}，装一次之后一直复用，升级时也由这里负责。</p>
 *
 * <p>安装失败不能静默：对方点完允许却一直等不到结果是最坏的情况。失败原因会作为这次执行的失败
 * 回传给双方，并说明是哪个 Agent 的运行组件没准备好。</p>
 */
import { spawn } from "node:child_process";
import { accessSync, chmodSync, constants as fsConstants, existsSync, realpathSync, statSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";

import { findExecutable, shellLaunch } from "./executables.js";
import { installPackages, type PackageRequest } from "./npm-install.js";

/** 需要适配器的 Agent：npm 包、要执行的可执行文件名、以及最小可用版本。 */
export interface AssistAdapter {
  sourceId: string;
  /** 界面上显示的名字，失败原因里要说清是哪个 Agent。 */
  name: string;
  /** 包名与版本（`@scope/name@1.2.3`）：交给系统 npm 时用的一整串。 */
  package: string;
  /** 只有包名：拼安装目录、找包内入口都用它。 */
  packageName: string;
  /** 包提供的可执行文件名；装好后去 node_modules/.bin 里找它。 */
  bin: string;
  /** 包内真正要跑的那份 JS：用 Memmy 自带的运行环境执行，不依赖对方装 node。 */
  entry: string;
  /** 这个适配器自己的代码要装的是哪几个包；引擎本体不在这里（见 {@link ADAPTER_ENGINE_PACKAGES}）。 */
  packages: readonly PackageRequest[];
  /** 由本机已装的 Agent 提供的包：不进 Memmy 的目录，避免下载几百 MB。 */
  enginePackages: readonly string[];
}

/**
 * 只有原生不支持 ACP 的三个才需要 adapter；其余 Agent 直接用它们自己的入口。
 *
 * <p>{@code packages} 为空表示这条还不走「不依赖 npm 的安装」（对子上游版本未核实的依赖树），
 * 继续用系统 npm，有内置目录时依旧优先用内置的那份。</p>
 */
export const ASSIST_ADAPTERS: readonly AssistAdapter[] = [
  {
    sourceId: "claude_code",
    name: "Claude Code",
    package: "@agentclientprotocol/claude-agent-acp@^0.100.0",
    packageName: "@agentclientprotocol/claude-agent-acp",
    // 包在改名后同时提供了两个可执行名，配方用新的那个。
    bin: "claude-agent-acp",
    entry: "dist/index.js",
    packages: [],
    enginePackages: []
  },
  {
    sourceId: "codex",
    name: "Codex",
    package: "@agentclientprotocol/codex-acp@^2.7.0",
    packageName: "@agentclientprotocol/codex-acp",
    bin: "codex-acp",
    entry: "dist/index.js",
    // 适配器自己的代码只有几 MB；`@openai/codex`（引擎，Windows 包解开 515 MB）由本机已装的
    // Codex 提供，执行时用 CODEX_PATH 指回去，不再下载。
    packages: [{ name: "@agentclientprotocol/codex-acp", version: "2.7.0" }],
    enginePackages: ["@openai/codex"]
  },
  {
    sourceId: "pi",
    name: "Pi",
    package: "pi-acp@^0.0.34",
    packageName: "pi-acp",
    bin: "pi-acp",
    entry: "dist/index.js",
    packages: [],
    enginePackages: []
  }
];

/** 安装超时：npm 走网络，冷启动可能慢，但也不能让执行一直挂着。 */
const INSTALL_TIMEOUT_MS = 180_000;

export interface AdapterInstallResult {
  /** 装好（或本来就装好）的可执行文件绝对路径；没装成时为 null。 */
  executable: string | null;
  /** 这次是否真的跑了一次安装。 */
  installed: boolean;
  /** 没装成的原因，直接给双方看。 */
  failure?: string;
  /** 适配器包自己的入口（用 Memmy 的运行环境跑它，而不是系统 node）。 */
  entry?: string | null;
}

/**
 * 能由 Memmy 自己准备的那一份：安装包里预先放好（`<resources>/assist-adapters`），
 * 或者测试、排障时用环境变量指到别处。
 */
export function bundledAdaptersDirectory(env: NodeJS.ProcessEnv = process.env): string {
  const override = env.MEMMY_ASSIST_ADAPTERS_DIR?.trim();
  if (override) return override;
  const resources = (process as NodeJS.Process & { resourcesPath?: string }).resourcesPath;
  return resources ? join(resources, "assist-adapters") : "";
}

/** 内置目录里的包入口：打包时把 adapter 包放进去，第一次执行不必联网。 */
export function bundledAdapterPath(adapter: AssistAdapter, env: NodeJS.ProcessEnv = process.env): string | null {
  const root = bundledAdaptersDirectory(env);
  if (!root) return null;
  return packageEntry(join(root, "node_modules"), adapter);
}

/** 适配器包里的入口 JS：`node_modules/<package>/<entry>`。 */
function packageEntry(nodeModules: string, adapter: AssistAdapter): string | null {
  const candidate = join(nodeModules, adapter.packageName, adapter.entry);
  return existsSync(candidate) ? candidate : null;
}

/** 适配器装在哪个目录：与协助的本机状态放在一起，卸载 Memmy 时一起清掉。 */
export function adaptersDirectory(home = process.env.MEMMY_HOME?.trim() || join(homedir(), ".memmy")): string {
  return join(home, "assist", "adapters");
}

export function adapterFor(sourceId: string): AssistAdapter | null {
  return ASSIST_ADAPTERS.find((adapter) => adapter.sourceId === sourceId) ?? null;
}

/**
 * 已经装好的适配器：node_modules/.bin 里的那个文件在、而且能执行，才算装好。
 *
 * <p>「在」不等于「能跑」：`.bin` 里是一个指向包内 `dist/index.js` 的软链接，而 npm 只在部分情况下
 * 才给目标文件加可执行位。实测同一个包、同样的 npm（10.9.8），在干净目录里装出来是 `-rwxr-xr-x`，
 * 在已有旧 `package-lock.json` 的目录里（`npm install` 认为 up to date、不重写文件）却是
 * `-rw-r--r--`；此时直接 spawn 这个软链接就报 EACCES，表现为「无法启动这个 Agent」。所以这里补一次
 * 可执行位：补得上就照常使用，补不上（例如文件系统只读）才当作没装好，让它走重装。</p>
 */
export function installedAdapterPath(adapter: AssistAdapter, home?: string): string | null {
  const binDir = join(adaptersDirectory(home), "node_modules", ".bin");
  // Windows 上 npm 给每个 bin 装出 `名字.cmd`（批处理）与一个给 posix shell 用的同名脚本；
  // 后者在 Windows 上跑不起来，所以先找 `.cmd`。macOS / Linux 只有一个普通文件，保持原样。
  const names = process.platform === "win32"
    ? [`${adapter.bin}.cmd`, `${adapter.bin}.exe`, adapter.bin]
    : [adapter.bin];
  for (const name of names) {
    const candidate = join(binDir, name);
    if (existsSync(candidate) && ensureExecutable(candidate)) return candidate;
  }
  return null;
}

/**
 * 保证这个可执行文件能被执行：软链接顺着找到真实文件，没有执行位就补一个。
 * 返回是否可用——Windows 上没有可执行位这回事，直接算可用。
 */
function ensureExecutable(path: string): boolean {
  if (process.platform === "win32") return true;
  try {
    const target = realpathSync(path);
    if ((statSync(target).mode & 0o111) === 0) chmodSync(target, 0o755);
    accessSync(target, fsConstants.X_OK);
    return true;
  } catch {
    // 补不上（只读文件系统、没有权限、软链接断了）：当作没装好，交给重装。
    return false;
  }
}

/**
 * 正在装的适配器：同一次安装被几轮执行同时需要时只跑一次。
 * 不同排查的请求现在会同时执行，两个人恰好都选了这个 Agent 时，两次 npm install 装进同一个
 * node_modules 会互相破坏，因此按「目录 + 包」合并成一次。
 */
const installing = new Map<string, Promise<AdapterInstallResult>>();

/**
 * 这个 Agent 现在能用哪一份适配器：安装包里自带的那份优先（免下载），其次是之前装好的。
 * 返回包内入口 JS 的绝对路径；两边都没有时返回 null。
 */
export function adapterEntryPath(
  adapter: AssistAdapter,
  options: { home?: string; env?: NodeJS.ProcessEnv } = {}
): string | null {
  const env = options.env ?? process.env;
  const bundled = bundledAdapterPath(adapter, env);
  if (bundled) return bundled;
  return packageEntry(join(adaptersDirectory(options.home), "node_modules"), adapter);
}

/**
 * 拉起适配器要用的命令：用 Memmy 自己的运行环境执行包内入口，不要求这台电脑上有 node。
 *
 * <p>打包后的 Memmy 可执行文件在 `ELECTRON_RUN_AS_NODE=1` 时就是一个完整的 Node，
 * Memory runtime 已经这么做（`App/shell/desktop/src/main/runtime-services.ts`）。
 * 只有老版本装出来的 `.bin` 脚本（没有包内入口）才直接执行它。</p>
 */
export interface AdapterLaunchSpec {
  command: string;
  args: string[];
  env?: Record<string, string>;
}

export function adapterLaunch(
  adapter: AssistAdapter,
  options: { home?: string; env?: NodeJS.ProcessEnv } = {}
): AdapterLaunchSpec | null {
  const entry = adapterEntryPath(adapter, options);
  if (entry) {
    return { command: process.execPath, args: [entry], env: { ELECTRON_RUN_AS_NODE: "1" } };
  }
  const executable = installedAdapterPath(adapter, options.home);
  return executable ? { command: executable, args: [] } : null;
}

/**
 * 确保这个 Agent 的适配器可用：自带的那份、装好的那份、或者现场装一次。
 * 只有需要适配器的 Agent 才会走到这里；原生 ACP 的 Agent 返回 null 表示不需要。
 */
export async function ensureAdapter(
  sourceId: string,
  options: {
    home?: string;
    env?: NodeJS.ProcessEnv;
    onInstalling?: () => void;
    onProgress?: (message: string) => void;
    /** 测试注入：不联网时用它给一个会失败的 fetch，走「装不上」那条分支。 */
    fetch?: typeof fetch;
    registry?: string;
  } = {}
): Promise<AdapterInstallResult | null> {
  const adapter = adapterFor(sourceId);
  if (!adapter) return null;
  const env = options.env ?? process.env;
  // 之前装好的（包括只有 `.bin` 的老安装）直接用，不再走一次安装。
  const installed = installedAdapterPath(adapter, options.home);
  const entry = adapterEntryPath(adapter, { env, ...(options.home === undefined ? {} : { home: options.home }) });
  if (installed || entry) {
    return { executable: installed ?? entry, installed: false, entry };
  }

  const directory = adaptersDirectory(options.home);

  const key = `${directory}:${adapter.package}`;
  let installation = installing.get(key);
  if (!installation) {
    // 先让界面知道这一刻在做什么：装一次可能要十几秒，静默等待会让人以为卡住了。
    // 只在真的要装时说一次：同时等同一份安装的其余几轮不必重复提示。
    options.onInstalling?.();
    installation = runInstall(adapter, directory, env, options)
      .finally(() => installing.delete(key));
    installing.set(key, installation);
  }
  return await installation;
}

/** 真正跑一次安装：先走不依赖 npm 的那条，失败再退回系统 npm。装完重新看一次入口在不在。 */
async function runInstall(
  adapter: AssistAdapter,
  directory: string,
  env: NodeJS.ProcessEnv,
  options: {
    home?: string;
    onProgress?: (message: string) => void;
    fetch?: typeof fetch;
    registry?: string;
  }
): Promise<AdapterInstallResult> {
  const failures: string[] = [];
  if (adapter.packages.length) {
    try {
      await installPackages({
        root: directory,
        packages: adapter.packages,
        skip: adapter.enginePackages,
        signal: AbortSignal.timeout(INSTALL_TIMEOUT_MS),
        ...(options.fetch ? { fetch: options.fetch } : {}),
        ...(options.registry ? { registry: options.registry } : {}),
        ...(options.onProgress
          ? { onInstalled: (name, version) => options.onProgress?.(`准备 ${adapter.name} 的运行组件：${name}@${version}`) }
          : {})
      });
    } catch (error) {
      failures.push(error instanceof Error ? error.message : String(error));
    }
  }
  const entry = adapterEntryPath(adapter, { env, ...(options.home === undefined ? {} : { home: options.home }) });
  if (entry) {
    return { executable: installedAdapterPath(adapter, options.home) ?? entry, installed: true, entry };
  }
  // 不依赖 npm 的那条没成（例如对方网络要代理）：还有系统 npm 时再试一次，与以前的路径一致。
  const npmFailure = await runNpmInstall(adapter, directory, env);
  const executable = installedAdapterPath(adapter, options.home);
  const entryAfterNpm = adapterEntryPath(adapter, { env, ...(options.home === undefined ? {} : { home: options.home }) });
  if (executable || entryAfterNpm) {
    return { executable: executable ?? entryAfterNpm, installed: true, entry: entryAfterNpm };
  }
  const reason = [npmFailure, ...failures].filter((item): item is string => Boolean(item)).join("；");
  return {
    executable: null,
    installed: true,
    entry: null,
    failure: reason || `没能准备好 ${adapter.name} 的运行组件`
  };
}

/**
 * `npm install --prefix <目录> <包>`：装进 Memmy 自己的目录，不动用户的全局 npm。
 * npm 不存在（打包后的应用不带 Node）时给出可以直接读懂的原因。
 *
 * <p>Windows 上 npm 是 `npm.cmd`，Node 不能直接拉起，走 {@link shellLaunch} 交给 cmd.exe；
 * 解析不到时把命令名原样交给 cmd，让它用自己的 PATH 与 PATHEXT 去查。macOS / Linux 保持原来的
 * 直接 spawn，行为不变。</p>
 */
function runNpmInstall(adapter: AssistAdapter, directory: string, env: NodeJS.ProcessEnv): Promise<string | null> {
  return new Promise((resolve) => {
    const args = [
      "install",
      "--prefix", directory,
      "--no-audit", "--no-fund", "--loglevel=error",
      adapter.package
    ];
    const npm = process.platform === "win32" ? findExecutable("npm", env) : null;
    const launch = shellLaunch(npm ?? "npm", args, { always: process.platform === "win32", env });
    const child = spawn(launch.command, launch.args, {
      env,
      stdio: ["ignore", "pipe", "pipe"],
      ...(launch.windowsVerbatimArguments ? { windowsVerbatimArguments: true } : {})
    });

    let stderr = "";
    child.stderr.setEncoding("utf8");
    child.stderr.on("data", (chunk: string) => {
      stderr = `${stderr}${chunk}`.slice(-1_000);
    });

    const timer = setTimeout(() => {
      child.kill("SIGTERM");
      resolve(`准备 ${adapter.name} 的运行组件超时`);
    }, INSTALL_TIMEOUT_MS);

    child.on("error", (error: NodeJS.ErrnoException) => {
      clearTimeout(timer);
      resolve(error.code === "ENOENT"
        ? `这台电脑没有 npm，装不了 ${adapter.name} 的运行组件`
        : `装 ${adapter.name} 的运行组件失败：${error.message}`);
    });

    child.on("exit", (code) => {
      clearTimeout(timer);
      if (code === 0) resolve(null);
      else resolve(`装 ${adapter.name} 的运行组件失败：${lastLine(stderr) || `npm 退出码 ${code}`}`);
    });
  });
}

function lastLine(value: string): string {
  const lines = value.trim().split("\n");
  return lines[lines.length - 1]?.trim() ?? "";
}
