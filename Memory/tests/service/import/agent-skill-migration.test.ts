import { probeDuringLongWrite } from "../../fixtures/startup-http-probe.js";
import { spawn } from "node:child_process";
import { join } from "node:path";
import { MemoryDb } from "../../../src/storage/db.js";
import { SqliteStorageBackend } from "../../../src/storage/backend.js";
import { once } from "node:events";
import { closeMemoryHttpServer, createMemoryHttpServer } from "../../../src/server/http.js";
import { createHash } from "node:crypto";
import { afterEach, describe, expect, it, vi } from "vitest";
import { configWithMemoryGates, createFailingLlm, createMemoryServiceFixture, LEGACY_TEST_CONFIG } from "../../fixtures/memory-service-fixture.js";
import { withLegacyImportedSkillWriter } from "../../fixtures/legacy-imported-skill-writer.js";
import { IMPORTED_SKILL_STATE_VERSION } from "../../../src/storage/imported-skill.js";

const { cleanup, createTestService, createTestMemoryService } = createMemoryServiceFixture();

afterEach(cleanup);

const namespace = { source: "claude_code", profileId: "default", userId: "skill-migration-user" };

type Service = ReturnType<typeof createTestService>["service"];
type Db = ReturnType<typeof createTestService>["db"];

/** Replays generic lifecycle migration without adding a Codex sidecar precondition. */
function legacyImport(service: Service, sourceSkillId: string, content: string, agent = "hermes"): string {
  return withLegacyImportedSkillWriter(service, () => service.addMemory({
    namespace,
    requestId: `legacy:${agent}:${sourceSkillId}:${content}`,
    adapterId: `agent-source:${agent}`,
    layer: "Skill",
    title: sourceSkillId,
    content,
    source: agent,
    sourceAgentId: agent,
    sourceSkillId,
    sourceSkillPath: `/home/me/.${agent}/skills/${sourceSkillId}/SKILL.md`,
    sourceContentHash: createHash("sha256").update(content).digest("hex")
  }).id);
}

function row(db: Db, id: string): { status: string; memory_value: string; reason: string | null; version: number | null; updated_at: string } {
  return db.db.prepare(
    `SELECT status, memory_value, updated_at,
       json_extract(properties_json, '$.internal_info.archive_reason') AS reason,
       json_extract(properties_json, '$.internal_info.import_state_version') AS version
     FROM memories WHERE id = ?`
  ).get(id) as { status: string; memory_value: string; reason: string | null; version: number | null; updated_at: string };
}

