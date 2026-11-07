/**
 * 成员协助里「由 Memmy 执行」的那一轮。
 *
 * <p>另一位成员请这台电脑协助、执行方选了 Memmy 时，本机后端会让运行时在对应的项目下新建一条任务，
 * 把请求作为第一条消息发进去。这条任务与人在界面里新建的任务走同一条派发路径，执行方随时可以打开它
 * 看过程、在里面停止。后端需要知道这一轮做到哪一步、最后回答了什么，才能把进度和结果发回给发起方：
 * 这里的记录器就是从这一轮的事件里整理出这些。</p>
 *
 * <p>记录器只认自己那条消息之后的事件：续跑同一条任务时，订阅瞬间推过来的目标状态、计时等与这一轮无关。</p>
 */

/** 给发起方看的一步：做了什么，以及（结束后）产出的一行摘要。 */
export interface AssistRunStep {
  text: string;
  output?: string;
  status: "running" | "done" | "failed";
}

/**
 * 完整执行过程里的一项：Agent 的说明文字，或一次工具调用（做了什么、命令或参数、完整输出、状态）。
 * 双方在项目看板里打开这次协助时按顺序看到它们；工具输出保留原有换行。
 */
export type AssistTranscriptItem =
  | { kind: "text"; text: string; truncated?: boolean }
  /** 模型的思考：由 reasoning_delta 逐段拼成，reasoning_end 结束一段。 */
  | { kind: "thinking"; text: string; truncated?: boolean }
  | { kind: "tool"; name: string; input: string; output: string; status: "running" | "done" | "failed"; truncated?: boolean }
  | { kind: "omitted"; count: number };

export type AssistRunStatus = "starting" | "queued" | "running" | "done" | "failed" | "stopped";

export interface AssistRunSnapshot {
  chat_id: string;
  status: AssistRunStatus;
  steps: AssistRunStep[];
  /** 完整执行过程：说明文字与工具调用按发生顺序排列。 */
  transcript: AssistTranscriptItem[];
  reply: string;
  error: string | null;
  turn_id: string | null;
  started_at: number;
  finished_at: number | null;
}

/** 摘要里一步的产出只留一行：任务页协助条与命令行用它；完整输出在 transcript 里。 */
const OUTPUT_LIMIT = 1_500;
/** 摘要最多记这么多步：再多也只是同类操作的重复。 */
const STEP_LIMIT = 60;
/** 完整执行过程里单段文字（说明、命令或参数、输出）的上限：16KB，超出截断并注明。与云端同一上限。 */
export const TRANSCRIPT_PART_BYTES = 16 * 1024;
/** 完整执行过程最多记这么多项：超出时保留开头，中间记一项「省略了几步」，最近的照常追加。 */
const TRANSCRIPT_ITEM_LIMIT = 2_000;
const TRANSCRIPT_HEAD = 500;

export class AssistRunRecorder {
  readonly chatId: string;
  readonly clientRequestId: string;
  status: AssistRunStatus = "starting";
  readonly steps: AssistRunStep[] = [];
  readonly transcript: AssistTranscriptItem[] = [];
  reply = "";
  error: string | null = null;
  turnId: string | null = null;
  readonly startedAt: number;
  finishedAt: number | null = null;
  /** 在自己那条消息被接受之前，事件都不算这一轮的。 */
  private armed = false;
  private readonly stepByCall = new Map<string, number>();
  private readonly toolByCall = new Map<string, Extract<AssistTranscriptItem, { kind: "tool" }>>();
  /** 正在接收的一段思考：reasoning_end 或其他内容插进来之后，下一段另起一项。 */
  private thinking: { item: Extract<AssistTranscriptItem, { kind: "thinking" }>; raw: string } | null = null;
  private readonly listeners = new Set<() => void>();

  constructor(input: { chatId: string; clientRequestId: string; now?: number }) {
    this.chatId = input.chatId;
    this.clientRequestId = input.clientRequestId;
    this.startedAt = input.now ?? Date.now();
  }

  get finished(): boolean {
    return this.status === "done" || this.status === "failed" || this.status === "stopped";
  }

  /** 状态变化时通知：HTTP 层可以用它等第一步，不必轮询。 */
  onChange(listener: () => void): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  /** 派发时就被拒绝（项目不在了、模型不可用……）：直接以失败结束。 */
  reject(reason: string): void {
    if (this.finished) return;
    this.error = reason;
    this.finish("failed");
  }

