import path from "node:path";
import { performance } from "node:perf_hooks";
import { randomUUID } from "node:crypto";
import { AgentHook, AgentHookContext } from "./hook.js";
import { AgentRunner, AgentRunSpec } from "./runner.js";
import { ToolContext } from "./tools/context.js";
import { ToolLoader } from "./tools/loader.js";
import { ToolRegistry } from "./tools/registry.js";
import { InboundMessage, MessageBus } from "../runtime-messages/index.js";
import { AgentDefaults, Config } from "../../config/schema.js";
import { readTemplate } from "../../templates/index.js";
import { ContextBuilder } from "./context.js";
import { SkillsLoader } from "./skills.js";

export class SubagentStatus {
  static PENDING = "pending";
  static RUNNING = "running";
  static COMPLETE = "complete";
  static FAILED = "failed";
  static CANCELLED = "cancelled";

  taskId: string;
  label: string;
  taskDescription: string;
  startedAt: number;
  phase: string;
  iteration: number;
  toolEvents: Record<string, any>[];
  usage: Record<string, any>;
  stopReason: string | null;
  error: string | null;

  constructor({
    taskId,
    label,
    taskDescription,
    startedAt,
    phase = "initializing",
    iteration = 0,
    toolEvents,
    usage = {},
    stopReason,
    error = null,
  }: {
    taskId?: string;
    label: string;
    taskDescription?: string;
    startedAt?: number;
    phase?: string;
    iteration?: number;
    toolEvents?: Record<string, any>[];
    usage?: Record<string, any>;
    stopReason?: string | null;
    error?: string | null;
  }) {
    const id = taskId ?? randomUUID().slice(0, 8);
    this.taskId = id;
    this.label = label;
    this.taskDescription = taskDescription ?? "";
    this.startedAt = startedAt ?? performance.now() / 1000;
    this.phase = phase;
    this.iteration = iteration;
    this.toolEvents = toolEvents ?? [];
    this.usage = usage;
    this.stopReason = stopReason ?? null;
    this.error = error;
  }
}

export class SubagentHook extends AgentHook {
  taskId: string;
  status: SubagentStatus | null;

  constructor(taskId: string, status: SubagentStatus | null = null) {
    super();
    this.taskId = taskId;
    this.status = status;
  }

  override async beforeExecuteTools(context: AgentHookContext): Promise<void> {
    // Hook point retained for parity with memmy logging and tests.
  }

  override async afterIteration(context: AgentHookContext): Promise<void> {
    if (!this.status) return;
    this.status.iteration = context.iteration ?? this.status.iteration;
    this.status.toolEvents = [...(context.toolEvents ?? [])];
    this.status.usage = { ...(context.usage ?? {}) };
    if (context.error) this.status.error = String(context.error);
  }
}

function renderInlineTemplate(template: string, values: Record<string, string>): string {
  return template.replace(/\{\{\s*(\w+)\s*\}\}/g, (match, key) => values[key] ?? "");
}

function renderSkillsSummaryBlock(template: string, skillsSummary: string): string {
  return template.replace(/\{%\s*if skillsSummary\s*%\}([\s\S]*?)\{%\s*endif\s*%\}/g, (_match, body) => (skillsSummary ? body : ""));
}

type SubagentManagerInit = {
  provider?: any;
  workspace?: string;
  bus?: MessageBus;
  model?: string | null;
  contextWindowTokens?: number;
  toolsConfig?: any;
  restrictToWorkspace?: boolean;
  disabledSkills?: string[];
  maxIterations?: number;
  maxConcurrent?: number;
  maxConcurrentSubagents?: number;
  maxToolResultChars?: number;
  llmWallTimeoutForSession?: (sessionKey?: string | null) => number | null;
  lifecycleHook?: (() => AgentHook | null) | null;
};

type CancelableSubagentTask = Promise<void> & {
  abort: () => boolean;
  cancel: () => boolean;
  done: () => boolean;
  cancelled: () => boolean;
  signal: AbortSignal;
};

export class SubagentManager {
  provider: any;
  workspace: string;
  bus: MessageBus;
  model: string | null;
  contextWindowTokens: number;
  toolsConfig: any;
  restrictToWorkspace: boolean;
  disabledSkills: Set<string>;
  maxToolResultChars: number;
  maxIterations: number;
  maxConcurrent: number;
  maxConcurrentSubagents: number;
  runner: AgentRunner;
  tasks = new Map<string, any>();
  runningTasks: Map<string, Promise<void> & Partial<CancelableSubagentTask>> = new Map();
  taskStatuses: Map<string, SubagentStatus> = new Map();
  sessionTasks: Map<string, Set<string>> = new Map();
  private llmWallTimeoutForSession?: (sessionKey?: string | null) => number | null;
  private lifecycleHook: (() => AgentHook | null) | null;

