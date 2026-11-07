/**
 * 执行方真正跑一次协助请求：先保证这个 Agent 的运行组件就位，再交给 ACP 客户端。
 *
 * <p>六个 Agent 原生支持 ACP，直接拉起它们自己的程序；Claude Code、Codex、Pi 需要一层适配器，
 * 由 {@link ./adapters} 在授权后按需装到 Memmy 自己的目录里——用户不需要先装任何东西。</p>
 *
 * <p>拉起失败、组件没装成、中途退出都变成一句能直接给双方看的原因（例如「没能准备好 Claude Code
 * 的运行组件」），由上层回传成 FAILED，而不是让请求一直停在「执行中」。</p>
 *
 * <p>没登录不再直接失败：先由 Memmy 用这个 Agent 引擎自带的登录命令在她电脑上打开浏览器（见 ./login），
 * 登录完成后用同样的参数重跑一次，只重试一次。</p>
 */
import { AcpError, runAcpAgent, type AcpRunOptions } from "./acp-client.js";
import { ensureAdapter } from "./adapters.js";
import { DEEPSEEK_HARNESS_SOURCE_ID, deepSeekHarnessLaunch } from "./deepseek-harness.js";
import { signIn, type AssistSignInOutcome } from "./login.js";
import { MEMMY_SOURCE_ID, assistAgentName, assistRecipe, findExecutable, qwenWorkEngine } from "./recipes.js";
import { assistEnv } from "./shell-env.js";
import type { AssistRunner } from "../collab-assist-service.js";

/**
 * 按执行方分派：选了 Memmy 自己时在项目下新建一条 Memmy 任务（见 ./memmy-runner），其余 Agent 走 ACP。
 */
export function createAssistRunner(runners: { acp: AssistRunner; memmy: AssistRunner }): AssistRunner {
  return {
    run: (input) => (input.agent === MEMMY_SOURCE_ID ? runners.memmy : runners.acp).run(input)
  };
}

export interface AcpAssistRunnerOptions {
  env?: NodeJS.ProcessEnv;
  /** 单次请求上限，默认 15 分钟。 */
  timeoutMs?: number;
  /** 本机状态目录，默认 ~/.memmy；适配器也装在这下面。 */
  home?: string;
  /** QwenWork 应用包位置，测试可注入。 */
  qwenWorkAppDirs?: readonly string[];
  /** 等登录完成的上限，默认 5 分钟。 */
  loginTimeoutMs?: number;
}

/** 一次执行要用什么命令、参数、环境变量：装好适配器之后才定得下来。 */
interface AssistLaunch {
  command: string;
  args: readonly string[];
  env?: Readonly<Record<string, string>>;
  sessionConfig?: Readonly<Record<string, string>>;
}

