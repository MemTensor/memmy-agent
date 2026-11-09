/**
 * 找可执行文件与启动命令的环境变量覆盖。
 *
 * <p>单独一层是为了避免环依赖：{@link ./recipes} 要用它判断「这个 Agent 能不能跑」，
 * 而 {@link ./deepseek-harness} 既要自己找入口、又要被 recipes 调用。</p>
 *
 * <p>平台差异集中在这里：macOS / Linux 用 `:` 分 PATH、命令就是文件本身；Windows 用 `;` 分 PATH、
 * PATH 上写的是不带后缀的命令名，真正能被执行的却是 `名字.cmd` / `名字.exe`，而 `.cmd` 又不能被 Node
 * 直接拉起。这三件事在下面各有对应函数，调用方不必自己判断平台。</p>
 */
import { existsSync } from "node:fs";
import { homedir } from "node:os";
import { posix, win32 } from "node:path";

/**
 * 覆盖某个 Agent 的启动命令：`MEMMY_ASSIST_COMMAND_<SOURCE_ID>=…`，值按空格切成命令与参数。
 * 用于对方升级后路径变化的临时处置，不改代码。
 */
export function ASSIST_COMMAND_ENV(sourceId: string): string {
  return `MEMMY_ASSIST_COMMAND_${sourceId.toUpperCase().replace(/[^A-Z0-9]/gu, "_")}`;
}

/**
 * 按平台取 `node:path` 的实现。
 *
 * <p>不能直接用导入的 `delimiter` / `isAbsolute` / `join`：那些是**当前进程**平台的语义，
 * 测试里注入 `platform: "win32"`（在 macOS 上跑）时拿到的仍是 `/` 与 `:`，测不出 Windows 的真实行为。</p>
 */
export function pathForPlatform(platform: NodeJS.Platform): typeof posix {
  return platform === "win32" ? win32 : posix;
}

/**
 * 读环境变量：Windows 的变量名不分大小写，注入进来的测试对象却是普通对象，因此两种写法都认。
 *
 * <p>Windows 的环境块里通常写作 {@code Path}，而 `{...process.env}` 复制出来是普通对象、不再有
 * 大小写不敏感的代理——只读 {@code env.PATH} 会真的读不到，PATH 就丢了。</p>
 */
function rawEnvValue(env: NodeJS.ProcessEnv, name: string): string | undefined {
  const direct = env[name];
  if (direct) return direct;
  const key = Object.keys(env).find((candidate) => candidate.toLowerCase() === name.toLowerCase());
  return key === undefined ? undefined : env[key];
}

/** 同上，去掉首尾空格：目录列表与单值（ComSpec、PATHEXT）用这一份。 */
function envValue(env: NodeJS.ProcessEnv, name: string): string | undefined {
  return rawEnvValue(env, name)?.trim() || undefined;
}

/** macOS / Linux 的常见位置：PATH、Homebrew、以及各个包管理器的全局 bin。 */
const POSIX_LOOKUP_DIRS: readonly string[] = [
  "/opt/homebrew/bin",
  "/usr/local/bin",
  "/usr/bin",
  posix.join(homedir(), ".local", "bin"),
  posix.join(homedir(), ".bun", "bin"),
  posix.join(homedir(), ".cargo", "bin"),
  posix.join(homedir(), ".npm-global", "bin")
];

/**
 * 兼容旧的导出：macOS / Linux 的查找目录。
 * 需要按平台取目录时用 {@link lookupDirs}，Windows 有自己的列表。
 */
export const LOOKUP_DIRS: readonly string[] = POSIX_LOOKUP_DIRS;

/**
 * Windows 上的查找目录。
 *
 * <p>Windows 没有 `/usr/bin` 这种统一位置：用户级安装器把程序放在 `%LOCALAPPDATA%\Programs`，
 * 全局 npm 把 `.cmd` 放在 `%APPDATA%\npm`，winget 与商店应用的入口是 `WindowsApps`。
 * 程序名之下的层级因应用而异（例如 `Cursor\resources\app\bin`），这里只列到目录一层，
 * 具体子路径由各自的配方负责。没有装在任何一处时由调用方给出失败原因，不猜。</p>
 */
