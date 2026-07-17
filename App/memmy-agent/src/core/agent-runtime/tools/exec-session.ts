import { ChildProcessWithoutNullStreams, spawn } from "node:child_process";
import { randomUUID } from "node:crypto";
import { Tool, type ToolExecutionContext } from "./base.js";
import { CommandOutputDecoder, type CommandOutputDecoderOptions } from "./command-output-decoder.js";

export const DEFAULT_YIELD_MS = 1000;
export const MAX_YIELD_MS = 30_000;
export const DEFAULT_WAIT_FOR_MS = 10_000;
export const MAX_WAIT_FOR_MS = 120_000;
export const DEFAULT_MAX_OUTPUT_CHARS = 10_000;
export const MAX_OUTPUT_CHARS = 50_000;

export type SessionPoll = {
  output: string;
  done: boolean;
  exitCode: number | null;
  elapsedS: number;
  timedOut: boolean;
  terminated: boolean;
  stdinClosed: boolean;
  truncatedChars: number;
};

export type ExecSessionInfo = {
  sessionId: string;
  command: string;
  cwd: string;
  elapsedS: number;
  idleS: number;
  remainingS: number;
  returncode: number | null;
};

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function createToolAbortError(): Error {
  const error = new Error("task cancelled");
  error.name = "AbortError";
  return error;
}

function isToolAbortError(error: unknown): boolean {
  return error instanceof Error && error.name === "AbortError";
}

function throwIfAborted(signal?: AbortSignal | null): void {
  if (signal?.aborted) throw createToolAbortError();
}

function abortableSleep(ms: number, signal?: AbortSignal | null): Promise<void> {
  if (ms <= 0) return Promise.resolve();
  throwIfAborted(signal);
  if (!signal) return sleep(ms);
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      signal.removeEventListener("abort", onAbort);
      resolve();
    }, ms);
    const onAbort = () => {
      clearTimeout(timer);
      reject(createToolAbortError());
    };
    signal.addEventListener("abort", onAbort, { once: true });
  });
}

export function clampSessionInt(value: number | null | undefined, fallback: number, minimum: number, maximum: number): number {
  if (value == null || Number.isNaN(Number(value))) return fallback;
  return Math.min(Math.max(Math.trunc(Number(value)), minimum), maximum);
}

export function truncateOutput(output: string, maxOutputChars: number): [string, number] {
  if (output.length <= maxOutputChars) return [output, 0];
  const half = Math.floor(maxOutputChars / 2);
  const omitted = output.length - maxOutputChars;
  return [
    `${output.slice(0, half)}\n\n... (${omitted.toLocaleString()} chars truncated) ...\n\n${output.slice(-half)}`,
    omitted,
  ];
}

export class ExecSession {
  process: ChildProcessWithoutNullStreams;
  command: string;
  cwd: string;
  startedAt = Date.now();
  deadlineMs: number;
  lastAccess = Date.now();
  private chunks: string[] = [];
  private timedOut = false;
  private stderrStarted = false;
  private readonly stdoutDecoder: CommandOutputDecoder;
  private readonly stderrDecoder: CommandOutputDecoder;
  private stdoutFinished = false;
  private stderrFinished = false;
  private streamsClosed = false;
  private readonly closePromise: Promise<void>;
  private resolveClose!: () => void;

