import { mkdirSync } from "node:fs";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import { afterEach, describe, expect, it, vi } from "vitest";
import { DEFAULT_MEMMY_CONFIG, MemoryDb } from "../../../src/index.js";
import { createAgentSourceExecutor } from "../../../src/agent-source/runtime.js";
import { createSourceRegistry } from "../../../src/agent-source/adapters/source-registry.js";
import type { SourceTurnCompleteRequest } from "../../../src/types.js";
import type { LlmClient } from "../../../src/model/types.js";
import { Repositories } from "../../../src/storage/repositories.js";
import { createMemoryServiceFixture, createBatchReflectionLlm, runWorkerRounds } from "../../fixtures/memory-service-fixture.js";

const fixture = createMemoryServiceFixture();
afterEach(() => fixture.cleanup());

function setup(enabled = true, options: { llm?: LlmClient; turnJudge?: boolean } = {}) {
  const root = fixture.createTestRoot("scan-l3-");
  const home = join(root, "home");
  const project = join(home, "code", "demo");
  mkdirSync(project, { recursive: true });
  const db = new MemoryDb({ path: join(root, "memory.sqlite") });
  const config = structuredClone(DEFAULT_MEMMY_CONFIG);
  config.algorithm.l3FieldCognition.enabled = enabled;
  config.algorithm.session.turnJudge = options.turnJudge ?? config.algorithm.session.turnJudge;
  const reload = { config };
  const service = fixture.createTestMemoryService({
    db, mode: "dev", config, llm: options.llm, configLoader: () => ({ config: reload.config }),
    l3FieldEnvironment: () => ({ machineId: "8".repeat(64), homeDir: home, tempRoots: [] }),
    l3MachineProbe: () => new Promise(() => undefined)
  });
  const switchTo = (enabled: boolean, writes = true) => {
    reload.config = structuredClone(config);
    reload.config.algorithm.l3FieldCognition.enabled = enabled;
    reload.config.algorithm.enableMemoryAdd = writes;
    service.reloadConfig({ restartFailedProcessing: false });
  };
  return { root, db, service, repos: new Repositories(db.db), project, switchTo };
}

function sourceTurn(
  channel: SourceTurnCompleteRequest["channel"],
  conversationId: string,
  index: number,
  workspacePath?: string,
  source = "codex"
): SourceTurnCompleteRequest {
  const minute = String(index).padStart(2, "0");
  return {
    namespace: { source, profileId: "default", userId: "scan-user" },
    source,
    channel,
    ...(workspacePath ? { workspacePath } : {}),
    sourceTurn: {
      source, profileId: "default", conversationId, turnId: `${conversationId}-turn-${index}`,
      startedAt: `2099-01-01T10:${minute}:00.000Z`, completedAt: `2099-01-01T10:${minute}:30.000Z`,
      sequence: index, completionEvidence: `task_complete:${index}`
    },
    query: `Run the project tests, step ${index}.`,
    answer: "The tests ran and one failed because vitest was missing.",
    toolCalls: [{ id: `call-${index}`, name: "exec_command", input: { cmd: "npm test", workdir: workspacePath } }],
    toolResults: [{ id: `call-${index}`, output: "sh: vitest: command not found" }]
  };
}

function sessionOf(repos: Repositories, conversationId: string) {
  const row = repos.db.prepare(`SELECT id FROM sessions WHERE conversation_id = ? OR host_session_key = ?`)
    .get(conversationId, conversationId) as { id: string };
  return repos.runtime.getSession(row.id)!;
}

function detachedHistory(conversationId: string, project: string): SourceTurnCompleteRequest {
  const request = sourceTurn("agent_source_scan", conversationId, 1, project);
  return { ...request, captureLegacyHistory: true, sourceTurn: { ...request.sourceTurn,
    startedAt: "2000-01-01T10:01:00.000Z", completedAt: "2000-01-01T10:01:30.000Z" } };
}