  consume(event: Record<string, any>): void {
    if (this.finished || !event || typeof event !== "object") return;
    const name = String(event.event ?? "");

    if (name === "error") {
      // 派发前的检查失败会直接回一条 error；带着自己的请求 id，或者还没开始时，才算这一轮的。
      const ours = event.client_request_id === this.clientRequestId || !this.armed;
      if (ours) this.reject(String(event.reason ?? event.detail ?? "dispatch_failed"));
      return;
    }
    if (name === "message_rejected" && event.client_request_id === this.clientRequestId) {
      this.reject(String(event.reason ?? "message_rejected"));
      return;
    }
    if (name === "message_queued" && event.client_request_id === this.clientRequestId) {
      if (this.status === "starting") this.setStatus("queued");
      return;
    }
    if (name === "message_accepted" && event.client_request_id === this.clientRequestId) {
      this.armed = true;
      if (this.status === "starting" || this.status === "queued") this.setStatus("running");
      return;
    }
    if (name === "run_status" && event.status === "running" && this.armed) {
      const turnId = typeof event.turn_id === "string" ? event.turn_id : null;
      if (turnId && !this.turnId) this.turnId = turnId;
      if (this.status !== "running") this.setStatus("running");
      return;
    }
    if (!this.armed) return;
    if (!this.belongsToTurn(event)) return;

    if (name === "reasoning_delta") {
      if (typeof event.text === "string" && event.text) this.addThinking(event.text);
      return;
    }
    if (name === "reasoning_end") {
      this.thinking = null;
      return;
    }

    if (name === "message") {
      if (Array.isArray(event.tool_events)) this.consumeToolEvents(event.tool_events);
      const progress = event.kind === "progress" || event.kind === "tool_hint";
      const text = typeof event.text === "string" ? event.text.trim() : "";
      if (event.model_error && typeof event.model_error === "object") {
        this.error = String(event.model_error.detail ?? event.model_error.category ?? "model_failed");
      }
      // 说明文字与回答都按顺序记进执行过程；工具提示（tool_hint）只是工具调用的另一种写法，不重复记。
      if (text && event.kind !== "tool_hint") this.addText(text);
      if (!progress && text) this.reply = text;
      return;
    }
    if (name === "stream_end") {
      const text = typeof event.text === "string" ? event.text.trim() : "";
      if (text) {
        this.addText(text);
        this.reply = text;
      }
      return;
    }
    if (name === "stop_result") {
      this.finish("stopped");
      return;
    }
    if (name === "turn_end" || (name === "run_status" && event.status === "idle")) {
      // 模型报错时这一轮也会正常收尾：有错误、又没有回答，就算失败。
      this.finish(this.error && !this.reply ? "failed" : "done");
    }
  }

  snapshot(): AssistRunSnapshot {
    return {
      chat_id: this.chatId,
      status: this.status,
      steps: this.steps.map((step) => ({ ...step })),
      transcript: this.transcript.map((item) => ({ ...item })),
      reply: this.reply,
      error: this.error,
      turn_id: this.turnId,
      started_at: this.startedAt,
      finished_at: this.finishedAt,
    };
  }

  /** 运行时没有给出结束事件时（比如重启），由调用方补一个结局。 */
  finish(status: "done" | "failed" | "stopped", now = Date.now()): void {
    if (this.finished) return;
    this.finishedAt = now;
    // 收尾时还在「进行中」的步骤按这一轮的结局落定，不让界面一直转圈。
    for (const step of this.steps) {
      if (step.status === "running") step.status = status === "done" ? "done" : "failed";
    }
    for (const item of this.transcript) {
      if (item.kind === "tool" && item.status === "running") item.status = status === "done" ? "done" : "failed";
    }
    this.setStatus(status);
  }

  private belongsToTurn(event: Record<string, any>): boolean {
    const turnId = typeof event.turn_id === "string" ? event.turn_id : null;
    if (!turnId || !this.turnId) return true;
    return turnId === this.turnId;
  }

