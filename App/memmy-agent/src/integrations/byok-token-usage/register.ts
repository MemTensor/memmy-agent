import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { Config } from "../../config/schema.js";
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
  config: Config | Record<string, any> | null | undefined,
  options: ByokTokenUsageInstallOptions = {},
): ByokTokenUsageIntegration {
  const env = options.env ?? process.env;
  if (isTestRuntime(env)) return { enabled: false };

  const runtimeConfigPath = resolveRuntimeConfigPath(options);
  const resolvedConfig = config instanceof Config ? config : new Config(config ?? {});
  const client = new HttpByokTokenUsageClient({
    runtimeConfigProvider: () => readRuntimeConfig(runtimeConfigPath),
    timeoutMs: options.timeoutMs,
    fetchImpl: options.fetchImpl,
  });
  const hook = new ByokTokenUsageHook({
    client,
    resolveProviderName: createProviderNameResolver(resolvedConfig),
  });
  if (Array.isArray(options.hooks)) options.hooks.push(hook);
  return { enabled: true, client, hook };
}

export function createByokTokenUsageRecorder(
  config: Config | Record<string, any> | null | undefined,
  options: ByokTokenUsageInstallOptions = {},
): ByokTokenUsageRecorder {
  const runtimeConfigPath = resolveRuntimeConfigPath(options);
  const resolvedConfig = config instanceof Config ? config : new Config(config ?? {});
  const client = new HttpByokTokenUsageClient({
    runtimeConfigProvider: () => readRuntimeConfig(runtimeConfigPath),
    timeoutMs: options.timeoutMs,
    fetchImpl: options.fetchImpl,
  });
  return new ByokTokenUsageRecorder({
    client,
    resolveProviderName: createProviderNameResolver(resolvedConfig),
  });
}

function isTestRuntime(env: Record<string, string | undefined>): boolean {
  return env.NODE_ENV === "test" || Boolean(env.VITEST_WORKER_ID);
}

function createProviderNameResolver(config: Config): (modelId: string | null) => string | null {
  return (modelId: string | null): string | null => {
    try {
      const preset = config.resolvePreset();
      return config.getProviderName(modelId, { preset });
    } catch {
      return null;
    }
  };
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
