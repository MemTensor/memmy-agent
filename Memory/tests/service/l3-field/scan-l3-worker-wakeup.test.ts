import { mkdirSync } from "node:fs";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { DEFAULT_MEMMY_CONFIG, MemoryDb } from "../../../src/index.js";
import { createAgentSourceExecutor } from "../../../src/agent-source/runtime.js";
import { createSourceRegistry } from "../../../src/agent-source/adapters/source-registry.js";
import { Repositories } from "../../../src/storage/repositories.js";
import type { SourceTurnCompleteRequest } from "../../../src/types.js";
import { createBatchReflectionLlm, createMemoryServiceFixture } from "../../fixtures/memory-service-fixture.js";

const fixture = createMemoryServiceFixture();
afterEach(() => fixture.cleanup());

function turn(index: number, workspacePath: string): SourceTurnCompleteRequest {
  const minute = String(index).padStart(2, "0");
  return {
    namespace: { source: "codex", profileId: "default", userId: "wakeup-user" },
    source: "codex", channel: "agent_source_scan", workspacePath,
    sourceTurn: {
      source: "codex", profileId: "default", conversationId: "closed-wakeup", turnId: `closed-turn-${index}`,
      startedAt: `2099-01-01T10:${minute}:00.000Z`, completedAt: `2099-01-01T10:${minute}:30.000Z`,
      sequence: index, completionEvidence: `task_complete:${index}`
    },
    query: `Run project checks, step ${index}.`, answer: "The checks passed.", toolCalls: [], toolResults: []
  };
}

async function harness() {
  const root = fixture.createTestRoot("scan-l3-wakeup-");
  const home = join(root, "home");
  const project = join(home, "code", "demo");
  mkdirSync(project, { recursive: true });
  const db = new MemoryDb({ path: join(root, "memory.sqlite") });
  const config = structuredClone(DEFAULT_MEMMY_CONFIG);
  config.userId = "wakeup-user";
  config.algorithm.l3FieldCognition.enabled = false;
  config.algorithm.session.turnJudge = false;
  const reload = { config };
  const service = fixture.createTestMemoryService({
    db, mode: "dev", config, llm: createBatchReflectionLlm([]), configLoader: () => ({ config: reload.config }),
    l3FieldEnvironment: () => ({ machineId: "8".repeat(64), homeDir: home, tempRoots: [] })
  });
  const repos = new Repositories(db.db);
  const old = turn(1, project);
  const first = await service.completeSourceTurn(old);
  expect(first.status).toBe("stored");
  const sessionId = first.result!.sessionId;
  repos.runtime.closeSession(sessionId, "2099-01-01T10:05:00.000Z");
  reload.config = structuredClone(config);
  reload.config.algorithm.l3FieldCognition.enabled = true;
  service.reloadConfig({ restartFailedProcessing: false });
  const batches = () => repos.db.prepare(`SELECT COUNT(*) AS n FROM l3_unit_batches`).get() as { n: number };
  return { root, project, db, service, repos, sessionId, old, pending: turn(2, project), batches };
}