  constructor(init: SubagentManagerInit = {}) {
    const defaults = new AgentDefaults();
    this.provider = init.provider ?? null;
    this.workspace = path.resolve(String(init.workspace ?? defaults.workspace ?? process.cwd()));
    this.bus = init.bus ?? new MessageBus();
    this.model = init.model ?? this.provider?.getDefaultModel?.() ?? this.provider?.model ?? null;
    this.contextWindowTokens = init.contextWindowTokens ?? defaults.contextWindowTokens;
    this.toolsConfig = init.toolsConfig ?? new Config().tools;
    this.restrictToWorkspace = init.restrictToWorkspace ?? false;
    this.disabledSkills = new Set(init.disabledSkills ?? []);
    this.maxToolResultChars = init.maxToolResultChars ?? defaults.maxToolResultChars;
    this.maxIterations = init.maxIterations ?? defaults.maxToolIterations;
    this.maxConcurrent = init.maxConcurrent ?? init.maxConcurrentSubagents ?? defaults.maxConcurrentSubagents;
    this.maxConcurrentSubagents = this.maxConcurrent;
    this.runner = new AgentRunner(this.provider);
    this.llmWallTimeoutForSession = init.llmWallTimeoutForSession;
    this.lifecycleHook = init.lifecycleHook ?? null;
  }

  private getLifecycleHook(): AgentHook | null {
    return this.lifecycleHook?.() ?? null;
  }

  private subagentContext(
    taskId: string,
    task: string,
    label: string,
    origin: Record<string, any>,
    status: SubagentStatus,
    extra: Record<string, any> = {},
  ): AgentHookContext {
    return new AgentHookContext({
      sessionKey: origin.sessionKey ?? null,
      reason: extra.reason ?? null,
      subagent: {
        taskId,
        label,
        task,
        origin,
        phase: status.phase,
        status: status.phase,
        stopReason: status.stopReason,
        error: status.error,
        ...extra,
      },
    });
  }

  private async emitSubagentStart(taskId: string, task: string, label: string, origin: Record<string, any>, status: SubagentStatus): Promise<void> {
    await this.getLifecycleHook()?.subagentStart(this.subagentContext(taskId, task, label, origin, status, { reason: "spawn" }));
  }

  private async emitSubagentStop(
    taskId: string,
    task: string,
    label: string,
    origin: Record<string, any>,
    status: SubagentStatus,
    extra: Record<string, any> = {},
  ): Promise<void> {
    await this.getLifecycleHook()?.subagentStop(this.subagentContext(taskId, task, label, origin, status, extra));
  }

  subagentToolsConfig(): any {
    return {
      ...this.toolsConfig,
      restrictToWorkspace: this.restrictToWorkspace,
    };
  }

  buildTools(workspace: string | null = null, toolsConfig: any = null): ToolRegistry {
    const root = path.resolve(workspace ?? this.workspace);
    const ctx = new ToolContext({
      config: toolsConfig ?? this.subagentToolsConfig(),
      workspace: root,
    });
    return new ToolLoader({ workspace: root, ctx }).loadRegistry(ctx, { scope: "subagent" });
  }

  setProvider(provider: any, model: string, contextWindowTokens = this.contextWindowTokens): void {
    this.provider = provider;
    this.model = model;
    this.contextWindowTokens = contextWindowTokens;
    this.runner.provider = provider;
  }

