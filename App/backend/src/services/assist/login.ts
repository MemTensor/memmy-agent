/**
 * 未登录时由 Memmy 代为发起登录。
 *
 * <p>执行方选的 Agent 没登录时，最坏的情况是对方点完允许、等了很久才看到一句「执行失败」。
 * 这里在那一步接过来：用这个 Agent 引擎自带的登录命令在**执行方的电脑上**打开浏览器，
 * 她登录完成后用同样的参数重跑一次。Memmy 不读也不解密任何 App 自己的令牌——那些令牌只在
 * App 拉起引擎时注入，登录结果由命令行写进这个 Agent 自己的配置目录（{@code ~/.claude}、
 * {@code ~/.codex} 等），与 App 共用。</p>
 *
 * <p>登录命令只接标准输出与标准错误，不接标准输入：这些命令都要靠浏览器完成，
 * 不应该要求有人在终端里粘贴东西。核实下来确实要交互终端的 Agent 在这里没有配置登录命令，
 * 只给出「登录后再试」的提示。</p>
 */
import { spawn } from "node:child_process";
import { existsSync } from "node:fs";
import { join } from "node:path";

import type { AssistStep } from "./acp-client.js";
import { adaptersDirectory, installedAdapterPath, adapterFor } from "./adapters.js";
import { ASSIST_COMMAND_ENV, findExecutable, shellLaunch } from "./executables.js";
import { qwenWorkEngine } from "./recipes.js";
import { assistEnv } from "./shell-env.js";

/** 打开登录页后最多等这么久：超过就当这次登录没有完成。 */
export const LOGIN_TIMEOUT_MS = 5 * 60 * 1000;

/** 查「是不是已经登录」的上限：只是读状态，不该等太久。 */
const LOGIN_STATUS_TIMEOUT_MS = 5_000;

/** 一个 Agent 的登录命令：命令与参数。进程退出即代表登录完成（成功时退出码为 0）。 */
export interface AssistLoginCommand {
  command: string;
  args: string[];
}

/**
 * 覆盖某个 Agent 的登录命令：`MEMMY_ASSIST_LOGIN_<SOURCE_ID>=…`，值按空格切成命令与参数。
 * 与 {@link ASSIST_COMMAND_ENV} 同一套思路：对方升级后命令变了，不必改代码。
 */
export function ASSIST_LOGIN_ENV(sourceId: string): string {
  return `MEMMY_ASSIST_LOGIN_${sourceId.toUpperCase().replace(/[^A-Z0-9]/gu, "_")}`;
}

export interface AssistSignInLookupOptions {
  env?: NodeJS.ProcessEnv;
  /** 适配器与协助状态目录，默认 {@code MEMMY_HOME} 或 {@code ~/.memmy}。 */
  home?: string;
  /** 已经准备好的适配器可执行文件；有它就不用再去找。 */
  adapterExecutable?: string | null;
  /** QwenWork 应用包位置，测试可注入。 */
  qwenWorkAppDirs?: readonly string[];
}

/**
 * 这个 Agent 自带的登录命令；没有可用命令时返回 null（只提示去登录，不代为发起）。
 *
 * <ul>
 *   <li>Claude Code：适配器的 {@code --cli auth login --claudeai}（把参数转给适配器自带的 CLI），
 *       没有适配器时用 PATH 上的 {@code claude auth login --claudeai}。两者都写 {@code ~/.claude}。</li>
 *   <li>Codex：适配器装出来的 {@code codex login}，没有再退回 PATH 上的 {@code codex login}。</li>
 *   <li>QwenWork：应用包里的 {@code qoderclicn login}。</li>
 * </ul>
 */
