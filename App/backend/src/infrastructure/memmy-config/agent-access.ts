import { readFileSync } from "node:fs";
import type { PatchScanPreferencesInput, ScanPreferences } from "@memmy/local-api-contracts";
import { ScanPreferencesSchema } from "@memmy/local-api-contracts";
import { mutateRuntimeConfig } from "@memmy/migrations";
import YAML from "yaml";

export interface ScanPreferencesStore {
  getScanPreferences(): ScanPreferences;
  updateScanPreferences(patch: PatchScanPreferencesInput): Promise<ScanPreferences>;
}

export const DEFAULT_MEMORY_SCAN_PREFERENCES: ScanPreferences = {
  autoScanKnownAgents: true,
  watchFileChanges: true,
  autoInjectSkill: false
};

export async function ensureMemoryScanPreferences(
  configPath: string,
  legacyPreferences: ScanPreferences
): Promise<void> {
  await mutateRuntimeConfig(configPath, (root) => {
    const memory = record(root.memmyMemory);
    if (isCompletePreferences(memory.agentAccess)) return;
    root.memmyMemory = {
      ...memory,
      agentAccess: {
        ...legacyPreferences,
        ...record(memory.agentAccess)
      }
    };
  });
}

export function createMemoryScanPreferencesStore(configPath: string): ScanPreferencesStore {
  return {
    getScanPreferences() {
      return readMemoryScanPreferences(configPath);
    },

    async updateScanPreferences(patch) {
      await mutateRuntimeConfig(configPath, (root) => {
        const memory = record(root.memmyMemory);
        root.memmyMemory = {
          ...memory,
          agentAccess: {
            ...readPreferencesRecord(memory.agentAccess),
            ...patch
          }
        };
      });
      return readMemoryScanPreferences(configPath);
    }
  };
}

export function readMemoryScanPreferences(configPath: string): ScanPreferences {
  try {
    const parsed = YAML.parse(readFileSync(configPath, "utf8")) as unknown;
    return ScanPreferencesSchema.parse({
      ...DEFAULT_MEMORY_SCAN_PREFERENCES,
      ...readPreferencesRecord(record(record(parsed).memmyMemory).agentAccess)
    });
  } catch (error) {
    if (error instanceof Error && "code" in error && (error as NodeJS.ErrnoException).code === "ENOENT") {
      return { ...DEFAULT_MEMORY_SCAN_PREFERENCES };
    }
    throw error;
  }
}

function readPreferencesRecord(value: unknown): Partial<ScanPreferences> {
  const input = record(value);
  return {
    ...(typeof input.autoScanKnownAgents === "boolean"
      ? { autoScanKnownAgents: input.autoScanKnownAgents }
      : {}),
    ...(typeof input.watchFileChanges === "boolean"
      ? { watchFileChanges: input.watchFileChanges }
      : {}),
    ...(typeof input.autoInjectSkill === "boolean"
      ? { autoInjectSkill: input.autoInjectSkill }
      : {})
  };
}

function isCompletePreferences(value: unknown): boolean {
  const input = record(value);
  return typeof input.autoScanKnownAgents === "boolean"
    && typeof input.watchFileChanges === "boolean"
    && typeof input.autoInjectSkill === "boolean";
}

function record(value: unknown): Record<string, unknown> {
  return value && typeof value === "object" && !Array.isArray(value)
    ? value as Record<string, unknown>
    : {};
}
