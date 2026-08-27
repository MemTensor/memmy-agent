import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { HttpByokTokenUsageClient } from "./client.js";
import { ByokTokenUsageHook } from "./hook.js";
import { ByokTokenUsageRecorder } from "./recorder.js";
import type { ByokTokenUsageClient, ByokTokenUsageInstallOptions, ByokTokenUsageRuntimeConfig } from "./types.js";

export type ByokTokenUsageIntegration = {
  enabled: boolean;
  client?: ByokTokenUsageClient;
  hook?: ByokTokenUsageHook;
};

export function installByokTokenUsage(
  _config: unknown,
  options: ByokTokenUsageInstallOptions = {},
): ByokTokenUsageIntegration {
  const env = options.env ?? process.env;
  if (isTestRuntime(env)) return { enabled: false };

  const runtimeConfigPath = resolveRuntimeConfigPath(options);
  const client = new HttpByokTokenUsageClient({
    runtimeConfigProvider: () => readRuntimeConfig(runtimeConfigPath),
    timeoutMs: options.timeoutMs,
    fetchImpl: options.fetchImpl,
  });
  const hook = new ByokTokenUsageHook({ client });
  if (Array.isArray(options.hooks)) options.hooks.push(hook);
  return { enabled: true, client, hook };
}

export function createByokTokenUsageRecorder(
  _config: unknown,
  options: ByokTokenUsageInstallOptions = {},
): ByokTokenUsageRecorder {
  const runtimeConfigPath = resolveRuntimeConfigPath(options);
  const client = new HttpByokTokenUsageClient({
    runtimeConfigProvider: () => readRuntimeConfig(runtimeConfigPath),
    timeoutMs: options.timeoutMs,
    fetchImpl: options.fetchImpl,
  });
  return new ByokTokenUsageRecorder({ client });
}

function isTestRuntime(env: Record<string, string | undefined>): boolean {
  return env.NODE_ENV === "test" || Boolean(env.VITEST_WORKER_ID);
}

function resolveRuntimeConfigPath(options: ByokTokenUsageInstallOptions): string {
  if (options.runtimeConfigPath) return options.runtimeConfigPath;
  return path.join(options.homeDir ?? os.homedir(), ".memmy", "runtime.json");
}

function readRuntimeConfig(filePath: string): ByokTokenUsageRuntimeConfig | null {
  if (!fs.existsSync(filePath)) return null;
  try {
    const parsed = JSON.parse(fs.readFileSync(filePath, "utf8")) as unknown;
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) return null;
    const record = parsed as Record<string, unknown>;
    const baseUrl = stringOrNull(record.baseUrl);
    const localToken = stringOrNull(record.localToken);
    if (!baseUrl || !localToken) return null;
    return { baseUrl, localToken };
  } catch {
    return null;
  }
}

function stringOrNull(value: unknown): string | null {
  return typeof value === "string" && value.trim() ? value.trim() : null;
}
