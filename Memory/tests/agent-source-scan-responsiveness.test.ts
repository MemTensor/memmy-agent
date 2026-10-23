import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { createAgentSourceExecutor } from "../src/agent-source/runtime.js";
import { createSourceRegistry } from "../src/agent-source/adapters/source-registry.js";
import type { ConversationMessage, SourceAdapter } from "../src/agent-source/adapters/types.js";
import * as scanStore from "../src/agent-source/scan-store.js";
import { closeMemoryHttpServer, listenMemoryHttpServer } from "../src/server/http.js";
import type { MemoryService } from "../src/service/memory-service.js";

const roots: string[] = [];
afterEach(() => {
  vi.restoreAllMocks();
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

const TURN_COUNT = 4_000;
// Reaching a phase includes discovery, staging and SQLite preparation. It is
// setup work, not the HTTP responsiveness guarantee exercised once we get there.
const PHASE_SETUP_TIMEOUT_MS = 10_000;
const HTTP_RESPONSE_TIMEOUT_MS = 2_000;

describe("standalone scan HTTP responsiveness", () => {
  it.each([
    { phase: "stage", shape: "native", discoveryDelayMs: 0 },
    { phase: "prepare", shape: "native", discoveryDelayMs: 0 },
    { phase: "ingest", shape: "native", discoveryDelayMs: 0 },
    { phase: "ingest", shape: "native", discoveryDelayMs: 1_200 },
    { phase: "ingest", shape: "incomplete", discoveryDelayMs: 0 },
    { phase: "ingest", shape: "long_turn", discoveryDelayMs: 0 },
  ] as const)("serves health and cancellation during $phase of $shape history (discovery delay: $discoveryDelayMs ms)", async ({ phase, shape, discoveryDelayMs }) => {
    const root = tempRoot();
    let requestDuringScan!: () => Promise<void>;
    let check!: Promise<void>;
    let lastPhase = "discovery";
    let closeObserved = false;
    const originalOpen = scanStore.openMemoryAgentSourceScanStore;
    vi.spyOn(scanStore, "openMemoryAgentSourceScanStore").mockImplementation(async (...args) => {
      const store = await originalOpen(...args);
      const saveMeta = store.saveMeta;
      let requested = false;
      store.saveMeta = (meta) => {
        saveMeta(meta);
        lastPhase = meta.phase;
        if (meta.phase === phase && !requested) {
          requested = true;
          check = new Promise<void>((resolve, reject) => {
            setTimeout(() => { void requestDuringScan().then(resolve, reject); }, 0);
          });
          // Attach a handler while the scan continues to avoid an unhandled rejection.
          void check.catch(() => undefined);
        }
      };
      const close = store.close;
      store.close = () => { close(); closeObserved = true; };
      return store;
    });
    const completeSourceTurn = vi.fn(() => ({ status: "existing" }));
    const addMemory = vi.fn(() => ({ id: "synthetic-memory" }));
    const executor = createAgentSourceExecutor({
      service: { completeSourceTurn, addMemory, enqueuePendingImportSummaries: vi.fn() } as unknown as MemoryService,
      configPath: join(root, "config.yaml"),
      scanStoreDirectory: join(root, "scans"),
      sourceRegistry: createSourceRegistry([{
        ...syntheticAdapter(root, shape),
        detect: async () => {
          if (discoveryDelayMs) await new Promise((done) => setTimeout(done, discoveryDelayMs));
          return true;
        },
      }]),
      resolveAgentSkillRoot: () => null,
    });
    const { server, url } = await listenMemoryHttpServer({
      service: {
        health: () => ({ ok: true, scanRunning: executor.scanStatus().running }),
        setAppBudgetReconcileListener: () => undefined,
        setPersistRecoveredListener: () => undefined,
      } as unknown as MemoryService,
      agentSourceExecutor: executor,
      auth: { allowAnonymous: true },
      workerStartupFallbackMs: 60_000,
      workerPostHealthDelayMs: 60_000,
      host: "127.0.0.1",
      port: 0,
    });
    requestDuringScan = async () => {
      const response = await fetch(`${url}/api/v1/health`, { signal: AbortSignal.timeout(HTTP_RESPONSE_TIMEOUT_MS) });
      expect(response.status).toBe(200);
      expect(await response.json()).toMatchObject({ ok: true, scanRunning: true });
      const cancel = await fetch(`${url}/api/v1/agent-sources/scan/cancel`, {
        method: "POST",
        signal: AbortSignal.timeout(HTTP_RESPONSE_TIMEOUT_MS),
        headers: { "x-memmy-viewer": "1", "content-type": "application/json" },
        body: "{}",
      });
      expect(cancel.status).toBe(200);
      expect(executor.scanStatus()).toMatchObject({ running: false, status: "cancelled", jobId: expect.any(String), attemptId: expect.any(String) });
    };
    try {
      const { jobId } = await executor.startScan({ sourceId: "codex", mode: "full" });
      await vi.waitFor(() => {
        expect(check, `Waiting for ${phase}; last phase: ${lastPhase}; scan: ${JSON.stringify(executor.scanStatus())}`).toBeDefined();
      }, { timeout: PHASE_SETUP_TIMEOUT_MS });
      await check;
      await executor.dispose();
      expect(completeSourceTurn.mock.calls.length).toBeLessThan(TURN_COUNT);
      if (phase === "prepare" || shape !== "native") expect(completeSourceTurn).not.toHaveBeenCalled();
      if (shape !== "native") expect(addMemory).not.toHaveBeenCalled();
      expect(closeObserved).toBe(true);
      expect(existsSync(join(root, "scans", `${jobId}.sqlite`))).toBe(false);
    } finally {
      await closeMemoryHttpServer(server);
    }
  }, PHASE_SETUP_TIMEOUT_MS + 2 * HTTP_RESPONSE_TIMEOUT_MS + 1_000);

  it("does not write skills or replace progress after its job is cancelled", async () => {
    const root = tempRoot();
    const skillRoot = join(root, "agent");
    mkdirSync(join(skillRoot, "skills", "synthetic"), { recursive: true });
    writeFileSync(join(skillRoot, "skills", "synthetic", "SKILL.md"), "Synthetic fixture skill");
    let replacement!: Promise<{ accepted: true; jobId: string }>;
    let firstJob = true;
    const addMemory = vi.fn(() => ({ id: "synthetic-skill" }));
    const executor = createAgentSourceExecutor({
      service: { addMemory, enqueuePendingImportSummaries: vi.fn() } as unknown as MemoryService,
      configPath: join(root, "config.yaml"),
      scanStoreDirectory: join(root, "scans"),
      sourceRegistry: createSourceRegistry([{
        descriptor: { sourceId: "codex", displayName: "Synthetic Codex", builtin: true, dataPath: root },
        detect: async () => true,
        async *scan() {},
      }]),
      resolveAgentSkillRoot: () => {
        if (!firstJob) return null;
        firstJob = false;
        const cancellation = executor.cancelScan();
        replacement = executor.startScan({ sourceId: "codex", mode: "full" }).then(
          () => { throw new Error("replacement must wait for cancellation"); },
          async (error: unknown) => {
            expect(error).toMatchObject({ code: "conflict" });
            await cancellation;
            return executor.startScan({ sourceId: "codex", mode: "full" });
          }
        );
        return skillRoot;
      },
    });
    try {
      const first = await executor.startScan({ sourceId: "codex", mode: "full" });
      await vi.waitFor(() => expect(replacement).toBeDefined());
      const second = await replacement;
      expect(second.jobId).not.toBe(first.jobId);
      await vi.waitFor(() => expect(executor.scanStatus()).toMatchObject({ jobId: second.jobId, running: false, error: null }));
      expect(addMemory).not.toHaveBeenCalled();
      await executor.dispose();
      expect(existsSync(join(root, "scans", `${first.jobId}.sqlite`))).toBe(false);
    } finally {
      await executor.dispose();
    }
  });

  it("preserves a shutdown checkpoint and resumes the same initial subset job", async () => {
    const root = tempRoot();
    let stopping!: Promise<void>;
    let first!: ReturnType<typeof createAgentSourceExecutor>;
    let stopAtPrepare = true;
    const originalOpen = scanStore.openMemoryAgentSourceScanStore;
    vi.spyOn(scanStore, "openMemoryAgentSourceScanStore").mockImplementation(async (...args) => {
      const store = await originalOpen(...args);
      const saveMeta = store.saveMeta;
      store.saveMeta = (meta) => {
        saveMeta(meta);
        if (meta.phase === "prepare" && stopAtPrepare) {
          stopAtPrepare = false;
          stopping = Promise.resolve(first.dispose());
        }
      };
      return store;
    });
    const completeSourceTurn = vi.fn(() => ({ status: "existing" }));
    const create = () => createAgentSourceExecutor({
      service: { completeSourceTurn } as unknown as MemoryService,
      configPath: join(root, "config.yaml"),
      scanStoreDirectory: join(root, "scans"),
      sourceRegistry: createSourceRegistry([syntheticAdapter(root)]),
      resolveAgentSkillRoot: () => null,
    });
    first = create();
    let resumed: ReturnType<typeof createAgentSourceExecutor> | undefined;
    try {
      const initial = await first.startScan({ sourceId: "codex", mode: "initial_subset" });
      await vi.waitFor(() => expect(stopping).toBeDefined());
      await stopping;
      expect(completeSourceTurn).not.toHaveBeenCalled();
      expect(existsSync(join(root, "scans", `${initial.jobId}.sqlite`))).toBe(true);
      resumed = create();
      const recovery = resumed.scanStatus();
      expect(recovery.version!.generation).toBeGreaterThan(initial.version!.generation);
      expect(recovery.attemptId).toBe(initial.attemptId);
      expect(recovery.status).toBe("paused");
      const continued = await resumed.startScan({ sourceId: "codex", mode: "initial_subset", expectedExecution: { jobId: initial.jobId, attemptId: initial.attemptId } });
      expect(continued.jobId).toBe(initial.jobId);
      expect(continued.attemptId).toBe(initial.attemptId);
      await vi.waitFor(() => expect(resumed!.scanStatus().running).toBe(false), { timeout: 10_000 });
      expect(resumed.scanStatus().error).toBeNull();
      expect(completeSourceTurn).toHaveBeenCalledTimes(1_000);
    } finally {
      await first.dispose();
      await resumed?.dispose();
    }
  });

  it.each([
    { mode: "full", expectedTurns: TURN_COUNT },
    { mode: "initial_subset", expectedTurns: 1_000 },
  ] as const)("uses a fixed staged total and preserves $mode selection", async ({ mode, expectedTurns }) => {
    const root = tempRoot();
    const count = vi.fn();
    const originalOpen = scanStore.openMemoryAgentSourceScanStore;
    vi.spyOn(scanStore, "openMemoryAgentSourceScanStore").mockImplementation(async (...args) => {
      const store = await originalOpen(...args);
      const readCount = store.count;
      store.count = (sourceId) => { count(sourceId); return readCount(sourceId); };
      return store;
    });
    const completeSourceTurn = vi.fn((_request: Parameters<MemoryService["completeSourceTurn"]>[0]) => ({ status: "existing" }));
    const executor = createAgentSourceExecutor({
      service: { completeSourceTurn } as unknown as MemoryService,
      configPath: join(root, "config.yaml"),
      sourceRegistry: createSourceRegistry([syntheticAdapter(root)]),
      resolveAgentSkillRoot: () => null,
    });
    try {
      await executor.startScan({ sourceId: "codex", mode });
      await vi.waitFor(() => expect(executor.scanStatus().running).toBe(false), { timeout: 10_000 });
      expect(executor.scanStatus().error).toBeNull();
      expect(completeSourceTurn).toHaveBeenCalledTimes(expectedTurns);
      expect(completeSourceTurn.mock.calls[0]?.[0].sourceTurn.turnId).toBe(`turn-${TURN_COUNT - expectedTurns}`);
      expect(completeSourceTurn.mock.calls.at(-1)?.[0].sourceTurn.turnId).toBe(`turn-${TURN_COUNT - 1}`);
      expect(count.mock.calls.length).toBeLessThan(10);
    } finally {
      await executor.dispose();
    }
  });
});

function syntheticAdapter(root: string, shape: "native" | "incomplete" | "long_turn" = "native"): SourceAdapter {
  return {
    descriptor: { sourceId: "codex", displayName: "Synthetic Codex", builtin: true, dataPath: root },
    detect: async () => true,
    async *scan() {
      if (shape !== "native") {
        for (let index = 0; index < TURN_COUNT * 2; index += 1) {
          yield { sourceId: "codex", conversationId: "long-conversation", messageId: `message-${index}`,
            role: shape === "incomplete" || index === 0 ? "user" : "assistant", content: "Synthetic history",
            createdAt: new Date(Date.UTC(2099, 0, 1, 0, 0, index)).toISOString(), workspacePath: null, gitRoot: null, rawMeta: {},
          } satisfies ConversationMessage;
        }
        return;
      }
      for (let index = 0; index < TURN_COUNT; index += 1) {
        const turnId = `turn-${index}`;
        const conversationId = `conversation-${String(index).padStart(6, "0")}`;
        const at = new Date(Date.UTC(2099, 0, 1, 0, 0, index)).toISOString();
        const base = { sourceId: "codex", conversationId, createdAt: at, workspacePath: null, gitRoot: null };
        const rawMeta = { sourceTurnId: turnId, sourceTurnState: "complete" };
        yield { ...base, messageId: `u-${index}`, role: "user", content: "Synthetic question", rawMeta } satisfies ConversationMessage;
        yield { ...base, messageId: `a-${index}`, role: "assistant", content: "Synthetic answer", rawMeta: {
          ...rawMeta,
          sourceTurn: { source: "codex", profileId: "default", conversationId, turnId, startedAt: at, completedAt: at,
            completionEvidence: `synthetic:${turnId}`, query: "Synthetic question", answer: "Synthetic answer", status: "succeeded", toolCalls: [], toolResults: [] },
        } } satisfies ConversationMessage;
      }
    },
  };
}

function tempRoot(): string {
  const root = mkdtempSync(join(tmpdir(), "memmy-scan-responsiveness-"));
  roots.push(root);
  return root;
}
