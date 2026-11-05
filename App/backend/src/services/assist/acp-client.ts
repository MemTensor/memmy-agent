/**
 * ACP（Agent Client Protocol）客户端：用标准输入输出驱动一个 Agent，新开会话、发送指令、
 * 收流式进展、应答权限请求、续跑会话。
 *
 * <p>协议是 JSON-RPC 2.0，一行一条消息。协助只需要几个方法：{@code initialize}、{@code session/new}、
 * {@code session/prompt}；续跑用 {@code session/load} 接回同一个会话。Agent 中途请求审批时一律自动允许
 * ——执行方授权了这次协助，就代表允许这个 Agent 用它平时的能力做事，不再逐项打断她。</p>
 *
 * <p>这里不做任何文件与终端代理：客户端能力里不声明 fs 与 terminal，Agent 用自己的工具读写本机文件，
 * 失败与越界都由它自己处理，结果由它写在回答里。</p>
 */

import { ASSIST_TRANSCRIPT_PART_BYTES, clipBytes, type AssistTranscriptItem } from "./transcript.js";

/** 执行过程中的一步：做了什么、结果是什么。 */
export interface AssistStep {
  text: string;
  output?: string;
}

export interface AcpRunOptions {
  /** 已解析的可执行文件路径或命令名。 */
  command: string;
  args: readonly string[];
  /** Agent 的工作目录：项目文件夹。 */
  cwd: string;
  env?: Readonly<Record<string, string>>;
  /** 这一轮要说的话。 */
  prompt: string;
  /** 接回已有会话；为空时新开一个。续跑用。 */
  sessionId?: string;
  /** 每一步刚发生时回调：执行方的 Memmy 据此实时展示。 */
  onStep?: (step: AssistStep) => void;
  /** 完整执行过程有变化时回调（整份）：说明文字与工具调用按顺序排列。 */
  onTranscript?: (items: AssistTranscriptItem[]) => void;
  /** 会话已建立时回调：把会话 id 记下来，下一次请求接着用。 */
  onSession?: (sessionId: string) => void;
  /** 停止执行：杀掉子进程，prompt 以 cancelled 结束。 */
  signal?: AbortSignal;
  /** 单次请求的最长时间：与产品内置的 15 分钟一致。 */
  timeoutMs?: number;
  /** Agent 的名字，只用于拼给人看的原因（例如「Cursor 返回错误：…」）；默认「Agent」。 */
  agentName?: string;
  /**
   * 需要登录时调 authenticate 的上限，默认 15 秒。有的 Agent 的登录方法会一直不回应
   * （QwenWork 实测 120 秒仍无响应），不能跟着它一起等下去。
   */
  authTimeoutMs?: number;
  /**
   * 会话建好后要设置的会话选项（ACP 的 {@code session/set_config_option}）：configId → 值。
   * 值先按选项的 value 精确匹配，再按显示名（不分大小写）匹配；Agent 不支持或设置失败时照常执行。
   */
  sessionConfig?: Readonly<Record<string, string>>;
}

export interface AcpRunResult {
  reply: string;
  steps: AssistStep[];
  /** 完整执行过程：Agent 的说明文字（agent_message_chunk）、思考（agent_thought_chunk）与工具调用（tool_call / tool_call_update）。 */
  transcript: AssistTranscriptItem[];
  sessionId: string | null;
}

/**
 * 从 ACP 的 session/update 里整理完整执行过程：说明文字按块拼进同一段，遇到工具调用另起一项；
 * 工具调用按 toolCallId 合并后续更新，输出保留原有换行。
 */
export class AcpTranscriptCollector {
  readonly items: AssistTranscriptItem[] = [];
  private readonly tools = new Map<string, Extract<AssistTranscriptItem, { kind: "tool" }>>();