  constructor({
    command,
    cwd = process.cwd(),
    env,
    timeoutS = null,
    shellProgram = null,
    login = true,
    decoderOptions = {},
    spawnProcess = spawn,
  }: {
    command: string;
    cwd?: string;
    env?: NodeJS.ProcessEnv;
    timeoutS?: number | null;
    shellProgram?: string | null;
    login?: boolean;
    decoderOptions?: CommandOutputDecoderOptions;
    spawnProcess?: typeof spawn;
  }) {
    this.command = command;
    this.cwd = cwd;
    this.deadlineMs = timeoutS && timeoutS > 0 ? Date.now() + timeoutS * 1000 : Number.POSITIVE_INFINITY;
    this.stdoutDecoder = new CommandOutputDecoder(decoderOptions);
    this.stderrDecoder = new CommandOutputDecoder(decoderOptions);
    this.closePromise = new Promise((resolve) => {
      this.resolveClose = resolve;
    });
    if (!shellProgram) {
      this.process = spawnProcess(command, { cwd, env, shell: true });
    } else if (process.platform === "win32") {
      this.process = spawnProcess(command, { cwd, env, shell: true, windowsHide: true });
    } else {
      const resolvedShell = shellProgram;
      const args: string[] = [];
      const shellName = resolvedShell.split(/[\\/]/).pop()?.toLowerCase() ?? "";
      if (login && ["bash", "bash.exe", "zsh", "zsh.exe"].includes(shellName)) args.push("-l");
      args.push("-c", command);
      this.process = spawnProcess(resolvedShell, args, { cwd, env });
    }
    this.process.on("error", (error) => this.chunks.push(`Error executing command: ${error.message}`));
    this.process.stdout.on("data", (chunk: Buffer) => {
      this.stdoutDecoder.push(chunk);
      this.appendStdout(this.stdoutDecoder.read());
    });
    this.process.stderr.on("data", (chunk) => {
      this.stderrDecoder.push(chunk);
      this.appendStderr(this.stderrDecoder.read());
    });
    this.process.stdout.once("end", () => this.finishStdoutOnce());
    this.process.stderr.once("end", () => this.finishStderrOnce());
    this.process.once("close", () => {
      this.finishStdoutOnce();
      this.finishStderrOnce();
      this.streamsClosed = true;
      this.resolveClose();
    });
  }

  private isDone(): boolean {
    return this.process.exitCode != null || this.process.signalCode != null;
  }

  async write(data: string): Promise<string | null> {
    if (this.isDone()) return "session has already exited";
    if (!this.process.stdin.writable) return "session stdin is closed";
    return new Promise((resolve) => {
      this.process.stdin.write(data, (error) => resolve(error ? error.message : null));
    });
  }

  async closeStdin(): Promise<string | null> {
    if (this.isDone()) return "session has already exited";
    if (!this.process.stdin.writable) return "session stdin is closed";
    this.process.stdin.end();
    return null;
  }

  async kill(): Promise<void> {
    if (this.isDone()) return;
    this.process.kill("SIGTERM");
    await Promise.race([
      new Promise<void>((resolve) => this.process.once("close", () => resolve())),
      sleep(5000).then(() => {
        if (!this.isDone()) this.process.kill("SIGKILL");
      }),
    ]);
  }

  async poll(
    yieldTimeMs: number,
    maxOutputChars: number,
    { terminated = false, stdinClosed = false }: { terminated?: boolean; stdinClosed?: boolean } = {},
    abortSignal?: AbortSignal | null,
  ): Promise<SessionPoll> {
    this.lastAccess = Date.now();
    throwIfAborted(abortSignal);
    if (yieldTimeMs > 0 && !this.isDone()) await abortableSleep(Math.min(yieldTimeMs, MAX_YIELD_MS), abortSignal);
    throwIfAborted(abortSignal);
    if (!this.isDone() && Date.now() >= this.deadlineMs) {
      this.timedOut = true;
      await this.kill();
    }
    if (this.isDone() && !this.streamsClosed) await this.closePromise;
    throwIfAborted(abortSignal);
    const raw = this.chunks.join("");
    this.chunks = [];
    const [output, truncated] = truncateOutput(raw, maxOutputChars);
    const elapsed = Math.max(0, (Date.now() - this.startedAt) / 1000);
    const done = this.streamsClosed;
    return {
      output,
      done,
      exitCode: this.process.exitCode,
      elapsedS: elapsed,
      timedOut: this.timedOut,
      terminated,
      stdinClosed,
      truncatedChars: truncated,
    };
  }

  private appendStdout(text: string): void {
    if (text) this.chunks.push(text);
  }

  private appendStderr(text: string): void {
    if (!text) return;
    this.chunks.push(this.stderrStarted ? text : `STDERR:\n${text}`);
    this.stderrStarted = true;
  }

  private finishStdoutOnce(): void {
    if (this.stdoutFinished) return;
    this.stdoutFinished = true;
    this.appendStdout(this.stdoutDecoder.end());
  }

  private finishStderrOnce(): void {
    if (this.stderrFinished) return;
    this.stderrFinished = true;
    this.appendStderr(this.stderrDecoder.end());
  }
}

export class ExecSessionManager {
  maxSessions: number;
  idleTimeout: number;
  sessions = new Map<string, ExecSession>();

