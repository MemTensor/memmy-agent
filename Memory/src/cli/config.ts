import { existsSync, readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join, resolve } from "node:path";
import YAML from "yaml";

export const DEFAULT_MEMORY_URL = "http://127.0.0.1:18960";

export interface CliMemoryConfig {
  endpoint?: string;
  token?: string;
  userId?: string;
}

export function loadCliMemoryConfig(configPath?: string): {
  config: CliMemoryConfig;
  path?: string;
} {
  const selectedPath = configPath
    ? resolve(expandHome(configPath))
    : defaultConfigPaths().find((candidate) => existsSync(candidate));
  const rootConfig = selectedPath && existsSync(selectedPath)
    ? parseConfigFile(selectedPath)
    : {};
  const memmyMemory = asRecord(rootConfig.memmyMemory);
  const storage = asRecord(memmyMemory.storage);
  const app = asRecord(rootConfig.app);
  const profile = activeMemoryProfile(memmyMemory);

  return {
    config: {
      endpoint: optionalString(process.env.MEMMY_MEMORY_URL) ??
        optionalString(process.env.MEMORY_SERVICE_URL) ??
        optionalString(storage.endpoint) ??
        optionalString(memmyMemory.endpoint),
      token: optionalString(process.env.MEMMY_MEMORY_TOKEN) ??
        optionalString(process.env.MEMORY_SERVICE_TOKEN) ??
        optionalString(storage.token) ??
        optionalString(memmyMemory.token),
      userId: optionalString(process.env.MEMMY_MEMORY_USER_ID) ??
        optionalString(process.env.MEMMY_USER_ID) ??
        optionalString(process.env.MEMORY_SERVICE_USER_ID) ??
        optionalString(profile.userId) ??
        optionalString(memmyMemory.userId) ??
        optionalString(app.userId)
    },
    path: selectedPath
  };
}

export function defaultConfigPaths(): string[] {
  return [
    process.env.MEMMY_CONFIG ? resolve(expandHome(process.env.MEMMY_CONFIG)) : undefined,
    join(homedir(), ".memmy", "config.yaml")
  ].filter((value): value is string => Boolean(value));
}

export function expandHome(value: string): string {
  return value === "~" || value.startsWith("~/") ? join(homedir(), value.slice(2)) : value;
}

function parseConfigFile(path: string): Record<string, unknown> {
  const raw = readFileSync(path, "utf8");
  if (path.endsWith(".json")) {
    const parsed = JSON.parse(raw);
    return asRecord(parsed);
  }
  return asRecord(YAML.parse(raw));
}

export function asRecord(value: unknown): Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value)
    ? value as Record<string, unknown>
    : {};
}

export function optionalString(value: unknown): string | undefined {
  return typeof value === "string" && value.trim() ? value.trim() : undefined;
}

function activeMemoryProfile(memmyMemory: Record<string, unknown>): Record<string, unknown> {
  const activeProfile = optionalString(memmyMemory.activeProfile);
  const profiles = asRecord(memmyMemory.profiles);
  if (activeProfile !== "account" && activeProfile !== "byok") {
    return {};
  }
  return asRecord(profiles[activeProfile]);
}
