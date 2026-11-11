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

/** 需要适配器的 Agent：npm 包、要执行的可执行文件名、以及最小可用版本。 */
export interface AssistAdapter {
  sourceId: string;
  /** 界面上显示的名字，失败原因里要说清是哪个 Agent。 */
  name: string;
  package: string;
  /** 包提供的可执行文件名；装好后去 node_modules/.bin 里找它。 */
  bin: string;
}

/** 只有原生不支持 ACP 的三个才需要适配器；其余 Agent 直接用它们自己的入口。 */
export const ASSIST_ADAPTERS: readonly AssistAdapter[] = [
  {
    sourceId: "claude_code",
    name: "Claude Code",
    package: "@agentclientprotocol/claude-agent-acp@^0.100.0",
    // 包在改名后同时提供了两个可执行名，配方用新的那个。
    bin: "claude-agent-acp"
  },
  { sourceId: "codex", name: "Codex", package: "@agentclientprotocol/codex-acp@^2.5.0", bin: "codex-acp" },
  { sourceId: "pi", name: "Pi", package: "pi-acp@^0.0.34", bin: "pi-acp" }
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
 * 确保这个 Agent 的适配器可用：已经装好就直接用，否则装一次。
 * 只有需要适配器的 Agent 才会走到这里；原生 ACP 的 Agent 返回 null 表示不需要。
 */
export async function ensureAdapter(
  sourceId: string,
  options: { home?: string; env?: NodeJS.ProcessEnv; onInstalling?: () => void } = {}
): Promise<AdapterInstallResult | null> {
  const adapter = adapterFor(sourceId);
  if (!adapter) return null;
  const existing = installedAdapterPath(adapter, options.home);
  if (existing) return { executable: existing, installed: false };

  const env = options.env ?? process.env;
  const directory = adaptersDirectory(options.home);

  const key = `${directory}:${adapter.package}`;
  let installation = installing.get(key);
  if (!installation) {
    // 先让界面知道这一刻在做什么：装一次可能要十几秒，静默等待会让人以为卡住了。
    // 只在真的要装时说一次：同时等同一份安装的其余几轮不必重复提示。
    options.onInstalling?.();
    installation = runInstall(adapter, directory, env, options.home).finally(() => installing.delete(key));
    installing.set(key, installation);
  }
  return await installation;
}

/** 真正跑一次安装，装完再看一次可执行文件在不在。 */
async function runInstall(
  adapter: AssistAdapter,
  directory: string,
  env: NodeJS.ProcessEnv,
  home?: string
): Promise<AdapterInstallResult> {
  const failure = await runNpmInstall(adapter, directory, env);
  const executable = installedAdapterPath(adapter, home);
  if (executable) return { executable, installed: true };
  return {
    executable: null,
    installed: true,
    failure: failure ?? `没能准备好 ${adapter.name} 的运行组件`
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
