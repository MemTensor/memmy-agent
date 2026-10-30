import { createHash } from "node:crypto";
import { afterEach, describe, expect, it } from "vitest";
import type { AgentSkillReconcileSkill } from "../../../src/service/import/agent-skill-library.js";
import { DEFAULT_MEMMY_CONFIG } from "../../../src/index.js";
import { embeddingTextForMemory } from "../../../src/service/embedding/embedding-pipeline.js";
import { Repositories } from "../../../src/storage/repositories.js";
import { createCapturingEmbedder, createMemoryServiceFixture, runWorkerRounds } from "../../fixtures/memory-service-fixture.js";

const { cleanup, createTestService } = createMemoryServiceFixture();

afterEach(cleanup);

const namespace = { source: "claude_code", profileId: "default", userId: "skill-reconcile-user" };

function skill(sourceSkillId: string, content: string, overrides: Partial<AgentSkillReconcileSkill> = {}): AgentSkillReconcileSkill {
  return {
    sourceSkillId,
    sourceSkillPath: `/home/me/.codex/skills/${sourceSkillId}/SKILL.md`,
    title: sourceSkillId,
    content,
    contentHash: createHash("sha256").update(content).digest("hex"),
    modifiedAt: "2026-10-01T00:00:00.000Z",
    ...overrides
  };
}

type Db = ReturnType<typeof createTestService>["db"];

function rows(db: Db, sourceSkillId: string): Array<{ id: string; status: string; memory_value: string; reason: string | null }> {
  return db.db.prepare(
    `SELECT id, status, memory_value, json_extract(properties_json, '$.internal_info.archive_reason') AS reason
     FROM memories
     WHERE json_extract(properties_json, '$.internal_info.source_skill_id') = ?
     ORDER BY created_at, id`
  ).all(sourceSkillId) as Array<{ id: string; status: string; memory_value: string; reason: string | null }>;
}

function embeddingJobs(db: Db, memoryId: string): number {
  return (db.db.prepare(`SELECT COUNT(*) AS n FROM evolution_jobs WHERE job_type = 'embedding' AND target_memory_id = ?`)
    .get(memoryId) as { n: number }).n;
}

function inFts(db: Db, memoryId: string): boolean {
  return Boolean(db.db.prepare(`SELECT 1 FROM memories_fts WHERE id = ?`).get(memoryId));
}