  async spawn(input: string | {
    task?: string;
    label?: string | null;
    originChannel?: string;
    originChatId?: string;
    sessionKey?: string | null;
    originMessageId?: string | null;
    temperature?: number | null;
  }, label: string | null = null, originChannel = "cli", originChatId = "direct", sessionKey: string | null = null, originMessageId: string | null = null, temperature: number | null = null): Promise<string> {
    const args = typeof input === "string" ? { task: input, label, originChannel, originChatId, sessionKey, originMessageId, temperature } : input;
    const task = String(args.task ?? "");
    const taskId = randomUUID().slice(0, 8);
    const displayLabel = args.label ?? (task.length > 30 ? `${task.slice(0, 30)}...` : task);
    const origin = {
      channel: args.originChannel ?? originChannel,
      chatId: args.originChatId ?? originChatId,
      sessionKey: args.sessionKey ?? sessionKey,
    };
    const status = new SubagentStatus({
      taskId,
      label: displayLabel,
      taskDescription: task,
      startedAt: performance.now() / 1000,
    });
    this.taskStatuses.set(taskId, status);
    this.tasks.set(taskId, status);
    try {
      await this.emitSubagentStart(taskId, task, displayLabel, origin, status);
    } catch (error) {
      this.taskStatuses.delete(taskId);
      this.tasks.delete(taskId);
      throw error;
    }

    const controller = new AbortController();
    let cancelled = false;
    let settled = false;
    const running = this.runSubagent(
      taskId,
      task,
      displayLabel,
      origin,
      status,
      args.originMessageId ?? originMessageId,
      args.temperature ?? temperature,
      { signal: controller.signal },
    )
      .finally(() => {
        settled = true;
        this.runningTasks.delete(taskId);
        this.taskStatuses.delete(taskId);
        this.tasks.delete(taskId);
        const key = origin.sessionKey;
        if (key) {
          const ids = this.sessionTasks.get(key);
          ids?.delete(taskId);
          if (ids && ids.size === 0) this.sessionTasks.delete(key);
        }
      }) as CancelableSubagentTask;
    const abort = (): boolean => {
      if (settled) return false;
      cancelled = true;
      if (!controller.signal.aborted) controller.abort();
      return true;
    };
    running.abort = abort;
    running.cancel = abort;
    running.done = () => settled;
    running.cancelled = () => cancelled || controller.signal.aborted;
    running.signal = controller.signal;
    this.runningTasks.set(taskId, running);
    if (origin.sessionKey) {
      const ids = this.sessionTasks.get(origin.sessionKey) ?? new Set<string>();
      ids.add(taskId);
      this.sessionTasks.set(origin.sessionKey, ids);
    }
    return `Subagent [${displayLabel}] started (id: ${taskId}). I'll notify you when it completes.`;
  }

  async runSubagent(
    taskId: string,
    task: string,
    label: string,
    origin: Record<string, any>,
    status: SubagentStatus,
    originMessageId: string | null = null,
    temperature: number | null = null,
    { signal = null }: { signal?: AbortSignal | null } = {},
  ): Promise<void> {
    let finalStatus = "error";
    let resultText: string | null = null;
    let stopError: string | null = null;
    const isCancelled = (): boolean => Boolean(signal?.aborted);
    try {
      status.phase = "running";
      const tools = this.buildTools();
      const messages = [
        { role: "system", content: this.buildSubagentPrompt() },
        { role: "user", content: task },
      ];
      const sessKey = origin.sessionKey ?? null;
      const result = await this.runner.run(new AgentRunSpec({
        messages,
        provider: this.provider,
        tools,
        model: this.model,
        maxTokens: this.provider?.generation?.maxTokens,
        contextWindowTokens: this.contextWindowTokens,
        temperature: temperature ?? undefined,
        maxIterations: this.maxIterations,
        maxToolResultChars: this.maxToolResultChars,
        maxIterationsMessage: "Task completed but no final response was generated.",
        errorMessage: null,
        failOnToolError: true,
        checkpointCallback: async (payload: Record<string, any>) => {
          status.phase = String(payload.phase ?? status.phase);
          status.iteration = Number(payload.iteration ?? status.iteration);
        },
        sessionKey: sessKey,
        llmTimeoutS: this.llmWallTimeoutForSession?.(sessKey) ?? null,
        abortSignal: signal,
        hook: new SubagentHook(taskId, status),
      }));
      if (isCancelled()) {
        status.phase = SubagentStatus.CANCELLED;
        finalStatus = "cancelled";
        return;
      }
      status.phase = "done";
      status.stopReason = result.stopReason;
      if (status.stopReason === "toolError") {
        status.toolEvents = [...(result.toolEvents ?? [])];
        finalStatus = "error";
        resultText = SubagentManager.formatPartialProgress(result);
        await this.announceResult(taskId, label, task, resultText, origin, "error", originMessageId);
      } else if (status.stopReason === "error") {
        finalStatus = "error";
        const errorText = (result as any).error ?? "Error: subagent execution failed.";
        resultText = errorText;
        stopError = errorText;
        await this.announceResult(taskId, label, task, errorText, origin, "error", originMessageId);
      } else {
        finalStatus = "ok";
        resultText = result.finalContent || "Task completed but no final response was generated.";
        await this.announceResult(taskId, label, task, resultText, origin, "ok", originMessageId);
      }
    } catch (error) {
      if (isCancelled()) {
        status.phase = SubagentStatus.CANCELLED;
        finalStatus = "cancelled";
        return;
      }
      status.phase = "error";
      status.error = (error as Error).message;
      finalStatus = "error";
      stopError = (error as Error).message;
      resultText = `Error: ${(error as Error).message}`;
      await this.announceResult(taskId, label, task, resultText, origin, "error", originMessageId);
    } finally {
      if (!isCancelled()) {
        await this.emitSubagentStop(taskId, task, label, origin, status, {
          reason: "completed",
          result: resultText,
          finalStatus,
          error: stopError,
        });
      }
    }
  }