export function assistLoginCommand(
  sourceId: string,
  options: AssistSignInLookupOptions = {}
): AssistLoginCommand | null {
  const env = options.env ?? process.env;
  const override = env[ASSIST_LOGIN_ENV(sourceId)]?.trim();
  if (override) {
    const [command, ...args] = override.split(/\s+/u);
    return command ? { command, args } : null;
  }
  if (sourceId === "claude_code") {
    const adapter = options.adapterExecutable ?? installedAdapterFor("claude_code", options.home);
    if (adapter) return { command: adapter, args: ["--cli", "auth", "login", "--claudeai"] };
    const cli = findExecutable("claude", env);
    return cli ? { command: cli, args: ["auth", "login", "--claudeai"] } : null;
  }
  if (sourceId === "codex") {
    // 适配器把 codex 装在自己的 node_modules 里：优先用它那一份，与执行时用的是同一个引擎。
    const bundled = bundledCodexExecutable(options.home, env);
    if (bundled) return { command: bundled, args: ["login"] };
    const cli = findExecutable("codex", env);
    return cli ? { command: cli, args: ["login"] } : null;
  }
  if (sourceId === "qwenwork") {
    const engine = qwenWorkEngine(env, options.qwenWorkAppDirs);
    return engine ? { command: engine, args: ["login"] } : null;
  }
  // 其余 Agent（Cursor、OpenCode、OpenClaw、Hermes、DeepSeek Harness）：不代为登录，只提示。
  return null;
}

/** 适配器装出来的 codex 可执行文件：先看 .bin，再退回包内的 bin。 */
function bundledCodexExecutable(home: string | undefined, env: NodeJS.ProcessEnv): string | null {
  const binDir = join(adaptersDirectory(home), "node_modules", ".bin");
  // Windows 上 npm 给每个 bin 同时装出 `codex.cmd`（批处理）与一个给 posix shell 用的同名无后缀脚本，
  // 后者在 Windows 上跑不起来，所以先找 .cmd。macOS / Linux 上本来就只有无后缀那一个。
  const candidates = process.platform === "win32"
    ? [join(binDir, "codex.cmd"), join(binDir, "codex.exe"), join(binDir, "codex")]
    : [join(binDir, "codex")];
  for (const candidate of candidates) {
    if (existsSync(candidate)) return candidate;
  }
  const installed = installedAdapterFor("codex", home);
  if (installed) {
    const nested = join(
      adaptersDirectory(home), "node_modules", "@openai", "codex", "bin", process.platform === "win32" ? "codex.exe" : "codex.js"
    );
    if (existsSync(nested)) return nested;
  }
  return findExecutable("codex", env);
}

function installedAdapterFor(sourceId: string, home: string | undefined): string | null {
  const adapter = adapterFor(sourceId);
  return adapter ? installedAdapterPath(adapter, home) : null;
}

/**
 * 这个 Agent 现在是不是已经登录了：只有能读状态的才给得出答案，其余返回 null（不知道）。
 *
 * <p>Codex 不查：它可以用 API Key 或自定义 provider（config.toml 里的 model_providers），
 * 只看 {@code auth.json} 在不在会误判。</p>
 */
export async function assistSignedIn(
  sourceId: string,
  options: AssistSignInLookupOptions & { timeoutMs?: number } = {}
): Promise<boolean | null> {
  const env = options.env ?? process.env;
  let command: string | null = null;
  let args: string[] = [];
  if (sourceId === "claude_code") {
    const adapter = options.adapterExecutable ?? installedAdapterFor("claude_code", options.home);
    if (adapter) {
      command = adapter;
      args = ["--cli", "auth", "status"];
    } else {
      command = findExecutable("claude", env);
      args = ["auth", "status"];
    }
  } else if (sourceId === "qwenwork") {
    // status 输出「Account: Not logged in」或「Logged in as …」。
    command = qwenWorkEngine(env, options.qwenWorkAppDirs);
    args = ["status"];
  }
  if (!command) return null;
  const output = await runToEnd(command, args, env, options.timeoutMs ?? LOGIN_STATUS_TIMEOUT_MS).catch(() => null);
  if (output === null) return null;
  if (sourceId === "claude_code") {
    try {
      const parsed = JSON.parse(output.trim()) as { loggedIn?: unknown };
      return parsed.loggedIn === true;
    } catch {
      return null;
    }
  }
  // 输出形如「Account: Not logged in」或「Account: 用户名 / 邮箱」。
  const account = /^\s*account\s*:\s*(.+)$/imu.exec(output)?.[1]?.trim();
  if (!account) return null;
  return !/not logged in|not signed in|no account|^none$/iu.test(account);
}

