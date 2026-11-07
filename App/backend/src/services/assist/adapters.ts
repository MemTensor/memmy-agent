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
import { existsSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";

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

/** 已经装好的适配器：node_modules/.bin 里的那个文件在就算装好。 */
export function installedAdapterPath(adapter: AssistAdapter, home?: string): string | null {
  const candidate = join(adaptersDirectory(home), "node_modules", ".bin", adapter.bin);
  return existsSync(candidate) ? candidate : null;
}

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
  // 先让界面知道这一刻在做什么：装一次可能要十几秒，静默等待会让人以为卡住了。
  options.onInstalling?.();

  const failure = await runNpmInstall(adapter, directory, env);
  const executable = installedAdapterPath(adapter, options.home);
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
 */
function runNpmInstall(adapter: AssistAdapter, directory: string, env: NodeJS.ProcessEnv): Promise<string | null> {
  return new Promise((resolve) => {
    const child = spawn("npm", [
      "install",
      "--prefix", directory,
      "--no-audit", "--no-fund", "--loglevel=error",
      adapter.package
    ], { env, stdio: ["ignore", "pipe", "pipe"] });

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
