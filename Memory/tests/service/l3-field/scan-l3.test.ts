import { mkdirSync } from "node:fs";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { DEFAULT_MEMMY_CONFIG, MemoryDb } from "../../../src/index.js";
import type { SourceTurnCompleteRequest } from "../../../src/types.js";
import { Repositories } from "../../../src/storage/repositories.js";
import { createMemoryServiceFixture } from "../../fixtures/memory-service-fixture.js";

const fixture = createMemoryServiceFixture();
afterEach(() => fixture.cleanup());

function setup(enabled = true) {
  const root = fixture.createTestRoot("scan-l3-");
  const home = join(root, "home");
  const project = join(home, "code", "demo");
  mkdirSync(project, { recursive: true });
  const db = new MemoryDb({ path: join(root, "memory.sqlite") });
  const config = structuredClone(DEFAULT_MEMMY_CONFIG);
  config.algorithm.l3FieldCognition.enabled = enabled;
  const service = fixture.createTestMemoryService({
    db, mode: "dev", config,
    l3FieldEnvironment: () => ({ machineId: "8".repeat(64), homeDir: home, tempRoots: [] }),
    l3MachineProbe: () => new Promise(() => undefined)
  });
  return { db, service, repos: new Repositories(db.db), project };
}

function sourceTurn(
  channel: SourceTurnCompleteRequest["channel"],
  conversationId: string,
  index: number,
  workspacePath?: string
): SourceTurnCompleteRequest {
  const minute = String(index).padStart(2, "0");
  return {
    namespace: { source: "codex", profileId: "default", userId: "scan-user" },
    source: "codex",
    channel,
    ...(workspacePath ? { workspacePath } : {}),
    sourceTurn: {
      source: "codex", profileId: "default", conversationId, turnId: `${conversationId}-turn-${index}`,
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

describe("scanned sessions enter L3", () => {
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
