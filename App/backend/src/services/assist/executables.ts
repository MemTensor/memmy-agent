/**
 * 找可执行文件与启动命令的环境变量覆盖。
 *
 * <p>单独一层是为了避免环依赖：{@link ./recipes} 要用它判断「这个 Agent 能不能跑」，
 * 而 {@link ./deepseek-harness} 既要自己找入口、又要被 recipes 调用。</p>
 */
import { existsSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";

/**
 * 覆盖某个 Agent 的启动命令：`MEMMY_ASSIST_COMMAND_<SOURCE_ID>=…`，值按空格切成命令与参数。
 * 用于对方升级后路径变化的临时处置，不改代码。
 */
export function ASSIST_COMMAND_ENV(sourceId: string): string {
  return `MEMMY_ASSIST_COMMAND_${sourceId.toUpperCase().replace(/[^A-Z0-9]/gu, "_")}`;
}

/** 一个可执行文件在常见位置：PATH、Homebrew、以及各个包管理器的全局 bin。 */
const LOOKUP_DIRS = [
  "/opt/homebrew/bin",
  "/usr/local/bin",
  "/usr/bin",
  join(homedir(), ".local", "bin"),
  join(homedir(), ".bun", "bin"),
  join(homedir(), ".cargo", "bin"),
  join(homedir(), ".npm-global", "bin")
];

/** 在 PATH 与常见目录里找一个可执行文件；找不到时返回 null。 */
export function findExecutable(command: string, env: NodeJS.ProcessEnv = process.env): string | null {
  if (command.includes("/")) return existsSync(command) ? command : null;
  const dirs = [...(env.PATH ?? "").split(":").filter(Boolean), ...LOOKUP_DIRS];
  for (const dir of dirs) {
    const candidate = join(dir, command);
    if (existsSync(candidate)) return candidate;
  }
  return null;
}