  /** 返回这次更新是否改变了执行过程。 */
  consume(update: Record<string, unknown>): boolean {
    const kind = String(update.sessionUpdate ?? "");
    if (kind === "agent_message_chunk" || kind === "agent_thought_chunk") {
      // 说明文字与思考各自按块拼进同一段；两者交替出现时另起一项，保留先后。
      const itemKind = kind === "agent_thought_chunk" ? "thinking" : "text";
      const content = update.content as { type?: string; text?: string } | undefined;
      if (content?.type !== "text" || !content.text) return false;
      const last = this.items[this.items.length - 1];
      if (last && last.kind === itemKind) {
        if (last.truncated) return false;
        const joined = clipBytes(`${last.text}${content.text}`, ASSIST_TRANSCRIPT_PART_BYTES);
        if (joined !== `${last.text}${content.text}`) last.truncated = true;
        last.text = joined;
      } else {
        this.items.push({ kind: itemKind, text: clipBytes(content.text, ASSIST_TRANSCRIPT_PART_BYTES) });
      }
      return true;
    }
    if (kind !== "tool_call" && kind !== "tool_call_update") return false;
    const id = typeof update.toolCallId === "string" ? update.toolCallId : "";
    let item = id ? this.tools.get(id) : undefined;
    if (!item) {
      item = { kind: "tool", name: "执行了一步", input: "", output: "", status: "running" };
      if (id) this.tools.set(id, item);
      this.items.push(item);
    }
    if (typeof update.title === "string" && update.title.trim()) item.name = update.title.trim();
    if (update.rawInput !== undefined && !item.input) item.input = clipBytes(formatInput(update.rawInput), ASSIST_TRANSCRIPT_PART_BYTES);
    const output = readFullToolOutput(update.content) || formatRaw(update.rawOutput);
    if (output) {
      const clipped = clipBytes(output, ASSIST_TRANSCRIPT_PART_BYTES);
      if (clipped !== output) item.truncated = true;
      item.output = clipped;
    }
    const status = typeof update.status === "string" ? update.status : "";
    if (status === "completed") item.status = "done";
    else if (status === "failed") item.status = "failed";
    return true;
  }

  /** 收尾：还在进行中的工具调用按这一轮的结局落定。 */
  settle(succeeded: boolean): AssistTranscriptItem[] {
    for (const item of this.items) {
      if (item.kind === "tool" && item.status === "running") item.status = succeeded ? "done" : "failed";
    }
    return this.snapshot();
  }

  snapshot(): AssistTranscriptItem[] {
    return this.items.map((item) => ({ ...item }));
  }
}

/** 工具调用的参数：命令行工具给命令原文，其余格式化成 JSON。 */
function formatInput(raw: unknown): string {
  if (typeof raw === "string") return raw;
  if (raw && typeof raw === "object" && !Array.isArray(raw)) {
    const record = raw as Record<string, unknown>;
    for (const key of ["command", "cmd"]) {
      const value = record[key];
      if (typeof value === "string" && value.trim()) return value;
      if (Array.isArray(value) && value.every((part) => typeof part === "string")) return value.join(" ");
    }
  }
  return formatRaw(raw);
}

function formatRaw(raw: unknown): string {
  if (raw === undefined || raw === null) return "";
  if (typeof raw === "string") return raw;
  try {
    return JSON.stringify(raw, null, 2);
  } catch {
    return "";
  }
}

/** 工具调用的完整产出：内容块里的文字按原样拼接，差异块写成「修改 路径」。 */
function readFullToolOutput(content: unknown): string {
  if (!Array.isArray(content)) return "";
  const parts: string[] = [];
  for (const item of content) {
    if (!item || typeof item !== "object") continue;
    const block = item as { type?: string; content?: { text?: string }; text?: string; path?: string; newText?: string };
    if (block.type === "content" && block.content?.text) parts.push(block.content.text);
    else if (block.type === "text" && block.text) parts.push(block.text);
    else if (block.type === "diff" && block.path) parts.push(`修改 ${block.path}${block.newText ? `\n${block.newText}` : ""}`);
  }
  return parts.join("\n");
}

/** 拉不起来、需要登录、中途失败、超时：都带一句能直接给双方看的中文原因。 */
export class AcpError extends Error {
  /** 中途失败时已经记下的执行过程：失败的轮次也要让双方看到做到了哪一步。 */
  transcript?: AssistTranscriptItem[];
  /** JSON-RPC 错误码：只有在判断「是不是要登录」时用得着（有的 Agent 用 -32000 表示需要认证）。 */
  code?: number;
  constructor(
    message: string,
    readonly kind: "unavailable" | "failed" | "timeout" | "cancelled" | "unauthenticated"
  ) {
    super(message);
    this.name = "AcpError";
  }
}

