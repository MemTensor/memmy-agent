/**
 * 内置 Agent 的启动配方。
 *
 * <p>成员协助要由执行方的 Memmy 在后台拉起对方选的 Agent。所有已支持的 Agent 都能走 ACP
 * （Agent Client Protocol）：7 个原生支持，另外 3 个（Claude Code、Codex、Pi）有现成的适配器。
 * 配方只描述「用哪个程序、带什么参数、要不要补环境变量」，协议交互都在 {@link ./acp-client}。</p>
 *
 * <p>这些程序的入口有一半来自桌面端自带的引擎或隐藏参数，对方升级后可能变化；因此每个配方都可以用
 * 环境变量覆盖（见 {@link ASSIST_COMMAND_ENV}），出问题时不必改代码。</p>
 */
import { existsSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";

/** 一个执行方怎么被拉起来：命令、参数、追加的环境变量。 */
export interface AssistRecipe {
  /** 内置来源的 sourceId，与协作项目「在其他 Agent 中使用协作项目」里的标识一致。 */
  sourceId: string;
  /** 界面上显示的名字。 */
  name: string;
  command: string;
  args: readonly string[];
  /** 需要补的环境变量：WorkBuddy 的包内引擎要靠它才会读取自己的 bundle。 */
  env?: Readonly<Record<string, string>>;
  /** 工作目录不方便指定时（CLI 固定工作目录），改用 ACP 的 cwd 告知。 */
  cwdHint?: string;
}

/**
 * 覆盖某个 Agent 的启动命令：`MEMMY_ASSIST_COMMAND_<SOURCE_ID>=…`，值按空格切成命令与参数。
 * 用于对方升级后路径变化的临时处置，不改代码。
 */
export function ASSIST_COMMAND_ENV(sourceId: string): string {
  return `MEMMY_ASSIST_COMMAND_${sourceId.toUpperCase().replace(/[^A-Z0-9]/gu, "_")}`;
}

/**
 * 各内置 Agent 的 ACP 入口。按内置来源的 sourceId 索引。
 *
 * <p>取不到配方时不猜，直接作为失败告诉双方（「王雨的 Cursor 未启动」），让人换个 Agent 或去修。</p>
 */
const RECIPES: readonly AssistRecipe[] = [
  // 这三个要适配器把 ACP 翻成它们自己的接口；适配器由 Memmy 在授权后自己装（见 ./adapters）。
  { sourceId: "claude_code", name: "Claude Code", command: "claude-agent-acp", args: [] },
  { sourceId: "codex", name: "Codex", command: "codex-acp", args: [] },
  // Cursor 的 ACP 入口是隐藏参数：帮助里看不到，但可以直接用。
  { sourceId: "cursor", name: "Cursor", command: "cursor-agent", args: ["acp"] },
  { sourceId: "opencode", name: "OpenCode", command: "opencode", args: ["acp"] },
  // OpenClaw 的 CLI 工作目录固定，改由 ACP 的 cwd 指定。
  { sourceId: "openclaw", name: "OpenClaw", command: "openclaw", args: ["acp"], cwdHint: "acp" },
  { sourceId: "hermes", name: "Hermes", command: "hermes", args: ["acp"] },
  {
    sourceId: "workbuddy",
    name: "WorkBuddy",
    command: "codebuddy",
    args: ["--acp"],
    env: { CODEBUDDY_FORCE_LITE_WB_BUNDLE: "1" }
  },
  // QwenWork 用桌面端包内的 Qoder 引擎，ACP 同样是隐藏参数。
  { sourceId: "qwenwork", name: "QwenWork", command: "qoderclicn", args: ["--acp"] },
  // DeepSeek Harness 的一次性模式不能续跑，协助统一走 ACP。
  { sourceId: "deepseek_harness", name: "DeepSeek Harness", command: "dsh", args: ["--profile", "acp"] },
  { sourceId: "pi", name: "Pi", command: "pi-acp", args: [] }
];

/** 执行方标识里 Memmy 自己不用 ACP：它在项目下新建一条 Memmy 任务执行（见 {@link ./memmy-runner}）。 */
export const MEMMY_SOURCE_ID = "memmy";

/** 一个可执行文件在常见位置：PATH、Homebrew、以及各个包管理器的全局 bin。 */
const LOOKUP_DIRS = [
  "/opt/homebrew/bin",
  "/usr/local/bin",
  "/usr/bin",
  join(homedir(), ".local", "bin"),
  join(homedir(), ".bun", "bin"),
  join(homedir(), ".cargo", "bin"),
  join(homedir(), ".npm-global", "bin")
];

export interface AssistAgentRecipe extends AssistRecipe {
  /** 实际要执行的命令；环境变量覆盖时用覆盖后的值。 */
  resolved: string;
}

/**
 * 取某个 Agent 的配方。命令找不到时先看环境变量覆盖，再在常见目录里找一次；
 * 都没有就返回配方本身（命令仍是原始值），由调用方把「未安装」变成给双方看的失败原因。
 */
export function assistRecipe(sourceId: string, env: NodeJS.ProcessEnv = process.env): AssistAgentRecipe | null {
  const base = RECIPES.find((recipe) => recipe.sourceId === sourceId);
  if (!base) return null;
  const override = env[ASSIST_COMMAND_ENV(sourceId)]?.trim();
  if (override) {
    const [command, ...args] = override.split(/\s+/u);
    return { ...base, resolved: command!, args };
  }
  return { ...base, resolved: base.command };
}

/** 这台电脑上可以拿来执行的 Agent：只列配置了配方且能运行的，界面用它说明「可用」。 */
export function availableAssistAgents(env: NodeJS.ProcessEnv = process.env): AssistAgentRecipe[] {
  return RECIPES.map((recipe) => assistRecipe(recipe.sourceId, env))
    .filter((recipe): recipe is AssistAgentRecipe => recipe !== null && assistRunnable(recipe.sourceId, env));
}

/**
 * 靠适配器接入 ACP 的 Agent 要看它本体的命令行：适配器可以在授权后按需安装，
 * 但本体不在，装上适配器也跑不起来。
 */
const BODY_COMMANDS: Readonly<Record<string, string>> = Object.freeze({
  claude_code: "claude",
  codex: "codex",
  pi: "pi"
});

/**
 * 这个 Agent 在这台电脑上能不能运行：有环境变量覆盖时看覆盖的命令；需要适配器的看本体命令行；
 * 其余看配方里的命令本身。没有配方的（用户自己添加的 Agent）一律不能由 Memmy 拉起。
 */
export function assistRunnable(sourceId: string, env: NodeJS.ProcessEnv = process.env): boolean {
  if (sourceId === MEMMY_SOURCE_ID) return true;
  const recipe = assistRecipe(sourceId, env);
  if (!recipe) return false;
  if (env[ASSIST_COMMAND_ENV(sourceId)]?.trim()) return findExecutable(recipe.resolved, env) !== null;
  const body = BODY_COMMANDS[sourceId];
  return findExecutable(body ?? recipe.command, env) !== null;
}

/** 在 PATH 与常见目录里找一个可执行文件；找不到时返回 null。 */
export function findExecutable(command: string, env: NodeJS.ProcessEnv = process.env): string | null {
  if (command.includes("/")) return existsSync(command) ? command : null;
  const dirs = [...(env.PATH ?? "").split(":").filter(Boolean), ...LOOKUP_DIRS];
  for (const dir of dirs) {
    const candidate = join(dir, command);
    if (existsSync(candidate)) return candidate;
  }
  return null;
}

/** 已知的 Agent 名：失败原因要说清是哪个 Agent 起不来。 */
export function assistAgentName(sourceId: string): string {
  if (sourceId === MEMMY_SOURCE_ID) return "Memmy";
  return RECIPES.find((recipe) => recipe.sourceId === sourceId)?.name ?? sourceId;
}