import "../../fixtures/isolated-user-home.js";
import { afterEach, describe, expect, it } from "vitest";
import { embeddingTextForMemory } from "../../../src/service/embedding/embedding-pipeline.js";
import { retrievalDocumentIsCurrent } from "../../../src/algorithm/plugin-algorithms.js";
import { Repositories } from "../../../src/storage/repositories.js";
import { createMemoryServiceFixture, createCapturingEmbedder, createFailingLlm, runWorkerRounds } from "../../fixtures/memory-service-fixture.js";

const fixture = createMemoryServiceFixture();
afterEach(fixture.cleanup);
const namespace = { source: "codex", profileId: "default", userId: "retrieval-gate-user" };
const body = "---\nname: recovery-helper\ndescription: Recover the service safely.\n---\nRun restore:checkpoint before restarting the queue worker.";

describe("imported Skill retrieval quality gate", () => {
  it("keeps full-body retrieval evidence while displaying and injecting the description", async () => {
    const seen: string[] = [];
    const { db, service } = fixture.createTestService({ llm: createFailingLlm(), embedder: createCapturingEmbedder(seen) });
    const id = service.reconcileAgentSkills({ namespace, sourceAgentId: "codex", complete: true, skills: [{
      sourceSkillId: "recovery-helper", sourceSkillPath: "/fixture/recovery-helper/SKILL.md", title: "recovery-helper",
      content: body, contentHash: "fixture", modifiedAt: "2026-11-05T00:00:00.000Z", description: "Recover the service safely."
    }] }).skills[0]!.memoryId!;
    const repos = new Repositories(db.db);
    expect(embeddingTextForMemory(repos.memories.get(id)!)).toContain("restore:checkpoint");
    expect(repos.memories.get(id)?.info.summary).toBe("Recover the service safely.");
    const fts = db.db.prepare("SELECT memory_value FROM memories_fts WHERE id = ?").get(id) as { memory_value: string };
    expect(fts.memory_value).toContain("restore:checkpoint");
    await runWorkerRounds(service, 2, 50);
    expect(seen.some(text => text.includes("restore:checkpoint"))).toBe(true);
    const session = service.openSession({ namespace: { ...namespace, source: "claude_code" } });
    const recall = await service.search({ sessionId: session.sessionId, query: "restore:checkpoint", layers: ["Skill"], includeInjectedContext: true });
    expect(recall.hits.map(hit => hit.id)).toContain(id);
    expect(recall.injectedContext.markdown).toContain("Recover the service safely.");
    expect(recall.injectedContext.markdown).not.toContain("before restarting");
  });

  it("repairs a persisted v3 short index once and protects the cold embedding path", async () => {
    const { db, service } = fixture.createTestService({ llm: createFailingLlm() });
    // Seed a verified source observation before emulating an old representation.
    // A direct Codex body alone provides no evidence about agents/openai.yaml.
    const id = service.reconcileAgentSkills({ namespace, sourceAgentId: "codex", complete: true, skills: [{
      sourceSkillId: "recovery-helper", sourceSkillPath: "/fixture/recovery-helper/SKILL.md", title: "recovery-helper",
      content: body, contentHash: "fixture", modifiedAt: "2026-11-05T00:00:00.000Z"
    }] }).skills[0]!.memoryId!;
    db.db.prepare("UPDATE memories SET properties_json = json_set(properties_json, '$.internal_info.retrieval_representation_version', 3, '$.internal_info.retrieval_index.source_hash', 'old-description-hash') WHERE id = ?").run(id);
    db.db.prepare("UPDATE memories_fts SET memory_value = ? WHERE id = ?").run("recovery-helper\nRecover the service safely.", id);
    const repos = new Repositories(db.db);
    expect(embeddingTextForMemory(repos.memories.get(id)!)).toContain("restore:checkpoint");
    service.reconcileWorkerStartup(1);
    expect(repos.memories.get(id)?.properties.internal_info.retrieval_representation_version).toBeGreaterThan(3);
    await runWorkerRounds(service, 2, 50);
    expect(retrievalDocumentIsCurrent(repos.memories.get(id)!)).toBe(true);
    const fts = db.db.prepare("SELECT memory_value FROM memories_fts WHERE id = ?").get(id) as { memory_value: string };
    expect(fts.memory_value).toContain("restore:checkpoint");
    const once = repos.memories.get(id)!;
    service.reconcileWorkerStartup(1);
    expect(repos.memories.get(id)?.version).toBe(once.version);
    expect(repos.memories.get(id)?.updatedAt).toBe(once.updatedAt);
  });
});