function windowsLookupDirs(env: NodeJS.ProcessEnv): string[] {
  const path = pathForPlatform("win32");
  const local = envValue(env, "LOCALAPPDATA") ?? path.join(homedir(), "AppData", "Local");
  const roaming = envValue(env, "APPDATA") ?? path.join(homedir(), "AppData", "Roaming");
  const profile = envValue(env, "USERPROFILE") ?? homedir();
  const dirs = [
    // 用户级安装器（Cursor、VS Code、各类 Electron 应用）默认装到这里。
    path.join(local, "Programs"),
    // winget / Microsoft Store 应用的命令入口。
    path.join(local, "Microsoft", "WindowsApps"),
    // 全局 npm 的 bin：npm 在 Windows 上把命令装成这里的 `.cmd`。
    path.join(roaming, "npm"),
    // 其他包管理器的全局 bin，与 macOS 那份列表对应。
    path.join(local, "pnpm"),
    path.join(profile, ".bun", "bin"),
    path.join(profile, ".cargo", "bin"),
    path.join(profile, ".local", "bin")
  ];
  for (const name of ["ProgramFiles", "ProgramFiles(x86)"]) {
    const value = envValue(env, name);
    if (value) dirs.push(value);
  }
  return dirs;
}

/** 按平台取常见目录：Windows 只给 Windows 的，其余保持原来那一份。 */
export function lookupDirs(
  platform: NodeJS.Platform = process.platform,
  env: NodeJS.ProcessEnv = process.env
): string[] {
  return platform === "win32" ? windowsLookupDirs(env) : [...POSIX_LOOKUP_DIRS];
}

/**
 * 按平台切分 PATH 这类目录列表。
 *
 * <p>POSIX 的目录名里可能有空格，只跳过空串、不做 trim；Windows 的 PATH 经常带多余空格与包起来的引号
 * （注册表里的旧值），不去掉的话拼出来的路径打不开。</p>
 */
export function splitPathList(value: string | undefined, platform: NodeJS.Platform = process.platform): string[] {
  const parts = (value ?? "").split(pathForPlatform(platform).delimiter);
  if (platform !== "win32") return parts.filter(Boolean);
  return parts
    .map((dir) => dir.trim().replace(/^"(.*)"$/u, "$1").trim())
    .filter(Boolean);
}

/** 按平台拼接目录列表。 */
export function joinPathList(dirs: readonly string[], platform: NodeJS.Platform = process.platform): string {
  return dirs.join(pathForPlatform(platform).delimiter);
}

/** Windows 的 `PATHEXT` 缺省值：环境变量缺失时按这一份找。 */
const DEFAULT_PATHEXT = [".COM", ".EXE", ".BAT", ".CMD"];

/** 这台电脑上能被直接执行的后缀。 */
function pathextList(env: NodeJS.ProcessEnv): string[] {
  const raw = envValue(env, "PATHEXT");
  const list = (raw ? raw.split(";") : []).map((ext) => ext.trim()).filter(Boolean);
  return list.length > 0 ? list : DEFAULT_PATHEXT;
}

/**
 * 一个候选路径要试的文件名：Windows 上命令名不带后缀，真正存在的是 `名字.cmd` / `名字.exe`。
 *
 * <p>原文与小写都试一次：`PATHEXT` 习惯写大写，而 npm 装出来的文件是小写 `npm.cmd`；Windows 的文件系统
 * 不分大小写，两种写法都能命中，在其他平台上跑测试时也不会因为大小写对不上而误判成「找不到」。</p>
 */
function candidatesFor(full: string, platform: NodeJS.Platform, env: NodeJS.ProcessEnv): string[] {
  if (platform !== "win32") return [full];
  const names = [full];
  for (const ext of pathextList(env)) {
    names.push(`${full}${ext}`);
    const lower = ext.toLowerCase();
    if (lower !== ext) names.push(`${full}${lower}`);
  }
  return names;
}

export interface FindExecutableOptions {
  platform?: NodeJS.Platform;
  /**
   * 只在测试里替换「文件在不在」的判断。Windows 的路径（`C:\…`）在其他平台上打不开，
   * 不注入就只能猜到别的平台上测不到 PATHEXT 那段。
   */
  exists?: (path: string) => boolean;
}

