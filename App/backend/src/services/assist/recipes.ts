/**
 * 内置 Agent 的启动配方。
 *
 * <p>内置 Agent 大多能走 ACP（Agent Client Protocol）：六个原生支持，另外三个（Claude Code、
 * Codex、Pi）有现成的适配器。配方只描述「用哪个程序、带什么参数、要不要补环境变量」，
 * 协议交互都在 {@link ./acp-client}。</p>
 *
 * <p>这些程序的入口有一半来自桌面端自带的引擎或隐藏参数，对方升级后可能变化；因此每个配方都可以用
 * 环境变量覆盖（见 {@link ASSIST_COMMAND_ENV}），出问题时不必改代码。</p>
 */
import type { DeepSeekHarnessOptions } from "./deepseek-harness.js";
import { DEEPSEEK_HARNESS_SOURCE_ID, resolveDeepSeekHarness } from "./deepseek-harness.js";
import { ASSIST_COMMAND_ENV, findExecutable } from "./executables.js";

// 命令查找与覆盖用的环境变量拆到 ./executables：deepseek-harness 也要用，放在这里会形成环依赖。
export { ASSIST_COMMAND_ENV, findExecutable } from "./executables.js";

/** 一个执行方怎么被拉起来：命令、参数、追加的环境变量。 */
export interface AssistRecipe {
  /** 内置来源的 sourceId，与协作项目「在其他 Agent 中使用协作项目」里的标识一致。 */
  sourceId: string;
  /** 界面上显示的名字。 */
  name: string;
  command: string;
  args: readonly string[];
  /** 需要补的环境变量：有的 Agent 要靠它读取自己的配置。 */
  env?: Readonly<Record<string, string>>;
  /** 工作目录不方便指定时（CLI 固定工作目录），改用 ACP 的 cwd 告知。 */
  cwdHint?: string;
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
  // WorkBuddy 暂不支持执行协助（2026-11-05 下线）：原配方 `codebuddy --acp` 拉起的是另外安装的 CodeBuddy 命令行，
  // 账号、额度都不是 WorkBuddy 的；WorkBuddy 自带的引擎由桌面端带着内部参数与账号拉起，单独走 ACP 没有响应。
  // 等有稳定的调用方式再加回来。
  // QwenWork 用桌面端包内的 Qoder 引擎，ACP 同样是隐藏参数。
  { sourceId: "qwenwork", name: "QwenWork", command: "qoderclicn", args: ["--acp"] },
  // DeepSeek Harness 的一次性模式不能续跑，协助统一走 ACP。真正的入口与参数由 ./deepseek-harness 解析：
  // 桌面版自带的引擎优先，其次是版本够新的 dsh 命令行，并且要叠上桌面版的模型补丁。
  { sourceId: DEEPSEEK_HARNESS_SOURCE_ID, name: "DeepSeek Harness", command: "dsh", args: ["--profile", "acp"] },
  { sourceId: "pi", name: "Pi", command: "pi-acp", args: [] }
];

/** 执行方标识里 Memmy 自己不用 ACP：它在项目下新建一条 Memmy 任务执行（见 {@link ./memmy-runner}）。 */
export const MEMMY_SOURCE_ID = "memmy";

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
 * DeepSeek Harness 看桌面版或够新的命令行；其余看配方里的命令本身。没有配方的（用户自己添加的 Agent）
 * 一律不能由 Memmy 拉起。
 */
export function assistRunnable(
  sourceId: string,
  env: NodeJS.ProcessEnv = process.env,
  /** 只给测试注入桌面版位置与 dsh 主目录；正式运行按默认位置找。 */
  dsh: Pick<DeepSeekHarnessOptions, "appDirs" | "dshHome"> = {}
): boolean {
  if (sourceId === MEMMY_SOURCE_ID) return true;
  const recipe = assistRecipe(sourceId, env);
  if (!recipe) return false;
  if (env[ASSIST_COMMAND_ENV(sourceId)]?.trim()) return findExecutable(recipe.resolved, env) !== null;
  // DeepSeek Harness 的入口不止 PATH 上一个命令：桌面版自带的引擎能跑就够（见 ./deepseek-harness）。
  if (sourceId === DEEPSEEK_HARNESS_SOURCE_ID) return resolveDeepSeekHarness({ ...dsh, env }).ok;
  const body = BODY_COMMANDS[sourceId];
  return findExecutable(body ?? recipe.command, env) !== null;
}

/** 已知的 Agent 名：失败原因要说清是哪个 Agent 起不来。下线的也留着名字，旧记录里仍然按名字显示。 */
const RETIRED_NAMES: Readonly<Record<string, string>> = Object.freeze({ workbuddy: "WorkBuddy" });

export function assistAgentName(sourceId: string): string {
  if (sourceId === MEMMY_SOURCE_ID) return "Memmy";
  return RECIPES.find((recipe) => recipe.sourceId === sourceId)?.name ?? RETIRED_NAMES[sourceId] ?? sourceId;
}