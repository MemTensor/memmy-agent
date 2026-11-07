/**
 * 协助用的环境变量：把用户登录 shell 的 PATH 补进来。
 *
 * <p>打包后的 Memmy 从 Dock 启动时，进程 PATH 只有系统默认的几个目录，不读 {@code ~/.zshrc}。
 * Homebrew、nvm、fnm、volta 装的 npm / node，以及各 Agent 的命令行都装在这些目录里，按进程 PATH
 * 去找一个都找不到；{@code npm} 本身还是 {@code #!/usr/bin/env node} 脚本，PATH 上没有 node 时
 * 即使按绝对路径找到它也跑不起来。因此第一次需要时读一次用户登录 shell 的 PATH，进程内缓存。</p>
 *
 * <p>读取时用定界标记包住 {@code $PATH}：rc 文件经常会打印别的东西（版本提示、首次配置向导），
 * 直接取整段输出会把这些噪音当成 PATH。读取设了短超时，rc 文件里有卡住的命令时退回进程 PATH，
 * 不能让一次读取把协助拖住。Windows 没有这套登录 shell，直接跳过。</p>
 */
import { execFileSync } from "node:child_process";

import { LOOKUP_DIRS } from "./executables.js";

/** 包住 PATH 的定界标记：rc 文件打印的内容不会包含它。 */
const PATH_MARKER = "__MEMMY_ASSIST_PATH__";

/** 读登录 shell 的上限：rc 文件卡住时不能一直等。 */
export const LOGIN_SHELL_TIMEOUT_MS = 5_000;

/** 执行登录 shell 的方式：默认同步执行并带超时，测试可替换。 */
export type LoginShellRunner = (
  shell: string,
  script: string,
  env: NodeJS.ProcessEnv,
  timeoutMs: number
) => string | null;

export interface LoginShellPathOptions {
  /** 读 PATH 时用的环境变量（要读 {@code SHELL} 与 {@code HOME}）。 */
  env?: NodeJS.ProcessEnv;
  /** 指定登录 shell，默认取 {@code $SHELL}。 */
  shell?: string;
  timeoutMs?: number;
  /** 直接当作「读不到」：不需要登录 shell PATH 时用，单测也用它避免真的跑用户 shell。 */
  disabled?: boolean;
  /** 只在测试里替换执行方式。 */
  run?: LoginShellRunner;
  /** 只在测试里替换平台判断。 */
  platform?: NodeJS.Platform;
}

/**
 * 读一次用户登录 shell 的 PATH；读不到时返回 null（调用方退回进程 PATH）。
 * 这里不缓存，缓存由 {@link loginShellPath} 负责。
 */
export function readLoginShellPath(options: LoginShellPathOptions = {}): string | null {
  // Windows 没有 `zsh -ilc` 这套，也没有 rc 文件里追加 PATH 的习惯。
  if ((options.platform ?? process.platform) === "win32") return null;
  if (options.disabled) return null;
  const env = options.env ?? process.env;
  const shell = (options.shell ?? env.SHELL ?? "").trim();
  // 没有登录 shell 可用时不必猜：进程 PATH 加上常见目录已经覆盖了大部分安装位置。
  if (!shell) return null;
  const script = `printf '${PATH_MARKER}%s${PATH_MARKER}' "$PATH"`;
  const output = (options.run ?? runLoginShell)(shell, script, env, options.timeoutMs ?? LOGIN_SHELL_TIMEOUT_MS);
  if (!output) return null;
  const start = output.indexOf(PATH_MARKER);
  if (start < 0) return null;
  const from = start + PATH_MARKER.length;
  const end = output.indexOf(PATH_MARKER, from);
  if (end < 0) return null;
  const value = output.slice(from, end).trim();
  return value || null;
}

/** 同步执行登录 shell：超时由 execFileSync 自己杀掉进程，失败一律当作读不到。 */
function runLoginShell(shell: string, script: string, env: NodeJS.ProcessEnv, timeoutMs: number): string | null {
  try {
    const output = execFileSync(shell, ["-ilc", script], {
      encoding: "utf8",
      timeout: timeoutMs,
      env,
      // stderr 里是 rc 文件的噪音与交互提示，不需要。
      stdio: ["ignore", "pipe", "ignore"],
      maxBuffer: 1024 * 1024
    });
    return String(output);
  } catch {
    return null;
  }
}

/**
 * 进程内缓存：登录 shell 的 PATH 在一次运行里不会变，同一个 shell 只读一次。
 * 按 shell 分开存，测试注入别的环境时既不会读到上一份，也不会把真实结果带进来。
 */
const loginShellPathCache = new Map<string, string | null>();

/**
 * 缓存的登录 shell PATH。显式注入 shell 或执行方式时不走缓存，避免测试之间串味。
 */
export function loginShellPath(options: LoginShellPathOptions = {}): string | null {
  if (options.disabled) return null;
  if (options.shell !== undefined || options.run !== undefined || options.platform !== undefined) {
    return readLoginShellPath(options);
  }
  const env = options.env ?? process.env;
  const key = `${options.platform ?? process.platform}:${env.SHELL ?? ""}:${options.timeoutMs ?? ""}`;
  if (!loginShellPathCache.has(key)) loginShellPathCache.set(key, readLoginShellPath({ ...options, env }));
  return loginShellPathCache.get(key) ?? null;
}

/** 清掉缓存：只在测试里用。 */
export function resetLoginShellPathCache(): void {
  loginShellPathCache.clear();
}

/**
 * 协助查找命令用的 PATH：登录 shell 的 PATH 在前，进程自己的 PATH 其次，最后补常见目录，去重后合并。
 * 登录 shell 在前是因为用户实际用的是它那一份（nvm / fnm 的 node 就在里面）。
 */
export function assistSearchPath(basePath: string | undefined, loginPath: string | null): string {
  const dirs: string[] = [];
  const push = (value: string | undefined): void => {
    for (const dir of (value ?? "").split(":")) {
      // 目录名里可能有空格，只跳过空串，不做 trim。
      if (dir && !dirs.includes(dir)) dirs.push(dir);
    }
  };
  push(loginPath ?? undefined);
  push(basePath);
  push(LOOKUP_DIRS.join(":"));
  return dirs.join(":");
}

/**
 * 协助用的环境变量：在传入的 env 基础上换掉 PATH。
 * 找命令、判断能不能运行、装适配器、拉起 Agent 与登录命令都用这一份。
 */
export function assistEnv(base: NodeJS.ProcessEnv = process.env, options: LoginShellPathOptions = {}): NodeJS.ProcessEnv {
  const loginPath = loginShellPath({ ...options, env: base });
  return { ...base, PATH: assistSearchPath(base.PATH, loginPath) };
}