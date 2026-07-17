import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import YAML from "yaml";
import { configureSsrfWhitelist } from "../security/network.js";
import { Config } from "./schema.js";

let configPathOverride: string | null = null;

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
  return new Config(resolveEnvVars(config as any) as any);
}

function resolveInPlace(obj: any): any {
  if (typeof obj === "string") return obj.replace(/\$\{([A-Z0-9_]+)(?::([^}]*))?\}/gi, (fullMatch, key, fallback) => {
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

class EnvValueError extends Error {}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

export function resolveEnvVars(obj: any): any {
  return resolveInPlace(structuredClone(obj));
}

export function migrateConfig(data: any): any {
  if (!data || typeof data !== "object") return {};
  const copy = structuredClone(data);
  if (copy.agent && !copy.agents) copy.agents = { defaults: copy.agent };
  if (copy.model && !copy.agents?.defaults?.model) {
    copy.agents ??= {};
    copy.agents.defaults ??= {};
    copy.agents.defaults.model = copy.model;
  }
  if (copy.tools) {
    if (!copy.tools.my && ("myEnabled" in copy.tools || "mySet" in copy.tools)) {
      copy.tools.my = {
        enable: copy.tools.myEnabled ?? true,
        allowSet: copy.tools.mySet ?? false,
      };
    }
    delete copy.tools.myEnabled;
    delete copy.tools.mySet;
  }
  return copy;
}

export function loadConfig(configPath?: string | null): Config {
  const target = expandHome(configPath ?? getConfigPath());
  let config = new Config();
  if (!fs.existsSync(target)) {
    configureSsrfWhitelist(config.tools.ssrfWhitelist);
    return config;
  }
  const raw = fs.readFileSync(target, "utf8");
  try {
    const parsed = raw.trim() ? YAML.parse(raw) : {};
    config = new Config(migrateConfig(parsed));
  } catch (error) {
    console.warn(`Failed to load config from ${target}: ${errorMessage(error)}\nUsing default configuration.`);
  }
  configureSsrfWhitelist(config.tools.ssrfWhitelist);
  return config;
}

export function saveConfig(config: Config, configPath?: string | null): void {
  const target = expandHome(configPath ?? getConfigPath());
  fs.mkdirSync(path.dirname(target), { recursive: true });
  const dumped = config.toObject();
  const body = YAML.stringify(dumped);
  fs.writeFileSync(target, body, "utf8");
}
