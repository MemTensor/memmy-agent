/** Permission manager tests. */
import { describe, expect, it } from "vitest";
import type { ScanPermission } from "@memmy/local-api-contracts";
import type { AppStateStore } from "../../infrastructure/app-state-store/index.js";
import { createPermissionManager } from "../permission-manager.js";

describe("permission manager", () => {
  it.each([
    ["scan_only", true, false],
    ["scan_and_write_skill", true, true],
    ["none", false, false],
    ["unset", false, false]
  ] as const)("maps %s to scan and skill permissions", async (permission, canScan, canWriteSkill) => {
    const manager = createPermissionManager({
      appStateStore: createStore(permission),
      runtimeToken: "runtime-token"
    });

    await expect(manager.canScanAgentSource({ agentSourceId: "cursor" })).resolves.toBe(canScan);
    await expect(manager.canWriteAgentSkill({ agentSourceId: "cursor" })).resolves.toBe(canWriteSkill);
  });
});

function createStore(scanPermission: ScanPermission): AppStateStore {
  return {
    repositories: {
      bootstrap: {
        getOnboardingState() {
          return { scanPermission };
        }
      }
    }
  } as AppStateStore;
}
