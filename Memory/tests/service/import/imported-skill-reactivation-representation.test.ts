import "../../fixtures/isolated-user-home.js";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { readAgentSkillInventory } from "@memmy/agent-source-core";
import { afterEach, describe, expect, it } from "vitest";
import { embeddingTextForMemory } from "../../../src/service/embedding/embedding-pipeline.js";
import { Repositories } from "../../../src/storage/repositories.js";
import type { MemoryRow } from "../../../src/types.js";
import type { SerializedMemoryVector } from "../../../src/storage/sqlite-vec-store.js";
import { IMPORTED_SKILL_STATE_VERSION, IMPORTED_SKILL_RETRIEVAL_VERSION } from "../../../src/storage/imported-skill.js";
import { withLegacyImportedSkillWriter } from "../../fixtures/legacy-imported-skill-writer.js";
import { createCapturingEmbedder, createFailingLlm, createMemoryServiceFixture, LEGACY_TEST_CONFIG, runWorkerRounds } from "../../fixtures/memory-service-fixture.js";

const fixture = createMemoryServiceFixture();
afterEach(() => fixture.cleanup());
const namespace = { source: "codex", profileId: "default", userId: "reactivation-representation-user" };

describe("imported Skill reactivation representation", () => {
  it("upgrades a user archive after disabled-capture startup migrated lifecycle but skipped retrieval representation", async () => {
    const seen: string[] = [];
    const llm = createFailingLlm();
    const seed = fixture.createTestService({ llm, embedder: createCapturingEmbedder(seen) });
    const repos = new Repositories(seed.db.db);
    const bodyMarker = "LEGACY_BODY_ONLY_REACTIVATION_CANARY";
    const content = `---\nname: old-release\ndescription: Release the service safely.\n---\n${bodyMarker}`;
    // This test isolates delayed representation repair from sidecar discovery.
    const id = withLegacyImportedSkillWriter(seed.service, () => seed.service.addMemory({
      namespace, requestId: "legacy-import", adapterId: "agent-source:hermes", layer: "Skill", title: "old-release",
      content, source: "hermes", sourceAgentId: "hermes", sourceSkillId: "old-release", sourceSkillPath: "/fixture/old-release/SKILL.md"
    }).id);
    seed.service.archiveMemory(id, { namespace });
    await seed.service.stop();
    const disabled = structuredClone(LEGACY_TEST_CONFIG);
    disabled.algorithm.enableMemoryAdd = false;
    const enabled = structuredClone(disabled);
    enabled.algorithm.enableMemoryAdd = true;
    const service = fixture.createTestMemoryService({ db: seed.db, mode: "dev", config: disabled,
      configLoader: () => ({ config: enabled }), llm, skillLlm: llm, embedder: createCapturingEmbedder(seen) });
    service.reconcileWorkerStartup();
    const migrated = repos.memories.get(id)!;
    expect(migrated.properties.internal_info.import_state_version).toBe(IMPORTED_SKILL_STATE_VERSION);
    expect(migrated.properties.internal_info.retrieval_representation_version).toBeUndefined();
    expect(migrated.info.summary).toBe("---");
    expect(JSON.stringify(migrated.properties)).toContain(bodyMarker);
    service.reloadConfig({ restartFailedProcessing: false });
    expect(service.reactivateSkill(id, { namespace }).status).toBe("activated");
    const restored = repos.memories.get(id)!;
    expect(restored.properties.internal_info.retrieval_representation_version).toBe(IMPORTED_SKILL_RETRIEVAL_VERSION);
    expect(restored.info.summary).toBe("Release the service safely.");
    expect(JSON.stringify(restored.properties)).not.toContain(bodyMarker);
    expect(embeddingTextForMemory(restored)).toContain(bodyMarker);
    const fts = seed.db.db.prepare("SELECT memory_value FROM memories_fts WHERE id = ?").get(id) as { memory_value: string };
    expect(fts.memory_value).toContain(bodyMarker);
    seen.length = 0;
    await runWorkerRounds(service, 3, 100);
    expect(seen.some(text => text.includes("Release the service safely."))).toBe(true);
    expect(seen.some(text => text.includes(bodyMarker))).toBe(true);
    expect(repos.memories.hasVector(id, "vec")).toBe(true);
  });

  it("repairs captured v2 short vectors while preserving an owned current-text retry and first backup", async () => {
    const captured = JSON.parse(readFileSync(new URL("../../fixtures/imported-skill-v2-retrieval.json", import.meta.url), "utf8")) as {
      rows: MemoryRow[]; vectors: SerializedMemoryVector[];
    };
    const { db, service } = fixture.createTestService();
    const repos = new Repositories(db.db);
    // Preserve the captured retrieval metadata and vectors, while independently
    // supplying actual sidecar evidence for these eligible positive controls.
    const root = fixture.createTestRoot("v2-retrieval-policy-");
    for (const row of captured.rows) {
      const directory = join(root, row.id);
      mkdirSync(join(directory, "agents"), { recursive: true });
      writeFileSync(join(directory, "SKILL.md"), row.memoryValue);
      writeFileSync(join(directory, "agents", "openai.yaml"), "policy:\n  allow_implicit_invocation: true\n");
    }
    const observed = await readAgentSkillInventory(root);
    expect(observed.complete).toBe(true);
    for (const row of captured.rows) {
      const policy = observed.items.find(item => item.sourceSkillId === row.id)!;
      expect(policy.allowImplicitInvocation).toBe(true);
      const copy = structuredClone(row);
      copy.properties.internal_info.invocation = { ...(copy.properties.internal_info.invocation as Record<string, unknown>),
        allow_implicit_invocation: policy.allowImplicitInvocation };
      repos.memories.insert(copy);
    }
    repos.vectors.importRows(captured.vectors);
    const plainBefore = captured.rows.find(row => row.info.title === "round6-plain")!;
    const describedBefore = captured.rows.find(row => row.info.title === "round6-described")!;
    expect(plainBefore.properties.internal_info.retrieval_representation_version).toBe(2);
    expect(embeddingTextForMemory(plainBefore)).toContain("BODY_ONLY_V2_CANARY");
    expect(repos.memories.hasVector(describedBefore.id, "vec")).toBe(true);
    const matching = repos.runtime.enqueueEmbeddingRetry({ targetKind: "skill", targetId: describedBefore.id,
      vectorField: "vec", sourceText: embeddingTextForMemory(describedBefore) });
    const claimed = repos.runtime.claimEmbeddingRetryById(matching.id, { now: Date.now() + 1, workerId: "existing-owner", leaseUntil: Date.now() + 60_000 });
    expect(claimed?.status).toBe("in_progress");
    const stale = repos.runtime.enqueueEmbeddingRetry({ targetKind: "skill", targetId: plainBefore.id,
      vectorField: "vec", sourceText: "obsolete v2 name-only retrieval" });
    service.reconcileWorkerStartup(1);
    const plain = repos.memories.get(plainBefore.id)!;
    const described = repos.memories.get(describedBefore.id)!;
    expect.soft(embeddingTextForMemory(plain)).toContain("BODY_ONLY_V2_CANARY");
    expect.soft(plain.properties.internal_info.retrieval_representation_version).toBeGreaterThan(2);
    expect.soft(repos.memories.hasVector(plain.id, "vec")).toBe(false);
    expect.soft(repos.runtime.getEmbeddingRetry(stale.id)).toBeUndefined();
    expect.soft(repos.memories.hasVector(described.id, "vec")).toBe(false);
    expect.soft(repos.runtime.getEmbeddingRetry(matching.id)).toEqual(claimed);
    for (const memory of [plain, described]) {
      const original = captured.rows.find(row => row.id === memory.id)!;
      expect.soft(memory.properties.internal_info.retrieval_previous).toEqual(original.properties.internal_info.retrieval_previous);
    }
    const jobs = () => db.db.prepare("SELECT COUNT(*) AS n FROM evolution_jobs WHERE job_type = 'embedding'").get();
    const once = jobs();
    service.reconcileWorkerStartup(1);
    expect(jobs()).toEqual(once);
    expect(service.restoreImportedSkillRetrievalText(1)).toEqual({ restored: 2 });
    expect(repos.memories.get(plain.id)?.info.summary).toBe("# round6-plain");
    expect(repos.memories.get(described.id)?.info.summary).toBe("---");
  });

});