  private consumeToolEvents(events: unknown[]): void {
    let changed = false;
    for (const raw of events) {
      if (!raw || typeof raw !== "object") continue;
      const event = raw as Record<string, any>;
      const phase = String(event.phase ?? "");
      if (phase !== "start" && phase !== "end" && phase !== "error") continue;
      const key = String(event.ui_tool_call_id ?? event.call_id ?? "");
      const existing = key ? this.stepByCall.get(key) : undefined;
      const text = describeToolEvent(event);
      let step: AssistRunStep | null = existing === undefined ? null : this.steps[existing] ?? null;
      if (existing === undefined && this.steps.length < STEP_LIMIT) {
        if (key) this.stepByCall.set(key, this.steps.length);
        step = { text, status: "running" };
        this.steps.push(step);
      }
      // 摘要只留前 60 步，完整过程照常记。
      this.recordTool(key, event, phase, text);
      if (step && (phase === "end" || phase === "error")) {
        step.status = phase === "end" ? "done" : "failed";
        const output = phase === "end" ? oneLine(event.result) : oneLine(event.error);
        if (output) step.output = output;
        // 结束事件带着更完整的说明（比如命令的实际显示文字）时以它为准。
        if (typeof event.display_text === "string" && event.display_text.trim()) step.text = text;
      }
      changed = true;
    }
    if (changed) this.emit();
  }

  /** 一段思考的增量：接在正在接收的那一段后面，超过 16KB 的部分截断并注明。 */
  private addThinking(delta: string): void {
    const last = this.transcript[this.transcript.length - 1];
    if (!this.thinking || last !== this.thinking.item) {
      const item: Extract<AssistTranscriptItem, { kind: "thinking" }> = { kind: "thinking", text: "" };
      this.thinking = { item, raw: "" };
      this.pushItem(item);
    }
    const current = this.thinking;
    if (current.item.truncated) return;
    current.raw += delta;
    const clipped = clipBytes(current.raw, TRANSCRIPT_PART_BYTES);
    current.item.text = clipped;
    if (clipped !== current.raw) current.item.truncated = true;
    this.emit();
  }

  /** 一段说明文字：与上一段相同（同一段回答经由两种事件送达）时不重复记。 */
  private addText(text: string): void {
    const last = this.transcript[this.transcript.length - 1];
    if (last?.kind === "text" && last.text === text) return;
    const clipped = clipBytes(text, TRANSCRIPT_PART_BYTES);
    this.pushItem({ kind: "text", text: clipped, ...(clipped !== text ? { truncated: true } : {}) });
    this.emit();
  }

  /** 一次工具调用：开始时记名称与参数，结束时补上完整输出与状态。 */
  private recordTool(key: string, event: Record<string, any>, phase: string, name: string): void {
    let item = key ? this.toolByCall.get(key) : undefined;
    // 没有调用 id 的结束事件：落到最近一个还在进行中的工具调用上。
    if (!item && !key && phase !== "start") {
      const last = this.transcript[this.transcript.length - 1];
      if (last?.kind === "tool" && last.status === "running") item = last;
    }
    if (!item) {
      const input = toolInput(event);
      const clippedInput = clipBytes(input, TRANSCRIPT_PART_BYTES);
      item = { kind: "tool", name, input: clippedInput, output: "", status: "running", ...(clippedInput !== input ? { truncated: true } : {}) };
      if (key) this.toolByCall.set(key, item);
      this.pushItem(item);
    }
    if (phase === "end" || phase === "error") {
      item.status = phase === "end" ? "done" : "failed";
      const raw = fullText(phase === "end" ? event.result : event.error);
      const output = clipBytes(raw, TRANSCRIPT_PART_BYTES);
      item.output = output;
      if (output !== raw) item.truncated = true;
      if (typeof event.display_text === "string" && event.display_text.trim()) item.name = name;
      if (!item.input) {
        const input = toolInput(event);
        if (input) item.input = clipBytes(input, TRANSCRIPT_PART_BYTES);
      }
    }
  }

  /** 超过项数上限时保留开头，中间记一项「省略了几步」，最近的照常追加。 */
  private pushItem(item: AssistTranscriptItem): void {
    if (this.transcript.length >= TRANSCRIPT_ITEM_LIMIT) {
      const marker = this.transcript[TRANSCRIPT_HEAD];
      if (marker?.kind === "omitted") {
        this.transcript.splice(TRANSCRIPT_HEAD + 1, 1);
        marker.count += 1;
      } else {
        this.transcript.splice(TRANSCRIPT_HEAD, 2, { kind: "omitted", count: 2 });
      }
    }
    this.transcript.push(item);
  }

  private setStatus(status: AssistRunStatus): void {
    this.status = status;
    this.emit();
  }

  private emit(): void {
    for (const listener of this.listeners) {
      try {
        listener();
      } catch {
        // 监听方自己的问题不影响记录。
      }
    }
  }
}