describe("imported skill migration at startup", () => {
  it("authenticates an external client while serial legacy transactions are still running", async () => {
    const { db, service } = createTestService();
    const count = 147;
    for (let i = 0; i < count; i++) legacyImport(service, `skill-${i}`, "Synthetic historical Skill.");
    const server = createMemoryHttpServer({
      service, auth: { localServiceToken: "migration-test" }, workerPostHealthDelayMs: 0, workerStartupFallbackMs: 60_000
    });
    server.listen(0, "127.0.0.1");
    await once(server, "listening");
    const address = server.address();
    if (!address || typeof address === "string") throw new Error("expected a test port");
    const base = `http://127.0.0.1:${address.port}`;
    // The deadline must run outside the service's event loop to detect starvation.
    const probe = spawn(process.execPath, ["-e", `
      process.stdin.once("data", async () => {
        try {
          const r = await fetch(process.argv[1] + "/api/v1/auth/check", {
            headers: { authorization: "Bearer migration-test" }, signal: AbortSignal.timeout(1000)
          });
          process.exit(r.status === 200 ? 0 : 1);
        } catch { process.exit(2); }
      });
    `, base]);
    const exit = once(probe, "exit");
    let migrated = 0;
    const delay = new Int32Array(new SharedArrayBuffer(4));
    db.db.function("test_migrated", () => {
      if (++migrated === 1) probe.stdin.end("probe");
      Atomics.wait(delay, 0, 0, 9);
      return 0;
    });
    db.db.exec(`CREATE TEMP TRIGGER observe_migration AFTER UPDATE ON memories
      WHEN COALESCE(json_extract(OLD.properties_json, '$.internal_info.import_state_version'), 0) < ${IMPORTED_SKILL_STATE_VERSION}
       AND json_extract(NEW.properties_json, '$.internal_info.import_state_version') = ${IMPORTED_SKILL_STATE_VERSION}
      BEGIN SELECT test_migrated(); END`);
    try {
      const health = await fetch(base + "/api/v1/health");
      expect(health.status).toBe(200);
      expect((await exit)[0]).toBe(0);
      expect(migrated).toBeLessThan(count);
      await vi.waitFor(() => expect(migrated).toBe(count), { timeout: 20_000 });
    } finally {
      probe.kill();
      await closeMemoryHttpServer(server);
    }
  }, 30_000);

  it("keeps health and auth responsive during one long indivisible file-backed transaction", async () => {
    const { db, service: writer } = createTestService();
    const old = legacyImport(writer, "single-group", "First");
    const latest = legacyImport(writer, "single-group", "Second");
    // A persistent trigger is visible to the runtime's separate SQLite connection.
    db.db.exec(`CREATE TRIGGER slow_version BEFORE UPDATE ON memories
      WHEN OLD.id = '${old}' AND COALESCE(json_extract(OLD.properties_json, '$.internal_info.import_state_version'), 0) = 0
        AND json_extract(NEW.properties_json, '$.internal_info.import_state_version') = ${IMPORTED_SKILL_STATE_VERSION}
      BEGIN SELECT (WITH RECURSIVE slow(n) AS (VALUES(0) UNION ALL SELECT n+1 FROM slow WHERE n<20000000)
        SELECT sum(n) FROM slow); END`);
    const service = createTestMemoryService({ backend: new SqliteStorageBackend(db), llm: createFailingLlm() });
    const server = createMemoryHttpServer({ service, auth: { localServiceToken: "test" },
      workerPostHealthDelayMs: 0, workerStartupFallbackMs: 60_000 });
    server.listen(0, "127.0.0.1");
    await once(server, "listening");
    const address = server.address();
    if (!address || typeof address === "string") throw new Error("expected a test port");
    const base = `http://127.0.0.1:${address.port}/api/v1`;
    try {
      await probeDuringLongWrite(db.path, base);
      await vi.waitFor(() => expect([old, latest].map(id => row(db, id).version)).toEqual([
        IMPORTED_SKILL_STATE_VERSION, IMPORTED_SKILL_STATE_VERSION
      ]), { timeout: 20_000 });
    } finally {
      await closeMemoryHttpServer(server);
    }
  }, 30_000);

  it("commits every version in a group before shutdown and resumes remaining groups after reopening", async () => {
    const { db, service, root } = createTestService();
    const old = legacyImport(service, "shared", "Old instructions");
    const current = legacyImport(service, "shared", "Current instructions");
    const other = legacyImport(service, "other", "Independent instructions");
    const abort = new AbortController();
    db.db.function("stop_after_first_write", () => { abort.abort(); return 0; });
    db.db.exec(`CREATE TEMP TRIGGER stop_after_first_write AFTER UPDATE ON memories
      WHEN json_extract(NEW.properties_json, '$.internal_info.import_state_version') = ${IMPORTED_SKILL_STATE_VERSION}
      BEGIN SELECT stop_after_first_write(); END`);
    await expect(service.reconcileWorkerStartupInBackground(abort.signal)).rejects.toThrow();
    expect([old, current].map(id => row(db, id).version)).toEqual([IMPORTED_SKILL_STATE_VERSION, IMPORTED_SKILL_STATE_VERSION]);
    expect(row(db, other).version).toBeNull();
    const committed = [row(db, old), row(db, current)];
    await service.stop();
    db.close();

    const reopenedDb = new MemoryDb({ path: join(root, "memory.sqlite") });
    const reopened = createTestMemoryService({ db: reopenedDb, mode: "dev", llm: createFailingLlm() });
    await reopened.reconcileWorkerStartupInBackground(new AbortController().signal);
    expect(row(reopenedDb, other).version).toBe(IMPORTED_SKILL_STATE_VERSION);
    expect([row(reopenedDb, old), row(reopenedDb, current)]).toEqual(committed);
  });

  it("keeps large version groups intact and separates same-named skills from different agents", async () => {
    const { db, service } = createTestService();
    const ids = [];
    for (let i = 0; i < 160; i++) ids.push(legacyImport(service, "guide", `Revision ${i}`));
    const other = legacyImport(service, "guide", "Separate source", "cursor");
    // Observe committed state from a separate connection between worker turns.
    const counts: number[] = [];
    const reader = new MemoryDb({ path: db.path, readonly: true });
    const check = reader.db.prepare(`SELECT COUNT(*) AS n FROM memories WHERE memory_layer = 'Skill'
      AND json_extract(properties_json, '$.internal_info.source_agent_id') = 'hermes'
      AND json_extract(properties_json, '$.internal_info.import_state_version') = ?`);
    const sample = () => counts.push((check.get(IMPORTED_SKILL_STATE_VERSION) as { n: number }).n);
    const timer = setInterval(sample, 2);
    try {
      sample();
      await service.reconcileWorkerStartupInBackground(new AbortController().signal);
      sample();
      expect(new Set(counts)).toEqual(new Set([0, ids.length]));
      expect(ids.filter(id => row(db, id).status === "activated")).toHaveLength(1);
      expect(row(db, other)).toMatchObject({ status: "activated", version: IMPORTED_SKILL_STATE_VERSION });
    } finally {
      clearInterval(timer);
      reader.close();
    }
  }, 30_000);

  it("rolls back a failed version group, advances past it and can retry it later", async () => {
    const { db, service } = createTestService();
    const old = legacyImport(service, "broken", "Revision one");
    const current = legacyImport(service, "broken", "Revision two");
    const other = legacyImport(service, "healthy", "Other group");
    db.db.function("fail_second_version", (id) => {
      if (id === current) throw new Error("synthetic migration failure");
      return 0;
    });
    db.db.exec(`CREATE TEMP TRIGGER reject_one_version BEFORE UPDATE ON memories
      WHEN json_extract(NEW.properties_json, '$.internal_info.import_state_version') = ${IMPORTED_SKILL_STATE_VERSION}
      BEGIN SELECT fail_second_version(NEW.id); END`);
    const before = [row(db, old), row(db, current)];
    await service.reconcileWorkerStartupInBackground(new AbortController().signal);
    expect([row(db, old), row(db, current)]).toEqual(before);
    expect(row(db, other).version).toBe(IMPORTED_SKILL_STATE_VERSION);
    db.db.exec("DROP TRIGGER reject_one_version");
    await service.reconcileWorkerStartupInBackground(new AbortController().signal);
    expect([old, current].map(id => row(db, id).version)).toEqual([IMPORTED_SKILL_STATE_VERSION, IMPORTED_SKILL_STATE_VERSION]);
  });

  it("brings old records to the current state once and keeps unchanged ones untouched", () => {
    const { db, service } = createTestService();
    const older = legacyImport(service, "openai-docs", "Version A.");
    const newer = legacyImport(service, "openai-docs", "Version B.");
    // The old importer could leave two versions of one file active.
    db.db.prepare(`UPDATE memories SET status = 'activated', properties_json = json_set(properties_json, '$.status', 'activated') WHERE id = ?`).run(older);
    db.db.prepare(`UPDATE memories SET properties_json = json_set(properties_json, '$.internal_info.imported_at', '2026-01-01T00:00:00.000Z') WHERE id = ?`).run(older);
    const manual = legacyImport(service, "memmy-resume", "---\nname: memmy-resume\ndisable-model-invocation: true\n---\nResume.\n");
    const archivedByUser = legacyImport(service, "old-archive", "Archived body.");
    db.db.prepare(`UPDATE memories SET status = 'archived', properties_json = json_set(properties_json, '$.status', 'archived') WHERE id = ?`).run(archivedByUser);
    const deleted = legacyImport(service, "deleted", "DELETED-BODY-91c2 text.");
    db.db.prepare(`UPDATE memories SET status = 'deleted', deleted_at = '2026-02-01T00:00:00.000Z' WHERE id = ?`).run(deleted);
    db.db.prepare(`INSERT INTO api_logs (tool_name, input_json, output_json, called_at) VALUES ('memory_search', '{}', ?, '2026-02-01T00:00:00.000Z')`)
      .run(JSON.stringify({ candidates: [{ refId: deleted, content: "DELETED-BODY-91c2 text.", snippet: "DELETED-BODY-91c2" }] }));
    const newerUpdatedAt = row(db, newer).updated_at;

    service.reconcileWorkerStartup();

    expect(row(db, newer)).toMatchObject({ status: "activated", reason: null, version: IMPORTED_SKILL_STATE_VERSION, updated_at: newerUpdatedAt });
    expect(row(db, older)).toMatchObject({ status: "archived", reason: "superseded", version: IMPORTED_SKILL_STATE_VERSION });
    expect(row(db, manual)).toMatchObject({ status: "archived", reason: "invocation_policy", memory_value: "" });
    expect(row(db, archivedByUser)).toMatchObject({ status: "archived", reason: "user", memory_value: "Archived body." });
    expect(row(db, deleted)).toMatchObject({ status: "deleted", memory_value: "", version: IMPORTED_SKILL_STATE_VERSION });
    expect(db.db.prepare(`SELECT COUNT(*) AS n FROM api_logs WHERE output_json LIKE '%DELETED-BODY-91c2%'`).get()).toEqual({ n: 0 });

    const before = db.db.prepare(`SELECT id, updated_at, version, properties_json FROM memories ORDER BY id`).all();
    service.reconcileWorkerStartup();
    expect(db.db.prepare(`SELECT id, updated_at, version, properties_json FROM memories ORDER BY id`).all()).toEqual(before);
  });

  it("does not rewrite a migrated skill on the next scan when its file is unchanged", () => {
    const { db, service } = createTestService();
    const content = "Unchanged body.";
    const id = legacyImport(service, "stable", content);
    service.reconcileWorkerStartup();
    const jobs = () => (db.db.prepare(`SELECT COUNT(*) AS n FROM evolution_jobs WHERE job_type = 'embedding' AND target_memory_id = ?`).get(id) as { n: number }).n;
    const jobsBefore = jobs();

    const result = service.reconcileAgentSkills({
      namespace,
      sourceAgentId: "hermes",
      complete: true,
      skills: [{
        sourceSkillId: "stable",
        sourceSkillPath: "/home/me/.hermes/skills/stable/SKILL.md",
        title: "stable",
        content,
        contentHash: createHash("sha256").update(content).digest("hex"),
        modifiedAt: "2026-10-01T00:00:00.000Z"
      }]
    });

    expect(result.skills[0]).toMatchObject({ outcome: "unchanged", memoryId: id });
    expect(jobs()).toBe(jobsBefore);
  });

  it("migrates existing restrictions and deleted bodies while memory capture is disabled", async () => {
    let config: ReturnType<typeof configWithMemoryGates> = LEGACY_TEST_CONFIG;
    const { db, service } = createTestService({ config, configLoader: () => ({ config }), llm: createFailingLlm() });
    const manual = legacyImport(service, "manual-only", "---\nname: manual-only\ndisable-model-invocation: true\n---\nResume sqlite maintenance with private instructions.");
    const deleted = legacyImport(service, "old-deletion", "DELETED-DISABLED-CAPTURE body.");
    const ordinary = legacyImport(service, "ordinary", "Ordinary sqlite migration instructions.");
    db.db.prepare(`UPDATE memories SET status = 'deleted', deleted_at = '2026-03-01T00:00:00.000Z' WHERE id = ?`).run(deleted);
    db.db.prepare(`INSERT INTO api_logs (tool_name, input_json, output_json, called_at)
      VALUES ('memory_search', '{}', ?, '2026-03-01T00:00:00.000Z')`).run(JSON.stringify({
      candidates: [{ refId: deleted, content: "DELETED-DISABLED-CAPTURE body." }]
    }));
    config = configWithMemoryGates({ enableMemoryAdd: false, enableQueryRewrite: false });
    service.reloadConfig({ restartFailedProcessing: false });
    expect(() => service.addMemory({ content: "New capture is disabled" })).toThrow("memory add is disabled");

    service.reconcileWorkerStartup(1);

    expect.soft(row(db, manual)).toMatchObject({ status: "archived", reason: "invocation_policy", memory_value: "", version: IMPORTED_SKILL_STATE_VERSION });
    expect.soft(row(db, deleted)).toMatchObject({ status: "deleted", memory_value: "", version: IMPORTED_SKILL_STATE_VERSION });
    expect.soft(db.db.prepare(`SELECT COUNT(*) AS n FROM api_logs WHERE output_json LIKE '%DELETED-DISABLED-CAPTURE%'`).get()).toEqual({ n: 0 });
    expect(row(db, ordinary)).toMatchObject({ status: "activated", version: IMPORTED_SKILL_STATE_VERSION });
    expect(db.db.prepare(`SELECT json_extract(properties_json, '$.internal_info.retrieval_representation_version') AS version
      FROM memories WHERE id = ?`).get(ordinary)).toEqual({ version: null });
    const session = service.openSession({ namespace });
    const recalled = await service.search({ sessionId: session.sessionId, query: "resume sqlite maintenance private instructions", layers: ["Skill"] });
    expect(recalled.hits.map(hit => hit.id)).not.toContain(manual);
  });
});
