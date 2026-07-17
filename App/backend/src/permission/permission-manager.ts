import type { ScanPermission } from "@memmy/local-api-contracts";
import { randomUUID, timingSafeEqual } from "node:crypto";
import type { AppStateStore } from "../infrastructure/app-state-store/index.js";
import type {
  CanScanAgentSourceInput,
  CanSearchMemoryInput,
  CanWriteAgentSkillInput,
  PermissionManager,
  RevokeAgentSourceInput,
  SetScanPermissionInput
} from "./types.js";

export interface CreatePermissionManagerOptions {
  appStateStore: AppStateStore;
  runtimeToken?: string;
}

export function createPermissionManager(options: CreatePermissionManagerOptions): PermissionManager {
  const runtimeToken = options.runtimeToken ?? randomUUID();
  let scanPermissionOverride: ScanPermission | undefined;

  const getScanPermission = async (): Promise<ScanPermission> =>
    scanPermissionOverride ?? options.appStateStore.repositories.bootstrap.getOnboardingState().scanPermission;

  return {
    async getRuntimeToken() {
      return runtimeToken;
    },

    async verifyRuntimeToken(token: string) {
      return safeEqual(token, runtimeToken);
    },

    getScanPermission,

    async setScanPermission(input: SetScanPermissionInput) {
      scanPermissionOverride = input.scanPermission;
    },

    async canDetectAgentSources() {
      return true;
    },

    async canScanAgentSource(_input: CanScanAgentSourceInput) {
      const permission = await getScanPermission();
      return permission === "scan_only" || permission === "scan_and_write_skill";
    },

    async canWriteAgentSkill(_input: CanWriteAgentSkillInput) {
      return (await getScanPermission()) === "scan_and_write_skill";
    },

    async canSearchMemory(_input: CanSearchMemoryInput) {
      return true;
    },

    async revokeAgentSource(_input: RevokeAgentSourceInput) {
      return undefined;
    }
  };
}

function safeEqual(actual: string, expected: string): boolean {
  const actualBuffer = Buffer.from(actual);
  const expectedBuffer = Buffer.from(expected);

  if (actualBuffer.length !== expectedBuffer.length) {
    return false;
  }

  return timingSafeEqual(actualBuffer, expectedBuffer);
}
