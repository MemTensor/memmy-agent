import fs from "node:fs";
import path from "node:path";
import { type LLMProvider, type LLMResponse } from "../providers/base.js";
import { evaluateResponse as defaultEvaluateResponse } from "../utils/evaluator.js";
import { currentTimeStr } from "../utils/helpers.js";
import { type LLMRuntimeResolver, staticLlmRuntime } from "../utils/llm-runtime.js";

export const HEARTBEAT_TOOL = [
  {
    type: "function",
    function: {
      name: "heartbeat",
      description: "Report heartbeat decision after reviewing tasks.",
      parameters: {
        type: "object",
        properties: {
          action: {
            type: "string",
            enum: ["skip", "run"],
            description: "skip = nothing to do, run = has active tasks",
          },
          tasks: {
            type: "string",
            description: "Natural-language summary of active tasks (required for run)",
          },
        },
        required: ["action"],
      },
    },
  },
];

type MaybePromise<T> = T | Promise<T>;

type HeartbeatCallback = (tasks: string) => MaybePromise<string | null | undefined>;
type HeartbeatNotifyCallback = (response: string) => MaybePromise<void>;
type HeartbeatEvaluator = (
  response: string,
  tasks: string,
  provider: LLMProvider,
  model: string,
) => MaybePromise<boolean | Record<string, any>>;

export interface HeartbeatServiceOptions {
  workspace: string;
  provider?: LLMProvider | null;
  model?: string | null;
  onExecute?: HeartbeatCallback | null;
  onNotify?: HeartbeatNotifyCallback | null;
  intervalS?: number;
  enabled?: boolean;
  timezone?: string | null;
  llmRuntime?: LLMRuntimeResolver | null;
  evaluateResponse?: HeartbeatEvaluator | null;
}

function isToolCapableResponse(response: any): boolean {
  if (typeof response?.shouldExecuteTools === "boolean") return response.shouldExecuteTools;
  const calls = response?.toolCalls ?? [];
  const finishReason = response?.finishReason ?? "stop";
  return calls.length > 0 && ["tool_calls", "function_call", "stop"].includes(finishReason);
}

function parseToolArguments(value: any): Record<string, any> {
  if (!value) return {};
  if (typeof value === "string") {
    try {
      const parsed = JSON.parse(value);
      return parsed && typeof parsed === "object" ? parsed : {};
    } catch {
      return {};
    }
  }
  return typeof value === "object" ? value : {};
}

function evaluatorAllowsNotify(verdict: boolean | Record<string, any>): boolean {
  if (typeof verdict === "boolean") return verdict;
  for (const key of ["shouldNotify", "should_notify", "notify", "deliver", "ok"]) {
    if (key in verdict) return Boolean(verdict[key]);
  }
  return Boolean(verdict);
}

export class HeartbeatService {
  workspace: string;
  onExecute: HeartbeatCallback | null;
  onNotify: HeartbeatNotifyCallback | null;
  intervalS: number;
  enabled: boolean;
  timezone: string | null;
  runningTask: Promise<void> | null = null;
  private runningState = false;
  private runToken: object | null = null;
  private sleepAbortController: AbortController | null = null;
  private readonly llmRuntime: LLMRuntimeResolver;
  private readonly evaluateHeartbeatResponse: HeartbeatEvaluator;

  constructor(options: HeartbeatServiceOptions) {
    this.workspace = path.resolve(options.workspace);
    const provider = options.provider ?? null;
    const model = options.model ?? null;
    const llmRuntime = options.llmRuntime;
    if (!llmRuntime && (!provider || !model)) {
      throw new Error("HeartbeatService requires either llmRuntime or provider/model");
    }
    this.llmRuntime = llmRuntime ?? staticLlmRuntime(provider as LLMProvider, model as string);
    this.onExecute = options.onExecute ?? null;
    this.onNotify = options.onNotify ?? null;
    this.intervalS = options.intervalS ?? 30 * 60;
    this.enabled = options.enabled ?? true;
    this.timezone = options.timezone ?? null;
    this.evaluateHeartbeatResponse = options.evaluateResponse ?? defaultEvaluateResponse;
  }

  get running(): boolean {
    return this.runningState;
  }

  set running(value: boolean) {
    this.runningState = value;
  }

  get heartbeatFile(): string {
    return path.join(this.workspace, "HEARTBEAT.md");
  }

  readHeartbeatFile(): string | null {
    if (!fs.existsSync(this.heartbeatFile)) return null;
    try {
      return fs.readFileSync(this.heartbeatFile, "utf8");
    } catch {
      return null;
    }
  }

