import { ChildProcess, spawn } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { containsInternalUrl } from "../../../security/network.js";
import { getMediaDir } from "../../../config/paths.js";
import { Tool, type ToolExecutionContext } from "./base.js";
import { CommandOutputDecoder, type CommandOutputDecoderOptions } from "./command-output-decoder.js";
import {
  DEFAULT_EXEC_SESSION_MANAGER,
  DEFAULT_MAX_OUTPUT_CHARS,
  DEFAULT_YIELD_MS,
  ExecSessionManager,
  MAX_OUTPUT_CHARS,
  MAX_YIELD_MS,
  clampSessionInt,
  formatSessionPoll,
  truncateOutput,
} from "./exec-session.js";
import { isPathInside } from "./path-utils.js";
import { wrapCommand } from "./sandbox.js";

let isWindows = process.platform === "win32";

export function setIsWindowsForTest(value: boolean): void {
  isWindows = value;
}

const WORKSPACE_BOUNDARY_NOTE =
  "\n\nNote: this is a hard policy boundary, not a transient failure. " +
  "Do NOT retry with shell tricks (symlinks, base64 piping, alternative tools, working_dir overrides).";

export class ExecToolConfig {
  enable = true;
  enabled = true;
  timeout = 60;
  timeoutS = 60;
  pathAppend = "";
  sandbox = "";
  allowedEnvKeys: string[] = [];
  allowPatterns: string[] = [];
  denyPatterns: string[] = [];
  restrictToWorkspace = false;

  constructor(init: Partial<ExecToolConfig> = {}) {
    this.enabled = this.enable = init.enabled ?? init.enable ?? true;
    this.timeout = init.timeout ?? init.timeoutS ?? 60;
    if (!Number.isInteger(this.timeout) || this.timeout < 0) throw new Error("timeout must be a non-negative integer");
    this.timeoutS = this.timeout;
    this.pathAppend = init.pathAppend ?? "";
    this.sandbox = init.sandbox ?? "";
    this.allowedEnvKeys = init.allowedEnvKeys ?? [];
    this.allowPatterns = init.allowPatterns ?? [];
    this.denyPatterns = init.denyPatterns ?? [];
    this.restrictToWorkspace = init.restrictToWorkspace ?? false;
  }
}

type PreparedCommand = {
  command: string;
  cwd: string;
  env: NodeJS.ProcessEnv;
  timeout: number | null;
  shellProgram: string | null;
  login: boolean;
};

const BUILTIN_DENY_PATTERNS = [
  String.raw`\brm\s+-[rf]{1,2}\b`,
  String.raw`\bdel\s+/[fq]\b`,
  String.raw`\brmdir\s+/s\b`,
  String.raw`(?:^|[;&|]\s*)format(?!=)\b`,
  String.raw`\b(mkfs|diskpart)\b`,
  String.raw`\bdd\s+if=`,
  String.raw`>\s*/dev/sd`,
  String.raw`\b(shutdown|reboot|poweroff)\b`,
  String.raw`:\(\)\s*\{.*\};\s*:`,
  String.raw`>>?\s*\S*(?:history\.jsonl|\.dream_cursor)`,
  String.raw`\btee\b[^|;&<>]*(?:history\.jsonl|\.dream_cursor)`,
  String.raw`\b(?:cp|mv)\b(?:\s+[^\s|;&<>]+)+\s+\S*(?:history\.jsonl|\.dream_cursor)`,
  String.raw`\bdd\b[^|;&<>]*\bof=\S*(?:history\.jsonl|\.dream_cursor)`,
  String.raw`\bsed\s+-i[^|;&<>]*(?:history\.jsonl|\.dream_cursor)`,
];

const BENIGN_DEVICE_PATHS = new Set([
  "/dev/null",
  "/dev/zero",
  "/dev/full",
  "/dev/random",
  "/dev/urandom",
  "/dev/stdin",
  "/dev/stdout",
  "/dev/stderr",
  "/dev/tty",
]);

const WINDOWS_ENV_KEYS = [
  "APPDATA",
  "LOCALAPPDATA",
  "ProgramData",
  "ProgramFiles",
  "ProgramFiles(x86)",
  "ProgramW6432",
];

