import { mkdirSync } from "node:fs";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { DEFAULT_MEMMY_CONFIG, MemoryDb } from "../../../src/index.js";
import type { SourceTurnCompleteRequest, SourceTurnCompleteResponse } from "../../../src/types.js";
import { Repositories } from "../../../src/storage/repositories.js";
import { createMemoryServiceFixture } from "../../fixtures/memory-service-fixture.js";

const fixture = createMemoryServiceFixture();
afterEach(async () => { await fixture.cleanup(); });

describe("migrated native history entering L3", () => {
  it("retains a migrated capture's submitting account while backfilling on the original Session owner", async () => {
    const root = fixture.createTestRoot("migrated-source-l3-");
    const home = join(root, "home");
    const project = join(home, "code", "demo");
    mkdirSync(project, { recursive: true });
    const dbPath = join(root, "memory.sqlite");
    const config = structuredClone(DEFAULT_MEMMY_CONFIG);
    config.algorithm.l3FieldCognition.enabled = false;
    config.algorithm.session.turnJudge = false;
    const reload = { config };
    const options = {
      mode: "dev" as const, config, configLoader: () => ({ config: reload.config }),
      l3FieldEnvironment: () => ({ machineId: "8".repeat(64), homeDir: home, tempRoots: [] }),
      l3MachineProbe: () => new Promise<never>(() => undefined)
    };
    const request = (index: number, userId: string): SourceTurnCompleteRequest => ({
      namespace: { source: "codex", profileId: "default", userId },
      source: "codex", channel: "agent_source_scan", workspacePath: project,
      sourceTurn: {
        source: "codex", profileId: "default", conversationId: "migrated-owner", turnId: `turn-${index}`,
        startedAt: `2099-01-01T10:0${index}:00.000Z`, completedAt: `2099-01-01T10:0${index}:30.000Z`,
        sequence: index, completionEvidence: `task_complete:${index}`
      },
      query: `Run the project tests, step ${index}.`, answer: "One test failed.",
      toolCalls: [{ id: `call-${index}`, name: "exec_command", input: { cmd: "npm test", workdir: project } }],
      toolResults: [{ id: `call-${index}`, output: "one test failed" }]
    });
    const originalDb = new MemoryDb({ path: dbPath });
    const originalService = fixture.createTestMemoryService({ ...options, db: originalDb });
    const first = await originalService.completeSourceTurn(request(1, "original-owner"));
    expect(first.status).toBe("stored");
    const migratedRequest = request(2, "submitting-account");
    const acceptedAt = migratedRequest.sourceTurn.completedAt;
    originalDb.db.prepare(`INSERT INTO evolution_jobs (
      id, job_type, status, user_id, session_id, payload_json, attempts, max_attempts, created_at, updated_at
    ) VALUES ('legacy-source', 'capture_replay', 'dead_letter', 'submitting-account', ?, ?, 3, 3, ?, ?)`)
      .run(first.result!.sessionId, JSON.stringify({ command: {
        operation: "completeSourceTurn", args: [migratedRequest]
      } }), acceptedAt, acceptedAt);
    await originalService.stop();
    originalDb.close();

    // Construction converts the durable old command through migrateLegacyCaptures.
    const db = new MemoryDb({ path: dbPath });
    const service = fixture.createTestMemoryService({ ...options, db });
    const repos = new Repositories(db.db);
    expect(db.db.prepare(`SELECT COUNT(*) AS n FROM evolution_jobs WHERE job_type = 'capture_replay'`).get())
      .toEqual({ n: 0 });
    const ledger = () => db.db.prepare(`SELECT * FROM source_turn_captures ORDER BY turn_id`).all() as Array<{
      turn_id: string; user_id: string; response_json: string;
    }>;
    const before = ledger();
    expect(before.map(row => ({ turn: row.turn_id, owner: row.user_id }))).toEqual([
      { turn: "turn-1", owner: "original-owner" }, { turn: "turn-2", owner: "submitting-account" }
    ]);
    const migrated = JSON.parse(before[1]!.response_json) as SourceTurnCompleteResponse;
    expect(migrated.result!.sessionId).toBe(first.result!.sessionId);
    expect(repos.runtime.getRawTurn(migrated.result!.rawTurnId)!.userId).toBe("original-owner");
    const originalRawTimes = [first.result!.rawTurnId, migrated.result!.rawTurnId]
      .map(id => repos.runtime.getRawTurn(id)!.createdAt);
    for (const id of migrated.result!.l1MemoryIds) {
      expect(repos.memories.get(id)).toMatchObject({ userId: "original-owner", sessionId: first.result!.sessionId });
    }

    reload.config = structuredClone(config);
    reload.config.algorithm.l3FieldCognition.enabled = true;
    service.reloadConfig({ restartFailedProcessing: false });
    const duplicate = request(2, "current-account");
    expect((await service.completeSourceTurn(duplicate)).status).toBe("existing");
    const traces = () => repos.l3WorldModels.listInputTracesInRange(first.result!.sessionId, 0, 100);
    expect(traces().map(trace => trace.rawTurnId)).toEqual([first.result!.rawTurnId, migrated.result!.rawTurnId]);
    expect(traces().map(trace => trace.l1MemoryId)).toEqual([...first.result!.l1MemoryIds, ...migrated.result!.l1MemoryIds]);
    expect(traces().map(trace => trace.createdAt)).toEqual(originalRawTimes);
    expect(repos.runtime.getSession(first.result!.sessionId)).toMatchObject({ userId: "original-owner",
      meta: { l3_world_model_protocol_version: 2, work_memory_disabled: true } });
    await service.completeSourceTurn(duplicate);
    expect(traces()).toHaveLength(2);
    expect(ledger()).toEqual(before);
  });
});
