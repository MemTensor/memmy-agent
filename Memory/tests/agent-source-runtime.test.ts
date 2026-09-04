import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  createAgentSourceExecutor,
  createBuiltinSourceRegistry
} from "../src/agent-source/runtime.js";
import type { SourceAdapter } from "../src/agent-source/adapters/types.js";
import { createSourceRegistry } from "../src/agent-source/adapters/source-registry.js";
import { createCursorSkillTarget } from "../src/agent-source/integration/cursor/index.js";
import { createSkillTargetRegistry } from "../src/agent-source/integration/target-registry.js";
import type { MemoryService } from "../src/service/memory-service.js";

const roots: string[] = [];

afterEach(() => {
  vi.useRealTimers();
  vi.unstubAllEnvs();
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

describe("standalone Agent source executor", () => {
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
    const service = { addMemory, enqueuePendingImportSummaries } as unknown as MemoryService;
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
      service: {
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
      service: {
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
      service: {
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
    expect(executor.scanStatus()).toEqual({
      running: false,
      jobId: null,
      sourceId: null,
      mode: null,
      progress: null,
      startedAt: null,
      completedAt: null,
      error: null
    });
  });

  it("owns startup and recurring scans in the Memory process", async () => {
    vi.useFakeTimers();
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
      detect: async () => true,
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
      service: { addMemory, enqueuePendingImportSummaries } as unknown as MemoryService,
      configPath,
      statePath: join(root, "agent-sources.json"),
      sourceRegistry: createSourceRegistry([adapter]),
      initialScanDelayMs: 10,
      scheduledScanIntervalMs: 100,
      scheduleWorker
    });

    executor.startAutomation();
    await vi.advanceTimersByTimeAsync(9);
    expect(addMemory).not.toHaveBeenCalled();

    await vi.advanceTimersByTimeAsync(1);
    await waitForFakeTimerScan(executor);
    expect(addMemory).toHaveBeenCalledTimes(1);
    expect(enqueuePendingImportSummaries).toHaveBeenLastCalledWith(1_000, ["memory-1"]);
    expect(scheduleWorker).toHaveBeenCalledTimes(1);

    await vi.advanceTimersByTimeAsync(100);
    await waitForFakeTimerScan(executor);
    expect(addMemory).toHaveBeenCalledTimes(2);
    expect(enqueuePendingImportSummaries).toHaveBeenLastCalledWith(1_000, ["memory-2"]);
    expect(scheduleWorker).toHaveBeenCalledTimes(2);
    executor.dispose();
  });

  it("imports skills from a discovered Agent into the same Memory service", async () => {
    const root = tempRoot();
    const codexRoot = join(root, ".codex");
    const skillPath = join(codexRoot, "skills", "sample", "SKILL.md");
    mkdirSync(join(skillPath, ".."), { recursive: true });
    writeFileSync(skillPath, "---\nname: sample-skill\nversion: 1\n---\n\nUse the sample procedure.\n");
    vi.stubEnv("CODEX_HOME", codexRoot);
    const addMemory = vi.fn(() => ({ id: "skill-memory-1" }));
    const service = {
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

  it("installs and removes a real Cursor Hook without Memmy Desktop", async () => {
    const root = tempRoot();
    const cursorRoot = join(root, ".cursor");
    mkdirSync(cursorRoot, { recursive: true });
    const configPath = join(root, "config.yaml");
    writeFileSync(configPath, "memmyMemory:\n  storage:\n    endpoint: http://127.0.0.1:18960\n");
    const adapter: SourceAdapter = {
      descriptor: { sourceId: "cursor", displayName: "Cursor", builtin: true, dataPath: cursorRoot },
      detect: async () => true,
      async *scan() {}
    };
    const service = {
      addMemory: vi.fn(),
      enqueuePendingImportSummaries: vi.fn()
    } as unknown as MemoryService;
    const executor = createAgentSourceExecutor({
      service,
      configPath,
      statePath: join(root, "agent-sources.json"),
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
  });
});

async function waitForScan(executor: ReturnType<typeof createAgentSourceExecutor>): Promise<void> {
  for (let attempt = 0; attempt < 100; attempt += 1) {
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
  for (let attempt = 0; attempt < 100; attempt += 1) {
    if (!executor.scanStatus().running) return;
    await vi.advanceTimersByTimeAsync(1);
  }
  throw new Error("automatic scan did not complete");
}

function tempRoot(): string {
  const root = mkdtempSync(join(tmpdir(), "memmy-agent-source-runtime-"));
  roots.push(root);
  return root;
}