function existingShell(candidate: string): string | null {
  return fs.existsSync(candidate) ? candidate : null;
}

function shellName(value: string): string {
  return path.basename(value).toLowerCase();
}

function expandHome(value: string): string {
  return value === "~" || value.startsWith("~/") ? path.join(os.homedir(), value.slice(2)) : value;
}

function isWindowsAbsolutePath(value: string): boolean {
  return /^[A-Za-z]:[\\/]/.test(value) || value.startsWith("\\\\");
}

function normalizeWindowsPath(value: string): string {
  let normalized = value.replace(/\//g, "\\");
  if (/^[A-Za-z]:$/.test(normalized)) normalized += "\\";
  while (normalized.length > 3 && normalized.endsWith("\\")) normalized = normalized.slice(0, -1);
  return normalized.toLowerCase();
}

function firstNonEmptyString(...values: Array<string | null | undefined>): string | undefined {
  for (const value of values) {
    if (typeof value === "string" && value.trim()) return value;
  }
  return undefined;
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

function isWindowsPathInside(target: string, root: string): boolean {
  if (!isWindowsAbsolutePath(target) || !isWindowsAbsolutePath(root)) return false;
  const normalizedTarget = normalizeWindowsPath(target);
  const normalizedRoot = normalizeWindowsPath(root);
  if (normalizedTarget === normalizedRoot) return true;
  const prefix = normalizedRoot.endsWith("\\") ? normalizedRoot : `${normalizedRoot}\\`;
  return normalizedTarget.startsWith(prefix);
}

export class ExecTool extends Tool {
  static scopes = new Set(["core", "subagent"]);
  static configKey = "exec";
  static MAX_TIMEOUT = 600;
  static DEFAULT_OUTPUT_CHARS = 10_000;
  workspace: string;
  workingDir: string;
  config: ExecToolConfig;
  timeout: number;
  sandbox: string;
  denyPatterns: string[];
  allowPatterns: string[];
  restrictToWorkspace: boolean;
  pathAppend: string;
  allowedEnvKeys: string[];
  sessionManager: ExecSessionManager;
  private readonly commandOutputDecoderOptions: CommandOutputDecoderOptions;

  constructor({
    workspace,
    workingDir,
    config = new ExecToolConfig(),
    timeout,
    timeoutS,
    restrictToWorkspace,
    sandbox,
    pathAppend,
    allowedEnvKeys,
    allowPatterns,
    denyPatterns,
    sessionManager = DEFAULT_EXEC_SESSION_MANAGER,
    commandOutputDecoderOptions = {},
  }: {
    workspace?: string;
    workingDir?: string;
    config?: ExecToolConfig;
    timeout?: number;
    timeoutS?: number;
    restrictToWorkspace?: boolean;
    sandbox?: string;
    pathAppend?: string;
    allowedEnvKeys?: string[];
    allowPatterns?: string[];
    denyPatterns?: string[];
    sessionManager?: ExecSessionManager;
    commandOutputDecoderOptions?: CommandOutputDecoderOptions;
  } = {}) {
    super();
    this.config = config instanceof ExecToolConfig ? config : new ExecToolConfig(config);
    this.workspace = path.resolve(String(workspace ?? workingDir ?? process.cwd()));
    this.workingDir = this.workspace;
    this.timeout = timeout ?? timeoutS ?? this.config.timeout;
    this.config.timeout = this.config.timeoutS = this.timeout;
    this.sandbox = sandbox ?? this.config.sandbox;
    this.config.sandbox = this.sandbox;
    this.pathAppend = pathAppend ?? this.config.pathAppend;
    this.config.pathAppend = this.pathAppend;
    this.allowedEnvKeys = allowedEnvKeys ?? this.config.allowedEnvKeys;
    this.config.allowedEnvKeys = this.allowedEnvKeys;
    this.allowPatterns = allowPatterns ?? this.config.allowPatterns;
    this.config.allowPatterns = this.allowPatterns;
    const extraDeny = denyPatterns ?? this.config.denyPatterns;
    this.denyPatterns = [...BUILTIN_DENY_PATTERNS, ...extraDeny];
    this.config.denyPatterns = extraDeny;
    this.restrictToWorkspace = restrictToWorkspace ?? this.config.restrictToWorkspace;
    this.config.restrictToWorkspace = this.restrictToWorkspace;
    this.sessionManager = sessionManager;
    this.commandOutputDecoderOptions = commandOutputDecoderOptions;
  }

  static configCls(): typeof ExecToolConfig {
    return ExecToolConfig;
  }

  static enabled(ctx: any): boolean {
    const config = ctx?.config?.exec ?? ctx?.config?.tools?.exec;
    return config?.enable ?? config?.enabled ?? true;
  }

  static create(ctx: any): Tool {
    const raw = ctx?.config?.exec ?? ctx?.config?.tools?.exec ?? {};
    const config = raw instanceof ExecToolConfig ? raw : new ExecToolConfig(raw);
    return new ExecTool({
      workspace: ctx?.workspace ?? process.cwd(),
      config,
      restrictToWorkspace: ctx?.config?.restrictToWorkspace ?? config.restrictToWorkspace,
      sessionManager: ctx?.execSessionManager ?? DEFAULT_EXEC_SESSION_MANAGER,
    });
  }

  get name(): string {
    return "exec";
  }

  get description(): string {
    return (
      "Execute a shell command and return its output. " +
      "Use this for tests, builds, package commands, git commands, and other process execution. " +
      "Prefer read_file/find_files/grep for inspection and apply_patch/write_file/edit_file for file changes instead of cat, shell find/grep, echo, or sed. " +
      "Use -y or --yes flags to avoid interactive prompts. " +
      "For long-running or interactive commands, pass yield_time_ms; if the command keeps running, exec returns a session_id that can be polled or written to with write_stdin. " +
      "Output is truncated at 10 000 chars; timeout defaults to 60s."
    );
  }

  get exclusive(): boolean {
    return true;
  }

  get parameters() {
    return {
      type: "object",
      properties: {
        command: { type: "string" },
        cmd: { type: "string" },
        cwd: { type: "string" },
        working_dir: { type: "string" },
        workdir: { type: "string" },
        timeout: { type: "integer", minimum: 1, maximum: ExecTool.MAX_TIMEOUT },
        timeout_s: { type: "integer", minimum: 1, maximum: ExecTool.MAX_TIMEOUT },
        timeoutS: { type: "integer", minimum: 1, maximum: ExecTool.MAX_TIMEOUT },
        shell: { type: "string" },
        login: { type: "boolean" },
        yield_time_ms: { type: "integer", minimum: 0, maximum: MAX_YIELD_MS },
        max_output_chars: { type: "integer", minimum: 1000, maximum: MAX_OUTPUT_CHARS },
        max_output_tokens: { type: "integer", minimum: 1000, maximum: MAX_OUTPUT_CHARS },
      },
    };
  }

  static extractAbsolutePaths(command: string): string[] {
    const commandWithoutUrls = command.replace(/https?:\/\/[^\s'"`<>]+/gi, "");
    const paths = new Set<string>();
    for (const m of commandWithoutUrls.matchAll(/(?<![A-Za-z])(?:[A-Za-z]:[^\s"'|><;]*|\\\\[^\s"'|><;]+(?:\\[^\s"'|><;]+)*)/g)) {
      paths.add(m[0]);
    }
    for (const m of commandWithoutUrls.matchAll(/(?:^|[\s|>'"])(\/[^\s"'>;|<)]+)/g)) {
      paths.add(m[1]);
    }
    for (const m of commandWithoutUrls.matchAll(/(?:^|[\s>'"])(~[^\s"'>;|<)]*)/g)) {
      paths.add(m[1]);
    }
    return [...paths];
  }

  static async spawnProcess(
    command: string,
    cwd: string,
    env: NodeJS.ProcessEnv,
    shellProgram: string | null = null,
    login = true,
  ): Promise<ChildProcess> {
    if (isWindows) {
      return spawn(command, { cwd, env, shell: true, windowsHide: true, stdio: ["ignore", "pipe", "pipe"] });
    }
    const shellProgramResolved = shellProgram ?? existingShell("/bin/bash") ?? existingShell("/usr/bin/bash") ?? "bash";
    const args = [];
    if (login && ["bash", "bash.exe", "zsh", "zsh.exe"].includes(shellName(shellProgramResolved))) args.push("-l");
    args.push("-c", command);
    return spawn(shellProgramResolved, args, { cwd, env, stdio: ["ignore", "pipe", "pipe"] });
  }

  static resolveShell(shell?: string | null): [string | null, string | null] {
    if (!shell) return [null, null];
    if (isWindows) return [null, "Error: shell parameter is not supported on Windows"];
    if (shell.includes("\0") || shell.includes("\n") || shell.includes("\r")) return [null, "Error: shell contains invalid characters"];
    const allowed = new Set(["sh", "bash", "zsh"]);
    if (path.isAbsolute(shell)) {
      if (!allowed.has(path.basename(shell))) return [null, `Error: unsupported shell ${JSON.stringify(shell)}. Allowed: bash, sh, zsh`];
      if (!fs.existsSync(shell) || !fs.statSync(shell).isFile()) return [null, `Error: shell is not executable: ${shell}`];
      return [shell, null];
    }
    if (shell.includes("/") || shell.includes("\\")) return [null, "Error: shell must be a shell name or absolute path"];
    if (!allowed.has(shell)) return [null, `Error: unsupported shell ${JSON.stringify(shell)}. Allowed: bash, sh, zsh`];
    const resolved = existingShell(`/bin/${shell}`) ?? existingShell(`/usr/bin/${shell}`);
    if (!resolved) return [null, `Error: shell not found: ${shell}`];
    return [resolved, null];
  }

  resolveShell(shell?: string | null): [string | null, string | null] {
    return ExecTool.resolveShell(shell);
  }

  resolveTimeout(timeout?: number | null): number | null {
    if (timeout && timeout > 0) return Math.min(timeout, ExecTool.MAX_TIMEOUT);
    if (this.timeout && this.timeout > 0) return this.timeout;
    return null;
  }

  buildEnv(): NodeJS.ProcessEnv {
    if (isWindows) {
      const sr = process.env.SYSTEMROOT ?? "C:\\Windows";
      const env: NodeJS.ProcessEnv = {
        SYSTEMROOT: sr,
        COMSPEC: process.env.COMSPEC ?? `${sr}\\system32\\cmd.exe`,
        USERPROFILE: process.env.USERPROFILE ?? "",
        HOMEDRIVE: process.env.HOMEDRIVE ?? "C:",
        HOMEPATH: process.env.HOMEPATH ?? "\\",
        TEMP: process.env.TEMP ?? `${sr}\\Temp`,
        TMP: process.env.TMP ?? `${sr}\\Temp`,
        PATHEXT: process.env.PATHEXT ?? ".COM;.EXE;.BAT;.CMD",
        PATH: process.env.PATH ?? `${sr}\\system32;${sr}`,
      };
      for (const key of WINDOWS_ENV_KEYS) env[key] = process.env[key] ?? "";
      for (const key of this.allowedEnvKeys) {
        const value = process.env[key];
        if (value != null) env[key] = value;
      }
      return env;
    }
    const env: NodeJS.ProcessEnv = {
      HOME: process.env.HOME ?? os.tmpdir(),
      LANG: process.env.LANG ?? "C.UTF-8",
      TERM: process.env.TERM ?? "dumb",
    };
    for (const key of this.allowedEnvKeys) {
      const value = process.env[key];
      if (value != null) env[key] = value;
    }
    return env;
  }

  static isBenignDevicePath(value: string): boolean {
    return BENIGN_DEVICE_PATHS.has(value) || value.startsWith("/dev/fd/");
  }

  isBenignDevicePath(value: string): boolean {
    return ExecTool.isBenignDevicePath(value);
  }

  async guardCommand(command: string, cwd = this.workspace): Promise<string | null> {
    const cmd = command.trim();
    const lower = cmd.toLowerCase();
    const explicitlyAllowed = this.allowPatterns.length > 0 && this.allowPatterns.some((pattern) => new RegExp(pattern, "i").test(lower));
    if (!explicitlyAllowed) {
      for (const pattern of this.denyPatterns) {
        if (new RegExp(pattern, "i").test(lower)) return "Error: Command blocked by deny pattern filter";
      }
      if (this.allowPatterns.length) return "Error: Command blocked by allowlist filter (not in allowlist)";
    }

    if (await containsInternalUrl(cmd)) return "Error: Command blocked by safety guard (internal/private URL detected)";

    if (this.restrictToWorkspace) {
      if (cmd.includes("../") || cmd.includes("..\\")) {
        return "Error: Command blocked by safety guard (path traversal detected)" + WORKSPACE_BOUNDARY_NOTE;
      }
      const cwdPath = path.resolve(cwd);
      const mediaPath = path.resolve(getMediaDir());
      for (const raw of ExecTool.extractAbsolutePaths(cmd)) {
        if (isWindowsAbsolutePath(raw)) {
          if (!isWindowsPathInside(raw, cwd)) {
            return "Error: Command blocked by safety guard (path outside working dir)" + WORKSPACE_BOUNDARY_NOTE;
          }
          continue;
        }
        const expanded = expandHome(raw);
        if (ExecTool.isBenignDevicePath(expanded)) continue;
        const absolute = path.resolve(expanded);
        if (ExecTool.isBenignDevicePath(absolute)) continue;
        if (!isPathInside(absolute, cwdPath) && !isPathInside(absolute, mediaPath)) {
          return "Error: Command blocked by safety guard (path outside working dir)" + WORKSPACE_BOUNDARY_NOTE;
        }
      }
    }
    return null;
  }

  async prepareCommand(
    command: string,
    workingDir?: string | null,
    timeout?: number | null,
    shell?: string | null,
    login?: boolean | null,
  ): Promise<PreparedCommand | string> {
    let cwd = workingDir ? path.resolve(this.workspace, workingDir) : this.workingDir;
    if (this.restrictToWorkspace) {
      try {
        const requested = path.resolve(cwd);
        const root = path.resolve(this.workingDir);
        if (!isPathInside(requested, root)) {
          return "Error: working_dir is outside the configured workspace" + WORKSPACE_BOUNDARY_NOTE;
        }
      } catch {
        return "Error: working_dir could not be resolved" + WORKSPACE_BOUNDARY_NOTE;
      }
    }

    const guardError = await this.guardCommand(command, cwd);
    if (guardError) return guardError;

    if (this.sandbox) {
      if (!isWindows) {
        const workspace = this.workingDir || cwd;
        command = wrapCommand(this.sandbox, command, workspace, cwd);
        cwd = path.resolve(workspace);
      }
    }

    const env = this.buildEnv();
    if (this.pathAppend) {
      if (isWindows) {
        env.PATH = `${env.PATH ?? ""};${this.pathAppend}`;
      } else {
        env.MEMMY_AGENT_PATH_APPEND = this.pathAppend;
        command = `export PATH="$PATH${path.delimiter}$MEMMY_AGENT_PATH_APPEND"; ${command}`;
      }
    }

    const [shellProgram, shellError] = this.resolveShell(shell);
    if (shellError) return shellError;
    return {
      command,
      cwd,
      env,
      timeout: this.resolveTimeout(timeout),
      shellProgram,
      login: login ?? true,
    };
  }

  async execute(params: {
    command?: string;
    cmd?: string;
    cwd?: string;
    working_dir?: string;
    workingDir?: string;
    workdir?: string;
    timeout?: number;
    timeout_s?: number;
    timeoutS?: number;
    shell?: string | null;
    login?: boolean | null;
    yield_time_ms?: number | null;
    yieldTimeMs?: number | null;
    max_output_chars?: number | null;
    maxOutputChars?: number | null;
    max_output_tokens?: number | null;
    maxOutputTokens?: number | null;
  } = {}, context?: ToolExecutionContext): Promise<string> {
    const command = firstNonEmptyString(params.command, params.cmd);
    if (!command) return "Error: Missing command. Provide command or cmd.";
    const signal = context?.abortSignal ?? null;
    const maxOutputParam = params.max_output_chars ?? params.maxOutputChars ?? params.max_output_tokens ?? params.maxOutputTokens;
    const prepared = await this.prepareCommand(
      command,
      firstNonEmptyString(params.cwd, params.working_dir, params.workingDir, params.workdir),
      params.timeout ?? params.timeout_s ?? params.timeoutS,
      firstNonEmptyString(params.shell),
      params.login,
    );
    if (typeof prepared === "string") return prepared;

    const maxOutputChars = clampSessionInt(maxOutputParam, ExecTool.DEFAULT_OUTPUT_CHARS, 1000, MAX_OUTPUT_CHARS);
    if (params.yield_time_ms != null || params.yieldTimeMs != null) {
      try {
        throwIfAborted(signal);
        const [sessionId, poll] = await this.sessionManager.start({
          command: prepared.command,
          cwd: prepared.cwd,
          env: prepared.env,
          timeout: prepared.timeout,
          shellProgram: prepared.shellProgram,
          login: prepared.login,
          yieldTimeMs: clampSessionInt(params.yield_time_ms ?? params.yieldTimeMs, DEFAULT_YIELD_MS, 0, MAX_YIELD_MS),
          maxOutputChars: clampSessionInt(maxOutputParam, DEFAULT_MAX_OUTPUT_CHARS, 1000, MAX_OUTPUT_CHARS),
          decoderOptions: this.outputDecoderOptions(),
          abortSignal: signal,
        });
        return formatSessionPoll(sessionId, poll);
      } catch (error) {
        if (isToolAbortError(error)) throw error;
        return `Error executing command: ${(error as Error).message}`;
      }
    }

    try {
      throwIfAborted(signal);
      const child = await ExecTool.spawnProcess(prepared.command, prepared.cwd, prepared.env, prepared.shellProgram, prepared.login);
      return await new Promise((resolve, reject) => {
        const stdoutDecoder = new CommandOutputDecoder(this.outputDecoderOptions());
        const stderrDecoder = new CommandOutputDecoder(this.outputDecoderOptions());
        let settled = false;
        let timer: NodeJS.Timeout | null = null;
        let killTimer: NodeJS.Timeout | null = null;
        const cleanup = () => {
          if (timer) clearTimeout(timer);
          if (killTimer) clearTimeout(killTimer);
          signal?.removeEventListener("abort", onAbort);
        };
        const onAbort = () => {
          if (settled) return;
          settled = true;
          if (timer) clearTimeout(timer);
          child.kill("SIGTERM");
          killTimer = setTimeout(() => {
            if (child.exitCode == null && child.signalCode == null) child.kill("SIGKILL");
          }, 1000);
          killTimer.unref?.();
          reject(createToolAbortError());
        };
        if (signal?.aborted) {
          child.kill("SIGTERM");
          reject(createToolAbortError());
          return;
        }
        signal?.addEventListener("abort", onAbort, { once: true });
        if (prepared.timeout != null) {
          timer = setTimeout(() => {
            if (settled) return;
            settled = true;
            cleanup();
            child.kill("SIGTERM");
            resolve(`Error: Command timed out after ${prepared.timeout} seconds`);
          }, prepared.timeout * 1000);
        }
        child.stdout?.on("data", (chunk: Buffer) => stdoutDecoder.push(chunk));
        child.stderr?.on("data", (chunk: Buffer) => stderrDecoder.push(chunk));
        child.on("error", (error) => {
          if (settled) return;
          settled = true;
          cleanup();
          resolve(`Error executing command: ${error.message}`);
        });
        child.on("close", (code) => {
          if (settled) return;
          settled = true;
          cleanup();
          const stdout = stdoutDecoder.end();
          const stderr = stderrDecoder.end();
          const parts = [];
          if (stdout) parts.push(stdout);
          if (stderr.trim()) parts.push(`STDERR:\n${stderr}`);
          parts.push(`\nExit code: ${code}`);
          const body = parts.length ? parts.join("\n") : "(no output)";
          const [truncated] = truncateOutput(body, maxOutputChars);
          resolve(code === 0 ? truncated : `Error: command exited with ${code}\n${truncated}`);
        });
      });
    } catch (error) {
      if (isToolAbortError(error)) throw error;
      return `Error executing command: ${(error as Error).message}`;
    }
  }

  private outputDecoderOptions(): CommandOutputDecoderOptions {
    return {
      ...this.commandOutputDecoderOptions,
      platform: isWindows ? "win32" : process.platform,
    };
  }
}

export class ShellTool extends ExecTool {}
