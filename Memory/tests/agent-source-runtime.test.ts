import { withUnrestrictedScanPermit } from "./fixtures/scan-admission-fixture.js";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { setTimeout as waitForIO } from "node:timers/promises";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  createAgentSourceExecutor,
  createBuiltinSourceRegistry
} from "../src/agent-source/runtime.js";
import type { SourceAdapter } from "../src/agent-source/adapters/types.js";
import { createSourceRegistry } from "../src/agent-source/adapters/source-registry.js";
import { createCursorSkillTarget } from "../src/agent-source/integration/cursor/index.js";
import { createSkillTargetRegistry } from "../src/agent-source/integration/target-registry.js";
import type { SkillTarget } from "../src/agent-source/integration/types.js";
import type { MemoryService } from "../src/service/memory-service.js";

const roots: string[] = [];

afterEach(() => {
  vi.useRealTimers();
  vi.unstubAllEnvs();
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

describe("standalone Agent source executor", () => {
  it.each([[false, true], [true, true], [false, false]])("refreshes installed OpenCode with auto injection disabled, removal=%s, storedState=%s", async (removed, storedState) => {
    const root = tempRoot();
    const configPath = join(root, "config.yaml");
    const statePath = join(root, "agent-sources.json");
    writeFileSync(configPath, JSON.stringify({ memmyMemory: { agentAccess: {
      autoScanKnownAgents: false, watchFileChanges: false, autoInjectSkill: false
    } } }));
    writeFileSync(statePath, JSON.stringify({ version: 2, sources: storedState ? { opencode: {
      status: "plugin_installed", autoInjectSuppressed: removed, messageCount: 0, lastScannedAt: null, latestSeenAt: null
    } } : {} }));
    const installPlugin = vi.fn(async () => {});
    const isInstalledHookCurrent = vi.fn(async () => installPlugin.mock.calls.length > 0);
    const target: SkillTarget = {
      targetId: "opencode", displayName: "OpenCode", async resolveRootDirectory() { return root; },
      async install() {}, async uninstall() {}, async isInstalled() { return true; },
      installPlugin, isInstalledHookCurrent
    };
    const executor = createAgentSourceExecutor({
      service: {} as MemoryService, configPath, statePath, initialScanDelayMs: 0, scheduledScanIntervalMs: 10,
      sourceRegistry: createSourceRegistry([{
        descriptor: { sourceId: "opencode", displayName: "OpenCode", builtin: true, dataPath: root },
        detect: async () => true, async *scan() {}
      }]),
      integrationRegistry: createSkillTargetRegistry([target])
    });
    try {
      executor.startAutomation();
      if (!removed) await vi.waitFor(() => expect(isInstalledHookCurrent.mock.calls.length).toBeGreaterThan(1));
      else await new Promise(resolve => setTimeout(resolve, 60));
      expect(installPlugin).toHaveBeenCalledTimes(removed ? 0 : 1);
    } finally { await executor.dispose(); }
  });

  it("preserves explicit OpenCode removal suppression when clearing memory", async () => {
    const root = tempRoot();
    const configPath = join(root, "config.yaml");
    const statePath = join(root, "agent-sources.json");
    writeFileSync(configPath, JSON.stringify({ memmyMemory: { agentAccess: {
      autoScanKnownAgents: false, watchFileChanges: false, autoInjectSkill: true
    } } }));
    writeFileSync(statePath, JSON.stringify({ version: 2, sources: { opencode: {
      status: "not_connected", autoInjectSuppressed: true, messageCount: 4, lastScannedAt: null, latestSeenAt: null
    } } }));
    const installPlugin = vi.fn(async () => {});
    const detect = vi.fn(async () => true);
    const executor = createAgentSourceExecutor({
      service: { clearAllData: vi.fn(() => ({ ok: true })) } as unknown as MemoryService,
      configPath, statePath, initialScanDelayMs: 0, scheduledScanIntervalMs: 10,
      sourceRegistry: createSourceRegistry([{
        descriptor: { sourceId: "opencode", displayName: "OpenCode", builtin: true, dataPath: root },
        detect, async *scan() {}
      }]),
      integrationRegistry: createSkillTargetRegistry([{
        targetId: "opencode", displayName: "OpenCode", async resolveRootDirectory() { return root; },
        async install() {}, async uninstall() {}, async isInstalled() { return false; }, installPlugin
      }])
    });
    try {
      await executor.clearAllData();
      expect(JSON.parse(readFileSync(statePath, "utf8")).sources.opencode).toMatchObject({
        status: "not_connected", autoInjectSuppressed: true, messageCount: 0
      });
      executor.startAutomation();
      await vi.waitFor(() => expect(detect).toHaveBeenCalled());
      await waitForIO(20);
      expect(installPlugin).not.toHaveBeenCalled();
    } finally { await executor.dispose(); }
  });

  it("does not refresh OpenCode after clearing begins during freshness lookup", async () => {
    const root = tempRoot();
    const configPath = join(root, "config.yaml");
    const statePath = join(root, "agent-sources.json");
    writeFileSync(configPath, JSON.stringify({ memmyMemory: { agentAccess: {
      autoScanKnownAgents: false, watchFileChanges: false, autoInjectSkill: false
    } } }));
    writeFileSync(statePath, JSON.stringify({ version: 2, sources: { opencode: {
      status: "plugin_installed", messageCount: 0, lastScannedAt: null, latestSeenAt: null
    } } }));
    let finishLookup!: (current: boolean) => void;
    const freshness = new Promise<boolean>((resolve) => { finishLookup = resolve; });
    const isInstalledHookCurrent = vi.fn(() => freshness);
    const installPlugin = vi.fn(async () => {});
    const executor = createAgentSourceExecutor({
      service: { clearAllData: vi.fn(() => ({ ok: true })) } as unknown as MemoryService,
      configPath, statePath, initialScanDelayMs: 0, scheduledScanIntervalMs: 10,
      sourceRegistry: createSourceRegistry([{
        descriptor: { sourceId: "opencode", displayName: "OpenCode", builtin: true, dataPath: root },
        detect: async () => true, async *scan() {}
      }]),
      integrationRegistry: createSkillTargetRegistry([{
        targetId: "opencode", displayName: "OpenCode", async resolveRootDirectory() { return root; },
        async install() {}, async uninstall() {}, async isInstalled() { return true; },
        installPlugin, isInstalledHookCurrent
      }])
    });
    try {
      executor.startAutomation();
      await vi.waitFor(() => expect(isInstalledHookCurrent).toHaveBeenCalledOnce());
      const clearing = executor.clearAllData();
      finishLookup(false);
      await clearing;
      expect(installPlugin).not.toHaveBeenCalled();
    } finally { finishLookup(true); await executor.dispose(); }
  });

  it("waits for cancellation to release its writer before allowing a replacement", async () => {
    const root = tempRoot();
    let finishFirst!: () => void;
    let finishSecond!: () => void;
    const first = new Promise<void>((done) => { finishFirst = done; });
    const second = new Promise<void>((done) => { finishSecond = done; });
    const detect = vi.fn()
      .mockImplementationOnce(async () => { await first; return true; })
      .mockImplementationOnce(async () => { await second; return true; });
    const executor = createAgentSourceExecutor({
      service: { withAgentSourceScanPermit: withUnrestrictedScanPermit,} as MemoryService,
      configPath: join(root, "config.yaml"),
      sourceRegistry: createSourceRegistry([{
        descriptor: { sourceId: "fixture-agent", displayName: "Fixture Agent", builtin: true, dataPath: root },
        detect,
        async *scan() { yield fixtureMessage("user", "disposal", "2026-08-28T01:00:00.000Z"); },
      }]),
    });
    try {
      await executor.startScan({ sourceId: "fixture-agent" });
      await vi.waitFor(() => expect(detect).toHaveBeenCalledTimes(1));
      const cancellation = executor.cancelScan();
      await expect(executor.startScan({ sourceId: "fixture-agent" })).rejects.toThrow("Canceling");
      finishFirst();
      await cancellation;
      await executor.startScan({ sourceId: "fixture-agent" });
      await vi.waitFor(() => expect(detect).toHaveBeenCalledTimes(2));
      let completed = false;
      const disposal = Promise.resolve(executor.dispose()).then(() => { completed = true; });
      expect(completed).toBe(false);
      finishSecond();
      await disposal;
    } finally {
      finishFirst();
      finishSecond();
      await executor.dispose();
    }
  });

  it("waits for an aborted scan to release its store before disposal completes", async () => {
    const root = tempRoot();
    let finishDetection!: () => void;
    const detection = new Promise<void>((done) => { finishDetection = done; });
    const detect = vi.fn(async () => { await detection; return true; });
    const adapter: SourceAdapter = {
      descriptor: { sourceId: "fixture-agent", displayName: "Fixture Agent", builtin: true, dataPath: root },
      detect,
      async *scan() { yield fixtureMessage("user", "disposal", "2026-08-28T01:00:00.000Z"); },
    };
    const addMemory = vi.fn();
    const executor = createAgentSourceExecutor({
      service: { withAgentSourceScanPermit: withUnrestrictedScanPermit, addMemory } as unknown as MemoryService,
      configPath: join(root, "config.yaml"),
      sourceRegistry: createSourceRegistry([adapter]),
    });
    try {
      await executor.startScan({ sourceId: "fixture-agent", mode: "full" });
      await vi.waitFor(() => expect(detect).toHaveBeenCalledOnce());
      let completed = false;
      const disposal = Promise.resolve(executor.dispose()).then(() => { completed = true; });
      await new Promise((done) => setTimeout(done, 10));
      expect(completed).toBe(false);
      finishDetection();
      await disposal;
      expect(addMemory).not.toHaveBeenCalled();
      await expect(executor.startScan({ sourceId: "fixture-agent" })).rejects.toThrow("shutting down");
    } finally {
      finishDetection();
      await executor.dispose();
    }
  });

  it("waits for automation and prevents a scan from starting after disposal", async () => {
    const root = tempRoot();
    const configPath = join(root, "config.yaml");
    writeFileSync(configPath, JSON.stringify({ memmyMemory: {
      agentAccess: { autoScanKnownAgents: true, watchFileChanges: true, autoInjectSkill: true },
    } }));
    let finishDetection!: () => void;
    const detection = new Promise<void>((done) => { finishDetection = done; });
    const detect = vi.fn(async () => { await detection; return true; });
    const executor = createAgentSourceExecutor({
      service: { withAgentSourceScanPermit: withUnrestrictedScanPermit,} as MemoryService,
      configPath,
      initialScanDelayMs: 0,
      sourceRegistry: createSourceRegistry([{
        descriptor: { sourceId: "fixture-agent", displayName: "Fixture Agent", builtin: true, dataPath: root },
        detect,
        async *scan() { yield fixtureMessage("user", "disposal", "2026-08-28T01:00:00.000Z"); },
      }]),
    });
    try {
      executor.startAutomation();
      await vi.waitFor(() => expect(detect).toHaveBeenCalledOnce());
      let completed = false;
      const disposal = Promise.resolve(executor.dispose()).then(() => { completed = true; });
      await new Promise((done) => setTimeout(done, 10));
      expect(completed).toBe(false);
      finishDetection();
      await disposal;
      expect(executor.scanStatus().jobId).toBeNull();
    } finally {
      finishDetection();
      await executor.dispose();
    }
  });

  it("owns the complete built-in source registry without a Desktop bridge", () => {
    expect(createBuiltinSourceRegistry().list().map((source) => source.descriptor.sourceId)).toEqual([
      "cursor",
      "claude_code",
      "codex",
      "opencode",
      "openclaw",
      "hermes",
      "deepseek_harness",
      "workbuddy",
      "pi",
      "qwenwork"
    ]);
  });

  it("scans, imports, persists progress, and deduplicates without Memmy Desktop", async () => {
    const root = tempRoot();
    const addMemory = vi.fn()
      .mockReturnValueOnce({ id: "memory-1", duplicate: false })
      .mockReturnValue({ id: "memory-1", duplicate: true });
    const enqueuePendingImportSummaries = vi.fn();
    const scheduleWorker = vi.fn();
    const service = { withAgentSourceScanPermit: withUnrestrictedScanPermit, addMemory, enqueuePendingImportSummaries } as unknown as MemoryService;
    const adapter: SourceAdapter = {
      descriptor: {
        sourceId: "fixture-agent",
        displayName: "Fixture Agent",
        builtin: true,
        dataPath: join(root, "history")
      },
      detect: async () => true,
      async *scan() {
        yield {
          messageId: "user-1",
          sourceId: "fixture-agent",
          conversationId: "conversation-1",
          role: "user",
          content: "Remember this",
          createdAt: "2026-08-28T01:00:00.000Z",
          workspacePath: null,
          gitRoot: null,
          rawMeta: {}
        };
        yield {
          messageId: "assistant-1",
          sourceId: "fixture-agent",
          conversationId: "conversation-1",
          role: "assistant",
          content: "Done",
          createdAt: "2026-08-28T01:01:00.000Z",
          workspacePath: null,
          gitRoot: null,
          rawMeta: {}
        };
      }
    };
    const statePath = join(root, "agent-sources.json");
    const executor = createAgentSourceExecutor({
      service,
      configPath: join(root, "config.yaml"),
      statePath,
      sourceRegistry: createSourceRegistry([adapter]),
      scheduleWorker
    });

    expect(await executor.list()).toMatchObject({
      executorAvailable: true,
      sources: [{ sourceId: "fixture-agent", available: true, messageCount: 0 }]
    });

    await executor.startScan({ sourceId: "fixture-agent", mode: "full" });
    await waitForScan(executor);
    expect(addMemory).toHaveBeenCalledTimes(1);
    expect(addMemory).toHaveBeenCalledWith(expect.objectContaining({
      adapterId: "agent-source:fixture-agent",
      source: "fixture-agent",
      deferProcessing: true
    }));
    expect(enqueuePendingImportSummaries).toHaveBeenCalledWith(1_000, ["memory-1"]);
    expect(scheduleWorker).toHaveBeenCalledTimes(1);
    expect((await executor.list()).sources[0]).toMatchObject({ messageCount: 2 });

    await executor.startScan({ sourceId: "fixture-agent", mode: "full" });
    await waitForScan(executor);
    expect(addMemory).toHaveBeenCalledTimes(2);
    expect(JSON.parse(readFileSync(statePath, "utf8"))).toMatchObject({
      version: 2,
      sources: {
        "fixture-agent": {
          messageCount: 2,
          latestSeenAt: "2026-08-28T01:01:00.000Z",
        }
      }
    });
  });

  it("clears import checkpoints so ordinary single-source and all-source scans reimport deleted history", async () => {
    const root = tempRoot();
    const statePath = join(root, "agent-sources.json");
    const checkpointPath = `${statePath}.checkpoints.sqlite`;
    const scanStoreDirectory = join(root, "agent-source-scans");
    writeFileSync(statePath, JSON.stringify({ version: 2, legacyRecoveryChecked: true, sources: {
      alpha: { status: "plugin_installed", messageCount: 4, lastScannedAt: "2026-08-27T01:00:00.000Z", latestSeenAt: "2026-08-27T01:00:00.000Z", contentHash: "old-hash" }
    } }));
    let imported: Array<{ sourceId: string; memoryId: string }> = [];
    let sequence = 0;
    const addMemory = vi.fn((input: { source: string }) => {
      const memoryId = `memory-${++sequence}`;
      imported.push({ sourceId: input.source, memoryId });
      return { id: memoryId, duplicate: false };
    });
    const clearMemory = vi.fn(() => {
      const memories = imported.length;
      imported = [];
      return { ok: true as const, cleared: { memories }, clearedAt: new Date().toISOString(), serverTime: new Date().toISOString() };
    });
    const enqueuePendingImportSummaries = vi.fn();
    const scanOptions: Array<{ sourceId: string; options: Parameters<SourceAdapter["scan"]>[0] }> = [];
    const createAdapter = (sourceId: string): SourceAdapter => ({
      descriptor: { sourceId, displayName: sourceId, builtin: true, dataPath: join(root, sourceId) },
      detect: async () => true,
      async *scan(options) {
        scanOptions.push({ sourceId, options });
        yield* completeTurn(`${sourceId}-conversation`, "2026-08-28T01:00:00.000Z").map((message) => ({
          ...message,
          sourceId,
          content: `${sourceId}: ${message.content}`
        }));
      }
    });
    const executor = createAgentSourceExecutor({
      service: { withAgentSourceScanPermit: withUnrestrictedScanPermit, addMemory, clearAllData: clearMemory, enqueuePendingImportSummaries } as unknown as MemoryService,
      configPath: join(root, "config.yaml"),
      statePath,
      scanStoreDirectory,
      sourceRegistry: createSourceRegistry([createAdapter("alpha"), createAdapter("beta")])
    });

    try {
      await executor.startScan({ sourceId: "alpha", mode: "full" });
      await waitForScan(executor);
      expect(addMemory).toHaveBeenCalledTimes(1);
      expect(scanOptions[0]?.options).toMatchObject({ fullHistory: true, order: "source_default" });
      expect(scanOptions[0]?.options.since).toBeUndefined();
      expect(existsSync(checkpointPath)).toBe(true);
      expect(readdirSync(scanStoreDirectory).some((name) => name.endsWith(".sqlite"))).toBe(true);

      await executor.clearAllData();
      expect(clearMemory).toHaveBeenCalledOnce();
      expect(imported).toEqual([]);
      expect(executor.scanStatus()).toMatchObject({ running: false, status: "idle", progress: null });
      expect(JSON.parse(readFileSync(statePath, "utf8"))).toMatchObject({
        version: 2,
        legacyRecoveryChecked: true,
        sources: { alpha: { status: "plugin_installed", messageCount: 0, lastScannedAt: null, latestSeenAt: null } }
      });
      expect(JSON.parse(readFileSync(statePath, "utf8")).sources.alpha).not.toHaveProperty("recoveryPending");
      expect(existsSync(checkpointPath)).toBe(false);
      expect(readdirSync(scanStoreDirectory)).toEqual(["state-generation.json"]);

      await executor.startScan({ sourceId: "alpha" });
      await waitForScan(executor);
      expect(addMemory).toHaveBeenCalledTimes(2);
      expect(scanOptions[1]?.options).toMatchObject({ fullHistory: true, order: "recent_first" });
      expect(scanOptions[1]?.options.since).toBeUndefined();

      await executor.clearAllData();
      scanOptions.length = 0;
      await executor.startScan({ sourceId: "all" });
      await waitForScan(executor);
      expect(scanOptions.map(({ sourceId }) => sourceId)).toEqual(["alpha", "beta"]);
      expect(addMemory).toHaveBeenCalledTimes(4);
      expect(scanOptions.map(({ sourceId, options }) => ({ sourceId, fullHistory: options.fullHistory, since: options.since }))).toEqual([
        { sourceId: "alpha", fullHistory: true, since: undefined },
        { sourceId: "beta", fullHistory: true, since: undefined }
      ]);
    } finally {
      await executor.dispose();
    }
  });

  it("stops an active scan and rejects new scans until clearing has removed its writers", async () => {
    const root = tempRoot();
    let releaseDetection!: () => void;
    let markDetectionStarted!: () => void;
    const detectionStarted = new Promise<void>((resolve) => { markDetectionStarted = resolve; });
    const blockedDetection = new Promise<void>((resolve) => { releaseDetection = resolve; });
    let firstDetection = true;
    const scan = vi.fn(async function* (options: Parameters<SourceAdapter["scan"]>[0]) {
      yield* completeTurn("fixture-agent-conversation", "2026-08-28T01:00:00.000Z");
      void options;
    });
    const addMemory = vi.fn(() => ({ id: "memory-after-clear", duplicate: false }));
    const cleared = { ok: true as const, cleared: { memories: 1 }, clearedAt: "2026-08-28T01:00:00.000Z", serverTime: "2026-08-28T01:00:00.000Z" };
    let finishClear!: (result: typeof cleared) => void;
    const clearingMemory = new Promise<typeof cleared>((resolve) => { finishClear = resolve; });
    const clearMemory = vi.fn(() => clearingMemory);
    const executor = createAgentSourceExecutor({
      service: { withAgentSourceScanPermit: withUnrestrictedScanPermit, addMemory, clearAllData: clearMemory } as unknown as MemoryService,
      configPath: join(root, "config.yaml"),
      sourceRegistry: createSourceRegistry([{
        descriptor: { sourceId: "fixture-agent", displayName: "Fixture Agent", builtin: true, dataPath: root },
        async detect() {
          if (firstDetection) {
            firstDetection = false;
            markDetectionStarted();
            await blockedDetection;
          }
          return true;
        },
        scan
      }])
    });

    try {
      await executor.startScan({ sourceId: "fixture-agent", mode: "full" });
      await detectionStarted;
      const clearing = executor.clearAllData();
      await expect(executor.startScan({ sourceId: "fixture-agent" })).rejects.toThrow("Clearing Memory data");
      expect(clearMemory).not.toHaveBeenCalled();
      releaseDetection();
      await vi.waitFor(() => expect(clearMemory).toHaveBeenCalledOnce());
      await expect(executor.startScan({ sourceId: "fixture-agent" })).rejects.toThrow("Clearing Memory data");
      finishClear(cleared);
      await clearing;
      expect(clearMemory).toHaveBeenCalledOnce();
      expect(scan).toHaveBeenCalledOnce();
      expect(scan.mock.calls[0]?.[0].signal?.aborted).toBe(true);
      expect(addMemory).not.toHaveBeenCalled();
      expect(executor.scanStatus()).toMatchObject({ running: false, status: "idle", progress: null });

      await executor.startScan({ sourceId: "fixture-agent" });
      await waitForScan(executor);
      expect(scan).toHaveBeenCalledTimes(2);
      expect(addMemory).toHaveBeenCalledOnce();
    } finally {
      releaseDetection();
      finishClear(cleared);
      await executor.dispose();
    }
  });

  it("uses an injected Agent Skill root without reading the developer home", async () => {
    const root = tempRoot();
    const skillRoot = join(root, "isolated-agent-root");
    mkdirSync(join(skillRoot, "skills", "release-check"), { recursive: true });
    writeFileSync(
      join(skillRoot, "skills", "release-check", "SKILL.md"),
      "---\nname: release-check\nversion: 1.0.0\n---\nVerify release evidence.\n",
      "utf8"
    );
    const addMemory = vi.fn(({ layer }: { layer: string }) => ({
      id: layer === "Skill" ? "skill-memory" : "trace-memory"
    }));
    const resolveAgentSkillRoot = vi.fn(() => skillRoot);
    const adapter: SourceAdapter = {
      descriptor: {
        sourceId: "cursor",
        displayName: "Cursor",
        builtin: true,
        dataPath: join(root, "history")
      },
      detect: async () => true,
      async *scan() {
        yield fixtureMessage("user", "user-isolated", "2026-08-28T01:00:00.000Z");
        yield fixtureMessage("assistant", "assistant-isolated", "2026-08-28T01:01:00.000Z");
      }
    };
    const executor = createAgentSourceExecutor({
      service: { withAgentSourceScanPermit: withUnrestrictedScanPermit,
        addMemory,
        enqueuePendingImportSummaries: vi.fn()
      } as unknown as MemoryService,
      configPath: join(root, "config.yaml"),
      statePath: join(root, "agent-sources.json"),
      sourceRegistry: createSourceRegistry([adapter]),
      resolveAgentSkillRoot
    });

    await executor.startScan({ sourceId: "cursor", mode: "full" });
    await waitForScan(executor);

    expect(resolveAgentSkillRoot).toHaveBeenCalledWith("cursor");
    expect(addMemory).toHaveBeenCalledTimes(2);
    expect(addMemory).toHaveBeenCalledWith(expect.objectContaining({
      layer: "Skill",
      sourceSkillId: "release-check",
      sourceSkillPath: join(skillRoot, "skills", "release-check", "SKILL.md")
    }));
  });

  it("pauses and resumes the active standalone scan without creating a second job", async () => {
    const root = tempRoot();
    let releaseSecondMessage: (() => void) | undefined;
    const secondMessageReady = new Promise<void>((resolve) => {
      releaseSecondMessage = resolve;
    });
    const addMemory = vi.fn(() => ({ id: "memory-paused" }));
    const adapter: SourceAdapter = {
      descriptor: {
        sourceId: "fixture-agent",
        displayName: "Fixture Agent",
        builtin: true,
        dataPath: join(root, "history")
      },
      detect: async () => true,
      async *scan(options) {
        options.onProgress?.({ sourceId: "fixture-agent", phase: "scan", current: 1, total: 2 });
        yield fixtureMessage("user", "user-paused", "2026-08-28T01:00:00.000Z");
        await secondMessageReady;
        options.onProgress?.({ sourceId: "fixture-agent", phase: "scan", current: 2, total: 2 });
        yield fixtureMessage("assistant", "assistant-paused", "2026-08-28T01:01:00.000Z");
      }
    };
    const executor = createAgentSourceExecutor({
      service: { withAgentSourceScanPermit: withUnrestrictedScanPermit,
        addMemory,
        enqueuePendingImportSummaries: vi.fn()
      } as unknown as MemoryService,
      configPath: join(root, "config.yaml"),
      statePath: join(root, "agent-sources.json"),
      sourceRegistry: createSourceRegistry([adapter])
    });

    const started = await executor.startScan({ sourceId: "fixture-agent" });
    await waitForProgress(executor);
    await executor.pauseScan();
    expect(executor.scanStatus()).toMatchObject({
      running: false,
      jobId: started.jobId,
      progress: { sourceId: "fixture-agent", phase: "stopped", current: 1, total: 2 }
    });

    const resumed = await executor.startScan({ sourceId: "fixture-agent" });
    expect(resumed.jobId).toBe(started.jobId);
    expect(executor.scanStatus().running).toBe(true);
    releaseSecondMessage?.();
    await waitForScan(executor);
    expect(executor.scanStatus()).toMatchObject({
      running: false,
      jobId: started.jobId,
      progress: { phase: "done" },
      error: null
    });
    expect(addMemory).toHaveBeenCalledTimes(1);
  });

  it("cancels a paused standalone scan and clears its progress", async () => {
    const root = tempRoot();
    const adapter: SourceAdapter = {
      descriptor: {
        sourceId: "fixture-agent",
        displayName: "Fixture Agent",
        builtin: true,
        dataPath: join(root, "history")
      },
      detect: async () => true,
      async *scan(options) {
        options.onProgress?.({ sourceId: "fixture-agent", phase: "scan", current: 1, total: 2 });
        yield fixtureMessage("user", "user-canceled", "2026-08-28T01:00:00.000Z");
        if (options.signal?.aborted) throw options.signal.reason;
        await new Promise<void>((_resolve, reject) => {
          options.signal?.addEventListener("abort", () => reject(options.signal?.reason), { once: true });
        });
      }
    };
    const executor = createAgentSourceExecutor({
      service: { withAgentSourceScanPermit: withUnrestrictedScanPermit,
        addMemory: vi.fn(),
        enqueuePendingImportSummaries: vi.fn()
      } as unknown as MemoryService,
      configPath: join(root, "config.yaml"),
      statePath: join(root, "agent-sources.json"),
      sourceRegistry: createSourceRegistry([adapter])
    });

    await executor.startScan({ sourceId: "fixture-agent" });
    await waitForProgress(executor);
    await executor.pauseScan();
    await executor.cancelScan();
    expect(executor.scanStatus()).toMatchObject({
      running: false, status: "cancelled", jobId: expect.any(String), attemptId: expect.any(String),
      version: { generation: expect.any(Number), sequence: expect.any(Number) }, progress: null,
      completedAt: null, error: null
    });
  });

  it("owns startup and recurring scans in the Memory process", async () => {
    // Control scheduling deadlines while adapter/filesystem event-loop work stays real.
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
    const root = tempRoot();
    const configPath = join(root, "config.yaml");
    writeFileSync(configPath, [
      "memmyMemory:",
      "  agentAccess:",
      "    autoScanKnownAgents: true",
      "    watchFileChanges: true",
      "    autoInjectSkill: false",
      ""
    ].join("\n"));
    let sequence = 0;
    const adapter: SourceAdapter = {
      descriptor: {
        sourceId: "fixture-agent",
        displayName: "Fixture Agent",
        builtin: true,
        dataPath: join(root, "history")
      },
      // Adapter I/O can span multiple event-loop turns without advancing scan deadlines.
      detect: () => new Promise<boolean>((resolve) => {
        setImmediate(() => setImmediate(() => resolve(true)));
      }),
      async *scan() {
        sequence += 1;
        yield {
          messageId: `user-${sequence}`,
          sourceId: "fixture-agent",
          conversationId: `conversation-${sequence}`,
          role: "user",
          content: `Remember ${sequence}`,
          createdAt: `2026-08-28T01:0${sequence}:00.000Z`,
          workspacePath: null,
          gitRoot: null,
          rawMeta: {}
        };
        yield {
          messageId: `assistant-${sequence}`,
          sourceId: "fixture-agent",
          conversationId: `conversation-${sequence}`,
          role: "assistant",
          content: "Done",
          createdAt: `2026-08-28T01:0${sequence}:30.000Z`,
          workspacePath: null,
          gitRoot: null,
          rawMeta: {}
        };
      }
    };
    const addMemory = vi.fn(() => ({ id: `memory-${sequence}` }));
    const enqueuePendingImportSummaries = vi.fn();
    const scheduleWorker = vi.fn();
    const executor = createAgentSourceExecutor({
      service: { withAgentSourceScanPermit: withUnrestrictedScanPermit, addMemory, enqueuePendingImportSummaries } as unknown as MemoryService,
      configPath,
      statePath: join(root, "agent-sources.json"),
      sourceRegistry: createSourceRegistry([adapter]),
      initialScanDelayMs: 10,
      scheduledScanIntervalMs: 100,
      scheduleWorker
    });

    try {
      executor.startAutomation();
      await vi.advanceTimersByTimeAsync(9);
      expect(addMemory).not.toHaveBeenCalled();

      await vi.advanceTimersByTimeAsync(1);
      await waitForFakeTimerScan(executor);
      expect(addMemory).toHaveBeenCalledTimes(1);
      expect(enqueuePendingImportSummaries).toHaveBeenLastCalledWith(1_000, ["memory-1"]);
      expect(scheduleWorker).toHaveBeenCalledTimes(1);

      await vi.advanceTimersByTimeAsync(99);
      expect(addMemory).toHaveBeenCalledTimes(1);
      await vi.advanceTimersByTimeAsync(1);
      await waitForFakeTimerScan(executor);
      expect(addMemory).toHaveBeenCalledTimes(2);
      expect(enqueuePendingImportSummaries).toHaveBeenLastCalledWith(1_000, ["memory-2"]);
      expect(scheduleWorker).toHaveBeenCalledTimes(2);
    } finally {
      await executor.dispose();
    }
  });

  it("emits memory_desktop add analytics for standalone scan writes", async () => {
    const events: Array<{ name: string; payload: Record<string, unknown> }> = [];
    const root = tempRoot();
    const addMemory = vi.fn(() => ({ id: "memory-1", duplicate: false }));
    const executor = createAgentSourceExecutor({
      service: { withAgentSourceScanPermit: withUnrestrictedScanPermit,
        addMemory,
        enqueuePendingImportSummaries: vi.fn()
      } as unknown as MemoryService,
      configPath: join(root, "config.yaml"),
      statePath: join(root, "agent-sources.json"),
      sourceRegistry: createSourceRegistry([createFixtureAdapter(root)]),
      memoryAddAnalytics: createAddAnalyticsRecorder(events)
    });

    await executor.startScan({ sourceId: "fixture-agent", mode: "initial_subset" });
    await waitForScan(executor);
    expect(executor.scanStatus().error).toBeNull();

    expect(addMemory).toHaveBeenCalledTimes(1);
    expect(events.map((event) => event.name)).toEqual(["started", "succeeded"]);
    expect(events[0]?.payload).toMatchObject({
      adapterId: "agent-source:fixture-agent",
      conversationId: "conversation-1",
      scanMode: "initial_subset"
    });
    expect(events[1]?.payload).toMatchObject({
      adapterId: "agent-source:fixture-agent",
      conversationId: "conversation-1",
      scanMode: "initial_subset",
      storedCount: 1
    });
    expect(typeof events[0]?.payload.turnId).toBe("string");
    expect(typeof events[1]?.payload.durationMs).toBe("number");
    await executor.dispose();
  });

  it("emits add_failed analytics when a standalone scan write throws", async () => {
    const events: Array<{ name: string; payload: Record<string, unknown> }> = [];
    const root = tempRoot();
    const executor = createAgentSourceExecutor({
      service: { withAgentSourceScanPermit: withUnrestrictedScanPermit,
        addMemory: vi.fn(() => {
          throw new Error("write failed");
        }),
        enqueuePendingImportSummaries: vi.fn()
      } as unknown as MemoryService,
      configPath: join(root, "config.yaml"),
      statePath: join(root, "agent-sources.json"),
      sourceRegistry: createSourceRegistry([createFixtureAdapter(root)]),
      memoryAddAnalytics: createAddAnalyticsRecorder(events)
    });

    await executor.startScan({ sourceId: "fixture-agent", mode: "incremental" });
    await waitForScan(executor);

    expect(events.map((event) => event.name)).toEqual(["started", "failed"]);
    expect(events[1]?.payload).toMatchObject({
      adapterId: "agent-source:fixture-agent",
      conversationId: "conversation-1",
      scanMode: "incremental"
    });
    expect(events[1]?.payload.error).toBeInstanceOf(Error);
    await executor.dispose();
  });

  it("does not emit add analytics when a standalone scan write is a duplicate", async () => {
    const events: Array<{ name: string; payload: Record<string, unknown> }> = [];
    const root = tempRoot();
    const addMemory = vi.fn(() => ({ id: "memory-1", duplicate: true }));
    const executor = createAgentSourceExecutor({
      service: { withAgentSourceScanPermit: withUnrestrictedScanPermit,
        addMemory,
        enqueuePendingImportSummaries: vi.fn()
      } as unknown as MemoryService,
      configPath: join(root, "config.yaml"),
      statePath: join(root, "agent-sources.json"),
      sourceRegistry: createSourceRegistry([createFixtureAdapter(root)]),
      memoryAddAnalytics: createAddAnalyticsRecorder(events)
    });

    await executor.startScan({ sourceId: "fixture-agent", mode: "full" });
    await waitForScan(executor);

    expect(addMemory).toHaveBeenCalledTimes(1);
    expect(events).toEqual([]);
    await executor.dispose();
  });

  it("does not emit add analytics for unselected older standalone scan turns", async () => {
    const events: Array<{ name: string; payload: Record<string, unknown> }> = [];
    const root = tempRoot();
    const addMemory = vi.fn(() => ({ id: "memory-1", duplicate: false }));
    const turns = [
      completeTurn("conversation-old", "2026-08-28T01:00:00.000Z"),
      completeTurn("conversation-new", "2026-08-28T02:00:00.000Z")
    ];
    const executor = createAgentSourceExecutor({
      service: { withAgentSourceScanPermit: withUnrestrictedScanPermit,
        addMemory,
        enqueuePendingImportSummaries: vi.fn()
      } as unknown as MemoryService,
      configPath: join(root, "config.yaml"),
      statePath: join(root, "agent-sources.json"),
      sourceRegistry: createSourceRegistry([createFixtureAdapter(root, turns)]),
      memoryAddAnalytics: createAddAnalyticsRecorder(events)
    });

    await executor.startScan({ sourceId: "fixture-agent", mode: "incremental" });
    await waitForScan(executor);
    expect(events.filter((event) => event.name === "started")).toHaveLength(2);
    events.length = 0;

    await executor.startScan({ sourceId: "fixture-agent", mode: "incremental" });
    await waitForScan(executor);

    expect(events).toEqual([]);
    expect(addMemory).toHaveBeenCalledTimes(2);
    turns.push(completeTurn("conversation-latest", "2026-08-28T03:00:00.000Z"));
    await executor.startScan({ sourceId: "fixture-agent", mode: "incremental" });
    await waitForScan(executor);
    expect(events.map((event) => event.payload.conversationId)).toEqual([
      "conversation-latest",
      "conversation-latest"
    ]);
    await executor.dispose();
  });

  it("imports skills from a discovered Agent into the same Memory service", async () => {
    const root = tempRoot();
    const codexRoot = join(root, ".codex");
    const skillPath = join(codexRoot, "skills", "sample", "SKILL.md");
    mkdirSync(join(skillPath, ".."), { recursive: true });
    writeFileSync(skillPath, "---\nname: sample-skill\nversion: 1\n---\n\nUse the sample procedure.\n");
    vi.stubEnv("CODEX_HOME", codexRoot);
    const addMemory = vi.fn(() => ({ id: "skill-memory-1" }));
    const service = { withAgentSourceScanPermit: withUnrestrictedScanPermit,
      addMemory,
      enqueuePendingImportSummaries: vi.fn()
    } as unknown as MemoryService;
    const adapter: SourceAdapter = {
      descriptor: { sourceId: "codex", displayName: "Codex", builtin: true, dataPath: codexRoot },
      detect: async () => true,
      async *scan() {}
    };
    const executor = createAgentSourceExecutor({
      service,
      configPath: join(root, "config.yaml"),
      statePath: join(root, "agent-sources.json"),
      sourceRegistry: createSourceRegistry([adapter])
    });

    await executor.startScan({ sourceId: "codex" });
    await waitForScan(executor);

    expect(addMemory).toHaveBeenCalledWith(expect.objectContaining({
      layer: "Skill",
      source: "codex",
      sourceAgentId: "codex",
      sourceSkillId: "sample",
      sourceSkillPath: skillPath,
      title: "sample-skill"
    }));
  });

  it("emits add analytics only when a scanned skill is newly stored", async () => {
    const root = tempRoot();
    const codexRoot = join(root, ".codex");
    for (const sourceSkillId of ["deleted-skill", "duplicate-skill", "failing-skill", "fresh-skill"]) {
      const skillPath = join(codexRoot, "skills", sourceSkillId, "SKILL.md");
      mkdirSync(join(skillPath, ".."), { recursive: true });
      writeFileSync(skillPath, `---\nname: ${sourceSkillId}\nversion: 1\n---\n\n${sourceSkillId}\n`);
    }
    vi.stubEnv("CODEX_HOME", codexRoot);
    const events: Array<{ name: string; payload: Record<string, unknown> }> = [];
    const service = { withAgentSourceScanPermit: withUnrestrictedScanPermit,
      addMemory: vi.fn((input: { sourceSkillId?: string }) => {
        if (input.sourceSkillId === "duplicate-skill") return { id: "dup", duplicate: true, status: "activated" };
        if (input.sourceSkillId === "deleted-skill") return { id: "gone", status: "deleted" };
        if (input.sourceSkillId === "failing-skill") throw new Error("skill import failed");
        return { id: "fresh", status: "activated" };
      }),
      enqueuePendingImportSummaries: vi.fn()
    } as unknown as MemoryService;
    const adapter: SourceAdapter = {
      descriptor: { sourceId: "codex", displayName: "Codex", builtin: true, dataPath: codexRoot },
      detect: async () => true,
      async *scan() {}
    };
    const executor = createAgentSourceExecutor({
      service,
      configPath: join(root, "config.yaml"),
      statePath: join(root, "agent-sources.json"),
      sourceRegistry: createSourceRegistry([adapter]),
      memoryAddAnalytics: {
        trackAddStarted(input) { events.push({ name: "started", payload: { ...input } }); },
        trackAddSucceeded(input) { events.push({ name: "succeeded", payload: { ...input } }); },
        trackAddFailed(input) { events.push({ name: "failed", payload: { ...input } }); }
      }
    });

    await executor.startScan({ sourceId: "codex", mode: "incremental" });
    await waitForScan(executor);

    expect(events.map((event) => event.name)).toEqual(["started", "failed", "started", "succeeded"]);
    expect(events[1]?.payload).toMatchObject({
      adapterId: "agent-source:codex",
      conversationId: "skill:failing-skill",
      layer: "Skill",
      scanMode: "incremental"
    });
    expect(events[3]?.payload).toMatchObject({
      adapterId: "agent-source:codex",
      conversationId: "skill:fresh-skill",
      layer: "Skill",
      scanMode: "incremental",
      storedCount: 1
    });
    await executor.dispose();
  });

  it("installs and removes a real Cursor Hook without Memmy Desktop", async () => {
    const root = tempRoot();
    const cursorRoot = join(root, ".cursor");
    mkdirSync(cursorRoot, { recursive: true });
    const configPath = join(root, "config.yaml");
    const statePath = join(root, "agent-sources.json");
    writeFileSync(configPath, "memmyMemory:\n  storage:\n    endpoint: http://127.0.0.1:18960\n");
    const adapter: SourceAdapter = {
      descriptor: { sourceId: "cursor", displayName: "Cursor", builtin: true, dataPath: cursorRoot },
      detect: async () => true,
      async *scan() {}
    };
    const service = { withAgentSourceScanPermit: withUnrestrictedScanPermit,
      addMemory: vi.fn(),
      enqueuePendingImportSummaries: vi.fn()
    } as unknown as MemoryService;
    const executor = createAgentSourceExecutor({
      service,
      configPath,
      statePath,
      sourceRegistry: createSourceRegistry([adapter]),
      integrationRegistry: createSkillTargetRegistry([
        createCursorSkillTarget({ rootDirectory: cursorRoot, memmyConfigPath: configPath })
      ])
    });

    await executor.mutateConnection("cursor", "plugin", "POST");
    expect(readFileSync(join(cursorRoot, "hooks.json"), "utf8")).toContain("memmy-resume-hook.mjs");
    expect(readFileSync(join(cursorRoot, "hooks", "memmy-resume-hook.mjs"), "utf8")).toContain("const SOURCE = \"cursor\"");
    expect((await executor.list()).sources[0]?.status).toBe("plugin_installed");

    await executor.mutateConnection("cursor", "plugin", "DELETE");
    expect(readFileSync(join(cursorRoot, "hooks.json"), "utf8")).not.toContain("memmy-resume-hook.mjs");
    expect((await executor.list()).sources[0]?.status).toBe("not_connected");
    expect(JSON.parse(readFileSync(statePath, "utf8")).sources.cursor.autoInjectSuppressed).toBe(true);

    await executor.mutateConnection("cursor", "plugin", "POST", "auto_inject");
    expect(JSON.parse(readFileSync(statePath, "utf8")).sources.cursor.autoInjectSuppressed).toBe(true);
    await executor.mutateConnection("cursor", "plugin", "DELETE");
    await executor.mutateConnection("cursor", "plugin", "POST", "manual");
    expect(JSON.parse(readFileSync(statePath, "utf8")).sources.cursor.autoInjectSuppressed).toBeUndefined();
  });

  it("removes a hook when manual uninstall races with standalone auto injection", async () => {
    const root = tempRoot();
    const codexRoot = join(root, ".codex");
    mkdirSync(codexRoot, { recursive: true });
    const configPath = join(root, "config.yaml");
    const statePath = join(root, "agent-sources.json");
    writeFileSync(configPath, JSON.stringify({ memmyMemory: {
      agentAccess: { autoScanKnownAgents: true, watchFileChanges: false, autoInjectSkill: true },
    } }));
    let executor!: ReturnType<typeof createAgentSourceExecutor>;
    let autoInstallFinished = false;
    let hookPresent = false;
    const target: SkillTarget = {
      targetId: "codex",
      displayName: "Codex",
      async resolveRootDirectory() { return codexRoot; },
      async install() {},
      async uninstall() {},
      async isInstalled() { return hookPresent; },
      async installPlugin() {
        await executor.mutateConnection("codex", "plugin", "DELETE");
        hookPresent = true;
        autoInstallFinished = true;
      },
      async uninstallPlugin() { hookPresent = false; },
    };
    const adapter: SourceAdapter = {
      descriptor: { sourceId: "codex", displayName: "Codex", builtin: true, dataPath: codexRoot },
      detect: async () => true,
      async *scan() {},
    };
    executor = createAgentSourceExecutor({
      service: {} as MemoryService,
      configPath,
      statePath,
      initialScanDelayMs: 0,
      sourceRegistry: createSourceRegistry([adapter]),
      integrationRegistry: createSkillTargetRegistry([target]),
    });

    try {
      executor.startAutomation();
      await vi.waitFor(() => expect(autoInstallFinished).toBe(true));
      await vi.waitFor(() => expect(hookPresent).toBe(false));
      expect((await executor.list()).sources[0]?.status).toBe("not_connected");
      expect(JSON.parse(readFileSync(statePath, "utf8")).sources.codex.autoInjectSuppressed).toBe(true);
    } finally {
      await executor.dispose();
    }
  });
});

async function waitForScan(executor: ReturnType<typeof createAgentSourceExecutor>): Promise<void> {
  for (let attempt = 0; attempt < 10_000; attempt += 1) {
    if (!executor.scanStatus().running) return;
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
  throw new Error("scan did not complete");
}

async function waitForProgress(executor: ReturnType<typeof createAgentSourceExecutor>): Promise<void> {
  for (let attempt = 0; attempt < 100; attempt += 1) {
    if (executor.scanStatus().progress) return;
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
  throw new Error("scan did not report progress");
}

function createAddAnalyticsRecorder(
  events: Array<{ name: string; payload: Record<string, unknown> }>
) {
  return {
    trackAddStarted(input: Record<string, unknown>) {
      events.push({ name: "started", payload: input });
    },
    trackAddSucceeded(input: Record<string, unknown>) {
      events.push({ name: "succeeded", payload: input });
    },
    trackAddFailed(input: Record<string, unknown>) {
      events.push({ name: "failed", payload: input });
    }
  };
}

function completeTurn(conversationId: string, createdAt: string) {
  const assistantAt = new Date(Date.parse(createdAt) + 60_000).toISOString();
  return [
    {
      messageId: `${conversationId}-user`,
      sourceId: "fixture-agent",
      conversationId,
      role: "user" as const,
      content: "Remember this",
      createdAt,
      workspacePath: null,
      gitRoot: null,
      rawMeta: {}
    },
    {
      messageId: `${conversationId}-assistant`,
      sourceId: "fixture-agent",
      conversationId,
      role: "assistant" as const,
      content: "Done",
      createdAt: assistantAt,
      workspacePath: null,
      gitRoot: null,
      rawMeta: {}
    }
  ];
}

function createFixtureAdapter(
  root: string,
  turns: Array<ReturnType<typeof completeTurn>> = [completeTurn("conversation-1", "2026-08-28T01:00:00.000Z")]
): SourceAdapter {
  return {
    descriptor: {
      sourceId: "fixture-agent",
      displayName: "Fixture Agent",
      builtin: true,
      dataPath: join(root, "history")
    },
    detect: async () => true,
    async *scan() {
      for (const turn of turns) {
        yield* turn;
      }
    }
  };
}

function fixtureMessage(
  role: "user" | "assistant",
  messageId: string,
  createdAt: string
) {
  return {
    messageId,
    sourceId: "fixture-agent",
    conversationId: "conversation-paused",
    role,
    content: role === "user" ? "Remember this" : "Done",
    createdAt,
    workspacePath: null,
    gitRoot: null,
    rawMeta: {}
  } as const;
}

async function waitForFakeTimerScan(executor: ReturnType<typeof createAgentSourceExecutor>): Promise<void> {
  for (let attempt = 0; attempt < 200; attempt += 1) {
    if (!executor.scanStatus().running) return;
    // Filesystem promises need real event-loop time. Advancing the fake clock
    // alone races disk IO and can also trigger the next scheduled scan.
    await waitForIO(10);
    await vi.advanceTimersByTimeAsync(0);
  }
  throw new Error("automatic scan did not complete");
}

function tempRoot(): string {
  const root = mkdtempSync(join(tmpdir(), "memmy-agent-source-runtime-"));
  roots.push(root);
  return root;
}