/**
 * 在 PATH 与常见目录里找一个可执行文件；找不到时返回 null。
 *
 * <p>`command` 可以是命令名（`cursor-agent`），也可以是路径（应用包内的引擎）。路径只判断存在性，
 * 不去 PATH 上拼——配方里的引擎装在应用包内，只有绝对路径能表达。</p>
 */
export function findExecutable(
  command: string,
  env: NodeJS.ProcessEnv = process.env,
  options: FindExecutableOptions = {}
): string | null {
  const platform = options.platform ?? process.platform;
  const path = pathForPlatform(platform);
  const exists = options.exists ?? existsSync;
  // 绝对路径（含 Windows 的 `C:\…` 与 `\\server\share`）只判断在不在。
  if (path.isAbsolute(command)) return exists(command) ? command : null;
  // 带目录的相对写法（`./bin/tool`）也交给文件系统：原来的实现就是按路径处理，不能改成去 PATH 上找。
  if (/[\\/]/u.test(command)) return exists(command) ? command : null;
  // 整条 PATH 不清洗：posix 的目录名里可能有空格，切分那边会处理平台差异。
  const dirs = [...splitPathList(rawEnvValue(env, "PATH"), platform), ...lookupDirs(platform, env)];
  for (const dir of dirs) {
    const full = path.join(dir, command);
    for (const candidate of candidatesFor(full, platform, env)) {
      if (exists(candidate)) return candidate;
    }
  }
  return null;
}

/** 一条命令实际要交给子进程的样子。 */
export interface AssistLaunchSpec {
  command: string;
  args: string[];
  /** 命令串里的引号已经自己处理过，需要原样交给 cmd.exe（见 {@link shellLaunch}）。 */
  windowsVerbatimArguments?: boolean;
}

export interface ShellLaunchOptions {
  platform?: NodeJS.Platform;
  env?: NodeJS.ProcessEnv;
  /**
   * Windows 上即使命令不带 `.cmd` / `.bat` 也交给 cmd.exe：
   * npm 装的命令行程序在 PATH 上只有不带后缀的名字，要靠 cmd 的 PATHEXT 才能解析出来。
   */
  always?: boolean;
}

/** 只能由命令解释器执行的脚本后缀。 */
const WIN_SHELL_SCRIPT = /\.(?:cmd|bat)$/iu;

/** cmd 里的引号：整段加引号，内部的 `"` 写成 `\"`，否则带空格的目录会在空格处被拆开。 */
function winShellQuote(value: string): string {
  return `"${value.replace(/"/gu, '\\"')}"`;
}

/**
 * 把一条命令变成「子进程实际要执行的东西」。
 *
 * <p>Windows 上 npm 装的命令行程序都是 `.cmd`（一个批处理脚本），Node 直接 spawn 会 ENOENT。
 * 这里改成交给 `cmd.exe /d /s /c`：命令串自己加引号，参数里的空格与包名里的 `@`、`^` 都不会被拆开，
 * 并让引号原样透传。不用 `shell: true` 是因为那样 Node 会把命令与参数直接拼成一行，
 * 目录带空格（`C:\Users\Q Sun\…`）时参数就被拆断了。</p>
 *
 * <p>非 Windows 原样返回，macOS / Linux 的行为不变。</p>
 */
export function shellLaunch(
  command: string,
  args: readonly string[],
  options: ShellLaunchOptions = {}
): AssistLaunchSpec {
  const platform = options.platform ?? process.platform;
  if (platform !== "win32") return { command, args: [...args] };
  if (!options.always && !WIN_SHELL_SCRIPT.test(command)) return { command, args: [...args] };
  const env = options.env ?? process.env;
  const line = [command, ...args].map(winShellQuote).join(" ");
  return {
    command: envValue(env, "ComSpec") ?? "cmd.exe",
    // `/s` 之后 cmd 会去掉最外层的那对引号，剩下的正好是排好引号的命令。
    args: ["/d", "/s", "/c", `"${line}"`],
    windowsVerbatimArguments: true
  };
}
