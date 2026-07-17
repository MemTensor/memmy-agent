import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import YAML from "yaml";
import type { MemmyMemoryConnection } from "./types.js";

export const DEFAULT_MEMOS_MEMORY_URL = "http://127.0.0.1:18960";

type DiscoveryEnv = Record<string, string | undefined>;

export type MemmyMemoryDiscoveryOptions = {
  env?: DiscoveryEnv;
  homeDir?: string;
};

function expandHome(value: string, homeDir: string): string {
  return value === "~" || value.startsWith("~/") ? path.join(homeDir, value.slice(2)) : value;
}

export function memmyMemoryConfigPaths(options: MemmyMemoryDiscoveryOptions = {}): string[] {
  const env = options.env ?? process.env;
  const homeDir = options.homeDir ?? os.homedir();
  return [
    env.MEMMY_CONFIG,
    path.join(homeDir, ".memmy", "config.yaml"),
  ]
    .filter((value): value is string => Boolean(value))
    .map((value) => path.resolve(expandHome(value, homeDir)));
}

function parseConfigFile(file: string): Record<string, any> {
  if (!fs.existsSync(file)) return {};
  const raw = fs.readFileSync(file, "utf8");
  if (!raw.trim()) return {};
  const parsed = YAML.parse(raw);
  return parsed && typeof parsed === "object" && !Array.isArray(parsed) ? parsed as Record<string, any> : {};
}

function readTokenFile(file: string | null | undefined, homeDir: string): string | null {
  if (!file) return null;
  const target = path.resolve(expandHome(file, homeDir));
  if (!fs.existsSync(target)) return null;
  const token = fs.readFileSync(target, "utf8").trim();
  return token || null;
}

function runtimePath(env: DiscoveryEnv, homeDir: string): string {
  void env;
  return path.join(homeDir, ".memmy", "memory-service", "runtime.json");
}

function readRuntimeDiscovery(env: DiscoveryEnv, homeDir: string): Record<string, any> {
  const file = runtimePath(env, homeDir);
  if (!fs.existsSync(file)) return {};
  try {
    const parsed = JSON.parse(fs.readFileSync(file, "utf8"));
    return parsed && typeof parsed === "object" && !Array.isArray(parsed) ? parsed : {};
  } catch {
    return {};
  }
}

export function normalizeMemmyMemoryBaseUrl(value: string | null | undefined): string {
  const raw = (value ?? DEFAULT_MEMOS_MEMORY_URL).trim() || DEFAULT_MEMOS_MEMORY_URL;
  return raw.replace(/\/+$/, "");
}

export function discoverMemmyMemoryConnection(options: MemmyMemoryDiscoveryOptions = {}): MemmyMemoryConnection {
  const env = options.env ?? process.env;
  const homeDir = options.homeDir ?? os.homedir();
  const runtime = readRuntimeDiscovery(env, homeDir);
  const configPath = memmyMemoryConfigPaths({ env, homeDir }).find((candidate) => fs.existsSync(candidate));
  const config = configPath ? parseConfigFile(configPath) : {};
  const memmyMemory = config.memmyMemory && typeof config.memmyMemory === "object" ? config.memmyMemory as Record<string, any> : {};
  const storage = memmyMemory.storage && typeof memmyMemory.storage === "object" ? memmyMemory.storage as Record<string, any> : {};

  const baseUrl =
    env.MEMMY_MEMORY_URL ??
    env.MEMORY_SERVICE_URL ??
    runtime.url ??
    runtime.baseUrl ??
    storage.endpoint ??
    DEFAULT_MEMOS_MEMORY_URL;
  const token =
    env.MEMMY_MEMORY_TOKEN ??
    env.MEMORY_SERVICE_TOKEN ??
    runtime.token ??
    readTokenFile(runtime.tokenFile, homeDir) ??
    storage.token ??
    null;

  return {
    baseUrl: normalizeMemmyMemoryBaseUrl(String(baseUrl)),
    token: token ? String(token) : null,
    source: env.MEMMY_MEMORY_URL || env.MEMORY_SERVICE_URL
      ? "env"
      : runtime.url || runtime.baseUrl
        ? runtimePath(env, homeDir)
        : configPath ?? "default",
  };
}