/**
 * 这个错误是不是「要先登录」：JSON-RPC 错误里有认证字样，或者用的是 -32000 这个通用服务端错误码
 * （QwenWork 用它回「Authentication required」，Cursor 用它回需要认证）。
 * 用它区分「Agent 自己坏了」与「登录一下就能跑」，后者由上层替人发起登录。
 */
export function isAuthenticationError(error: unknown): boolean {
  if (!(error instanceof AcpError)) return false;
  if (/auth|authenticat|unauthor|login|log in|登录/iu.test(error.message)) return true;
  return error.code === -32000;
}

/**
 * 有的 Agent 把错误当成正常回答：Cursor 在账号有问题时会以 {@code end_turn} 正常结束，
 * 回复只是一句 {@code Error: I: WritableIterable is closed}，看不出真正原因。这种回复要当失败处理，
 * 不能当成答案交给发起方。只匹配「整段回复以 Error: 开头、没有换行、很短且这一轮没有任何工具调用」，
 * 正常回答里提到 Error: 不会被当失败。
 */
export const REPLY_ERROR_MAX_CHARS = 400;

export function assistReplyError(reply: string, toolCalls: number, agentName = "Agent"): string | null {
  const text = reply.trim();
  if (!text.startsWith("Error:") && !QUOTA_REPLY.test(text)) return null;
  // 做了事还是失败，过程本身有意义，交给正常流程展示。
  if (toolCalls > 0) return null;
  // 多行或者很长的一段更像正常回答（例如解释一个有出错信息的日志）。
  if (text.includes("\n") || text.length > REPLY_ERROR_MAX_CHARS) return null;
  return `${agentName} 返回错误：${text}`;
}

/**
 * 额度或账单问题时的回复：Cursor 在模型额度用完时同样以 {@code end_turn} 结束，回复只有一句
 * 「Upgrade your plan to continue」或「You have an unpaid invoice …」。和上面的 Error: 一样按失败处理。
 */
