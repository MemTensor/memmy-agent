import { createHash } from "node:crypto";
import { afterEach, describe, expect, it } from "vitest";
import { retrievalDocumentIsCurrent } from "../../../src/algorithm/plugin-algorithms.js";
import { DEFAULT_MEMMY_CONFIG } from "../../../src/index.js";
import { embeddingTextForMemory } from "../../../src/service/embedding/embedding-pipeline.js";
import { Repositories } from "../../../src/storage/repositories.js";
import type { AgentSkillReconcileSkill } from "../../../src/service/import/agent-skill-library.js";
import { createCapturingEmbedder, createMemoryServiceFixture, runWorkerRounds } from "../../fixtures/memory-service-fixture.js";

const { cleanup, createTestService } = createMemoryServiceFixture();

afterEach(cleanup);

const userId = "skill-retrieval-text-user";
const codex = { source: "codex", profileId: "default", userId };

const BODY = [
  "---",
  "name: memory-systems",
  "description: >",
  "  Design memory layers",
  "  for long-running agents.",
  "---",
  "",
  "# Memory systems",
  "Long body about vector stores, eviction and recall budgets."
].join("\n");

function skill(overrides: Partial<AgentSkillReconcileSkill> = {}): AgentSkillReconcileSkill {
  return {
    sourceSkillId: "memory-systems",
    sourceSkillPath: "/home/me/.codex/skills/memory-systems/SKILL.md",
    title: "memory-systems",
    content: BODY,
    contentHash: createHash("sha256").update(BODY).digest("hex"),
    modifiedAt: "2026-10-01T00:00:00.000Z",
    description: "Design memory layers for long-running agents.",
    ...overrides
  };
}

type Db = ReturnType<typeof createTestService>["db"];

function stored(db: Db, id: string): { summary: string; blurb: string | null; version: number | null; updated_at: string; fts: string | null } {
  return db.db.prepare(
    `SELECT json_extract(info_json, '$.summary') AS summary,
       json_extract(properties_json, '$.internal_info.skill.procedure_json.retrievalBlurb') AS blurb,
       json_extract(properties_json, '$.internal_info.retrieval_representation_version') AS version,
       updated_at,
       (SELECT memory_value FROM memories_fts WHERE memories_fts.id = memories.id) AS fts
     FROM memories WHERE id = ?`
  ).get(id) as { summary: string; blurb: string | null; version: number | null; updated_at: string; fts: string | null };
}

function pendingEmbeddings(db: Db, id: string): number {
  return (db.db.prepare(`SELECT COUNT(*) AS n FROM evolution_jobs WHERE job_type = 'embedding' AND target_memory_id = ? AND status IN ('queued', 'leased')`).get(id) as { n: number }).n;
}

function propertiesOf(db: Db, id: string): string {
  return (db.db.prepare(`SELECT properties_json FROM memories WHERE id = ?`).get(id) as { properties_json: string }).properties_json;
}

function repoMemory(db: Db, id: string) {
  return new Repositories(db.db).memories.get(id)!;
}