export type AssistSignInOutcome = "ok" | "unsupported" | "failed" | "timeout" | "cancelled";

export interface AssistSignInOptions extends AssistSignInLookupOptions {
  sourceId: string;
  /** 界面上显示的名字，用来拼「Claude Code 没有登录，已在浏览器打开登录页…」。 */
  name: string;
  onStep: (step: AssistStep) => void;
  signal: AbortSignal;
  timeoutMs?: number;
  statusTimeoutMs?: number;
}

/**
 * 正在进行的登录：同一个 Agent 被几轮执行同时需要登录时只开一次浏览器。
 * 不同排查的请求现在会同时执行，同一个 Agent 的登录命令开两份会互相抢同一份凭据。
 *
 * 这份登录不挂在某一轮的 signal 上：一轮被停了不该把还在等的另一轮一起判成已取消。
 * 用引用计数，等到最后一轮也不再等时才把它结束。
 */
interface SignInBatch {
  promise: Promise<AssistSignInOutcome>;
  controller: AbortController;
  waiters: number;
}
const signingIn = new Map<string, SignInBatch>();

/**
 * 替人发起一次登录并等它结束。返回结果由调用方决定后续文案（这里不改请求状态）。
 * 可以是 "ok" 的三种情况：已经登录（不必再开登录页）、登录进程正常退出、命令不支持。
 *
 * <p>同一个 Agent 已经有登录在等：直接等那一次的结果，不再开第二个登录页。</p>
 */
export async function signIn(options: AssistSignInOptions): Promise<AssistSignInOutcome> {
  if (options.signal.aborted) return "cancelled";
  let batch = signingIn.get(options.sourceId);
  if (!batch) {
    const controller = new AbortController();
    const promise = startSignIn({ ...options, signal: controller.signal })
      .finally(() => signingIn.delete(options.sourceId));
    batch = { promise, controller, waiters: 0 };
    signingIn.set(options.sourceId, batch);
  }
  batch.waiters += 1;
  try {
    // 等同一份登录结果，但自己先被停止时不再继续等。
    return await raceAbort(batch.promise, options.signal);
  } finally {
    batch.waiters -= 1;
    // 最后一轮也不再等了：登录页不必留着。
    if (batch.waiters <= 0) batch.controller.abort();
  }
}

/** 等一个已有的登录结果，但调用方自己停止时立即返回「已取消」。 */
function raceAbort(pending: Promise<AssistSignInOutcome>, signal: AbortSignal): Promise<AssistSignInOutcome> {
  return new Promise<AssistSignInOutcome>((resolve) => {
    const onAbort = (): void => resolve("cancelled");
    signal.addEventListener("abort", onAbort, { once: true });
    void pending.then(
      (outcome) => {
        signal.removeEventListener("abort", onAbort);
        resolve(outcome);
      },
      () => {
        signal.removeEventListener("abort", onAbort);
        resolve("failed");
      }
    );
  });
}

async function startSignIn(options: AssistSignInOptions): Promise<AssistSignInOutcome> {
  const env = assistEnv(options.env ?? process.env);
  const signedIn = await assistSignedIn(options.sourceId, {
    ...pickLookup(options),
    env,
    timeoutMs: options.statusTimeoutMs ?? LOGIN_STATUS_TIMEOUT_MS
  }).catch(() => null);
  // 查到的状态比当前失败更可信：CLI 说已登录，就当作登录信息在，直接重试执行。
  if (signedIn === true) return "ok";

  const login = assistLoginCommand(options.sourceId, { ...pickLookup(options), env });
  if (!login) return "unsupported";
  if (options.signal.aborted) return "cancelled";

  // 先让界面知道浏览器要开了：登录页在这一步弹出，她需要在浏览器里完成。
  options.onStep({ text: `${options.name} 没有登录，已在浏览器打开登录页，请在浏览器中完成登录` });
  return await waitForLogin(login, env, options.timeoutMs ?? LOGIN_TIMEOUT_MS, options.signal);
}

