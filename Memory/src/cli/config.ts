import { existsSync, readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join, resolve } from "node:path";
import YAML from "yaml";

import { DEFAULT_MEMORY_URL, resolveMemoryConnection } from "@memmy/agent-source-core/memory-connection";
export { DEFAULT_MEMORY_URL, sameHttpOrigin } from "@memmy/agent-source-core/memory-connection";

export interface CliMemoryConfig {
  endpoint?: string;
  token?: string;
  userId?: string;
}

export function loadCliMemoryConfig(configPath?: string, targetEndpoint?: string): {
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
  const app = asRecord(rootConfig.app);

  return {
    config: {
      ...resolveCliConnection(memmyMemory, targetEndpoint),
      userId: optionalString(process.env.MEMMY_MEMORY_USER_ID) ??
        optionalString(process.env.MEMMY_USER_ID) ??
        optionalString(process.env.MEMORY_SERVICE_USER_ID) ??
        optionalString(memmyMemory.userId) ??
        optionalString(app.userId)
    },
    path: selectedPath
  };
}

/** Keep each implicit credential bound to the endpoint it was configured for. */
export function resolveCliConnection(memory: Record<string, unknown>, targetEndpoint?: string) {
  const storage = asRecord(memory.storage);
  const fileEndpoint = configuredCliEndpoint(memory);
  const fileToken = optionalString(storage.token) ?? optionalString(memory.token);
  return resolveMemoryConnection(fileEndpoint, fileToken, process.env, targetEndpoint);
}

export function configuredCliEndpoint(memory: Record<string, unknown>): string {
  return optionalString(asRecord(memory.storage).endpoint) ?? optionalString(memory.endpoint) ?? DEFAULT_MEMORY_URL;
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
