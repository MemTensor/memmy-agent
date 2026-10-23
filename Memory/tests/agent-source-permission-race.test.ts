import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it, vi } from "vitest";
import { createAgentSourceExecutor } from "../src/agent-source/runtime.js";
import { createSourceRegistry } from "../src/agent-source/adapters/source-registry.js";
import { createSkillTargetRegistry } from "../src/agent-source/integration/target-registry.js";
import type { MemoryService } from "../src/service/memory-service.js";

function deferred() {
  let resolve!: () => void;
  const promise = new Promise<void>(yes => { resolve = yes; });
  return { promise, resolve };
}

describe("revoking permission during automatic integration", () => {
  it.each(["discovery", "detect", "root", "install"])("drains %s before acknowledging and prevents subsequent installs", async stage => {
    const root = mkdtempSync(join(tmpdir(), "memmy-auto-revoke-"));
    const configPath = join(root, "config.yaml");
    const save = (permission: string) => writeFileSync(configPath, `memmyMemory:\n  agentAccess:\n    scanPermission: ${permission}\n    autoInjectSkill: true\n    autoScanKnownAgents: true\n    watchFileChanges: false\n`);
    save("scan_and_write_skill");
    let entered = false;
    const release = deferred();
    const hold = async (point: string) => { if (point === stage) { entered = true; await release.promise; } };
    let detected = 0;
    const installs: string[] = [];
    const executor = createAgentSourceExecutor({
      service: {} as MemoryService, configPath, statePath: join(root, "state.json"),
      initialScanDelayMs: 1, scheduledScanIntervalMs: 60_000,
      sourceRegistry: createSourceRegistry(["cursor", "claude"].map(sourceId => ({
        descriptor: { sourceId, displayName: sourceId, builtin: true, dataPath: root },
        async detect() { if (sourceId === "cursor") await hold(++detected === 1 ? "discovery" : "detect"); return true; },
        async *scan() { /* no conversation data */ }
      }))),
      integrationRegistry: createSkillTargetRegistry(["cursor", "claude"].map(targetId => ({
        targetId, displayName: targetId,
        async resolveRootDirectory() { await hold("root"); return root; },
        async isInstalled() { return false; },
        async install() { await hold("install"); installs.push(targetId); },
        async installPlugin() { await hold("install"); installs.push(targetId); },
        async uninstall() {}
      })))
    });
    try {
      executor.startAutomation();
      await vi.waitFor(() => expect(entered).toBe(true));
      save("none");
      let acknowledged = false;
      const revoke = executor.reconcileScanPermission!().then(() => { acknowledged = true; });
      await Promise.resolve();
      expect(acknowledged).toBe(false);
      // A rapid re-grant must not resurrect the old discovery/installation run.
      save("scan_and_write_skill");
      release.resolve();
      await revoke;
      expect(installs).toEqual(stage === "install" ? ["cursor"] : []);
      save("none");
      await executor.reconcileScanPermission!();
      await expect(executor.startScan({ sourceId: "all" })).rejects.toThrow("not authorized");
      expect(installs).toEqual(stage === "install" ? ["cursor"] : []);
    } finally {
      release.resolve();
      await executor.dispose();
      rmSync(root, { recursive: true, force: true });
    }
  });
});