/** 只挑查询登录信息用的字段：其余是给执行流程的。 */
function pickLookup(options: AssistSignInLookupOptions): AssistSignInLookupOptions {
  return {
    ...(options.home === undefined ? {} : { home: options.home }),
    ...(options.adapterExecutable === undefined ? {} : { adapterExecutable: options.adapterExecutable }),
    ...(options.qwenWorkAppDirs === undefined ? {} : { qwenWorkAppDirs: options.qwenWorkAppDirs })
  };
}

/** 拉起登录命令并等它退出；超时或点了停止都杀掉进程。 */
function waitForLogin(
  login: AssistLoginCommand,
  env: NodeJS.ProcessEnv,
  timeoutMs: number,
  signal: AbortSignal
): Promise<AssistSignInOutcome> {
  return new Promise<AssistSignInOutcome>((resolve) => {
    if (signal.aborted) {
      resolve("cancelled");
      return;
    }
    // 不接标准输入：登录靠浏览器完成，要求有人在终端里粘贴东西的 Agent 不在这里代为登录。
    // Windows 上登录命令常是 `.cmd`（适配器与 npm 装出来的 CLI），同样要交给 cmd.exe（见 ./executables）。
    const launch = shellLaunch(login.command, login.args, { env });
    const child = spawn(launch.command, launch.args, {
      env,
      stdio: ["ignore", "pipe", "pipe"],
      ...(launch.windowsVerbatimArguments ? { windowsVerbatimArguments: true } : {})
    });
    let settled = false;
    const settle = (outcome: AssistSignInOutcome): void => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      signal.removeEventListener("abort", onAbort);
      if (!child.killed) child.kill("SIGTERM");
      resolve(outcome);
    };
    const timer = setTimeout(() => settle("timeout"), timeoutMs);
    const onAbort = (): void => settle("cancelled");
    signal.addEventListener("abort", onAbort, { once: true });
    // 登录命令的输出去哪了不重要，但不读会让子进程在管道写满时卡住。
    child.stdout?.resume();
    child.stderr?.resume();
    child.on("error", () => settle("failed"));
    child.on("exit", (code) => settle(code === 0 ? "ok" : "failed"));
  });
}

/**
 * 跑一条只读命令取回标准输出（查登录状态用）。
 *
 * <p>不看退出码：{@code claude auth status} 在未登录时会打印 JSON 然后以 1 退出（实测 0.100.0），
 * 按退出码判断会把它当成「查不到状态」。能不能读出登录状态以输出为准，读不出再当作不知道。</p>
 */
function runToEnd(
  command: string,
  args: string[],
  env: NodeJS.ProcessEnv,
  timeoutMs: number
): Promise<string> {
  return new Promise<string>((resolve, reject) => {
    const launch = shellLaunch(command, args, { env });
    const child = spawn(launch.command, launch.args, {
      env,
      stdio: ["ignore", "pipe", "pipe"],
      ...(launch.windowsVerbatimArguments ? { windowsVerbatimArguments: true } : {})
    });
    let output = "";
    let settled = false;
    const finish = (error: Error | null): void => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      if (!child.killed) child.kill("SIGTERM");
      if (error) reject(error);
      else resolve(output);
    };
    const timer = setTimeout(() => finish(new Error("超时")), timeoutMs);
    child.stdout.setEncoding("utf8");
    child.stdout.on("data", (chunk: string) => {
      output = `${output}${chunk}`.slice(-4_000);
    });
    child.stderr.resume();
    child.on("error", (error) => finish(error));
    child.on("exit", () => finish(null));
  });
}