const QUOTA_REPLY = /^(?:upgrade your plan|you have an unpaid invoice|you(?:'ve| have) (?:hit|reached) your usage limit)/iu;

/**
 * Cursor 的 ACP 在一轮结束时会在回复末尾附一行 {@code Error: RetriableError: WritableIterable is closed}，
 * 正常回答也会带（2026-11-05 实测 2026.11.05 版本）。这一行不是这次执行的内容，要从回复里去掉。
 */
const TRAILING_STREAM_NOISE = /(?:^|\n)\s*Error:[^\n]*WritableIterable is closed\.?\s*$/u;

/** 去掉回复末尾的那行流关闭报错；没有时原样返回。 */
export function stripTrailingStreamNoise(text: string): string {
  let current = text;
  while (TRAILING_STREAM_NOISE.test(current)) current = current.replace(TRAILING_STREAM_NOISE, "");
  return current;
}

/** 单次请求的上限：单次最长 15 分钟，超时就当作失败并告诉发起方。 */
export const ACP_TIMEOUT_MS = 15 * 60 * 1000;

/** 需要登录时调 authenticate 的上限：QwenWork 的登录方法会一直不回应，不能跟着一起等。 */
export const AUTH_TIMEOUT_MS = 15_000;

interface Pending {
  resolve: (value: unknown) => void;
  reject: (error: Error) => void;
}

/** 一行一条的 JSON-RPC 连接。 */
class JsonRpcConnection {
  private buffer = "";
  private nextId = 1;
  private readonly pending = new Map<number, Pending>();

  constructor(
    private readonly write: (line: string) => void,
    private readonly onNotification: (method: string, params: unknown) => void,
    private readonly onRequest: (id: number, method: string, params: unknown) => void
  ) {}

  request(method: string, params: unknown): Promise<unknown> {
    const id = this.nextId++;
    return new Promise((resolve, reject) => {
      this.pending.set(id, { resolve, reject });
      this.write(JSON.stringify({ jsonrpc: "2.0", id, method, params }));
    });
  }

  notify(method: string, params: unknown): void {
    this.write(JSON.stringify({ jsonrpc: "2.0", method, params }));
  }

  reply(id: number, result: unknown): void {
    this.write(JSON.stringify({ jsonrpc: "2.0", id, result }));
  }

  fail(id: number, message: string): void {
    this.write(JSON.stringify({ jsonrpc: "2.0", id, error: { code: -32601, message } }));
  }

  /** 把子进程的输出喂进来；返回 false 表示这一行不是 JSON，调用方忽略即可。 */
  receive(chunk: string): void {
    this.buffer += chunk;
    let at: number;
    while ((at = this.buffer.indexOf("\n")) >= 0) {
      const line = this.buffer.slice(0, at).trim();
      this.buffer = this.buffer.slice(at + 1);
      if (line) this.handle(line);
    }
  }

  /** 子进程退出时把还在等的请求都判失败，避免调用方一直挂着。 */
  close(message: string): void {
    for (const [, pending] of this.pending) pending.reject(new AcpError(message, "failed"));
    this.pending.clear();
  }

  private handle(line: string): void {
    let message: Record<string, unknown>;
    try {
      message = JSON.parse(line) as Record<string, unknown>;
    } catch {
      return;
    }
    if (typeof message.method === "string") {
      if (message.id === undefined) {
        this.onNotification(message.method, message.params);
        return;
      }
      // Agent 反过来请求客户端（比如审批）：必须回一条，否则它一直等。
      this.onRequest(Number(message.id), message.method, message.params);
      return;
    }
    const id = Number(message.id);
    const pending = this.pending.get(id);
    if (!pending) return;
    this.pending.delete(id);
    if (message.error) {
      const detail = message.error as { message?: string; code?: number };
      const error = new AcpError(detail.message || "Agent 返回错误", "failed");
      // 留下错误码：判断「是不是要登录」时用得到（见 {@link isAuthenticationError}）。
      if (typeof detail.code === "number") error.code = detail.code;
      pending.reject(error);
      return;
    }
    pending.resolve(message.result);
  }
}

/**
 * Agent 异常退出时从 stderr 里挑一行真正能说明问题的。
 *
 * <p>Node 崩溃时的最后一行只是版本号（`Node.js v22.23.1`），直接把最后一行当原因会变成
 * 「Agent 中断了这次执行：Node.js v22.23.1」，双方都不知道发生了什么。因此先排除版本行，
 * 再从后往前找报错行（`Error:` / `error:` / `failed`），都没有时退回最后一个非版本行。</p>
 */
export function assistFailureReason(stderr: string): string | null {
  const lines = stderr
    .split("\n")
    .map((line) => line.trim())
    .filter((line) => line.length > 0 && !isVersionLine(line));
  if (lines.length === 0) return null;
  for (let index = lines.length - 1; index >= 0; index -= 1) {
    const line = lines[index]!;
    if (/(?:^|\s)(?:[A-Za-z]*Error|error)\s*:|\bfail(?:ed|ure)\b/iu.test(line)) return line;
  }
  return lines[lines.length - 1]!;
}

/** `Node.js v22.23.1` 或单独的 `v22.23.1`：这些只是运行时版本号，不是原因。 */
function isVersionLine(line: string): boolean {
  return /^Node\.js v\d/iu.test(line) || /^v\d+\.\d+\.\d+$/u.test(line);
}

/** 从 session/update 通知里取一步进展：正文按块拼起来，工具调用逐条记下来。 */
function readUpdate(update: Record<string, unknown>): { text?: string; step?: AssistStep } {
  const kind = String(update.sessionUpdate ?? "");
  if (kind === "agent_message_chunk") {
    const content = update.content as { type?: string; text?: string } | undefined;
    return content?.type === "text" && content.text ? { text: content.text } : {};
  }
  if (kind === "tool_call") {
    const title = String(update.title ?? "执行了一步");
    return { step: { text: title } };
  }
  if (kind === "tool_call_update") {
    const title = typeof update.title === "string" ? update.title : "";
    const status = typeof update.status === "string" ? update.status : "";
    const output = readToolOutput(update.content);
    if (!title && !output) return {};
    return {
      step: {
        text: title || "执行了一步",
        ...(output ? { output } : {}),
        // 状态只用来决定这一步是「进行中」还是「已完成」，展示上按最后一条为准。
        ...(status === "failed" ? { output: output ? `${output}（失败）` : "失败" } : {})
      }
    };
  }
  return {};
}

/** 工具调用的产出可能是内容块数组，取其中的文本，压成一行。 */
function readToolOutput(content: unknown): string {
  if (!Array.isArray(content)) return "";
  const parts: string[] = [];
  for (const item of content) {
    if (!item || typeof item !== "object") continue;
    const block = item as { type?: string; content?: { text?: string }; text?: string };
    if (block.type === "content" && block.content?.text) parts.push(block.content.text);
    else if (block.type === "text" && block.text) parts.push(block.text);
  }
  return parts.join(" ").replace(/\s+/gu, " ").trim().slice(0, 1_500);
}

/**
 * 在后台跑一轮：拉起 Agent、建会话或接回已有会话、发指令，收集回答与每一步。
 * 拉到一半失败时抛 {@link AcpError}，由调用方转成给双方看的失败原因。
 */
export async function runAcpAgent(options: AcpRunOptions): Promise<AcpRunResult> {
  const { spawn } = await import("node:child_process");
  const steps: AssistStep[] = [];
  const transcript = new AcpTranscriptCollector();
  let reply = "";
  let sessionId: string | null = options.sessionId ?? null;
  let settled = false;
  /**
   * 这一轮的指令已经发出。续跑时 {@code session/load} 会先把这条会话的全部历史以 {@code session/update} 重放一遍（ACP 的规定），
   * 那些是前几次请求的内容，不能算进这一次的过程与回复；只收发出指令之后的更新。
   */
  let prompting = false;

  const child = spawn(options.command, [...options.args], {
    cwd: options.cwd,
    env: { ...process.env, ...options.env },
    stdio: ["pipe", "pipe", "pipe"]
  });

  const finish = (error?: AcpError, result?: AcpRunResult) => {
    if (settled) return;
    settled = true;
    cleanup();
    transcript.settle(!error);
    if (error) rejectRun(Object.assign(error, { transcript: transcript.snapshot() }));
    else resolveRun(result ?? { reply, steps, transcript: transcript.snapshot(), sessionId });
  };

  let resolveRun: (value: AcpRunResult) => void = () => undefined;
  let rejectRun: (error: Error) => void = () => undefined;
  const done = new Promise<AcpRunResult>((resolve, reject) => {
    resolveRun = resolve;
    rejectRun = reject;
  });

  const connection = new JsonRpcConnection(
    // 已经结束时不要再往标准输入写：子进程的流已经关掉，写了只会抛 ERR_STREAM_WRITE_AFTER_END。
    (line) => {
      if (settled || child.stdin.destroyed || !child.stdin.writable) return;
      child.stdin.write(`${line}\n`);
    },
    (method, params) => {
      if (method !== "session/update") return;
      const payload = params as { sessionId?: string; update?: Record<string, unknown> };
      if (payload.sessionId) sessionId = payload.sessionId;
      if (!prompting) return;
      const update = payload.update ?? {};
      const read = readUpdate(update);
      if (transcript.consume(update)) options.onTranscript?.(transcript.snapshot());
      if (read.text) reply += read.text;
      if (read.step) {
        steps.push(read.step);
        options.onStep?.(read.step);
      }
    },
    (id, method, params) => {
      if (method === "session/request_permission") {
        // 执行方授权了这次协助，就代表允许它用它平时的能力做事：选第一个「允许一次」即可。
        const payload = params as { options?: Array<{ optionId?: string; kind?: string }> };
        const allowOnce = payload.options?.find((option) => option.kind === "allow_once");
        const anyAllow = payload.options?.find((option) => (option.kind ?? "").startsWith("allow"));
        const option = allowOnce ?? anyAllow;
        if (option?.optionId) {
          connection.reply(id, { outcome: { outcome: "selected", optionId: option.optionId } });
          return;
        }
        connection.reply(id, { outcome: { outcome: "cancelled" } });
        return;
      }
      // 其余客户端能力（读写文件、开终端）都没有声明，直接告诉对方不支持。
      connection.fail(id, `${method} 不在支持范围内`);
    }
  );

  let stderrTail = "";
  child.stdout.setEncoding("utf8");
  child.stderr.setEncoding("utf8");
  child.stdout.on("data", (chunk: string) => connection.receive(chunk));
  child.stderr.on("data", (chunk: string) => {
    stderrTail = `${stderrTail}${chunk}`.slice(-2_000);
  });

  const timer = options.timeoutMs === undefined ? null : setTimeout(() => {
    finish(new AcpError("这次执行超过了 15 分钟，已停止", "timeout"));
    child.kill("SIGTERM");
  }, options.timeoutMs);

  const onAbort = () => {
    if (sessionId) connection.notify("session/cancel", { sessionId });
    finish(new AcpError("执行已停止", "cancelled"));
    child.kill("SIGTERM");
  };
  options.signal?.addEventListener("abort", onAbort, { once: true });
  // 暂停/停止可能发生在拉起之前（这里是异步函数，事件已经派发过了）：这里补一次，别让请求一直等。
  if (options.signal?.aborted) onAbort();

  function cleanup(): void {
    if (timer) clearTimeout(timer);
    options.signal?.removeEventListener("abort", onAbort);
    if (!child.stdin.destroyed && child.stdin.writable) {
      child.stdin.on("error", () => undefined);
      child.stdin.end();
    }
    if (!child.killed) child.kill("SIGTERM");
  }

  child.on("error", (error: NodeJS.ErrnoException) => {
    finish(new AcpError(error.code === "ENOENT"
      ? "这个 Agent 还没有安装，或者它的启动命令不在这台电脑上"
      : `无法启动这个 Agent：${error.message}`, "unavailable"));
  });

  child.on("exit", (code) => {
    connection.close(`Agent 退出了（${code ?? "unknown"}）`);
    if (settled) return;
    const reason = assistFailureReason(stderrTail);
    finish(new AcpError(reason ? `Agent 中断了这次执行：${reason}` : "Agent 中断了这次执行", "failed"));
  });

  void (async () => {
    try {
      const initialized = await connection.request("initialize", {
        protocolVersion: 1,
        // 不声明 fs 与 terminal：文件读写与命令都由 Agent 自己完成。
        clientCapabilities: {}
      }) as { authMethods?: Array<{ id?: string; name?: string }> } | undefined;
      const authMethods = (initialized?.authMethods ?? [])
        .map((method) => method?.id)
        .filter((id): id is string => typeof id === "string" && id.length > 0);

      /** 会话建好时 Agent 给出的会话选项（模型、模式等），设置 {@link AcpRunOptions.sessionConfig} 时用来找值。 */
      let configOptions: AcpConfigOption[] = [];

      /** 接回已有会话；接不回（或本来就没会话）就新开一个。 */
      const openSession = async (): Promise<string> => {
        if (sessionId) {
          try {
            const loaded = await connection.request("session/load", { sessionId, cwd: options.cwd, mcpServers: [] }) as
              { configOptions?: AcpConfigOption[] } | null | undefined;
            configOptions = Array.isArray(loaded?.configOptions) ? loaded.configOptions : [];
            return sessionId;
          } catch {
            // 这个 Agent 接不回那条会话（换过版本、会话被清理）：新开一个，本次照常执行。
          }
        }
        const session = await connection.request("session/new", { cwd: options.cwd, mcpServers: [] }) as {
          sessionId?: string;
          configOptions?: AcpConfigOption[];
        };
        if (typeof session.sessionId !== "string") throw new AcpError("Agent 没有给我们一个会话", "failed");
        configOptions = Array.isArray(session.configOptions) ? session.configOptions : [];
        return session.sessionId;
      };

      /**
       * 只在真的要登录时才调 authenticate：它原来是 initialize 之后无条件调一次，
       * 而 QwenWork 的登录方法会一直不回应（实测 120 秒仍无响应），把本来能跑的会话也一起卡死。
       * 这里给一个短超时，超时就当登录没完成，交给上层去发起浏览器登录。
       */
      const authenticate = async (): Promise<void> => {
        const methodId = authMethods[0]!;
        await withTimeout(
          connection.request("authenticate", { methodId }),
          options.authTimeoutMs ?? AUTH_TIMEOUT_MS,
          () => new AcpError("Agent 要求登录，但它的登录方法没有回应", "unauthenticated")
        );
      };

      const unauthenticated = (error: unknown): AcpError => {
        const reason = error instanceof Error ? error.message.trim() : "";
        return new AcpError(reason ? `这个 Agent 需要先登录：${reason}` : "这个 Agent 需要先登录", "unauthenticated");
      };

      let opened: string;
      try {
        opened = await openSession();
      } catch (error) {
        if (!isAuthenticationError(error)) throw error;
        // 它要求登录。没有登录方法时不能替它认证，但这个错误仍然是「登录一下就能跑」，交给上层提示去登录。
        if (authMethods.length === 0) throw unauthenticated(error);
        // 有用它给的第一个登录方法试一次，成功后再建一次会话。
        try {
          await authenticate();
          opened = await openSession();
        } catch (retry) {
          throw isAuthenticationError(retry) ? unauthenticated(retry) : retry;
        }
      }
      sessionId = opened;
      options.onSession?.(opened);

      // 配方要求的会话选项（例如 Cursor 统一用 Auto 模型）：设不上就按 Agent 自己的设置执行，不让这一步拦住执行。
      for (const [configId, wanted] of Object.entries(options.sessionConfig ?? {})) {
        const value = resolveConfigValue(configOptions, configId, wanted);
        if (value === null) continue;
        await connection.request("session/set_config_option", { sessionId, configId, value }).catch(() => undefined);
      }

      prompting = true;
      try {
        await connection.request("session/prompt", {
          sessionId,
          prompt: [{ type: "text", text: options.prompt }]
        });
      } catch (error) {
        // 有的 Agent 在 initialize 时给不出登录方法，直到真的让它动起来才回报需要认证。
        if (isAuthenticationError(error)) throw unauthenticated(error);
        throw error;
      }
      // Cursor 在回复末尾附带的流关闭报错不是执行内容：回复与执行过程里的最后一段说明都去掉。
      const rawReply = reply;
      reply = stripTrailingStreamNoise(reply);
      const lastText = [...transcript.items].reverse().find((item) => item.kind === "text");
      if (lastText && lastText.kind === "text") lastText.text = stripTrailingStreamNoise(lastText.text);
      const toolCalls = transcript.items.filter((item) => item.kind === "tool").length;
      // Cursor 会把「账号有问题」「额度用完」当成正常结束：回复只有一句 Error: … 或 Upgrade your plan …。
      // 只剩那行流关闭报错时也一样：Agent 什么都没做成。这种回复不能当答案。
      const replyError = assistReplyError(reply.trim() ? reply : rawReply, toolCalls, options.agentName ?? "Agent");
      if (replyError) throw new AcpError(replyError, "failed");
      finish(undefined, { reply: reply.trim(), steps, transcript: transcript.settle(true), sessionId });
    } catch (error) {
      finish(error instanceof AcpError ? error : new AcpError(
        error instanceof Error ? error.message : "Agent 执行失败", "failed"));
    }
  })();

  return done;
}

/** 给一个请求加超时：超时就抛调用方给的错误，原请求之后才失败不会变成未处理的拒绝。 */
function withTimeout<T>(promise: Promise<T>, timeoutMs: number, onTimeout: () => AcpError): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    const timer = setTimeout(() => reject(onTimeout()), timeoutMs);
    promise.then(
      (value) => {
        clearTimeout(timer);
        resolve(value);
      },
      (error: unknown) => {
        clearTimeout(timer);
        reject(error instanceof Error ? error : new AcpError(String(error), "failed"));
      }
    );
  });
}

