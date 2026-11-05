/**
 * 执行方真正跑一次协助请求：先保证这个 Agent 的运行组件就位，再交给 ACP 客户端。
 *
 * <p>七个 Agent 原生支持 ACP，直接拉起它们自己的程序；Claude Code、Codex、Pi 需要一层适配器，
 * 由 {@link ./adapters} 在授权后按需装到 Memmy 自己的目录里——用户不需要先装任何东西。</p>
 *
 * <p>拉起失败、组件没装成、中途退出都变成一句能直接给双方看的原因（例如「没能准备好 Claude Code
 * 的运行组件」），由上层回传成 FAILED，而不是让请求一直停在「执行中」。</p>
 */
import { AcpError, runAcpAgent } from "./acp-client.js";
import { ensureAdapter } from "./adapters.js";
import { MEMMY_SOURCE_ID, assistAgentName, assistRecipe, findExecutable } from "./recipes.js";
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
}

export function createAcpAssistRunner(options: AcpAssistRunnerOptions = {}): AssistRunner {
  const env = options.env ?? process.env;
  return {
    async run(input) {
      const name = assistAgentName(input.agent);

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
      // 自带适配器优先；没有适配器的 Agent 回到 PATH 上找它自己的程序。
      const executable = adapter?.executable ?? findExecutable(recipe.resolved, env);
      if (!executable) {
        throw new AcpError(`${name} 未启动：没有找到 ${recipe.resolved}`, "unavailable");
      }

      return runAcpAgent({
        command: executable,
        args: recipe.args,
        cwd: input.cwd,
        ...(recipe.env ? { env: recipe.env } : {}),
        prompt: input.prompt,
        ...(input.sessionId ? { sessionId: input.sessionId } : {}),
        onStep: input.onStep,
        ...(input.onTranscript ? { onTranscript: input.onTranscript } : {}),
        onSession: input.onSession,
        signal: input.signal,
        ...(options.timeoutMs === undefined ? {} : { timeoutMs: options.timeoutMs })
      });
    }
  };
}