describe("imported skill summary and retrieval text", () => {
  it("uses the frontmatter description as summary, injected description and retrieval text", async () => {
    const { db, service } = createTestService();
    const [result] = service.reconcileAgentSkills({ namespace: codex, sourceAgentId: "codex", complete: true, skills: [skill()] }).skills;
    const id = result!.memoryId!;
    await runWorkerRounds(service, 2, 50);

    const row = stored(db, id);
    expect(row).toMatchObject({ summary: "Design memory layers for long-running agents.", blurb: "Design memory layers for long-running agents.", version: 1 });
    expect(row.fts).toContain("Design memory layers");
    expect(row.fts).not.toContain("eviction");

    const session = service.openSession({ namespace: { ...codex, source: "claude_code" } });
    const recall = await service.search({ sessionId: session.sessionId, query: "design memory layers for agents", layers: ["Skill"], limit: 5, includeInjectedContext: true });
    expect(recall.hits.map((hit) => hit.id)).toContain(id);
    expect(recall.injectedContext.markdown).toContain("Design memory layers for long-running agents.");
    expect(recall.injectedContext.markdown).not.toContain("--- name: memory-systems");
  });

  it("switches existing skills at startup and can restore what they had", async () => {
    const seen: string[] = [];
    const { db, service } = createTestService({ embedder: createCapturingEmbedder(seen) });
    const legacy = service.addMemory({
      namespace: codex,
      requestId: "legacy-memory-systems",
      adapterId: "agent-source:codex",
      layer: "Skill",
      title: "memory-systems",
      content: BODY,
      source: "codex",
      sourceAgentId: "codex",
      sourceSkillId: "memory-systems",
      sourceContentHash: createHash("sha256").update(BODY).digest("hex")
    });
    await runWorkerRounds(service, 2, 50);
    const before = stored(db, legacy.id);
    const textBefore = embeddingTextForMemory(repoMemory(db, legacy.id));
    expect(before.summary).toBe("---");

    service.reconcileWorkerStartup();
    const upgraded = stored(db, legacy.id);
    expect(upgraded).toMatchObject({
      summary: "Design memory layers for long-running agents.",
      blurb: "Design memory layers for long-running agents.",
      version: 1,
      updated_at: before.updated_at
    });
    // The startup repair queued an embedding of the new text.
    expect(pendingEmbeddings(db, legacy.id)).toBe(1);

    // Restored before that job runs: the job embeds what the record has now.
    expect(service.restoreImportedSkillRetrievalText()).toEqual({ restored: 1 });
    expect(stored(db, legacy.id)).toMatchObject({ summary: "---", blurb: null, version: null, updated_at: before.updated_at });
    expect(stored(db, legacy.id).fts).toBe(before.fts);
    const restored = repoMemory(db, legacy.id);
    expect(embeddingTextForMemory(restored)).toBe(textBefore);
    seen.length = 0;
    await runWorkerRounds(service, 2, 50);
    expect(seen.some((text) => text.includes("Design memory layers for long-running agents."))).toBe(false);
    expect(retrievalDocumentIsCurrent(repoMemory(db, legacy.id))).toBe(true);
  });

  it("drops the earlier retrieval text when the skill is deleted", () => {
    const { db, service } = createTestService();
    const legacy = service.addMemory({
      namespace: codex,
      requestId: "legacy-memory-systems",
      adapterId: "agent-source:codex",
      layer: "Skill",
      title: "memory-systems",
      content: BODY,
      source: "codex",
      sourceAgentId: "codex",
      sourceSkillId: "memory-systems",
      sourceContentHash: createHash("sha256").update(BODY).digest("hex")
    });
    service.reconcileWorkerStartup();
    expect(propertiesOf(db, legacy.id)).toContain("retrieval_previous");

    service.deleteMemory(legacy.id, { namespace: codex });

    const properties = propertiesOf(db, legacy.id);
    expect(properties).not.toContain("retrieval_previous");
    expect(properties).not.toContain("Design memory layers");
    expect(properties).not.toContain("eviction");
  });

  it("points to the source directory only when it has supporting files", async () => {
    const config = {
      ...DEFAULT_MEMMY_CONFIG,
      algorithm: {
        ...DEFAULT_MEMMY_CONFIG.algorithm,
        retrieval: { ...DEFAULT_MEMMY_CONFIG.algorithm.retrieval, skillInjectionMode: "full" as const }
      }
    };
    const { service } = createTestService({ config });
    const [withFiles, plain] = service.reconcileAgentSkills({
      namespace: codex,
      sourceAgentId: "codex",
      complete: true,
      skills: [
        skill({ hasSupportingFiles: true }),
        skill({ sourceSkillId: "plain", sourceSkillPath: "/home/me/.codex/skills/plain/SKILL.md", title: "plain", hasSupportingFiles: false })
      ]
    }).skills;
    await runWorkerRounds(service, 2, 50);

    expect(service.getMemory(withFiles!.memoryId!, { namespace: codex }).body).toContain("source dir: /home/me/.codex/skills/memory-systems");
    expect(service.getMemory(plain!.memoryId!, { namespace: codex }).body).not.toContain("source dir:");
    const session = service.openSession({ namespace: { ...codex, source: "claude_code" } });
    const recall = await service.search({ sessionId: session.sessionId, query: "design memory layers for agents", layers: ["Skill"], limit: 5, includeInjectedContext: true });
    expect(recall.injectedContext.markdown).toContain("source dir: /home/me/.codex/skills/memory-systems");
  });
});