/** ACP 会话选项（{@code session/new} 返回的 {@code configOptions}）里用得到的部分。 */
export interface AcpConfigOption {
  id?: string;
  currentValue?: string;
  options?: Array<{ value?: string; name?: string }>;
}

/**
 * 要设置的会话选项值：先按 value 精确匹配，再按显示名（不分大小写）匹配。
 * Agent 没给出这个选项（例如接回旧会话时不返回选项列表）就按原值试一次；给了但没有匹配的值时不设，
 * 免得把一个它不认的值写进去。
 *
 * <p>即使它报告的当前值已经是想要的值也照样设一次：Cursor 报告的当前模型取自 {@code ~/.cursor/acp-config.json}，
 * 实际执行用的却是 {@code cli-config.json} 里的模型，两者可能不一致（2026-11-05 实测：报告 {@code default[]}，
 * 实际用 kimi-k3 并回「Upgrade your plan to continue」）。</p>
 */
export function resolveConfigValue(configOptions: readonly AcpConfigOption[], configId: string, wanted: string): string | null {
  const option = configOptions.find((candidate) => candidate.id === configId);
  if (!option) return wanted;
  const choices = option.options ?? [];
  const lower = wanted.toLowerCase();
  const match = choices.find((choice) => choice.value === wanted)
    ?? choices.find((choice) => (choice.name ?? "").toLowerCase() === lower);
  return match?.value || null;
}
