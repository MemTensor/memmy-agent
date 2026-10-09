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
      installed: ["cursor", "opencode", "openclaw", "deepseek_harness", "workbuddy", "pi", "qwenwork"],
      failed: []
    });
    expect(calls).toEqual([
      "plugin:cursor:auto_inject",
      "plugin:opencode:auto_inject",
      "plugin:openclaw:auto_inject",
      "plugin:deepseek_harness:auto_inject",
      "skill:workbuddy",
      "skill:pi",
      "skill:qwenwork",
    ]);
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

  it("refreshes an outdated installed hook while auto inject is disabled", async () => {
    const calls: string[] = [];
    const service = createAgentSourceAutoInjectService({
      agentSources: {
        ...createAgentSources(calls),
        async list() {
          return [source("cursor", "plugin_installed", true)];
        },
        async isInstalledHookCurrent() {
          return false;
        }
      },
      permissionManager: { async canWriteAgentSkill() { return true; } },
      getScanPreferences: () => ({ ...enabledPreferences, autoInjectSkill: false })
    });

    await expect(service.runOnce()).resolves.toEqual({
      ok: true,
      skipped: true,
      reason: "auto_inject_disabled",
      installed: ["cursor"],
      failed: []
    });
    expect(calls).toEqual(["plugin:cursor:auto_inject"]);
  });

  it("leaves a current hook in place and still installs a newly found agent", async () => {
    const calls: string[] = [];
    const service = createAgentSourceAutoInjectService({
      agentSources: {
        ...createAgentSources(calls),
        async list() {
          return [
            source("cursor", "plugin_installed", true),
            source("claude_code", "plugin_installed", true),
            source("codex", "plugin_installed", true),
            source("workbuddy", "not_connected", true)
          ];
        },
        async isInstalledHookCurrent(sourceId) {
          return sourceId !== "codex";
        }
      },
      permissionManager: { async canWriteAgentSkill() { return true; } },
      getScanPreferences: () => enabledPreferences
    });

    await expect(service.runOnce()).resolves.toEqual({
      ok: true,
      skipped: false,
      installed: ["codex", "workbuddy"],
      failed: []
    });
    expect(calls).toEqual([
      "plugin:codex:auto_inject",
      "skill:workbuddy"
    ]);
  });

  it("does not refresh installed plugins that are not hooks", async () => {
    const calls: string[] = [];
    const service = createAgentSourceAutoInjectService({
      agentSources: {
        ...createAgentSources(calls),
        async list() {
          return [
            source("hermes", "plugin_installed", true),
            source("opencode", "plugin_installed", true)
          ];
        },
        async isInstalledHookCurrent() {
          return false;
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

  it("skips an outdated hook when the agent is unavailable or not writable", async () => {
    const calls: string[] = [];
    const service = createAgentSourceAutoInjectService({
      agentSources: {
        ...createAgentSources(calls),
        async list() {
          return [
            { ...source("cursor", "plugin_installed", true), available: false },
            source("claude_code", "plugin_installed", true)
          ];
        },
        async isInstalledHookCurrent() {
          return false;
        }
      },
      permissionManager: {
        async canWriteAgentSkill(input: { agentSourceId: string }) {
          return input.agentSourceId !== "claude_code";
        }
      },
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

  it("records a hook refresh failure and continues with other agents", async () => {
    const calls: string[] = [];
    const service = createAgentSourceAutoInjectService({
      agentSources: {
        ...createAgentSources(calls),
        async list() {
          return [
            source("cursor", "plugin_installed", true),
            source("pi", "not_connected", true)
          ];
        },
        async isInstalledHookCurrent() {
          return false;
        },
        async installPlugin() {
          throw new Error("install failed");
        }
      },
      permissionManager: { async canWriteAgentSkill() { return true; } },
      getScanPreferences: () => enabledPreferences
    });

    await expect(service.runOnce()).resolves.toEqual({
      ok: true,
      skipped: false,
      installed: ["pi"],
      failed: [{ sourceId: "cursor", reason: "install failed" }]
    });
    expect(calls).toEqual(["skill:pi"]);
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
        source("deepseek_harness", "not_connected", true),
        source("workbuddy", "not_connected", true),
        source("pi", "not_connected", true),
        source("qwenwork", "not_connected", true),
        source("custom", "not_connected", false)
      ];
    },
    async installSkill(sourceId: string) {
      calls.push(`skill:${sourceId}`);
    },
    async installPlugin(sourceId: string, action?: { installType?: string }) {
      calls.push(`plugin:${sourceId}:${action?.installType ?? "manual"}`);
    },
    async isInstalledHookCurrent() {
      return true;
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