describe("scanned sessions enter L3", () => {

  it.each([true, false])("registers detached legacy history before its first completion with turnJudge=%s", async (turnJudge) => {
    const llm = createBatchReflectionLlm([]);
    const fallback = llm.complete.bind(llm);
    llm.complete = (messages, options) => options.operation === "l3_field.unit_update"
      ? Promise.resolve(JSON.stringify({ reason: "historical evidence retained", ops: [] }))
      : fallback(messages, options);
    const { service, repos, project } = setup(true, { llm, turnJudge });
    const newer = await service.completeSourceTurn(sourceTurn("hook", "detached-history", 3, project));
    const request = detachedHistory("detached-history", project);
    const first = await service.completeSourceTurn(request);
    expect(first.status).toBe("stored");
    const result = first.result!;
    const detachedId = result.sessionId;
    expect(detachedId).not.toBe(newer.result!.sessionId);
    expect(result.assignmentStatus).toBe("pending");
    expect(repos.runtime.getSession(detachedId)).toMatchObject({
      status: "closed", openedAt: request.sourceTurn.startedAt, closedAt: request.sourceTurn.completedAt,
      source: "codex", profileId: "default", conversationId: "detached-history",
      meta: { legacy_history_backfill: true, l3_world_model_protocol_version: 2, work_memory_disabled: true }
    });
    expect(repos.runtime.getSession(newer.result!.sessionId)!.meta.l3_world_model_protocol_version).toBeUndefined();
    expect(repos.runtime.getSession(newer.result!.sessionId)!.status).toBe("open");
    expect(repos.l3WorldModels.listInputTracesInRange(detachedId, 0, 100)).toEqual([
      expect.objectContaining({ rawTurnId: result.rawTurnId, l1MemoryId: result.l1MemoryIds[0], createdAt: request.sourceTurn.completedAt })
    ]);
    expect(repos.runtime.getRawTurn(result.rawTurnId)).toMatchObject({
      createdAt: request.sourceTurn.startedAt,
      userText: request.query, assistantText: request.answer,
      messagePayload: { source_turn: request.sourceTurn, turn_complete: { completed_at: request.sourceTurn.completedAt } }
    });
    expect(repos.memories.get(result.l1MemoryIds[0]!)!).toMatchObject({
      createdAt: request.sourceTurn.completedAt,
      properties: { internal_info: { capture_origin: "agent_source_scan" } }
    });
    // The detached close happens before episode assignment. Its existing summary/assignment
    // jobs must still hand the registered trace to L3 without another scan or a new queue.
    await runWorkerRounds(service, 12);
    expect(repos.db.prepare(`SELECT status FROM l3_unit_batches WHERE session_id = ?`).all(detachedId))
      .toEqual([{ status: "applied" }]);
    expect(repos.db.prepare(`SELECT COUNT(*) AS n FROM evolution_jobs WHERE job_type = 'work_memory_extract' AND session_id = ?`).get(detachedId))
      .toEqual({ n: 0 });
    const replay = await service.completeSourceTurn(request);
    expect(replay).toMatchObject({ status: "existing", result: { rawTurnId: result.rawTurnId, l1MemoryIds: result.l1MemoryIds } });
    service.reconcileWorkerStartup();
    expect(service.freezeScannedL3Sessions([detachedId])).toBe(0);
    expect(repos.db.prepare(`SELECT COUNT(*) AS n FROM l3_unit_batches WHERE session_id = ?`).get(detachedId)).toEqual({ n: 1 });
    expect(repos.runtime.getSession(detachedId)).toMatchObject({ status: "closed", closedAt: request.sourceTurn.completedAt });
  });

  it("recovers a detached first capture at startup when its scan hand-off never ran", async () => {
    const { service, repos, project } = setup(true, { llm: createBatchReflectionLlm([]) });
    await service.completeSourceTurn(sourceTurn("hook", "detached-crash", 3, project));
    const first = await service.completeSourceTurn(detachedHistory("detached-crash", project));
    const sessionId = first.result!.sessionId;
    expect(repos.db.prepare(`SELECT COUNT(*) AS n FROM l3_unit_batches WHERE session_id = ?`).get(sessionId)).toEqual({ n: 0 });
    service.reconcileWorkerStartup();
    expect(repos.db.prepare(`SELECT COUNT(*) AS n FROM l3_unit_batches WHERE session_id = ?`).get(sessionId)).toEqual({ n: 1 });
    expect(repos.runtime.listJobs("queued", 100).filter((job) => job.jobType === "l3_unit_update" && job.sessionId === sessionId)).toHaveLength(1);
    service.reconcileWorkerStartup();
    expect(service.freezeScannedL3Sessions([sessionId])).toBe(0);
    expect(repos.db.prepare(`SELECT COUNT(*) AS n FROM l3_unit_batches WHERE session_id = ?`).get(sessionId)).toEqual({ n: 1 });
    expect(repos.runtime.getSession(sessionId)!.status).toBe("closed");
  });

  it("upgrades retained detached history on rescan only when L3 and memory writes are on", async () => {
    const { service, repos, project, switchTo } = setup(false);
    await service.completeSourceTurn(sourceTurn("hook", "detached-replay", 3, project));
    const request = detachedHistory("detached-replay", project);
    const first = await service.completeSourceTurn(request);
    const result = first.result!;
    const originalRaw = repos.runtime.getRawTurn(result.rawTurnId);
    const originalL1 = repos.memories.get(result.l1MemoryIds[0]!);
    switchTo(true, false);
    expect((await service.completeSourceTurn(request)).status).toBe("existing");
    expect(repos.runtime.getSession(result.sessionId)!.meta.l3_world_model_protocol_version).toBeUndefined();
    expect(repos.l3WorldModels.listInputTracesInRange(result.sessionId, 0, 100)).toEqual([]);
    switchTo(true);
    expect(await service.completeSourceTurn(request)).toMatchObject({
      status: "existing", result: { rawTurnId: result.rawTurnId, l1MemoryIds: result.l1MemoryIds, scheduledEvolution: true }
    });
    expect(repos.runtime.getSession(result.sessionId)).toMatchObject({
      status: "closed", closedAt: request.sourceTurn.completedAt,
      meta: { legacy_history_backfill: true, l3_world_model_protocol_version: 2, work_memory_disabled: true }
    });
    expect(repos.l3WorldModels.listInputTracesInRange(result.sessionId, 0, 100)).toEqual([
      expect.objectContaining({ rawTurnId: result.rawTurnId, l1MemoryId: result.l1MemoryIds[0], createdAt: originalRaw!.createdAt })
    ]);
    expect(repos.runtime.getRawTurn(result.rawTurnId)).toEqual(originalRaw);
    expect(repos.memories.get(result.l1MemoryIds[0]!)).toEqual(originalL1);
    expect(repos.db.prepare(`SELECT COUNT(*) AS n FROM l3_unit_batches WHERE session_id = ?`).get(result.sessionId)).toEqual({ n: 1 });
    expect((await service.completeSourceTurn(request)).result!.scheduledEvolution).toBe(false);
    expect(service.freezeScannedL3Sessions([result.sessionId])).toBe(0);
    expect(repos.db.prepare(`SELECT COUNT(*) AS n FROM raw_turns WHERE session_id = ?`).get(result.sessionId)).toEqual({ n: 1 });
    expect(repos.db.prepare(`SELECT COUNT(*) AS n FROM l3_unit_batches WHERE session_id = ?`).get(result.sessionId)).toEqual({ n: 1 });
  });

  it("recovers a closed detached candidate when only a later turn is scanned after enabling L3", async () => {
    const { service, repos, project, switchTo } = setup(false);
    const newer = await service.completeSourceTurn(sourceTurn("hook", "detached-later", 3, project));
    const request = detachedHistory("detached-later", project);
    const first = await service.completeSourceTurn(request);
    const sessionId = first.result!.sessionId;
    service.closeSession(newer.result!.sessionId);
    switchTo(true);
    expect((await service.completeSourceTurn(sourceTurn("agent_source_scan", "detached-later", 4, project))).status).toBe("stored");
    expect(repos.runtime.getSession(sessionId)).toMatchObject({
      status: "closed", closedAt: request.sourceTurn.completedAt,
      meta: { l3_world_model_protocol_version: 2, work_memory_disabled: true }
    });
    expect(repos.l3WorldModels.listInputTracesInRange(sessionId, 0, 100).map((trace) => trace.rawTurnId))
      .toEqual([first.result!.rawTurnId]);
    await service.completeSourceTurn(request);
    service.reconcileWorkerStartup();
    expect(service.freezeScannedL3Sessions([sessionId])).toBe(0);
    expect(repos.db.prepare(`SELECT COUNT(*) AS n FROM l3_unit_batches WHERE session_id = ?`).get(sessionId)).toEqual({ n: 1 });
  });

  it("recovers an earlier closed sibling while its newer Session stays open, preserving gates and scope", async () => {
    const { service, repos, project, switchTo } = setup(false);
    const conversation = "open-sibling";
    const first = await service.completeSourceTurn(sourceTurn("agent_source_scan", conversation, 1, project));
    service.closeSession(first.result!.sessionId);
    const second = await service.completeSourceTurn(sourceTurn("agent_source_scan", conversation, 2, project));
    expect(second.result!.sessionId).not.toBe(first.result!.sessionId);
    const originalRaw = repos.runtime.getRawTurn(first.result!.rawTurnId);
    const originalL1 = repos.memories.get(first.result!.l1MemoryIds[0]!);
    const otherProfile = sourceTurn("agent_source_scan", conversation, 1, project);
    otherProfile.namespace!.profileId = "other-profile";
    otherProfile.sourceTurn.profileId = "other-profile";
    const otherTenant = sourceTurn("agent_source_scan", conversation, 1, project);
    otherTenant.namespace!.tenantId = "other-tenant";
    const foreign = [];
    for (const request of [sourceTurn("agent_source_scan", conversation, 1, project, "claude_code"), otherProfile, otherTenant]) {
      const captured = await service.completeSourceTurn(request);
      expect(captured.status).toBe("stored");
      service.closeSession(captured.result!.sessionId);
      foreign.push(captured.result!.sessionId);
    }
    await service.completeSourceTurn(sourceTurn("agent_source_scan", conversation, 3, project));
    expect(repos.runtime.getSession(first.result!.sessionId)!.meta.l3_world_model_protocol_version).toBeUndefined();
    switchTo(true, false);
    const next = sourceTurn("agent_source_scan", conversation, 4, project);
    expect(await service.completeSourceTurn(next)).toMatchObject({ status: "pending", reason: "memory_add_disabled" });
    expect(repos.runtime.getSession(first.result!.sessionId)!.meta.l3_world_model_protocol_version).toBeUndefined();
    switchTo(true);
    const recovered = await service.completeSourceTurn(next);
    expect(recovered).toMatchObject({ status: "stored", result: { sessionId: second.result!.sessionId } });
    expect(repos.runtime.getSession(second.result!.sessionId)!.status).toBe("open");
    expect(repos.runtime.getSession(first.result!.sessionId)).toMatchObject({ status: "closed",
      meta: { l3_world_model_protocol_version: 2, work_memory_disabled: true } });
    expect(repos.l3WorldModels.listInputTracesInRange(first.result!.sessionId, 0, 100).map(trace => trace.rawTurnId))
      .toEqual([first.result!.rawTurnId]);
    expect(repos.runtime.getRawTurn(first.result!.rawTurnId)).toEqual(originalRaw);
    expect(repos.memories.get(first.result!.l1MemoryIds[0]!)).toEqual(originalL1);
    for (const sessionId of foreign) {
      expect(repos.runtime.getSession(sessionId)!.meta.l3_world_model_protocol_version).toBeUndefined();
      expect(repos.db.prepare(`SELECT COUNT(*) AS n FROM l3_world_model_input_traces WHERE session_id = ?`).get(sessionId)).toEqual({ n: 0 });
    }
    await service.completeSourceTurn(sourceTurn("agent_source_scan", conversation, 5, project));
    expect(repos.db.prepare(`SELECT COUNT(*) AS n FROM l3_unit_batches WHERE session_id = ?`).get(first.result!.sessionId)).toEqual({ n: 1 });
  });

  it("recovers a closed detached sibling without closing the newer open Session", async () => {
    const { service, repos, project, switchTo } = setup(false);
    const newer = await service.completeSourceTurn(sourceTurn("hook", "detached-open-sibling", 3, project));
    const first = await service.completeSourceTurn(detachedHistory("detached-open-sibling", project));
    const sessionId = first.result!.sessionId;
    const raw = repos.runtime.getRawTurn(first.result!.rawTurnId);
    switchTo(true);
    const next = await service.completeSourceTurn(sourceTurn("agent_source_scan", "detached-open-sibling", 4, project));
    expect(next).toMatchObject({ status: "stored", result: { sessionId: newer.result!.sessionId } });
    expect(repos.runtime.getSession(newer.result!.sessionId)!.status).toBe("open");
    expect(repos.runtime.getSession(sessionId)).toMatchObject({ status: "closed",
      meta: { legacy_history_backfill: true, l3_world_model_protocol_version: 2, work_memory_disabled: true } });
    expect(repos.l3WorldModels.listInputTracesInRange(sessionId, 0, 100)).toEqual([
      expect.objectContaining({ rawTurnId: first.result!.rawTurnId, l1MemoryId: first.result!.l1MemoryIds[0], createdAt: raw!.createdAt })
    ]);
    await service.completeSourceTurn(sourceTurn("agent_source_scan", "detached-open-sibling", 5, project));
    expect(repos.db.prepare(`SELECT COUNT(*) AS n FROM l3_unit_batches WHERE session_id = ?`).get(sessionId)).toEqual({ n: 1 });
  });

  it("recovers closed siblings before reusing an explicitly supplied open Hook Session", async () => {
    const { service, repos, project, switchTo } = setup(false);
    const conversation = "supplied-open-sibling";
    const closed = [];
    for (const index of [1, 2]) {
      const captured = await service.completeSourceTurn(sourceTurn("agent_source_scan", conversation, index, project));
      service.closeSession(captured.result!.sessionId);
      closed.push(captured.result!);
    }
    const live = service.openSession({ namespace: { source: "codex", profileId: "default", userId: "scan-user",
      sessionKey: `codex-memory-${conversation}` }, workspacePath: project });
    switchTo(true);
    const request = { ...sourceTurn("agent_source_scan", conversation, 3, project), sessionId: live.sessionId };
    const scheduled = vi.fn();
    expect(await service.completeSourceTurn(request, scheduled)).toMatchObject({ status: "stored", result: { sessionId: live.sessionId } });
    expect(scheduled).toHaveBeenCalledTimes(1);
    expect(repos.runtime.getSession(live.sessionId)!.status).toBe("open");
    expect(repos.runtime.getSession(live.sessionId)!.meta.l3_world_model_protocol_version).toBeUndefined();
    expect(repos.runtime.getSession(live.sessionId)!.meta.work_memory_disabled).toBeUndefined();
    for (const result of closed) {
      expect(repos.runtime.getSession(result.sessionId)).toMatchObject({ status: "closed", meta: { l3_world_model_protocol_version: 2 } });
      expect(repos.l3WorldModels.listInputTracesInRange(result.sessionId, 0, 100).map(trace => trace.rawTurnId)).toEqual([result.rawTurnId]);
      expect(repos.db.prepare(`SELECT COUNT(*) AS n FROM l3_unit_batches WHERE session_id = ?`).get(result.sessionId)).toEqual({ n: 1 });
    }
    await service.completeSourceTurn(request, scheduled);
    expect(scheduled).toHaveBeenCalledTimes(1);
  });

  it("rolls back a detached first capture if registering its L3 input fails", async () => {
    const { service, repos, project } = setup();
    await service.completeSourceTurn(sourceTurn("hook", "detached-atomic", 3, project));
    const request = detachedHistory("detached-atomic", project);
    const counts = () => ["sessions", "raw_turns", "memories", "source_turn_captures", "evolution_jobs", "l3_world_model_input_traces"]
      .map((table) => (repos.db.prepare(`SELECT COUNT(*) AS n FROM ${table}`).get() as { n: number }).n);
    const before = counts();
    repos.db.exec(`CREATE TEMP TRIGGER reject_detached_input BEFORE INSERT ON l3_world_model_input_traces
      BEGIN SELECT RAISE(ABORT, 'simulated detached input failure'); END;`);
    await expect(service.completeSourceTurn(request)).rejects.toThrow("simulated detached input failure");
    expect(counts()).toEqual(before);
    repos.db.exec(`DROP TRIGGER reject_detached_input`);
    expect((await service.completeSourceTurn(request)).status).toBe("stored");
  });

  it("processes recovered history through the queue into the next session's project context once", async () => {
    const llm = createBatchReflectionLlm([], "本项目长期要求修改后运行 npm test");
    const otherwiseComplete = llm.complete.bind(llm);
    let unitCalls = 0;
    llm.complete = async (messages, options) => {
      if (options.operation !== "l3_field.unit_update") return otherwiseComplete(messages, options);
      unitCalls += 1;
      const input = JSON.parse(messages[1]!.content) as {
        evidence: Array<{ id: string; type: string }>;
        projects: Array<{ unit_key: string }>;
      };
      return JSON.stringify({ reason: "lasting project rule", ops: input.projects.length ? [{
        op: "add", unit: "project", kind: "project_constraint", content: "修改后运行 npm test",
        evidence: [input.evidence.find((fragment) => fragment.type === "user_text")!.id]
      }] : [] });
    };
    const { service, repos, project, switchTo } = setup(false, { llm, turnJudge: false });
    const request = { ...sourceTurn("agent_source_scan", "recovered-context", 1, project), query: "以后本项目每次修改后都运行 npm test" };
    const captured = await service.completeSourceTurn(request);
    await runWorkerRounds(service, 8);
    switchTo(true);
    await service.completeSourceTurn(request);
    service.freezeScannedL3Sessions([captured.result!.sessionId]);
    await runWorkerRounds(service, 12);
    expect(repos.db.prepare(`SELECT status FROM l3_unit_batches WHERE session_id = ?`).all(captured.result!.sessionId))
      .toEqual([{ status: "applied" }]);
    const namespace = { source: "codex", profileId: "default", sessionKey: "recovered-next", userId: "scan-user" };
    const next = service.openSession({ l3WorldModelProtocolVersion: 2, l3WorldModelTransition: "resume_only",
      namespace, workspaceUri: pathToFileURL(project).href, workspaceHostId: "8".repeat(64) });
    const context = service.l3WorldModelContext(next.sessionId, { requestId: "9353298b-4d3d-46f0-9178-27c27e81543e", adapterId: "codex-memory", namespace: { ...namespace, projectId: next.projectId! } });
    expect(context.projectContract).toBe("- 修改后运行 npm test");
    expect(context.sourceMemoryIds).toEqual(captured.result!.l1MemoryIds);
    expect(unitCalls).toBe(1);
    await service.completeSourceTurn(request);
    service.reconcileWorkerStartup();
    expect(service.freezeScannedL3Sessions([captured.result!.sessionId])).toBe(0);
    expect(repos.db.prepare(`SELECT COUNT(*) AS n FROM l3_unit_batches`).get()).toEqual({ n: 1 });
  });

  it("does not parse unrelated sessions' L1 while backfilling source history", async () => {
    const { service, repos, project } = setup(false);
    const first = await service.completeSourceTurn(sourceTurn("agent_source_scan", "bounded-backfill", 1, project));
    const second = await service.completeSourceTurn(sourceTurn("agent_source_scan", "bounded-backfill", 2, project));
    const sessionId = first.result!.sessionId;
    // Older native L1 may retain its raw-turn link only in the trace properties.
    repos.db.prepare(`UPDATE memories SET info_json = '{}' WHERE id = ?`).run(second.result!.l1MemoryIds[0]);
    const insert = repos.db.prepare(`INSERT INTO memories (id, timeline, user_id, session_id, memory_value, memory_layer, created_at, updated_at)
      VALUES (?, 'fixture', 'scan-user', 'unrelated-session', 'unrelated', 'L1', '2000-01-01', '2000-01-01')`);
    repos.transaction(() => { for (let index = 0; index < 300; index += 1) insert.run(`unrelated-${index}`); });
    repos.runtime.updateSessionMeta(sessionId, { l3_world_model_protocol_version: 2 });
    let jsonReads = 0;
    repos.db.function("json_extract", { deterministic: true }, (input: string, jsonPath: string) => {
      jsonReads += 1;
      const value = jsonPath.slice(2).split(".").reduce<unknown>((current, key) =>
        current && typeof current === "object" ? (current as Record<string, unknown>)[key] : undefined, JSON.parse(input));
      return value === undefined || value === null ? null : typeof value === "boolean" ? Number(value)
        : typeof value === "object" ? JSON.stringify(value) : value as string | number;
    });
    expect(repos.l3WorldModels.backfillSourceInputTraces(sessionId)).toBe(2);
    expect(repos.l3WorldModels.listInputTracesInRange(sessionId, 0, 10).map(trace => trace.l1MemoryId))
      .toEqual([...first.result!.l1MemoryIds, ...second.result!.l1MemoryIds]);
    expect(jsonReads).toBeLessThanOrEqual(12);
  });

  it("rolls the protocol upgrade back if registering retained history fails", async () => {
    const { service, repos, project, switchTo } = setup(false);
    const request = sourceTurn("agent_source_scan", "atomic-upgrade", 1, project);
    await service.completeSourceTurn(request);
    const session = sessionOf(repos, "atomic-upgrade");
    switchTo(true);
    repos.db.exec(`CREATE TEMP TRIGGER reject_backfill BEFORE INSERT ON l3_world_model_input_traces
      BEGIN SELECT RAISE(ABORT, 'simulated backfill failure'); END;`);
    await expect(service.completeSourceTurn(request)).rejects.toThrow("simulated backfill failure");
    expect(repos.runtime.getSession(session.id)!.meta.l3_world_model_protocol_version).toBeUndefined();
    expect(repos.db.prepare(`SELECT COUNT(*) AS n FROM l3_world_model_input_traces`).get()).toEqual({ n: 0 });
    repos.db.exec(`DROP TRIGGER reject_backfill`);
    expect((await service.completeSourceTurn(request)).status).toBe("existing");
    expect(repos.l3WorldModels.listInputTracesInRange(session.id, 0, 100)).toHaveLength(1);
  });

  it("keeps an explicitly opened legacy Hook Session's protocol and Work Memory on rescan", async () => {
    const { service, repos, project, switchTo } = setup(false);
    const hook = service.openSession({ namespace: { source: "codex", profileId: "default", userId: "scan-user", sessionKey: "codex-memory-legacy-live" }, workspacePath: project });
    const request = { ...sourceTurn("hook", "legacy-live", 1, project), sessionId: hook.sessionId };
    await service.completeSourceTurn(request);
    switchTo(true);
    expect((await service.completeSourceTurn({ ...request, channel: "agent_source_scan" })).status).toBe("existing");
    expect(repos.runtime.getSession(hook.sessionId)!.meta.l3_world_model_protocol_version).toBeUndefined();
    expect(repos.runtime.getSession(hook.sessionId)!.meta.work_memory_disabled).toBeUndefined();
  });

  it.each(["codex", "claude_code", "cursor", "opencode"])("upgrades and backfills an existing %s scan on rescan and continuation without duplicating captures", async (source) => {
    const { service, repos, project, switchTo } = setup(false);
    const firstRequest = sourceTurn("agent_source_scan", "old-scanned", 1, project, source);
    const first = await service.completeSourceTurn(firstRequest);
    expect(first.status).toBe("stored");
    const session = sessionOf(repos, "old-scanned");
    const original = { rawTurnId: first.result!.rawTurnId, l1MemoryIds: first.result!.l1MemoryIds };
    switchTo(true);
    const duplicate = await service.completeSourceTurn(firstRequest);
    expect(duplicate.status).toBe("existing");
    expect(duplicate.result).toMatchObject(original);
    const second = await service.completeSourceTurn(sourceTurn("agent_source_scan", "old-scanned", 2, project, source));
    expect(second.status).toBe("stored");
    expect(repos.runtime.getSession(session.id)!.meta).toMatchObject({ l3_world_model_protocol_version: 2, work_memory_disabled: true });
    const traces = () => repos.l3WorldModels.listInputTracesInRange(session.id, 0, 100);
    expect(traces().map((trace) => trace.rawTurnId)).toEqual([original.rawTurnId, second.result!.rawTurnId]);
    expect(traces().map((trace) => trace.l1MemoryId)).toEqual([...original.l1MemoryIds, ...second.result!.l1MemoryIds]);
    expect(service.freezeScannedL3Sessions([session.id])).toBe(1);
    await service.completeSourceTurn(firstRequest);
    service.reconcileWorkerStartup();
    expect(service.freezeScannedL3Sessions([session.id])).toBe(0);
    expect(traces()).toHaveLength(2);
    expect(repos.db.prepare(`SELECT COUNT(*) AS n FROM source_turn_captures`).get()).toEqual({ n: 2 });
    expect(repos.db.prepare(`SELECT COUNT(*) AS n FROM raw_turns`).get()).toEqual({ n: 2 });
    expect(repos.db.prepare(`SELECT COUNT(*) AS n FROM l3_unit_batches`).get()).toEqual({ n: 1 });
  });

  it("backfills earlier turns when an old scan is continued without rescanning the earlier turn", async () => {
    const { service, repos, project, switchTo } = setup(false);
    const first = await service.completeSourceTurn(sourceTurn("agent_source_scan", "continued", 1, project));
    switchTo(true);
    const second = await service.completeSourceTurn(sourceTurn("agent_source_scan", "continued", 2, project));
    const session = sessionOf(repos, "continued");
    expect(repos.l3WorldModels.listInputTracesInRange(session.id, 0, 100).map((trace) => trace.rawTurnId))
      .toEqual([first.result!.rawTurnId, second.result!.rawTurnId]);
    expect(repos.runtime.listJobs("queued", 100).filter((job) => job.jobType === "work_memory_idle_flush" && job.sessionId === session.id))
      .toHaveLength(1);
  });

  it("recovers a closed old scan when only a later turn is scanned after enabling L3", async () => {
    const { service, repos, project, switchTo } = setup(false);
    const first = await service.completeSourceTurn(sourceTurn("agent_source_scan", "closed-continued", 1, project));
    const originalSessionId = first.result!.sessionId;
    service.closeSession(originalSessionId);
    switchTo(true);
    const second = await service.completeSourceTurn(sourceTurn("agent_source_scan", "closed-continued", 2, project));
    expect(second.status).toBe("stored");
    expect(second.result!.sessionId).not.toBe(originalSessionId);
    expect(repos.runtime.getSession(originalSessionId)).toMatchObject({ status: "closed",
      meta: { l3_world_model_protocol_version: 2, work_memory_disabled: true } });
    const retained = repos.l3WorldModels.listInputTracesInRange(originalSessionId, 0, 100);
    expect(retained.map((trace) => trace.rawTurnId)).toEqual([first.result!.rawTurnId]);
    expect(retained.map((trace) => trace.l1MemoryId)).toEqual(first.result!.l1MemoryIds);
    expect(repos.l3WorldModels.listInputTracesInRange(second.result!.sessionId, 0, 100).map((trace) => trace.rawTurnId))
      .toEqual([second.result!.rawTurnId]);
    expect(repos.db.prepare(`SELECT COUNT(*) AS n FROM l3_unit_batches WHERE session_id = ?`).get(originalSessionId)).toEqual({ n: 1 });
    await service.completeSourceTurn(sourceTurn("agent_source_scan", "closed-continued", 2, project));
    service.reconcileWorkerStartup();
    expect(repos.db.prepare(`SELECT COUNT(*) AS n FROM l3_unit_batches WHERE session_id = ?`).get(originalSessionId)).toEqual({ n: 1 });
  });

  it("reports newly frozen work when a duplicate recovers a closed scan, then stays idle on repeat", async () => {
    const { service, repos, project, switchTo } = setup(false);
    const request = sourceTurn("agent_source_scan", "closed-wakeup", 1, project);
    const first = await service.completeSourceTurn(request);
    service.closeSession(first.result!.sessionId);
    switchTo(true);
    const recovered = await service.completeSourceTurn(request);
    expect(recovered.status).toBe("existing");
    expect(recovered.result!.scheduledEvolution).toBe(true);
    expect(repos.db.prepare(`SELECT COUNT(*) AS n FROM evolution_jobs WHERE job_type = 'l3_unit_update'`).get()).toEqual({ n: 1 });
    expect((await service.completeSourceTurn(request)).result!.scheduledEvolution).toBe(false);
  });

  it("wakes the scan worker when a full pass only recovers already captured closed history", async () => {
    const { root, service, repos, project, switchTo } = setup(false);
    const request = { ...sourceTurn("agent_source_scan", "closed-scan-worker", 1, project), toolCalls: [], toolResults: [] };
    const first = await service.completeSourceTurn(request);
    service.closeSession(first.result!.sessionId);
    switchTo(true);
    const native = { ...request.sourceTurn, query: request.query, answer: request.answer, status: "succeeded" as const,
      toolCalls: [], toolResults: [] };
    const scheduleWorker = vi.fn();
    const executor = createAgentSourceExecutor({
      service, configPath: join(root, "config.yaml"), statePath: join(root, "source-state.json"),
      resolveAgentSkillRoot: () => null, scheduleWorker,
      sourceRegistry: createSourceRegistry([{
        descriptor: { sourceId: "codex", displayName: "fixture", builtin: true, dataPath: root },
        async detect() { return true; },
        async *scan() {
          for (const role of ["user", "assistant"] as const) yield {
            sourceId: "codex", conversationId: native.conversationId, messageId: `native-${role}`, role,
            content: role === "user" ? native.query : native.answer,
            createdAt: role === "user" ? native.startedAt : native.completedAt,
            workspacePath: project, gitRoot: null,
            rawMeta: { sourceTurnState: "complete", sourceTurnId: native.turnId, sourceTurn: native }
          };
        }
      }])
    });
    try {
      await executor.startScan({ sourceId: "codex", mode: "full" });
      await vi.waitFor(() => expect(executor.scanStatus().running).toBe(false), { timeout: 5000 });
      expect(executor.scanStatus().error).toBeNull();
      expect(repos.db.prepare(`SELECT COUNT(*) AS n FROM raw_turns`).get()).toEqual({ n: 1 });
      expect(repos.db.prepare(`SELECT COUNT(*) AS n FROM l3_unit_batches`).get()).toEqual({ n: 1 });
      expect(scheduleWorker).toHaveBeenCalledTimes(1);
    } finally { await executor.dispose(); }
  });

  it("recovers a closed old scan without reopening it or making duplicate batches", async () => {
    const { service, repos, project, switchTo } = setup(false);
    const request = sourceTurn("agent_source_scan", "closed-old", 1, project);
    const first = await service.completeSourceTurn(request);
    const session = sessionOf(repos, "closed-old");
    service.closeSession(session.id);
    switchTo(true);
    expect((await service.completeSourceTurn(request)).status).toBe("existing");
    service.reconcileWorkerStartup();
    expect(repos.runtime.getSession(session.id)!.status).toBe("closed");
    expect(repos.l3WorldModels.listInputTracesInRange(session.id, 0, 100).map((trace) => trace.rawTurnId)).toEqual([first.result!.rawTurnId]);
    expect(repos.db.prepare(`SELECT COUNT(*) AS n FROM l3_unit_batches WHERE session_id = ?`).get(session.id)).toEqual({ n: 1 });
    await service.completeSourceTurn(request);
    service.reconcileWorkerStartup();
    expect(repos.db.prepare(`SELECT COUNT(*) AS n FROM l3_unit_batches WHERE session_id = ?`).get(session.id)).toEqual({ n: 1 });
  });

  it("does not backfill deleted, redacted or rejected history while recovering the remaining turns", async () => {
    const { service, repos, project, switchTo } = setup(false);
    const captures = [];
    for (let index = 1; index <= 4; index += 1) captures.push(await service.completeSourceTurn(sourceTurn("agent_source_scan", "filtered-old", index, project)));
    service.deleteMemory(captures[0]!.result!.l1MemoryIds[0]!, { namespace: { source: "codex", profileId: "default", userId: "scan-user" } });
    repos.db.prepare(`UPDATE raw_turns SET redacted_at = ? WHERE id = ?`).run(new Date().toISOString(), captures[1]!.result!.rawTurnId);
    repos.db.prepare(`UPDATE memories SET properties_json = json_set(properties_json, '$.internal_info.capture_decision.status', 'rejected') WHERE id = ?`)
      .run(captures[3]!.result!.l1MemoryIds[0]);
    switchTo(true);
    await service.completeSourceTurn(sourceTurn("agent_source_scan", "filtered-old", 3, project));
    const session = sessionOf(repos, "filtered-old");
    expect(repos.l3WorldModels.listInputTracesInRange(session.id, 0, 100).map((trace) => trace.rawTurnId)).toEqual([captures[2]!.result!.rawTurnId]);
  });

  it("preserves the capture owner when another account rescans old history", async () => {
    const { service, repos, project, switchTo } = setup(false);
    const request = sourceTurn("agent_source_scan", "owner-old", 1, project);
    await service.completeSourceTurn(request);
    const session = sessionOf(repos, "owner-old");
    switchTo(true);
    const response = await service.completeSourceTurn({ ...request, namespace: { source: "codex", profileId: "default", userId: "switched-user" } });
    expect(response.status).toBe("existing");
    expect(repos.runtime.getSession(session.id)!.userId).toBe("scan-user");
    expect(repos.l3WorldModels.listInputTracesInRange(session.id, 0, 100)).toHaveLength(1);
    service.freezeScannedL3Sessions([session.id]);
    expect(repos.db.prepare(`SELECT user_id FROM l3_unit_batches WHERE session_id = ?`).get(session.id)).toEqual({ user_id: "scan-user" });
  });

  it("does not upgrade or backfill old scans while memory writes are disabled", async () => {
    const { service, repos, project, switchTo } = setup(false);
    const request = sourceTurn("agent_source_scan", "read-only-old", 1, project);
    await service.completeSourceTurn(request);
    const session = sessionOf(repos, "read-only-old");
    switchTo(true, false);
    expect((await service.completeSourceTurn(request)).status).toBe("existing");
    expect(repos.runtime.getSession(session.id)!.meta.l3_world_model_protocol_version).toBeUndefined();
    expect(repos.db.prepare(`SELECT COUNT(*) AS n FROM l3_world_model_input_traces`).get()).toEqual({ n: 0 });
  });
  it("opens a scanned conversation on the L3 v2 protocol with Work Memory off, but leaves Hook sessions alone", async () => {
    const { service, repos, project } = setup();
    expect((await service.completeSourceTurn(sourceTurn("agent_source_scan", "scanned", 1, project))).status).toBe("stored");
    expect((await service.completeSourceTurn(sourceTurn("hook", "hooked", 1, project))).status).toBe("stored");
    expect(sessionOf(repos, "scanned").meta).toMatchObject({ l3_world_model_protocol_version: 2, work_memory_disabled: true });
    expect(sessionOf(repos, "hooked").meta.l3_world_model_protocol_version).toBeUndefined();
  });

  it("never extracts Work Memory for a scanned session, on idle, new task or close", async () => {
    const { service, repos, project } = setup();
    await service.completeSourceTurn(sourceTurn("agent_source_scan", "scanned", 1, project));
    await service.completeSourceTurn(sourceTurn("agent_source_scan", "scanned", 2, project));
    // Its idle flush (armed for the new L3) comes due and runs: it hands turns to L3, not to Work Memory.
    const quietSince = new Date(Date.now() - 3 * 60 * 60 * 1000).toISOString();
    repos.db.prepare(`UPDATE l3_world_model_input_traces SET created_at = ?`).run(quietSince);
    repos.db.prepare(`UPDATE evolution_jobs SET payload_json = json_set(payload_json, '$.runAfter', ?)
      WHERE job_type = 'work_memory_idle_flush'`).run(quietSince);
    await service.runWorkerOnce(50);
    service.closeSession(sessionOf(repos, "scanned").id);
    const workMemoryJobs = repos.db.prepare(
      `SELECT COUNT(*) AS n FROM evolution_jobs WHERE job_type = 'work_memory_extract'`
    ).get() as { n: number };
    expect(workMemoryJobs.n).toBe(0);
    expect(repos.db.prepare(`SELECT trigger FROM l3_unit_batches`).all()).toEqual([{ trigger: "session_idle" }]);
  });

  it("freezes what a scan pass added into new-L3 batches, and nothing when the pass added nothing", async () => {
    const { service, repos, project } = setup();
    await service.completeSourceTurn(sourceTurn("agent_source_scan", "scanned", 1, project));
    await service.completeSourceTurn(sourceTurn("agent_source_scan", "scanned", 2, project));
    const session = sessionOf(repos, "scanned");
    expect(service.freezeScannedL3Sessions([session.id, session.id])).toBe(1);
    const batches = repos.db.prepare(`SELECT trigger, l1_memory_ids_json FROM l3_unit_batches`).all() as Array<{ trigger: string; l1_memory_ids_json: string }>;
    expect(batches).toHaveLength(1);
    expect(batches[0]!.trigger).toBe("scan_pass");
    expect(JSON.parse(batches[0]!.l1_memory_ids_json).length).toBeGreaterThanOrEqual(2);
    expect(repos.runtime.listJobs("queued", 100).filter((job) => job.jobType === "l3_unit_update")).toHaveLength(1);

    expect(service.freezeScannedL3Sessions([session.id])).toBe(0);
    await service.completeSourceTurn(sourceTurn("agent_source_scan", "scanned", 3, project));
    expect(service.freezeScannedL3Sessions([session.id])).toBe(1);
  });

  it("lets a live Hook take over a conversation a scan saw first", async () => {
    const { service, repos, project } = setup();
    await service.completeSourceTurn(sourceTurn("agent_source_scan", "resumed", 1, project));
    const scanned = sessionOf(repos, "resumed");
    const hook = service.openSession({
      l3WorldModelProtocolVersion: 2, l3WorldModelTransition: "resume_only",
      namespace: { source: "codex", profileId: "default", userId: "scan-user", sessionKey: "codex-memory-resumed" }
    });
    const result = await service.completeSourceTurn({ ...sourceTurn("hook", "resumed", 2, project), sessionId: hook.sessionId });
    expect(result.status).toBe("stored");
    expect(result.result?.sessionId).toBe(hook.sessionId);
    expect(repos.runtime.getSession(scanned.id)!.status).toBe("closed");
    expect(repos.runtime.getSession(hook.sessionId)!.meta.work_memory_disabled).toBeUndefined();
    const batches = repos.db.prepare(`SELECT session_id FROM l3_unit_batches`).all() as Array<{ session_id: string }>;
    expect(batches.map((batch) => batch.session_id)).toEqual([scanned.id]);
    const idleFlush = repos.db.prepare(
      `SELECT COUNT(*) AS n FROM evolution_jobs WHERE job_type = 'work_memory_idle_flush' AND session_id = ?`
    ).get(hook.sessionId) as { n: number };
    expect(idleFlush.n).toBe(1);
    // Later turns follow the Hook Session.
    expect((await service.completeSourceTurn({ ...sourceTurn("hook", "resumed", 3, project), sessionId: hook.sessionId })).result?.sessionId)
      .toBe(hook.sessionId);
  });

  it("lets a scan freeze the scanned sessions of its source, also after an account switch, but not another source's", async () => {
    const { service, repos, project } = setup();
    await service.completeSourceTurn(sourceTurn("agent_source_scan", "imported", 1, project));
    const session = sessionOf(repos, "imported");
    const envelope = (userId: string, source: string) => ({
      requestId: "9353298b-4d3d-46f0-9178-27c27e81543e", adapterId: "memmy-desktop", source,
      namespace: { source, profileId: "default", userId }, sessionIds: [session.id]
    });
    expect(service.freezeScanSessions(envelope("someone-else", "claude_code")).batches).toBe(0);
    // Capture kept the conversation's earlier owner after the switch; the hand-off follows it.
    expect(service.freezeScanSessions(envelope("switched-account", "codex")).batches).toBe(1);
  });

  it("arms the idle flush of a scanned session only while the new L3 is on", async () => {
    const flushOf = (repos: Repositories, sessionId: string) => repos.db.prepare(
      `SELECT COUNT(*) AS n FROM evolution_jobs WHERE job_type = 'work_memory_idle_flush' AND session_id = ? AND status = 'queued'`
    ).get(sessionId) as { n: number };
    const on = setup();
    await on.service.completeSourceTurn(sourceTurn("agent_source_scan", "scanned", 1, on.project));
    expect(flushOf(on.repos, sessionOf(on.repos, "scanned").id)).toEqual({ n: 1 });
    const off = setup(false);
    await off.service.completeSourceTurn(sourceTurn("agent_source_scan", "scanned", 1, off.project));
    expect(off.repos.db.prepare(`SELECT COUNT(*) AS n FROM evolution_jobs WHERE job_type = 'work_memory_idle_flush'`).get()).toEqual({ n: 0 });
  });

  it("re-arms the idle flush on worker start for sessions whose turns never reached L3, as after a crash mid-scan", async () => {
    const { service, repos, project } = setup();
    await service.completeSourceTurn(sourceTurn("agent_source_scan", "crashed", 1, project));
    const sessionId = sessionOf(repos, "crashed").id;
    // The process stopped before the scan's hand-off and the flush job was lost with an old build.
    repos.db.prepare(`DELETE FROM evolution_jobs WHERE job_type = 'work_memory_idle_flush'`).run();
    service.reconcileWorkerStartup();
    expect(repos.db.prepare(
      `SELECT COUNT(*) AS n FROM evolution_jobs WHERE job_type = 'work_memory_idle_flush' AND session_id = ? AND status = 'queued'`
    ).get(sessionId)).toEqual({ n: 1 });
    expect(repos.db.prepare(`SELECT COUNT(*) AS n FROM l3_unit_batches`).get()).toEqual({ n: 0 });
  });

  it("keeps a session scanned while the switch was on out of the old L3 after it is switched off", async () => {
    const on = setup();
    await on.service.completeSourceTurn(sourceTurn("agent_source_scan", "scanned", 1, on.project));
    const sessionId = sessionOf(on.repos, "scanned").id;
    const reopen = (enabled: boolean) => {
      const config = structuredClone(DEFAULT_MEMMY_CONFIG);
      config.algorithm.l3FieldCognition.enabled = enabled;
      return fixture.createTestMemoryService({
        db: on.db, mode: "dev", config,
        l3FieldEnvironment: () => ({ machineId: "8".repeat(64), homeDir: join(on.project, "..", ".."), tempRoots: [] }),
        l3MachineProbe: () => new Promise(() => undefined)
      });
    };
    reopen(false).closeSession(sessionId);
    const count = (table: string) => (on.repos.db.prepare(`SELECT COUNT(*) AS n FROM ${table}`).get() as { n: number }).n;
    expect([count("l3_world_model_evidence_batches"), count("l3_unit_batches")]).toEqual([0, 0]);
    expect(on.repos.runtime.listJobs("queued", 100).filter((job) => job.jobType === "l3_world_model_update")).toEqual([]);
    // Switched on again, the waiting turns still reach the new L3.
    expect(reopen(true).freezeScannedL3Sessions([sessionId])).toBe(1);
  });

  it("keeps scans out of L3 when the switch is off, as before", async () => {
    const { service, repos, project } = setup(false);
    await service.completeSourceTurn(sourceTurn("agent_source_scan", "scanned", 1, project));
    const session = sessionOf(repos, "scanned");
    expect(session.meta.l3_world_model_protocol_version).toBeUndefined();
    expect(session.meta.work_memory_disabled).toBeUndefined();
    expect(service.freezeScannedL3Sessions([session.id])).toBe(0);
    service.closeSession(session.id);
    const count = (table: string) => (repos.db.prepare(`SELECT COUNT(*) AS n FROM ${table}`).get() as { n: number }).n;
    expect([count("l3_world_model_input_traces"), count("l3_world_model_evidence_batches"), count("l3_unit_batches")]).toEqual([0, 0, 0]);
    expect(repos.runtime.listJobs("queued", 100).filter((job) => job.jobType.startsWith("l3_"))).toEqual([]);
  });
});
