/** Memmy runtime config helpers. */
import { readFile } from "node:fs/promises";
import YAML from "yaml";

export interface MemmyMemoryServiceConfig {
  endpoint: string;
  token: string;
}

/** Reads Memmy memory service endpoint and token from the local config file. */
export async function readMemmyMemoryServiceConfig(configPath: string): Promise<MemmyMemoryServiceConfig> {
  const content = await readTextFile(configPath);
  const parsed = content.trim() ? YAML.parse(content) : {};
  const root = toMutableRecord(parsed);
  const memmyMemory = toMutableRecord(root.memmyMemory);
  const storage = toMutableRecord(memmyMemory.storage);
  const legacyStorage = toMutableRecord(root.storage);
  return {
    endpoint: normalizeString(storage.endpoint) ||
      normalizeString(memmyMemory.endpoint) ||
      normalizeString(legacyStorage.endpoint) ||
      "http://127.0.0.1:18960",
    token: normalizeString(storage.token) ||
      normalizeString(memmyMemory.token) ||
      normalizeString(legacyStorage.token)
  };
}

async function readTextFile(filePath: string): Promise<string> {
  try {
    return await readFile(filePath, "utf8");
  } catch (error) {
    if (isNodeError(error) && error.code === "ENOENT") {
      return "";
    }

    throw error;
  }
}

function toMutableRecord(value: unknown): Record<string, unknown> {
  return isRecord(value) ? { ...value } : {};
}

function normalizeString(value: unknown): string {
  return typeof value === "string" ? value.trim() : "";
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function isNodeError(error: unknown): error is NodeJS.ErrnoException {
  return error instanceof Error && "code" in error;
}