  constructor({ maxSessions = 8, idleTimeout = 1800 }: {
    maxSessions?: number;
    idleTimeout?: number;
  } = {}) {
    this.maxSessions = maxSessions;
    this.idleTimeout = idleTimeout;
  }

  private async cleanup(): Promise<void> {
    const now = Date.now();
    for (const [id, session] of [...this.sessions]) {
      if (now - session.lastAccess > this.idleTimeout * 1000) {
        this.sessions.delete(id);
        await session.kill();
      }
    }
  }

  async start({
    command,
    cwd = process.cwd(),
    env,
    timeout = null,
    shellProgram = null,
    login = true,
    yieldTimeMs = DEFAULT_YIELD_MS,
    maxOutputChars = DEFAULT_MAX_OUTPUT_CHARS,
    decoderOptions = {},
    spawnProcess = spawn,
    abortSignal = null,
  }: {
    command: string;
    cwd?: string;
    env?: NodeJS.ProcessEnv;
    timeout?: number | null;
    shellProgram?: string | null;
    login?: boolean;
    yieldTimeMs?: number;
    maxOutputChars?: number;
    decoderOptions?: CommandOutputDecoderOptions;
    spawnProcess?: typeof spawn;
    abortSignal?: AbortSignal | null;
  }): Promise<[string, SessionPoll]> {
    await this.cleanup();
    throwIfAborted(abortSignal);
    if (this.sessions.size >= this.maxSessions) throw new Error(`maximum exec sessions reached (${this.maxSessions})`);
    const sessionId = randomUUID().replace(/-/g, "").slice(0, 12);
    const session = new ExecSession({ command, cwd, env, timeoutS: timeout, shellProgram, login, decoderOptions, spawnProcess });
    this.sessions.set(sessionId, session);
    try {
      const poll = await session.poll(yieldTimeMs, maxOutputChars, {}, abortSignal);
      if (poll.done) this.sessions.delete(sessionId);
      return [sessionId, poll];
    } catch (error) {
      if (isToolAbortError(error)) {
        this.sessions.delete(sessionId);
        await session.kill();
      }
      throw error;
    }
  }

  async write({
    sessionId,
    chars = null,
    closeStdin = false,
    terminate = false,
    yieldTimeMs = DEFAULT_YIELD_MS,
    maxOutputChars = DEFAULT_MAX_OUTPUT_CHARS,
    abortSignal = null,
  }: {
    sessionId?: string;
    chars?: string | null;
    closeStdin?: boolean;
    terminate?: boolean;
    yieldTimeMs?: number;
    maxOutputChars?: number;
    abortSignal?: AbortSignal | null;
  }): Promise<SessionPoll> {
    await this.cleanup();
    const id = sessionId ?? "";
    const session = this.sessions.get(id);
    if (!session) throw new Error(`exec session not found: ${id}`);
    if (chars) {
      const error = await session.write(chars);
      if (error) throw new Error(error);
    }
    let stdinClosed = false;
    if (closeStdin) {
      const error = await session.closeStdin();
      if (error) throw new Error(error);
      stdinClosed = true;
    }
    if (terminate) await session.kill();
    const poll = await session.poll(yieldTimeMs, maxOutputChars, {
      terminated: terminate,
      stdinClosed,
    }, terminate ? null : abortSignal);
    if (poll.done) this.sessions.delete(id);
    return poll;
  }

  async list(): Promise<ExecSessionInfo[]> {
    await this.cleanup();
    const now = Date.now();
    return [...this.sessions.entries()].sort(([a], [b]) => a.localeCompare(b)).map(([sessionId, session]) => {
      const elapsed = Math.max(0, (now - session.startedAt) / 1000);
      const idle = Math.max(0, (now - session.lastAccess) / 1000);
      const remaining = Number.isFinite(session.deadlineMs) ? Math.max(0, (session.deadlineMs - now) / 1000) : Number.POSITIVE_INFINITY;
      return {
        sessionId,
        command: session.command,
        cwd: session.cwd,
        elapsedS: elapsed,
        idleS: idle,
        remainingS: remaining,
        returncode: session.process.exitCode,
      };
    });
  }

  get(id: string): ExecSession | undefined {
    return this.sessions.get(id);
  }

  async stop(id: string): Promise<boolean> {
    const session = this.sessions.get(id);
    if (!session) return false;
    this.sessions.delete(id);
    await session.kill();
    return true;
  }
}

