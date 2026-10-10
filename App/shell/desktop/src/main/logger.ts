import { app } from "electron";
import { join } from "node:path";
import { stdout, stderr } from "node:process";
import log from "electron-log/main";
import {
  DEFAULT_LOG_LEVEL,
  parseLogLevel,
  readPersistedLogLevel,
  writePersistedLogLevel,
  type LogLevel
} from "./log-level.js";
import { rollLogFiles } from "./rotating-log-file.js";

const MAX_LOG_SIZE = 5 * 1024 * 1024;

const MAX_LOG_FILES = 5;

let consoleOutputBroken = false;
let consoleErrorHandlersInstalled = false;

function handleConsoleError(error: NodeJS.ErrnoException): void {
  if (error.code !== "EPIPE") {
    throw error;
  }
  // A launcher/terminal can close its pipe while the desktop keeps running.
  // Do not log this failure through the failed transport or re-enable it later.
  consoleOutputBroken = true;
  log.transports.console.level = false;
}

export function developerSettingsPath(): string {
  return join(app.getPath("userData"), "developer-settings.json");
}

function mainLogPath(): string {
  return join(app.getPath("logs"), "main.log");
}

export function initLogger(): void {
  if (!consoleErrorHandlersInstalled) {
    stdout.on("error", handleConsoleError);
    stderr.on("error", handleConsoleError);
    consoleErrorHandlersInstalled = true;
  }
  log.initialize();
  log.transports.file.resolvePathFn = () => mainLogPath();
  log.transports.file.maxSize = MAX_LOG_SIZE;
  log.transports.file.archiveLogFn = (file) => {
    rollLogFiles(file.path, MAX_LOG_FILES);
  };
  applyLogLevel(getCurrentLogLevel());
}

export function applyLogLevel(level: LogLevel): void {
  const normalized = parseLogLevel(level);
  log.transports.file.level = normalized;
  log.transports.console.level = consoleOutputBroken ? false : normalized;
}

export function getCurrentLogLevel(): LogLevel {
  return readPersistedLogLevel(developerSettingsPath());
}

export function setLogLevel(level: LogLevel): void {
  const normalized = parseLogLevel(level);
  writePersistedLogLevel(developerSettingsPath(), normalized);
  applyLogLevel(normalized);
}

export { DEFAULT_LOG_LEVEL };
export type { LogLevel };