describe("recovered closed scan worker wakeup", () => {
  it("signals committed recovery even when the current turn stays pending, without signaling conflicts or repeats", async () => {
    const h = await harness();
    const onEvolutionScheduled = vi.fn(() => {
      expect(h.db.db.inTransaction).toBe(false);
      expect(h.batches()).toEqual({ n: 1 });
    });
    const existingListener = vi.fn();
    h.service.setCapturePendingListener(existingListener);
    expect(await h.service.completeSourceTurn({ ...h.old, answer: "A conflicting answer." }, onEvolutionScheduled))
      .toEqual({ status: "conflict", reason: "source_turn_content_conflict" });
    expect(onEvolutionScheduled).not.toHaveBeenCalled();
    expect(h.batches()).toEqual({ n: 0 });
    expect(await h.service.completeSourceTurn(h.pending, onEvolutionScheduled))
      .toEqual({ status: "pending", reason: "source_session_closed" });
    expect(onEvolutionScheduled).toHaveBeenCalledTimes(1);
    expect(await h.service.completeSourceTurn(h.pending, onEvolutionScheduled))
      .toEqual({ status: "pending", reason: "source_session_closed" });
    expect(onEvolutionScheduled).toHaveBeenCalledTimes(1);
    expect(existingListener).toHaveBeenCalledTimes(3);
    expect(h.batches()).toEqual({ n: 1 });
    expect(h.repos.runtime.getSession(h.sessionId)!.status).toBe("closed");
    expect(h.repos.db.prepare(`SELECT COUNT(*) AS n FROM raw_turns`).get()).toEqual({ n: 1 });
  });

  it("does not publish an inner recovery notification when outer acceptance rolls back", async () => {
    const h = await harness();
    const onEvolutionScheduled = vi.fn();
    const sessionTurns = h.service["sessionTurns"];
    const withEpisodeSelection = sessionTurns.withEpisodeSelection.bind(sessionTurns);
    const acceptance = vi.spyOn(sessionTurns, "withEpisodeSelection").mockImplementationOnce((context, operation) =>
      withEpisodeSelection(context, () => {
        operation();
        expect(h.batches()).toEqual({ n: 1 });
        throw new Error("simulated outer acceptance rollback");
      }));
    await expect(h.service.completeSourceTurn(h.pending, onEvolutionScheduled)).rejects.toThrow("simulated outer acceptance rollback");
    expect(onEvolutionScheduled).not.toHaveBeenCalled();
    expect(h.batches()).toEqual({ n: 0 });
    expect(h.repos.runtime.getSession(h.sessionId)!.meta.l3_world_model_protocol_version).toBeUndefined();
    expect(h.repos.l3WorldModels.listInputTracesInRange(h.sessionId, 0, 100)).toHaveLength(0);
    acceptance.mockRestore();
    expect(await h.service.completeSourceTurn(h.pending, onEvolutionScheduled))
      .toEqual({ status: "pending", reason: "source_session_closed" });
    expect(onEvolutionScheduled).toHaveBeenCalledTimes(1);
  });

  it("wakes an independent executor once before its pending branch and stays idle on replay", async () => {
    const h = await harness();
    const native = { ...h.pending.sourceTurn, query: h.pending.query, answer: h.pending.answer,
      status: "succeeded" as const, toolCalls: [], toolResults: [] };
    const scheduleWorker = vi.fn(() => {
      expect(h.db.db.inTransaction).toBe(false);
      expect(h.batches()).toEqual({ n: 1 });
    });
    const complete = vi.spyOn(h.service, "completeSourceTurn");
    const executor = createAgentSourceExecutor({
      service: h.service, configPath: join(h.root, "config.yaml"), statePath: join(h.root, "source-state.json"),
      resolveAgentSkillRoot: () => null, scheduleWorker,
      sourceRegistry: createSourceRegistry([{
        descriptor: { sourceId: "codex", displayName: "fixture", builtin: true, dataPath: h.root },
        async detect() { return true; },
        async *scan() {
          for (const role of ["user", "assistant"] as const) yield {
            sourceId: "codex", conversationId: native.conversationId, messageId: `pending-${role}`, role,
            content: role === "user" ? native.query : native.answer,
            createdAt: role === "user" ? native.startedAt : native.completedAt,
            workspacePath: h.project, gitRoot: null,
            rawMeta: { sourceTurnState: "complete", sourceTurnId: native.turnId, sourceTurn: native }
          };
        }
      }])
    });
    try {
      await executor.startScan({ sourceId: "codex", mode: "incremental" });
      await vi.waitFor(() => expect(executor.scanStatus().running).toBe(false), { timeout: 5000 });
      expect(executor.scanStatus().error).toBeNull();
      expect(await complete.mock.results[0]!.value).toEqual({ status: "pending", reason: "source_session_closed" });
      expect(h.batches()).toEqual({ n: 1 });
      expect(h.repos.db.prepare(`SELECT COUNT(*) AS n FROM raw_turns`).get()).toEqual({ n: 1 });
      expect(scheduleWorker).toHaveBeenCalledTimes(1);
      await executor.startScan({ sourceId: "codex", mode: "incremental" });
      await vi.waitFor(() => expect(executor.scanStatus().running).toBe(false), { timeout: 5000 });
      expect(executor.scanStatus().error).toBeNull();
      expect(scheduleWorker).toHaveBeenCalledTimes(1);
      expect(h.batches()).toEqual({ n: 1 });
    } finally { await executor.dispose(); }
  });
});