export const DEFAULT_EXEC_SESSION_MANAGER = new ExecSessionManager();

export function formatSessionPoll(sessionId: string, poll: SessionPoll): string {
  const parts = poll.output ? [poll.output] : [];
  if (poll.truncatedChars) parts.push(`(output truncated by ${poll.truncatedChars.toLocaleString()} chars)`);
  if (poll.timedOut) parts.push("Error: Command timed out; session was terminated.");
  if (poll.terminated && !poll.timedOut) parts.push("Session terminated.");
  if (poll.stdinClosed) parts.push("Stdin closed.");
  if (poll.done) parts.push(`Exit code: ${poll.exitCode}`);
  else parts.push(`Process running. session_id: ${sessionId}`);
  parts.push(`Elapsed: ${poll.elapsedS.toFixed(1)}s`);
  return parts.length ? parts.join("\n") : "(no output yet)";
}

export class WriteStdinTool extends Tool {
  static scopes = new Set(["core", "subagent"]);
  manager: ExecSessionManager;

  constructor({ manager = DEFAULT_EXEC_SESSION_MANAGER }: { manager?: ExecSessionManager } = {}) {
    super();
    this.manager = manager;
  }

  static create(ctx: any): Tool {
    return new WriteStdinTool({ manager: ctx?.execSessionManager ?? DEFAULT_EXEC_SESSION_MANAGER });
  }

  get exclusive(): boolean {
    return true;
  }

  get name(): string {
    return "write_stdin";
  }

  get description(): string {
    return (
      "Interact with a running exec session created by exec with yield_time_ms. " +
      "Use chars='' to poll without writing, chars to send stdin, close_stdin=true to send EOF, or terminate=true to stop the process. " +
      "Use wait_for with wait_timeout_ms for dev servers, test watchers, and prompts where you need to wait for expected output. " +
      "Do not use this to start new commands; start them with exec."
    );
  }

  get parameters() {
    return {
      type: "object",
      properties: {
        session_id: { type: "string" },
        chars: { type: ["string", "null"] },
        close_stdin: { type: "boolean" },
        terminate: { type: "boolean" },
        yield_time_ms: { type: "integer", minimum: 0, maximum: MAX_YIELD_MS },
        wait_for: { type: "string" },
        wait_timeout_ms: { type: "integer", minimum: 0, maximum: MAX_WAIT_FOR_MS },
        max_output_chars: { type: "integer", minimum: 1000, maximum: MAX_OUTPUT_CHARS },
        max_output_tokens: { type: "integer", minimum: 1000, maximum: MAX_OUTPUT_CHARS },
      },
      required: ["session_id"],
    };
  }

  async execute(params: {
    session_id?: string;
    sessionId?: string;
    chars?: string | null;
    close_stdin?: boolean;
    closeStdin?: boolean;
    terminate?: boolean;
    yield_time_ms?: number | null;
    yieldTimeMs?: number | null;
    wait_for?: string | null;
    waitFor?: string | null;
    wait_timeout_ms?: number | null;
    waitTimeoutMs?: number | null;
    max_output_chars?: number | null;
    maxOutputChars?: number | null;
    max_output_tokens?: number | null;
    maxOutputTokens?: number | null;
  } = {}, context?: ToolExecutionContext): Promise<string> {
    const sessionId = params.session_id ?? params.sessionId ?? "";
    const outputLimit = clampSessionInt(
      params.max_output_chars ?? params.maxOutputChars ?? params.max_output_tokens ?? params.maxOutputTokens,
      DEFAULT_MAX_OUTPUT_CHARS,
      1000,
      MAX_OUTPUT_CHARS,
    );
    try {
      const waitFor = params.wait_for ?? params.waitFor;
      if (waitFor) {
        return this.waitForOutput({
          sessionId,
          chars: params.chars,
          closeStdin: params.close_stdin ?? params.closeStdin ?? false,
          terminate: params.terminate ?? false,
          waitFor,
          waitTimeoutMs: clampSessionInt(params.wait_timeout_ms ?? params.waitTimeoutMs, DEFAULT_WAIT_FOR_MS, 0, MAX_WAIT_FOR_MS),
          maxOutputChars: outputLimit,
          abortSignal: context?.abortSignal ?? null,
        });
      }
      const poll = await this.manager.write({
        sessionId,
        chars: params.chars,
        closeStdin: params.close_stdin ?? params.closeStdin ?? false,
        terminate: params.terminate ?? false,
        yieldTimeMs: clampSessionInt(params.yield_time_ms ?? params.yieldTimeMs, DEFAULT_YIELD_MS, 0, MAX_YIELD_MS),
        maxOutputChars: outputLimit,
        abortSignal: context?.abortSignal ?? null,
      });
      return formatSessionPoll(sessionId, poll);
    } catch (error) {
      if (isToolAbortError(error)) throw error;
      const message = (error as Error).message;
      if (message.startsWith("exec session not found")) return `Error: ${message}`;
      return `Error writing to exec session: ${message}`;
    }
  }