  async announceResult(
    taskId: string,
    label: string,
    task: string,
    result: string,
    origin: Record<string, any>,
    status: string,
    originMessageId: string | null = null,
  ): Promise<void> {
    const statusText = status === "ok" ? "completed successfully" : "failed";
    const template = readTemplate("agent/subagent-announce.md");
    const content = renderInlineTemplate(template, {
      label,
      statusText,
      task,
      result,
    });
    const override = origin.sessionKey ?? `${origin.channel}:${origin.chatId}`;
    const metadata: Record<string, any> = {
      injectedEvent: "subagentResult",
      subagentTaskId: taskId,
    };
    if (originMessageId) metadata.originMessageId = originMessageId;
    const msg = new InboundMessage({
      channel: "system",
      senderId: "subagent",
      chatId: `${origin.channel}:${origin.chatId}`,
      content,
      sessionKeyOverride: override,
      metadata,
    });
    await this.bus.publishInbound(msg);
  }

  static formatPartialProgress(result: any): string {
    const events = result.toolEvents ?? [];
    const completed = events.filter((event: any) => event.status === "ok");
    const failure = [...events].reverse().find((event: any) => event.status === "error");
    const lines: string[] = [];
    if (completed.length) {
      lines.push("Completed steps:");
      for (const event of completed.slice(-3)) lines.push(`- ${event.name}: ${event.detail}`);
    }
    if (failure) {
      if (lines.length) lines.push("");
      lines.push("Failure:");
      lines.push(`- ${failure.name}: ${failure.detail}`);
    }
    const error = result.error;
    if (error && !failure) {
      if (lines.length) lines.push("");
      lines.push("Failure:");
      lines.push(`- ${error}`);
    }
    return lines.join("\n") || error || "Error: subagent execution failed.";
  }

  buildSubagentPrompt(): string {
    const skillsSummary = new SkillsLoader(this.workspace, null, this.disabledSkills).buildSkillsSummary();
    const template = renderSkillsSummaryBlock(
      readTemplate("agent/subagent-system.md")
        .replace(/\{%\s*include 'agent\/snippets\/untrusted-content\.md'\s*%\}/g, readTemplate("agent/snippets/untrusted-content.md"))
        .replace(/\{%\s*include 'agent\/verification-contract\.md'\s*%\}/g, readTemplate("agent/verification-contract.md")),
      skillsSummary,
    );
    return renderInlineTemplate(template, {
      timeContext: ContextBuilder.buildRuntimeContext?.(null, null) ?? "",
      workspace: this.workspace,
      skillsSummary,
    });
  }

  async cancelBySession(sessionKey: string): Promise<number> {
    const ids = [...(this.sessionTasks.get(sessionKey) ?? [])].filter((id) => this.runningTasks.has(id));
    const waits: Promise<unknown>[] = [];
    let cancelled = 0;
    for (const id of ids) {
      const task: any = this.runningTasks.get(id);
      const done = typeof task?.done === "function" ? task.done() : Boolean(task?.settled);
      let didCancel = false;
      if (!done && task && typeof task.cancel === "function") {
        didCancel = task.cancel() !== false;
      } else if (!done && task && typeof task.abort === "function") {
        didCancel = task.abort() !== false;
      }
      if (didCancel) {
        cancelled += 1;
        if (typeof task.then === "function") waits.push(Promise.resolve(task).catch(() => undefined));
      }
      this.runningTasks.delete(id);
      const status = this.taskStatuses.get(id);
      if (status) status.phase = SubagentStatus.CANCELLED;
      if (status) await this.emitSubagentStop(id, status.taskDescription, status.label, { sessionKey }, status, {
        reason: "cancelled",
        finalStatus: "cancelled",
        result: null,
        error: null,
      });
      this.taskStatuses.delete(id);
      this.tasks.delete(id);
    }
    this.sessionTasks.delete(sessionKey);
    if (waits.length) await Promise.allSettled(waits);
    return cancelled;
  }

  getRunningCount(): number {
    return this.runningTasks.size;
  }

  getRunningCountBySession(sessionKey?: string | null): number {
    if (!sessionKey) return 0;
    const ids = this.sessionTasks.get(sessionKey) ?? new Set<string>();
    return [...ids].filter((id) => this.runningTasks.has(id)).length;
  }
}
