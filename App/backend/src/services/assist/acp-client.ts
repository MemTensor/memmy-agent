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
  /** 会话已建立时回调：把会话 id 记下来，下一次请求接着用。 */
  onSession?: (sessionId: string) => void;
  /** 停止执行：杀掉子进程，prompt 以 cancelled 结束。 */
  signal?: AbortSignal;
  /** 单次请求的最长时间：与产品内置的 15 分钟一致。 */
  timeoutMs?: number;
}

export interface AcpRunResult {
  reply: string;
  steps: AssistStep[];
  sessionId: string | null;
}

/** 拉不起来、中途失败、超时：都带一句能直接给双方看的中文原因。 */
export class AcpError extends Error {
  constructor(message: string, readonly kind: "unavailable" | "failed" | "timeout" | "cancelled") {
    super(message);
    this.name = "AcpError";
  }
}

/** 单次请求的上限：单次最长 15 分钟，超时就当作失败并告诉发起方。 */
export const ACP_TIMEOUT_MS = 15 * 60 * 1000;

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
      const error = message.error as { message?: string };
      pending.reject(new AcpError(error.message || "Agent 返回错误", "failed"));
      return;
    }
    pending.resolve(message.result);
  }
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
  let reply = "";
  let sessionId: string | null = options.sessionId ?? null;
  let settled = false;

  const child = spawn(options.command, [...options.args], {
    cwd: options.cwd,
    env: { ...process.env, ...options.env },
    stdio: ["pipe", "pipe", "pipe"]
  });

  const finish = (error?: AcpError, result?: AcpRunResult) => {
    if (settled) return;
    settled = true;
    cleanup();
    if (error) rejectRun(error);
    else resolveRun(result ?? { reply, steps, sessionId });
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
      const update = payload.update ?? {};
      const read = readUpdate(update);
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
    const reason = stderrTail.trim().split("\n").pop();
    finish(new AcpError(reason ? `Agent 中断了这次执行：${reason}` : "Agent 中断了这次执行", "failed"));
  });

  void (async () => {
    try {
      const initialized = await connection.request("initialize", {
        protocolVersion: 1,
        // 不声明 fs 与 terminal：文件读写与命令都由 Agent 自己完成。
        clientCapabilities: {}
      }) as { authMethods?: Array<{ id?: string; name?: string }> } | undefined;
      // 有的 Agent（例如 Cursor）要求先走一次它自己的登录：它把人已经登录过的身份接进来，
      // 不调这一步，session/new 会直接回「需要认证」。第一个方法就是它默认的登录方式。
      const authMethod = initialized?.authMethods?.find((method) => typeof method.id === "string")?.id;
      if (authMethod) {
        await connection.request("authenticate", { methodId: authMethod }).catch(() => undefined);
      }
      const session = sessionId
        ? (await connection.request("session/load", { sessionId, cwd: options.cwd, mcpServers: [] }).then(
            () => ({ sessionId }), async () => await connection.request("session/new", { cwd: options.cwd, mcpServers: [] })
          ) as { sessionId?: string })
        : (await connection.request("session/new", { cwd: options.cwd, mcpServers: [] }) as { sessionId?: string });
      if (typeof session.sessionId === "string") {
        sessionId = session.sessionId;
        options.onSession?.(session.sessionId);
      }
      if (!sessionId) throw new AcpError("Agent 没有给我们一个会话", "failed");
      await connection.request("session/prompt", {
        sessionId,
        prompt: [{ type: "text", text: options.prompt }]
      });
      finish(undefined, { reply: reply.trim(), steps, sessionId });
    } catch (error) {
      finish(error instanceof AcpError ? error : new AcpError(
        error instanceof Error ? error.message : "Agent 执行失败", "failed"));
    }
  })();

  return done;
}