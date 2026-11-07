/**
 * 执行方选了 Memmy 自己：在这台电脑的对应项目下新建一条 Memmy 任务，把请求交给它执行。
 *
 * <p>与外部 Agent 不同，这里不拉起子进程：任务由运行时按界面同一条路径执行（见 memmy-agent 的
 * `/api/webui/assist/runs`），执行方打开项目就能看到这条任务，过程实时可见，也可以在任务里直接停止。
 * 后端只负责发起、每秒读一次进度、把结果交回上层回传给发起方。</p>
 *
 * <p>同一次排查的后续请求续在同一条任务里（会话 id 就是任务 id），Memmy 记得前面查到的内容。</p>
 */
import type { AssistRunSnapshot, MemmyAgentAdminClient } from "../../adapters/outbound/memmy-agent-admin-client/index.js";
import type { AssistRunner } from "../collab-assist-service.js";
import { ACP_TIMEOUT_MS, AcpError, type AssistStep } from "./acp-client.js";
import { ASSIST_RESULT_FORMAT } from "./prompt.js";

export interface MemmyAssistRunnerOptions {
  client: Pick<MemmyAgentAdminClient, "startAssistRun" | "readAssistRun" | "stopAssistRun">;
  /** 云端项目在这台电脑上对应的 Memmy 项目；没有时任务建成独立任务。 */
  localProjectId: (cloudProjectId: string) => Promise<string | null>;
  /** 读进度的间隔，默认 1 秒。 */
  pollIntervalMs?: number;
  /** 单次请求上限，与外部 Agent 一致，默认 15 分钟。 */
  timeoutMs?: number;
}

const DEFAULT_POLL_MS = 1_000;
/** 连续读不到进度这么多次（运行时短暂不可用），才当作失败。 */
const MAX_READ_FAILURES = 10;

export function createMemmyAssistRunner(options: MemmyAssistRunnerOptions): AssistRunner {
  const pollMs = options.pollIntervalMs ?? DEFAULT_POLL_MS;
  const timeoutMs = options.timeoutMs ?? ACP_TIMEOUT_MS;
  const { client } = options;
  return {
    async run(input) {
      if (!client.startAssistRun || !client.readAssistRun) {
        throw new AcpError("这台电脑上的 Memmy 还不支持执行协助请求，需要更新到新版本", "unavailable");
      }
      const request = input.request;
      const projectId = await options.localProjectId(request.projectId).catch(() => null);
      let current: AssistRunSnapshot;
      try {
        current = await client.startAssistRun({
          projectId,
          ...(input.sessionId ? { chatId: input.sessionId } : {}),
          title: request.title,
          content: input.prompt,
          assist: {
            requestId: request.id,
            threadId: request.threadId,
            cloudProjectId: request.projectId,
            requesterName: request.requester.name,
            requesterId: request.requester.userId,
            via: request.via,
            attempt: request.attempt,
            title: request.title,
            // 结果的写法交给模型、不出现在任务里：任务页只显示请求卡片。
            context: ASSIST_RESULT_FORMAT
          }
        });
      } catch (error) {
        throw new AcpError(`Memmy 没能开始执行：${error instanceof Error ? error.message : String(error)}`, "unavailable");
      }
      const chatId = current.chatId;
      input.onSession(chatId);
      // 这一轮实际交给模型、不在任务里显示的格式要求：协助会话里与提示词分开显示。
      if (current.promptContext) input.onPromptContext?.(current.promptContext);
      if (current.status === "failed") throw new AcpError(failureText(current.error), "failed");

      let stopRequested = false;
      const onAbort = () => {
        stopRequested = true;
        void client.stopAssistRun?.(chatId).catch(() => undefined);
      };
      if (input.signal.aborted) onAbort();
      else input.signal.addEventListener("abort", onAbort, { once: true });

      const deadline = Date.now() + timeoutMs;
      let shownSteps = "";
      let shownTranscript = "";
      let readFailures = 0;
      const publishSteps = (snapshot: AssistRunSnapshot) => {
        const steps = toSteps(snapshot);
        const key = JSON.stringify(steps);
        if (key !== shownSteps) {
          shownSteps = key;
          input.onSteps?.(steps);
        }
        const transcript = snapshot.transcript ?? [];
        const transcriptKey = JSON.stringify(transcript);
        if (transcriptKey !== shownTranscript) {
          shownTranscript = transcriptKey;
          input.onTranscript?.(transcript);
        }
      };
      const failWith = (error: AcpError): AcpError => Object.assign(error, { transcript: current.transcript ?? [] });
      try {
        publishSteps(current);
        while (!isFinished(current.status)) {
          if (Date.now() > deadline) {
            await client.stopAssistRun?.(chatId).catch(() => undefined);
            throw failWith(new AcpError("执行超过 15 分钟，已停止", "timeout"));
          }
          await sleep(pollMs);
          let next: AssistRunSnapshot | null;
          try {
            next = await client.readAssistRun(chatId);
            readFailures = 0;
          } catch {
            readFailures += 1;
            if (readFailures >= MAX_READ_FAILURES) throw failWith(new AcpError("读不到 Memmy 的执行进度，这次没有完成", "failed"));
            continue;
          }
          // 运行时不认识这条任务：多半是执行中重启过，这一轮的结果已经拿不到了。
          if (!next) throw failWith(new AcpError("Memmy 在执行中重新启动了，这次没有完成", "failed"));
          current = next;
          publishSteps(current);
        }
      } finally {
        input.signal.removeEventListener("abort", onAbort);
      }

      if (current.status === "stopped") {
        throw failWith(new AcpError(stopRequested ? "已停止当前执行" : "执行方在任务里停止了这次执行", "cancelled"));
      }
      if (current.status === "failed") throw failWith(new AcpError(failureText(current.error), "failed"));
      return { reply: current.reply, steps: toSteps(current), transcript: current.transcript ?? [], sessionId: chatId };
    }
  };
}

function isFinished(status: AssistRunSnapshot["status"]): boolean {
  return status === "done" || status === "failed" || status === "stopped";
}

/** 发给发起方的步骤只有「做了什么」和产出；还在进行中的那一步不带产出。 */
function toSteps(snapshot: AssistRunSnapshot): AssistStep[] {
  return snapshot.steps.map((step) => ({
    text: step.text,
    ...(step.output ? { output: step.status === "failed" ? `${step.output}（失败）` : step.output } : {})
  }));
}

/** 运行时给的原因码换成双方都能读懂的一句话。 */
export function failureText(error: string | null): string {
  switch (error) {
    case "project_not_found":
    case "project_removed":
      return "执行方的电脑上找不到这个项目";
    case "project_unavailable":
    case "workspace_unavailable":
    case "workspace_missing":
      return "执行方电脑上的项目文件夹不可用";
    case "model_selection_unavailable":
      return "执行方的 Memmy 没有可用的模型";
    case "quota_exhausted":
      return "执行方的 Memmy 模型额度已用完";
    case "run_in_progress":
      return "上一次请求还在执行，稍后再试";
    case null:
    case "":
      return "Memmy 执行失败";
    default:
      return `Memmy 执行失败：${error}`;
  }
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => {
    const timer = setTimeout(resolve, ms);
    timer.unref?.();
  });
}