/** 一次工具调用写成给人看的一句话：做了什么、对着什么做。 */
export function describeToolEvent(event: Record<string, any>): string {
  if (typeof event.display_text === "string" && event.display_text.trim()) {
    return truncate(collapse(event.display_text), 160);
  }
  const name = String(event.name ?? event.function?.name ?? "").trim();
  const args = readArguments(event.arguments ?? event.function?.arguments);
  const pick = (...keys: string[]) => {
    for (const key of keys) {
      const value = args[key];
      if (typeof value === "string" && value.trim()) return truncate(collapse(value), 120);
    }
    return "";
  };
  const lower = name.toLowerCase();
  const target = (label: string, value: string) => (value ? `${label} ${value}` : label);
  if (lower === "exec" || lower.endsWith("bash") || lower.endsWith("shell")) return target("运行命令", pick("command", "cmd"));
  if (lower === "read_file" || lower.endsWith("read_file")) return target("读取", pick("path", "file_path"));
  if (lower === "list_dir") return target("查看目录", pick("path", "dir"));
  if (lower === "grep") return target("搜索", pick("pattern", "query"));
  if (lower === "glob") return target("查找文件", pick("pattern", "path"));
  if (lower === "write_file") return target("写入", pick("path", "file_path"));
  if (lower === "edit_file" || lower === "apply_patch") return target("修改", pick("path", "file_path"));
  if (lower === "search_web" || lower === "web_search") return target("搜索网页", pick("query"));
  if (lower === "web_fetch") return target("打开", pick("url"));
  return name || "执行了一步";
}

function readArguments(value: unknown): Record<string, unknown> {
  if (value && typeof value === "object" && !Array.isArray(value)) return value as Record<string, unknown>;
  if (typeof value === "string") {
    try {
      const parsed = JSON.parse(value);
      return parsed && typeof parsed === "object" && !Array.isArray(parsed) ? parsed : {};
    } catch {
      return {};
    }
  }
  return {};
}

function oneLine(value: unknown): string {
  if (value == null) return "";
  if (typeof value === "string") return truncate(collapse(value), OUTPUT_LIMIT);
  if (Array.isArray(value)) {
    // 工具结果可能是内容块数组：只取其中的文字。
    const text = value
      .map((item) => (item && typeof item === "object" && typeof (item as any).text === "string" ? (item as any).text : ""))
      .filter(Boolean)
      .join(" ");
    if (text) return truncate(collapse(text), OUTPUT_LIMIT);
  }
  try {
    return truncate(collapse(JSON.stringify(value)), OUTPUT_LIMIT);
  } catch {
    return "";
  }
}

/** 工具调用做了什么：命令行工具给命令原文，其余给格式化后的参数。 */
export function toolInput(event: Record<string, any>): string {
  const args = readArguments(event.arguments ?? event.function?.arguments);
  for (const key of ["command", "cmd"]) {
    const value = args[key];
    if (typeof value === "string" && value.trim()) return value;
  }
  if (!Object.keys(args).length) return "";
  try {
    return JSON.stringify(args, null, 2);
  } catch {
    return "";
  }
}

/** 工具的完整输出：保留原有换行；内容块数组取其中的文字，其他结构格式化成 JSON。 */
export function fullText(value: unknown): string {
  if (value == null) return "";
  if (typeof value === "string") return value;
  if (Array.isArray(value)) {
    const text = value
      .map((item) => (item && typeof item === "object" && typeof (item as any).text === "string" ? (item as any).text : ""))
      .filter(Boolean)
      .join("\n");
    if (text) return text;
  }
  try {
    return JSON.stringify(value, null, 2);
  } catch {
    return "";
  }
}

/** 按 UTF-8 字节截断，保留换行，只在字符边界处截；截过的末尾注明「（已截断）」。 */
export function clipBytes(value: string, maxBytes: number): string {
  const encoder = new TextEncoder();
  if (encoder.encode(value).length <= maxBytes) return value;
  const suffix = "\n…（已截断）";
  const budget = Math.max(0, maxBytes - encoder.encode(suffix).length);
  let bytes = 0;
  let end = 0;
  for (const char of value) {
    const size = encoder.encode(char).length;
    if (bytes + size > budget) break;
    bytes += size;
    end += char.length;
  }
  return `${value.slice(0, end)}${suffix}`;
}

function collapse(value: string): string {
  return value.replace(/\s+/gu, " ").trim();
}

function truncate(value: string, max: number): string {
  return value.length > max ? `${value.slice(0, max - 1)}…` : value;
}