  private async waitForOutput({
    sessionId,
    chars,
    closeStdin,
    terminate,
    waitFor,
    waitTimeoutMs,
    maxOutputChars,
    abortSignal,
  }: {
    sessionId: string;
    chars?: string | null;
    closeStdin: boolean;
    terminate: boolean;
    waitFor: string;
    waitTimeoutMs: number;
    maxOutputChars: number;
    abortSignal?: AbortSignal | null;
  }): Promise<string> {
    const deadline = Date.now() + waitTimeoutMs;
    const aggregate: string[] = [];
    let first = true;
    let poll: SessionPoll | null = null;
    while (true) {
      const remaining = Math.max(0, deadline - Date.now());
      const step = Math.min(500, remaining);
      poll = await this.manager.write({
        sessionId,
        chars: first ? chars : null,
        closeStdin: first ? closeStdin : false,
        terminate: first ? terminate : false,
        yieldTimeMs: step,
        maxOutputChars,
        abortSignal,
      });
      first = false;
      if (poll.output) {
        aggregate.push(poll.output);
        const joined = aggregate.join("");
        if (joined.includes(waitFor)) {
          if (!poll.done) {
            const grace = await this.manager.write({
              sessionId,
              chars: null,
              closeStdin: false,
              terminate: false,
              yieldTimeMs: 100,
              maxOutputChars,
              abortSignal,
            });
            if (grace.output) aggregate.push(grace.output);
            poll = { ...grace, output: aggregate.join("") };
          } else {
            poll.output = joined;
          }
          return formatSessionPoll(sessionId, poll);
        }
      }
      if (poll.done || Date.now() >= deadline) break;
    }
    if (poll) poll.output = aggregate.join("");
    const formatted = formatSessionPoll(sessionId, poll ?? {
      output: "",
      done: false,
      exitCode: null,
      elapsedS: 0,
      timedOut: false,
      terminated: false,
      stdinClosed: false,
      truncatedChars: 0,
    });
    return `${formatted}\nWait target not observed: '${waitFor}'`;
  }
}

export class ListExecSessionsTool extends Tool {
  static scopes = new Set(["core", "subagent"]);
  manager: ExecSessionManager;

  constructor({ manager = DEFAULT_EXEC_SESSION_MANAGER }: { manager?: ExecSessionManager } = {}) {
    super();
    this.manager = manager;
  }

  static create(ctx: any): Tool {
    return new ListExecSessionsTool({ manager: ctx?.execSessionManager ?? DEFAULT_EXEC_SESSION_MANAGER });
  }

  get readOnly(): boolean {
    return true;
  }

  get name(): string {
    return "list_exec_sessions";
  }

  get description(): string {
    return (
      "List active long-running exec sessions, including session_id, cwd, elapsed time, idle time, remaining timeout, and command preview. " +
      "Use this to recover a session_id after context shifts before polling, writing stdin, or terminating with write_stdin."
    );
  }

  get parameters() {
    return { type: "object", properties: {} };
  }

  async execute(): Promise<string> {
    const sessions = await this.manager.list();
    if (!sessions.length) return "No active exec sessions.";
    return sessions
      .map((session) => {
        const remaining = Number.isFinite(session.remainingS) ? `${session.remainingS.toFixed(1)}s` : "unlimited";
        return `${session.sessionId} running elapsed=${session.elapsedS.toFixed(1)}s idle=${session.idleS.toFixed(1)}s remaining=${remaining} cwd=${session.cwd} command=${session.command}`;
      })
      .join("\n");
  }
}
