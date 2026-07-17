/** Agent source auto inject service tests. */
import { describe, expect, it } from "vitest";
import { createAgentSourceAutoInjectService } from "../agent-source-auto-inject-service.js";
import type { AgentSourceView, ScanPreferences } from "@memmy/local-api-contracts";

const enabledPreferences: ScanPreferences = {
  autoScanKnownAgents: true,
  watchFileChanges: true,
  autoInjectSkill: true
};

describe("agent source auto inject service", () => {
  it("skips when auto inject is disabled", async () => {
    const calls: string[] = [];
    const service = createAgentSourceAutoInjectService({
      agentSources: createAgentSources(calls),
      permissionManager: { async canWriteAgentSkill() { return true; } },
      getScanPreferences: () => ({ ...enabledPreferences, autoInjectSkill: false })
    });

    await expect(service.runOnce()).resolves.toEqual({
      ok: true,
      skipped: true,
      reason: "auto_inject_disabled",
      installed: [],
      failed: []
    });
    expect(calls).toEqual([]);
  });

  it("installs supported builtin not-connected agents only", async () => {
    const calls: string[] = [];
    const service = createAgentSourceAutoInjectService({
      agentSources: createAgentSources(calls),
      permissionManager: { async canWriteAgentSkill() { return true; } },
      getScanPreferences: () => enabledPreferences
    });

    await expect(service.runOnce()).resolves.toEqual({
      ok: true,
      skipped: false,
      installed: ["cursor", "opencode", "openclaw", "workbuddy"],
      failed: []
    });
    expect(calls).toEqual(["plugin:cursor", "plugin:opencode", "plugin:openclaw", "skill:workbuddy"]);
  });

  it("skips unavailable builtin agents", async () => {
    const calls: string[] = [];
    const service = createAgentSourceAutoInjectService({
      agentSources: {
        ...createAgentSources(calls),
        async list() {
          return [
            {
              ...source("claude_code", "not_connected", true),
              available: false
            }
          ];
        }
      },
      permissionManager: { async canWriteAgentSkill() { return true; } },
      getScanPreferences: () => enabledPreferences
    });

    await expect(service.runOnce()).resolves.toEqual({
      ok: true,
      skipped: false,
      installed: [],
      failed: []
    });
    expect(calls).toEqual([]);
  });


  it("does not run concurrently", async () => {
    const calls: string[] = [];
    let releaseInstall: () => void = () => undefined;
    const installGate = new Promise<void>((resolve) => {
      releaseInstall = resolve;
    });
    const service = createAgentSourceAutoInjectService({
      agentSources: {
        ...createAgentSources(calls),
        async installPlugin(sourceId) {
          calls.push(`plugin:${sourceId}`);
          await installGate;
        }
      },
      permissionManager: { async canWriteAgentSkill() { return true; } },
      getScanPreferences: () => enabledPreferences
    });

    const running = service.runOnce();
    await new Promise((resolve) => setImmediate(resolve));
    await expect(service.runOnce()).resolves.toMatchObject({
      skipped: true,
      reason: "already_running"
    });
    releaseInstall();
    await running;
  });
});

function createAgentSources(calls: string[]) {
  return {
    async list(): Promise<AgentSourceView[]> {
      return [
        source("cursor", "not_connected", true),
        source("codex", "skill_installed", true),
        source("opencode", "not_connected", true),
        source("openclaw", "not_connected", true),
        source("workbuddy", "not_connected", true),
        source("custom", "not_connected", false)
      ];
    },
    async installSkill(sourceId: string) {
      calls.push(`skill:${sourceId}`);
    },
    async installPlugin(sourceId: string) {
      calls.push(`plugin:${sourceId}`);
    }
  };
}

function source(sourceId: string, status: AgentSourceView["status"], builtin: boolean): AgentSourceView {
  return {
    sourceId,
    displayName: sourceId,
    dataPath: `/tmp/${sourceId}`,
    builtin,
    available: true,
    status,
    messageCount: 0,
    lastScannedAt: null
  };
}
