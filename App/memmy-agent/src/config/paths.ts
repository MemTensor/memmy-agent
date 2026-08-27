import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { getConfigPath as getActiveConfigPath } from "./loader.js";

function expandHome(value: string): string {
  return value === "~" || value.startsWith("~/") ? path.join(os.homedir(), value.slice(2)) : value;
}

function ensureDir(value: string): string {
  fs.mkdirSync(value, { recursive: true });
  return value;
}

function defaultWorkspacePath(): string {
  return expandHome(process.env.MEMMY_AGENT_WORKSPACE || "~/.memmy/workspace");
}

export function getConfigPath(): string {
  return getActiveConfigPath();
}

export function getDataDir(): string {
  return ensureDir(expandHome(process.env.MEMMY_AGENT_DATA_DIR || path.dirname(getConfigPath())));
}

export function getRuntimeSubdir(name: string): string {
  return ensureDir(path.join(getDataDir(), name));
}

export function getMediaDir(channel?: string | null): string {
  return ensureDir(channel ? path.join(getDataDir(), "media", channel) : path.join(getDataDir(), "media"));
}

export function getCronDir(): string {
  return ensureDir(path.join(getDataDir(), "cron"));
}

export function getLogsDir(): string {
  return ensureDir(path.join(getDataDir(), "logs"));
}

export function getWebuiDir(): string {
  return ensureDir(path.join(getDataDir(), "webui"));
}

export function getWorkspacePath(workspace?: string | null): string {
  return ensureDir(expandHome(workspace || process.env.MEMMY_AGENT_WORKSPACE || "~/.memmy/workspace"));
}

export function isDefaultWorkspace(workspace?: string | null): boolean {
  if (!workspace) return true;
  return path.resolve(expandHome(workspace)) === path.resolve(defaultWorkspacePath());
}

export function getCliHistoryPath(): string {
  return path.join(os.homedir(), ".memmy", "history", "cli_history");
}

export function getBridgeInstallDir(): string {
  return path.join(os.homedir(), ".memmy", "bridge");
}