describe("agent skill reconcile", () => {
  it("writes a skill once and leaves an unchanged skill alone on the next scan", () => {
    const { db, service } = createTestService();
    const first = service.reconcileAgentSkills({ namespace, sourceAgentId: "codex", complete: true, skills: [skill("review", "Review the diff.")] });
    const memoryId = first.skills[0]!.memoryId!;
    const updatedAt = (db.db.prepare(`SELECT updated_at FROM memories WHERE id = ?`).get(memoryId) as { updated_at: string }).updated_at;

    const second = service.reconcileAgentSkills({ namespace, sourceAgentId: "codex", complete: true, skills: [skill("review", "Review the diff.")] });
    const moved = service.reconcileAgentSkills({
      namespace,
      sourceAgentId: "codex",
      complete: true,
      skills: [skill("review", "Review the diff.", { sourceSkillPath: "/moved/review/SKILL.md", modifiedAt: "2026-10-02T00:00:00.000Z" })]
    });

    expect(first.skills[0]?.outcome).toBe("created");
    expect(second.skills[0]).toMatchObject({ outcome: "unchanged", memoryId });
    expect(moved.skills[0]).toMatchObject({ outcome: "unchanged", memoryId });
    expect(embeddingJobs(db, memoryId)).toBe(1);
    const row = db.db.prepare(
      `SELECT updated_at, json_extract(properties_json, '$.internal_info.source_skill_path') AS path FROM memories WHERE id = ?`
    ).get(memoryId) as { updated_at: string; path: string };
    expect(row).toEqual({ updated_at: updatedAt, path: "/moved/review/SKILL.md" });
  });

  it("keeps exactly one current version when a file changes and changes back", () => {
    const { db, service } = createTestService();
    const v1 = skill("openai-docs", "Version A.");
    const v2 = skill("openai-docs", "Version B.");
    service.reconcileAgentSkills({ namespace, sourceAgentId: "codex", complete: true, skills: [v1] });
    service.reconcileAgentSkills({ namespace, sourceAgentId: "codex", complete: true, skills: [v2] });
    const back = service.reconcileAgentSkills({ namespace, sourceAgentId: "codex", complete: true, skills: [v1] });

    const versions = rows(db, "openai-docs");
    expect(versions).toHaveLength(2);
    expect(versions.filter((version) => version.status === "activated")).toEqual([
      expect.objectContaining({ id: back.skills[0]!.memoryId, memory_value: "Version A." })
    ]);
    expect(versions.find((version) => version.status === "archived")).toMatchObject({ reason: "superseded", memory_value: "Version B." });
  });

  it("remembers a disconnect even when the user had archived every skill", () => {
    const { service } = createTestService();
    const created = service.reconcileAgentSkills({ namespace, sourceAgentId: "codex", complete: true, skills: [skill("pdf", "Body.")] });
    service.archiveMemory(created.skills[0]!.memoryId!, { namespace });
    expect(service.agentSkillsDisconnected("codex")).toBe(false);

    service.reconcileAgentSkills({ namespace, sourceAgentId: "codex", complete: false, disconnected: true, skills: [] });

    expect(service.agentSkillsDisconnected("codex")).toBe(true);
  });

  it("keeps archived Skills without a read_only field in embedding maintenance", () => {
    const { db } = createTestService();
    const repos = new Repositories(db.db);
    const at = "2026-10-01T00:00:00.000Z";
    // Feedback repairs and legacy migrations write Skills without the field.
    repos.memories.insert({
      id: "skill_legacy_archived", timeline: at, userId: namespace.userId, memoryType: "SkillMemory", status: "archived",
      visibility: "private", memoryKey: "skill:legacy", memoryValue: "Legacy guide.", tags: ["skill"],
      info: { title: "legacy", name: "legacy" },
      properties: { status: "archived", internal_info: { memory_layer: "Skill", memory_kind: "skill" } },
      memoryLayer: "Skill", version: 1, createdAt: at, updatedAt: at
    } as Parameters<typeof repos.memories.insert>[0]);

    expect(repos.vectors.maintenanceEntries().some((entry) => entry.id === "skill_legacy_archived")).toBe(true);
  });

  it("keeps the user's archive across file updates", () => {
    const { db, service } = createTestService();
    const created = service.reconcileAgentSkills({ namespace, sourceAgentId: "codex", complete: true, skills: [skill("pdf", "Old.")] });
    service.archiveMemory(created.skills[0]!.memoryId!, { namespace });

    service.reconcileAgentSkills({ namespace, sourceAgentId: "codex", complete: true, skills: [skill("pdf", "Old.")] });
    service.reconcileAgentSkills({ namespace, sourceAgentId: "codex", complete: true, skills: [skill("pdf", "New.")] });

    const versions = rows(db, "pdf");
    expect(versions.every((version) => version.status === "archived")).toBe(true);
    expect(versions.find((version) => version.memory_value === "New.")?.reason).toBe("user");
  });

  it("does not bring back a skill the user deleted and removes its body everywhere", async () => {
    const { db, service } = createTestService();
    const marker = "UNIQUE-SKILL-BODY-7f3a";
    const created = service.reconcileAgentSkills({
      namespace,
      sourceAgentId: "codex",
      complete: true,
      skills: [skill("secret-skill", `Run the ${marker} procedure for sqlite migrations.`)]
    });
    const memoryId = created.skills[0]!.memoryId!;
    await runWorkerRounds(service, 2, 50);
    // A panel rebuild goes through the embedding retry queue, which logs its
    // changes under the retry id with this skill as targetId.
    service.rebuildEmbeddings();
    await runWorkerRounds(service, 2, 50);
    expect((db.db.prepare(`SELECT COUNT(*) AS n FROM memory_change_log WHERE json_extract(after_json, '$.targetId') = ?`).get(memoryId) as { n: number }).n)
      .toBeGreaterThan(0);
    const session = service.openSession({ namespace: { ...namespace, source: "claude_code" } });
    const recall = await service.search({ sessionId: session.sessionId, query: "procedure for sqlite migrations", layers: ["Skill"], limit: 5, includeInjectedContext: true });
    expect(recall.hits.map((hit) => hit.id)).toContain(memoryId);
    expect(db.db.prepare(`SELECT status FROM embedding_retry_queue WHERE target_id = ?`).get(memoryId)).toEqual({ status: "succeeded" });

    service.deleteMemory(memoryId, { namespace });
    const again = service.reconcileAgentSkills({
      namespace,
      sourceAgentId: "codex",
      complete: true,
      skills: [skill("secret-skill", `Run the ${marker} procedure, updated.`)]
    });

    expect(again.skills[0]?.outcome).toBe("deleted_by_user");
    expect(rows(db, "secret-skill")).toEqual([expect.objectContaining({ id: memoryId, status: "deleted", memory_value: "" })]);
    for (const table of ["memories", "memory_change_log", "audit_logs", "api_logs", "recall_events", "embedding_retry_queue"]) {
      const columns = (db.db.prepare(`PRAGMA table_info(${table})`).all() as Array<{ name: string; type: string }>)
        .filter((column) => /TEXT/i.test(column.type))
        .map((column) => column.name);
      const leaked = db.db.prepare(
        `SELECT COUNT(*) AS n FROM ${table} WHERE ${columns.map((column) => `COALESCE(${column}, '') LIKE ?`).join(" OR ")}`
      ).get(...columns.map(() => `%${marker}%`)) as { n: number };
      expect({ table, leaked: leaked.n }).toEqual({ table, leaked: 0 });
    }
  });

  it("archives a skill whose file is gone only when the scan was complete", () => {
    const { db, service } = createTestService();
    service.reconcileAgentSkills({ namespace, sourceAgentId: "codex", complete: true, skills: [skill("gone", "Body."), skill("kept", "Body 2.")] });

    service.reconcileAgentSkills({ namespace, sourceAgentId: "codex", complete: false, skills: [skill("kept", "Body 2.")] });
    expect(rows(db, "gone")[0]?.status).toBe("activated");

    service.reconcileAgentSkills({ namespace, sourceAgentId: "codex", complete: true, skills: [skill("kept", "Body 2.")] });
    expect(rows(db, "gone")[0]).toMatchObject({ status: "archived", reason: "source_missing" });

    service.reconcileAgentSkills({ namespace, sourceAgentId: "codex", complete: true, skills: [skill("gone", "Body."), skill("kept", "Body 2.")] });
    expect(rows(db, "gone")[0]).toMatchObject({ status: "activated", reason: null });
  });

  it("keeps only the identity of user-invoked skills and of a disconnected source", () => {
    const { db, service } = createTestService();
    service.reconcileAgentSkills({
      namespace,
      sourceAgentId: "codex",
      complete: true,
      skills: [
        skill("memmy-resume", "Resume a task.", { disableModelInvocation: true }),
        skill("review-agent", "Review.", { allowImplicitInvocation: false }),
        skill("shared", "Shared body.")
      ]
    });
    for (const id of ["memmy-resume", "review-agent"]) {
      const [row] = rows(db, id);
      expect(row).toMatchObject({ status: "archived", reason: "invocation_policy", memory_value: "" });
      expect(inFts(db, row!.id)).toBe(false);
    }

    service.reconcileAgentSkills({ namespace, sourceAgentId: "codex", complete: false, disconnected: true, skills: [] });
    const [disconnected] = rows(db, "shared");
    expect(disconnected).toMatchObject({ status: "archived", reason: "disconnected", memory_value: "" });
    expect(inFts(db, disconnected!.id)).toBe(false);

    service.reconcileAgentSkills({ namespace, sourceAgentId: "codex", complete: true, skills: [skill("shared", "Shared body.")] });
    expect(rows(db, "shared")[0]).toMatchObject({ status: "activated", reason: null, memory_value: "Shared body." });
  });

  it("records enabled plugin skills as identity-only registrations", () => {
    const { db, service } = createTestService();
    const result = service.reconcileAgentSkills({
      namespace,
      sourceAgentId: "claude_code",
      complete: true,
      skills: [],
      registrations: [{ sourceSkillId: "plugin:superpowers@market/brainstorming", sourceSkillPath: "/p/brainstorming/SKILL.md", name: "Brainstorming", pluginId: "superpowers@market" }],
      registrationsComplete: true
    });
    const [row] = rows(db, "plugin:superpowers@market/brainstorming");

    expect(result.registrations).toBe(1);
    expect(row).toMatchObject({ status: "archived", reason: "registration", memory_value: "" });
    expect(inFts(db, row!.id)).toBe(false);
    expect(db.db.prepare(`SELECT json_extract(properties_json, '$.internal_info.normalized_name') AS name FROM memories WHERE id = ?`).get(row!.id))
      .toEqual({ name: "brainstorming" });
    const panel = service.panelItems({ namespace, layer: "Skill" });
    expect(panel.items.map((item) => item.id)).not.toContain(row!.id);

    service.reconcileAgentSkills({ namespace, sourceAgentId: "claude_code", complete: true, skills: [], registrations: [], registrationsComplete: true });
    expect(rows(db, "plugin:superpowers@market/brainstorming")[0]?.reason).toBe("source_missing");
  });

  it("adopts a record written by the old memory.add import instead of duplicating it", () => {
    const { db, service } = createTestService();
    const content = "Legacy body.";
    const legacy = service.addMemory({
      namespace,
      requestId: "legacy-skill",
      adapterId: "agent-source:codex",
      layer: "Skill",
      title: "legacy",
      content,
      source: "codex",
      sourceAgentId: "codex",
      sourceSkillId: "legacy",
      sourceContentHash: createHash("sha256").update(content).digest("hex")
    });

    const result = service.reconcileAgentSkills({ namespace, sourceAgentId: "codex", complete: true, skills: [skill("legacy", content)] });

    expect(result.skills[0]).toMatchObject({ outcome: "updated", memoryId: legacy.id });
    expect(rows(db, "legacy")).toHaveLength(1);
  });

  it("does not compute embeddings for identity-only records", async () => {
    const { db, service } = createTestService();
    service.reconcileAgentSkills({
      namespace,
      sourceAgentId: "codex",
      complete: true,
      skills: [skill("active", "Active body."), skill("manual", "Manual body.", { disableModelInvocation: true })]
    });
    await runWorkerRounds(service, 2, 50);

    const vectors = (id: string) => (db.db.prepare(`SELECT COUNT(*) AS n FROM memory_vector_entries WHERE memory_id = ?`).get(id) as { n: number }).n;
    expect(vectors(rows(db, "active")[0]!.id)).toBeGreaterThan(0);
    expect(vectors(rows(db, "manual")[0]!.id)).toBe(0);
  });

  it("rebuilds imported skills from their retrieval text and still rebuilds other records", async () => {
    const { db, service } = createTestService();
    service.reconcileAgentSkills({
      namespace,
      sourceAgentId: "codex",
      complete: true,
      skills: [skill("rebuild", "Rebuild body."), skill("hidden", "Hidden.", { disableModelInvocation: true })]
    });
    const trace = service.addMemory({ namespace, layer: "L1", title: "note", content: "A plain L1 note body." });

    await service.rebuildEmbeddings();

    const retries = db.db.prepare(`SELECT target_id, source_text FROM embedding_retry_queue`).all() as Array<{ target_id: string; source_text: string }>;
    const imported = retries.find((retry) => retry.target_id === rows(db, "rebuild")[0]!.id);
    expect(imported?.source_text).toContain("rebuild");
    expect(retries.some((retry) => retry.target_id === rows(db, "hidden")[0]!.id)).toBe(false);
    expect(retries.some((retry) => retry.target_id === trace.id)).toBe(true);
  });

  it("settles retries of imported skills before calling the embedder", async () => {
    const seen: string[] = [];
    const { db, service } = createTestService({ embedder: createCapturingEmbedder(seen) });
    service.reconcileAgentSkills({
      namespace,
      sourceAgentId: "codex",
      complete: true,
      skills: [skill("live", "Live body."), skill("manual", "MANUAL-ONLY body.", { disableModelInvocation: true })]
    });
    await runWorkerRounds(service, 2, 50);
    seen.length = 0;
    const insert = db.db.prepare(
      `INSERT INTO embedding_retry_queue (id, target_kind, target_id, vector_field, source_text, status, next_attempt_at, created_at, updated_at)
       VALUES (?, 'skill', ?, 'vec', ?, 'pending', 0, '2026-10-01T00:00:00.000Z', '2026-10-01T00:00:00.000Z')`
    );
    insert.run("retry-manual", rows(db, "manual")[0]!.id, "MANUAL-ONLY body.");
    insert.run("retry-stale", rows(db, "live")[0]!.id, "STALE TEXT");

    await runWorkerRounds(service, 3, 50);

    expect(seen.some((text) => text.includes("MANUAL-ONLY"))).toBe(false);
    expect(seen.some((text) => text.includes("STALE TEXT"))).toBe(false);
    expect(db.db.prepare(`SELECT status FROM embedding_retry_queue WHERE id = 'retry-manual'`).get()).toEqual({ status: "succeeded" });
  });

  it("lets the user undo an archive, back to the state the source implies", () => {
    const { db, service } = createTestService();
    const [plain, manual] = service.reconcileAgentSkills({
      namespace,
      sourceAgentId: "codex",
      complete: true,
      skills: [skill("plain", "Plain body."), skill("manual", "Manual body.")]
    }).skills;
    service.archiveMemory(plain!.memoryId!, { namespace });
    service.archiveMemory(manual!.memoryId!, { namespace });
    // The source later marks one of them user-invoked only.
    service.reconcileAgentSkills({
      namespace,
      sourceAgentId: "codex",
      complete: true,
      skills: [skill("plain", "Plain body."), skill("manual", "Manual body.", { disableModelInvocation: true })]
    });

    expect(service.reactivateSkill(plain!.memoryId!, { namespace }).status).toBe("activated");
    expect(service.reactivateSkill(manual!.memoryId!, { namespace }).status).toBe("archived");
    expect(rows(db, "manual")[0]).toMatchObject({ reason: "invocation_policy", memory_value: "" });

    service.reconcileAgentSkills({
      namespace,
      sourceAgentId: "codex",
      complete: true,
      skills: [skill("plain", "Plain body."), skill("manual", "Manual body.", { disableModelInvocation: true })]
    });
    expect(rows(db, "plain")[0]).toMatchObject({ status: "activated", reason: null });
  });

  it("does not undo archives made by scans and reactivates generated skills", () => {
    const { db, service } = createTestService();
    service.reconcileAgentSkills({ namespace, sourceAgentId: "codex", complete: true, skills: [skill("gone", "Body.")] });
    service.reconcileAgentSkills({ namespace, sourceAgentId: "codex", complete: true, skills: [] });
    const gone = rows(db, "gone")[0]!;
    expect(service.reactivateSkill(gone.id, { namespace }).status).toBe("archived");

    const generated = service.addMemory({ namespace, layer: "Skill", title: "generated", content: "Generated body.", source: "codex" });
    db.db.prepare(`UPDATE memories SET properties_json = json_set(properties_json, '$.internal_info.read_only', json('false')) WHERE id = ?`).run(generated.id);
    service.archiveMemory(generated.id, { namespace });
    expect(service.reactivateSkill(generated.id, { namespace }).status).toBe("activated");
  });

  it("restores a user archive to what happened at the source meanwhile", () => {
    const { db, service } = createTestService();
    const [gone, cut] = service.reconcileAgentSkills({
      namespace,
      sourceAgentId: "codex",
      complete: true,
      skills: [skill("gone-later", "Gone body."), skill("cut-later", "Cut body.")]
    }).skills;
    service.archiveMemory(gone!.memoryId!, { namespace });
    service.reconcileAgentSkills({ namespace, sourceAgentId: "codex", complete: true, skills: [skill("cut-later", "Cut body.")] });

    expect(service.reactivateSkill(gone!.memoryId!, { namespace }).status).toBe("archived");
    expect(rows(db, "gone-later")[0]).toMatchObject({ reason: "source_missing" });

    service.archiveMemory(cut!.memoryId!, { namespace });
    service.reconcileAgentSkills({ namespace, sourceAgentId: "codex", complete: false, disconnected: true, skills: [] });

    expect(service.reactivateSkill(cut!.memoryId!, { namespace }).status).toBe("archived");
    expect(rows(db, "cut-later")[0]).toMatchObject({ reason: "disconnected", memory_value: "" });
    expect(inFts(db, cut!.memoryId!)).toBe(false);
  });

  it("leaves plugin registrations out of the overview counts", () => {
    const { db, service } = createTestService();
    service.reconcileAgentSkills({
      namespace,
      sourceAgentId: "claude_code",
      complete: true,
      skills: [],
      registrations: [{ sourceSkillId: "plugin:superpowers@market/brainstorming", sourceSkillPath: "/p/brainstorming/SKILL.md", name: "brainstorming" }],
      registrationsComplete: true
    });
    const repos = new Repositories(db.db);

    expect(repos.memories.countByLayer().Skill).toBe(0);
    expect(repos.memories.countByStatus().archived).toBe(0);
    expect(repos.memories.listStats()).toHaveLength(0);
  });

  it("keeps reconciling the current version after the user deletes an old one", () => {
    const { db, service } = createTestService();
    const a = service.reconcileAgentSkills({ namespace, sourceAgentId: "codex", complete: true, skills: [skill("evolving", "Version A.")] }).skills[0]!.memoryId!;
    service.reconcileAgentSkills({ namespace, sourceAgentId: "codex", complete: true, skills: [skill("evolving", "Version B.")] });
    service.deleteMemory(a, { namespace });

    const c = service.reconcileAgentSkills({ namespace, sourceAgentId: "codex", complete: true, skills: [skill("evolving", "Version C.")] });
    expect(c.skills[0]?.outcome).toBe("created");
    expect(rows(db, "evolving").filter((version) => version.status === "activated")).toEqual([
      expect.objectContaining({ id: c.skills[0]!.memoryId, memory_value: "Version C." })
    ]);
    // Going back to the deleted content does not bring that version back.
    expect(service.reconcileAgentSkills({ namespace, sourceAgentId: "codex", complete: true, skills: [skill("evolving", "Version A.")] })
      .skills[0]?.outcome).toBe("deleted_by_user");
    // ...and C, which the source no longer has, stops being recalled.
    expect(rows(db, "evolving").some((version) => version.status === "activated")).toBe(false);

    service.reconcileAgentSkills({ namespace, sourceAgentId: "codex", complete: true, skills: [] });
    expect(rows(db, "evolving").some((version) => version.status === "activated")).toBe(false);
  });

  it("blocks a skill whose current version the user deleted, across new versions", () => {
    const { db, service } = createTestService();
    const current = service.reconcileAgentSkills({ namespace, sourceAgentId: "codex", complete: true, skills: [skill("unwanted", "V1.")] }).skills[0]!.memoryId!;
    service.deleteMemory(current, { namespace });

    expect(service.reconcileAgentSkills({ namespace, sourceAgentId: "codex", complete: true, skills: [skill("unwanted", "V2.")] })
      .skills[0]?.outcome).toBe("deleted_by_user");
    expect(rows(db, "unwanted")).toHaveLength(1);
  });

  it("remembers what happened at the source while the user keeps a skill archived", () => {
    const { db, service } = createTestService();
    const id = service.reconcileAgentSkills({ namespace, sourceAgentId: "codex", complete: true, skills: [skill("kept", "Body.")] }).skills[0]!.memoryId!;
    service.archiveMemory(id, { namespace });
    const state = () => (db.db.prepare(`SELECT json_extract(properties_json, '$.internal_info.source_state') AS s FROM memories WHERE id = ?`).get(id) as { s: string | null }).s;

    service.reconcileAgentSkills({ namespace, sourceAgentId: "codex", complete: true, skills: [] });
    expect(state()).toBe("source_missing");
    service.reconcileAgentSkills({ namespace, sourceAgentId: "codex", complete: true, skills: [skill("kept", "Body.")] });
    expect(state()).toBe("present");
    service.reconcileAgentSkills({ namespace, sourceAgentId: "codex", complete: false, disconnected: true, skills: [] });
    expect(state()).toBe("disconnected");
    expect(rows(db, "kept")[0]).toMatchObject({ status: "archived", reason: "user" });
  });

  it("drops a queued embedding job when the skill stops being recallable before it runs", async () => {
    const seen: string[] = [];
    const { db, service } = createTestService({ embedder: createCapturingEmbedder(seen) });
    const id = service.reconcileAgentSkills({ namespace, sourceAgentId: "codex", complete: true, skills: [skill("late", "LATE-BODY text.")] }).skills[0]!.memoryId!;
    expect(embeddingJobs(db, id)).toBe(1);
    service.reconcileAgentSkills({ namespace, sourceAgentId: "codex", complete: false, disconnected: true, skills: [] });

    await runWorkerRounds(service, 2, 50);

    expect(seen.some((text) => text.includes("LATE-BODY") || text.includes("late"))).toBe(false);
    expect((db.db.prepare(`SELECT COUNT(*) AS n FROM memory_vector_entries WHERE memory_id = ?`).get(id) as { n: number }).n).toBe(0);
    expect(db.db.prepare(`SELECT status FROM evolution_jobs WHERE job_type = 'embedding' AND target_memory_id = ?`).all(id))
      .toEqual([{ status: "succeeded" }]);
  });

  it("re-embeds the current text when a retry carried an outdated one", async () => {
    const seen: string[] = [];
    const { db, service } = createTestService({ embedder: createCapturingEmbedder(seen) });
    const id = service.reconcileAgentSkills({ namespace, sourceAgentId: "codex", complete: true, skills: [skill("fresh", "Fresh body.")] }).skills[0]!.memoryId!;
    await runWorkerRounds(service, 2, 50);
    seen.length = 0;
    db.db.prepare(
      `INSERT INTO embedding_retry_queue (id, target_kind, target_id, vector_field, source_text, status, next_attempt_at, created_at, updated_at)
       VALUES ('retry-old-text', 'skill', ?, 'vec', 'OUTDATED TEXT', 'pending', 0, '2026-10-01T00:00:00.000Z', '2026-10-01T00:00:00.000Z')`
    ).run(id);

    await runWorkerRounds(service, 3, 50);

    expect(seen).not.toContain("OUTDATED TEXT");
    expect(seen.some((text) => text.includes("Fresh body."))).toBe(true);
  });

  it("rebuilds L2, L3 and generated skills exactly as before", async () => {
    const { db, service } = createTestService();
    service.reconcileAgentSkills({ namespace, sourceAgentId: "codex", complete: true, skills: [skill("imported", "Imported body.")] });
    const l2 = service.addMemory({ namespace, layer: "L2", title: "policy", content: "Prefer focused tests." });
    const l3 = service.addMemory({ namespace, layer: "L3", title: "world", content: "The repo uses vitest." });
    const repos = new Repositories(db.db);
    const at = "2026-10-01T00:00:00.000Z";
    const generated = repos.memories.insert({
      id: "skill_generated_rebuild",
      timeline: at,
      userId: namespace.userId,
      memoryType: "SkillMemory",
      status: "activated",
      visibility: "private",
      memoryKey: "skill:direct:cluster-1",
      memoryValue: "# generated\n\nGenerated guide body.",
      tags: ["skill"],
      info: { title: "generated", name: "generated" },
      properties: {
        status: "activated",
        internal_info: {
          memory_layer: "Skill",
          memory_kind: "skill",
          source: "worker.skill_batch_evolve.v1",
          read_only: false,
          skill: { name: "generated", eta: 0.6, status: "active", invocation_guide: "# generated\n\nGenerated guide body." }
        }
      },
      memoryLayer: "Skill",
      version: 1,
      createdAt: at,
      updatedAt: at
    } as Parameters<typeof repos.memories.insert>[0]);

    await service.rebuildEmbeddings();

    const text = (id: string) => (db.db.prepare(`SELECT source_text FROM embedding_retry_queue WHERE target_id = ?`).get(id) as { source_text: string } | undefined)?.source_text;
    const value = (id: string) => (db.db.prepare(`SELECT memory_value FROM memories WHERE id = ?`).get(id) as { memory_value: string }).memory_value;
    // Other records keep the embedding text the rebuild has always used for them.
    for (const id of [l2.id, l3.id, generated.id]) expect(text(id)).toBe(embeddingTextForMemory(repos.memories.get(id)!));
    expect(text(rows(db, "imported")[0]!.id)).not.toBe(value(rows(db, "imported")[0]!.id));
    void DEFAULT_MEMMY_CONFIG;
  });
});