  async decide(content: string): Promise<[string, string]> {
    const llm = this.llmRuntime();
    const messages = [
      {
        role: "system",
        content: "You are a heartbeat agent. Call the heartbeat tool to report your decision.",
      },
      {
        role: "user",
        content:
          `Current Time: ${currentTimeStr(this.timezone)}\n\n` +
          "Review the following HEARTBEAT.md and decide whether there are active tasks.\n\n" +
          content,
      },
    ];
    const args = { messages, tools: HEARTBEAT_TOOL, model: llm.model };
    const provider: any = llm.provider;
    const response: LLMResponse =
      typeof provider.chatWithRetry === "function" ? await provider.chatWithRetry(args) : await provider.chat(args);

    const toolCalls = response?.toolCalls ?? [];
    if (!isToolCapableResponse(response) || toolCalls.length === 0) return ["skip", ""];

    const call = toolCalls[0] as any;
    const toolArgs = parseToolArguments(call.arguments ?? call.args);
    const action = toolArgs.action === "run" ? "run" : "skip";
    const tasks = String(toolArgs.tasks ?? "");
    return [action, tasks];
  }

  async start(): Promise<void> {
    if (!this.enabled || this.runningState) return;
    this.runningState = true;
    const token = {};
    this.runToken = token;
    const task = this.runLoop(token);
    this.runningTask = task;
    task.finally(() => {
      if (this.runToken === token) {
        this.runningTask = null;
        this.runningState = false;
        this.runToken = null;
      }
    });
  }

  stop(): void {
    this.runningState = false;
    this.runToken = null;
    this.sleepAbortController?.abort();
    this.sleepAbortController = null;
    this.runningTask = null;
  }

  private sleep(seconds: number, signal?: AbortSignal): Promise<boolean> {
    if (signal?.aborted) return Promise.resolve(false);
    return new Promise((resolve) => {
      let timer: ReturnType<typeof setTimeout> | null = null;
      const cleanup = () => {
        if (signal) signal.removeEventListener("abort", onAbort);
      };
      const finish = (slept: boolean) => {
        if (timer) clearTimeout(timer);
        cleanup();
        resolve(slept);
      };
      const onAbort = () => finish(false);
      timer = setTimeout(() => finish(true), seconds * 1000);
      if (signal) signal.addEventListener("abort", onAbort, { once: true });
      timer.unref?.();
    });
  }

  async runLoop(token: object | null = this.runToken): Promise<void> {
    if (!token) return;
    while (this.runningState && this.runToken === token) {
      const controller = new AbortController();
      this.sleepAbortController = controller;
      const slept = await this.sleep(this.intervalS, controller.signal);
      if (this.sleepAbortController === controller) this.sleepAbortController = null;
      if (!slept || !this.runningState || this.runToken !== token) break;
      try {
        await this.tick();
      } catch {
        // Keep the heartbeat loop alive after one failed tick.
      }
    }
  }

  static isDeliverable(response: string): boolean {
    const text = response.toLowerCase();
    if (text.includes("couldn't produce a final answer")) return false;
    const leakedPatterns = [
      "heartbeat.md",
      "awareness.md",
      "judgment call:",
      "decision logic",
      "valid options are",
      "my instructions",
      "i am supposed to",
      "strict heartbeat interpretation",
    ];
    return !leakedPatterns.some((pattern) => text.includes(pattern));
  }

  async tick(): Promise<void> {
    const content = this.readHeartbeatFile();
    if (!content) return;

    try {
      const [action, tasks] = await this.decide(content);
      if (action !== "run") return;

      const execute = this.onExecute;
      if (!execute) return;
      const response = await execute(tasks);
      if (!response) return;
      if (!HeartbeatService.isDeliverable(response)) return;

      const llm = this.llmRuntime();
      const verdict = await this.evaluateHeartbeatResponse(response, tasks, llm.provider, llm.model);
      if (evaluatorAllowsNotify(verdict)) {
        const notify = this.onNotify;
        if (notify) await notify(response);
      }
    } catch {
      // Heartbeat ticks should not tear down the owner loop.
    }
  }

  async triggerNow(): Promise<string | null> {
    const content = this.readHeartbeatFile();
    if (!content) return null;
    const [action, tasks] = await this.decide(content);
    const execute = this.onExecute;
    if (action !== "run" || !execute) return null;
    return (await execute(tasks)) ?? null;
  }
}