export function createAcpAssistRunner(options: AcpAssistRunnerOptions = {}): AssistRunner {
  /**
   * 协助用的环境变量：打包后的 Memmy 进程 PATH 只有系统默认目录，要补上用户登录 shell 的那一份
   * （见 ./shell-env），否则 Homebrew / nvm 装的 npm、node 与各 Agent 的命令行都找不到。
   * 第一次真的要执行时才读：读一次要起一个登录 shell，不该拖慢启动。
   */
  let prepared: NodeJS.ProcessEnv | null = null;
  const assistEnvironment = (): NodeJS.ProcessEnv => (prepared ??= options.env ?? assistEnv());
  return {
    async run(input) {
      const name = assistAgentName(input.agent);
      const env = assistEnvironment();

      // 需要适配器的 Agent：没有就地装一次。装的过程作为一步进展显示出来，避免界面一直静着。
      const adapter = await ensureAdapter(input.agent, {
        ...(options.home === undefined ? {} : { home: options.home }),
        env,
        onInstalling: () => input.onStep({ text: `准备 ${name} 的运行组件` })
      }).catch(() => null);
      if (adapter && !adapter.executable) {
        throw new AcpError(adapter.failure ?? `没能准备好 ${name} 的运行组件`, "unavailable");
      }

      const recipe = assistRecipe(input.agent, env);
      if (!recipe) {
        // 不认识这个执行方：要么是手动添加的 Agent（Memmy 不读它的记录，也不驱动它），要么是被撤掉了。
        throw new AcpError(`${name} 不能由 Memmy 在这台电脑上启动`, "unavailable");
      }

      const launch = (): AssistLaunch => {
        // DeepSeek Harness 的入口与环境变量要单独解析：桌面版自带的引擎优先，参数里还要叠上模型补丁。
        if (input.agent === DEEPSEEK_HARNESS_SOURCE_ID) {
          const resolved = deepSeekHarnessLaunch({
            env,
            ...(options.home === undefined ? {} : { home: options.home })
          });
          if (!resolved.ok) throw new AcpError(`${name} 未启动：${resolved.reason}`, "unavailable");
          return { command: resolved.command, args: resolved.args, env: resolved.env };
        }
        // 自带适配器优先；QwenWork 的引擎在应用包里；其余回到 PATH 上找它自己的程序。
        const engine = input.agent === "qwenwork" ? qwenWorkEngine(env, options.qwenWorkAppDirs) : null;
        const command = adapter?.executable ?? engine ?? findExecutable(recipe.resolved, env);
        if (!command) {
          throw new AcpError(
            input.agent === "qwenwork"
              ? `${name} 未启动：没有找到它的引擎，确认 QwenWork 装在这台电脑上`
              : `${name} 未启动：没有找到 ${recipe.resolved}`,
            "unavailable"
          );
        }
        return {
          command,
          args: recipe.args,
          ...(recipe.env ? { env: recipe.env } : {}),
          ...(recipe.sessionConfig ? { sessionConfig: recipe.sessionConfig } : {})
        };
      };

      const runOnce = async () => {
        const current = launch();
        return await runAcpAgent({
          command: current.command,
          args: current.args,
          cwd: input.cwd,
          // 拉起 Agent 时也要带上补好的 PATH：Agent 自己的工具要靠它找到 node、git 这些命令。
          env: mergedEnv(env, current.env),
          prompt: input.prompt,
          agentName: name,
          ...(current.sessionConfig ? { sessionConfig: current.sessionConfig } : {}),
          ...(input.sessionId ? { sessionId: input.sessionId } : {}),
          onStep: input.onStep,
          ...(input.onTranscript ? { onTranscript: input.onTranscript } : {}),
          onSession: input.onSession,
          signal: input.signal,
          ...(options.timeoutMs === undefined ? {} : { timeoutMs: options.timeoutMs })
        });
      };

      try {
        return await runOnce();
      } catch (error) {
        if (!(error instanceof AcpError) || error.kind !== "unauthenticated") throw error;
        // 没登录：先替她发起这个 Agent 自己的登录，登录完成后重跑一次，只重试一次。
        const outcome: AssistSignInOutcome = await signIn({
          sourceId: input.agent,
          name,
          env,
          signal: input.signal,
          onStep: input.onStep,
          ...(options.home === undefined ? {} : { home: options.home }),
          ...(options.qwenWorkAppDirs === undefined ? {} : { qwenWorkAppDirs: options.qwenWorkAppDirs }),
          ...(adapter?.executable ? { adapterExecutable: adapter.executable } : {}),
          ...(options.loginTimeoutMs === undefined ? {} : { timeoutMs: options.loginTimeoutMs })
        });
        if (outcome === "cancelled") throw new AcpError("执行已停止", "cancelled");
        if (outcome !== "ok") throw new AcpError(signInFailure(name, outcome), "unauthenticated");
        return await runOnce();
      }
    }
  };
}

/** 执行用的环境变量：补好的 PATH 加上配方自己要的那几个变量（值都是确定的字符串）。 */
function mergedEnv(
  base: NodeJS.ProcessEnv,
  extra?: Readonly<Record<string, string>>
): NonNullable<AcpRunOptions["env"]> {
  const merged: Record<string, string> = {};
  for (const [key, value] of Object.entries(base)) {
    if (typeof value === "string") merged[key] = value;
  }
  for (const [key, value] of Object.entries(extra ?? {})) merged[key] = value;
  return merged;
}

/** 登录没成时给双方看的原因：直接说没成什么，不用比喻。 */
function signInFailure(name: string, outcome: Exclude<AssistSignInOutcome, "ok" | "cancelled">): string {
  // 没有可代为执行的登录命令：只能请她在自己电脑上登录一次。
  if (outcome === "unsupported") return `${name} 没有登录，在这台电脑上登录后再试`;
  if (outcome === "timeout") return `${name} 的登录页长时间没有完成，完成登录后再试`;
  return `${name} 的登录没有完成，完成登录后再试`;
}