import { readFileSync } from "node:fs";
import type { PatchScanPreferencesInput, ScanPreferences, ScanPermission } from "@memmy/local-api-contracts";
import { ScanPreferencesSchema } from "@memmy/local-api-contracts";
import { mutateRuntimeConfig } from "@memmy/migrations";
import YAML from "yaml";

export interface ScanPreferencesStore {
  getScanPreferences(): ScanPreferences;
  getScanPermission(): ScanPermission | undefined;
  setScanPermission(permission: ScanPermission, enableAutomation?: boolean): Promise<void>;
  updateScanPreferences(patch: PatchScanPreferencesInput): Promise<ScanPreferences>;
}

export const DEFAULT_MEMORY_SCAN_PREFERENCES: ScanPreferences = {
  autoScanKnownAgents: true,
  watchFileChanges: true,
  autoInjectSkill: false
};

export async function ensureMemoryScanPreferences(
  configPath: string,
  legacyPreferences: ScanPreferences,
  scanPermission?: ScanPermission
): Promise<void> {
  await mutateRuntimeConfig(configPath, (root) => {
    const memory = record(root.memmyMemory);
    const access = record(memory.agentAccess);
    if (isCompletePreferences(access) && (scanPermission === undefined || access.scanPermission !== undefined)) return;
    root.memmyMemory = {
      ...memory,
      agentAccess: {
        ...legacyPreferences,
        ...access,
        ...(scanPermission !== undefined && access.scanPermission === undefined ? { scanPermission } : {})
      }
    };
  });
}

export function createMemoryScanPreferencesStore(configPath: string): ScanPreferencesStore {
  return {
    async setScanPermission(permission, enableAutomation = false) {
      await mutateRuntimeConfig(configPath, (root) => {
        const memory = record(root.memmyMemory);
        root.memmyMemory = {
          ...memory,
          agentAccess: {
            ...record(memory.agentAccess),
            scanPermission: permission,
            ...(permission === "none" || permission === "unset"
              ? { autoScanKnownAgents: false, watchFileChanges: false, autoInjectSkill: false }
              : enableAutomation ? {
                autoScanKnownAgents: true,
                watchFileChanges: true,
                autoInjectSkill: permission === "scan_and_write_skill"
              } : {})
          }
        };
      });
    },
    getScanPermission() {
      try {
        const root = record(YAML.parse(readFileSync(configPath, "utf8")));
        const permission = record(record(root.memmyMemory).agentAccess).scanPermission;
        if (permission === undefined) return undefined;
        return permission === "none" || permission === "scan_only" || permission === "scan_and_write_skill"
          ? permission : "unset";
      } catch (error) {
        if (error instanceof Error && "code" in error && (error as NodeJS.ErrnoException).code === "ENOENT") return undefined;
        throw error;
      }
    },
    getScanPreferences() {
      return readMemoryScanPreferences(configPath);
    },

    async updateScanPreferences(patch) {
      await mutateRuntimeConfig(configPath, (root) => {
        const memory = record(root.memmyMemory);
        root.memmyMemory = {
          ...memory,
          agentAccess: {
            ...record(memory.agentAccess),
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
