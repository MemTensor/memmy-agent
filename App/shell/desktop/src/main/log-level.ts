import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";

export type LogLevel = "error" | "warn" | "info" | "debug";

export const LOG_LEVELS: readonly LogLevel[] = ["error", "warn", "info", "debug"];

export const DEFAULT_LOG_LEVEL: LogLevel = "info";

export function parseLogLevel(value: unknown): LogLevel {
  return LOG_LEVELS.includes(value as LogLevel) ? (value as LogLevel) : DEFAULT_LOG_LEVEL;
}

export function readPersistedLogLevel(filePath: string): LogLevel {
  try {
    const parsed = JSON.parse(readFileSync(filePath, "utf8")) as { logLevel?: unknown };
    return parseLogLevel(parsed.logLevel);
  } catch {
    return DEFAULT_LOG_LEVEL;
  }
}

export function writePersistedLogLevel(filePath: string, level: LogLevel): void {
  mkdirSync(dirname(filePath), { recursive: true });
  writeFileSync(filePath, `${JSON.stringify({ logLevel: parseLogLevel(level) }, null, 2)}\n`, "utf8");
}
