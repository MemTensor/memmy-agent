import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import YAML from "yaml";
import { mutateRuntimeConfigSync } from "@memmy/migrations";
import { configureSsrfWhitelist } from "../security/network.js";
import { Config, FileMemoryConfig } from "./schema.js";

let configPathOverride: string | null = null;

/** Base class for config values that fail to load or resolve. Callers should treat these as fatal. */
export class ConfigError extends Error {}

/** The config file exists but could not be parsed as YAML or failed schema validation. */
export class ConfigLoadError extends ConfigError {}

function expandHome(value: string): string {
  return value === "~" || value.startsWith("~/") ? path.join(os.homedir(), value.slice(2)) : value;
}

export function setConfigPath(configPath: string | null): void {
  configPathOverride = configPath;
}

export function getConfigPath(): string {
  if (configPathOverride) return expandHome(configPathOverride);
  return expandHome(process.env.MEMMY_CONFIG || "~/.memmy/config.yaml");
}

export function resolveConfigEnvVars(config: Config): Config {
  const serialized = config.toObject();
  const dream = serialized.agents?.defaults?.dream;
  if (dream && config.agents.defaults.dream.cron) {
    dream.cron = config.agents.defaults.dream.cron;
  }
  return new Config(resolveEnvVars(serialized) as any);
}

function resolveInPlace(obj: any): any {
  if (typeof obj === "string")
    return obj.replace(/\$\{([A-Z0-9_]+)(?::([^}]*))?\}/gi, (fullMatch, key, fallback) => {
      void fullMatch;
      const value = process.env[key] ?? fallback;
      if (value == null) throw new EnvValueError(`Environment variable ${key} is not set`);
      return value;
    });
  if (Array.isArray(obj)) return obj.map(resolveInPlace);
  if (obj && typeof obj === "object") {
    for (const [key, value] of Object.entries(obj)) obj[key] = resolveInPlace(value);
  }
  return obj;
}

export class EnvValueError extends ConfigError {}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

export function resolveEnvVars(obj: any): any {
  return resolveInPlace(structuredClone(obj));
}

export function loadConfig(configPath?: string | null): Config {
  const target = expandHome(configPath ?? getConfigPath());
  if (!fs.existsSync(target)) {
    const config = new Config();
    configureSsrfWhitelist(config.tools.ssrfWhitelist);
    return config;
  }
  const raw = fs.readFileSync(target, "utf8");
  let config: Config;
  try {
    const parsed = raw.trim() ? YAML.parse(raw) : {};
    if (
      parsed &&
      typeof parsed === "object" &&
      !Array.isArray(parsed) &&
      Object.prototype.hasOwnProperty.call(parsed, "fileMemory")
    ) {
      new FileMemoryConfig(parsed.fileMemory);
    }
    config = new Config(parsed);
  } catch (error) {
    // The config file exists but is unusable (bad YAML or a value that fails schema
    // validation). Silently falling back to defaults here would run the agent on a
    // configuration the user never asked for (e.g. dropping BYOK credentials), so this
    // must fail loud instead of warning and continuing.
    throw new ConfigLoadError(`Failed to load config from ${target}: ${errorMessage(error)}`);
  }
  configureSsrfWhitelist(config.tools.ssrfWhitelist);
  return config;
}

export function saveConfig(config: Config, configPath?: string | null): void {
  const target = expandHome(configPath ?? getConfigPath());
  const dumped = config.toObject();
  mutateRuntimeConfigSync(target, (current) => {
    const merged = mergeConfigFields(current, dumped);
    for (const key of Object.keys(current)) delete current[key];
    Object.assign(current, merged);
  });
}

function mergeConfigFields(current: Record<string, any>, next: Record<string, any>): Record<string, any> {
  const merged: Record<string, any> = { ...current };
  for (const [key, value] of Object.entries(next)) {
    if (isPlainRecord(value) && isPlainRecord(current[key])) {
      merged[key] = mergeConfigFields(current[key], value);
    } else {
      merged[key] = value;
    }
  }
  // These maps are owned collections: an absent child means the caller deleted it.
  // Their surviving entries already carry unknown nested fields through Base.toObject().
  for (const key of ["providers", "modelPresets", "modelAssignments"]) {
    if (Object.prototype.hasOwnProperty.call(next, key)) merged[key] = next[key];
  }
  if (isPlainRecord(next.tools)) {
    merged.tools = isPlainRecord(merged.tools) ? merged.tools : {};
    if (Object.prototype.hasOwnProperty.call(next.tools, "mcpServers")) {
      merged.tools.mcpServers = next.tools.mcpServers;
    }
  }
  return merged;
}

function isPlainRecord(value: unknown): value is Record<string, any> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
