import "../../fixtures/isolated-user-home.js";
import { afterEach, describe, expect, it, vi } from "vitest";
import { compileRetrievalQuery, importedSkillBodyPatternTerms } from "../../../src/algorithm/plugin-algorithms.js";
import { Repositories } from "../../../src/storage/repositories.js";
import { IndexedCandidatePool } from "../../../src/service/retrieval/indexed-candidate-pool.js";
import type { MemoryRow } from "../../../src/types.js";
import { createMemoryServiceFixture } from "../../fixtures/memory-service-fixture.js";

const fixture = createMemoryServiceFixture();
afterEach(async () => { vi.restoreAllMocks(); await fixture.cleanup(); });
const at = "2026-01-01T00:00:00.000Z";
function memory(id: string, imported = true): MemoryRow {
  return { id, userId: "local-user", memoryLayer: "Skill", memoryType: "SkillMemory", status: "activated", visibility: "private",
    memoryValue: "Read 灰度 npm:deploy:verify bodycandidatecanary.", memoryKey: id, tags: ["release"], info: { title: id },
    version: 1, createdAt: at, updatedAt: at, timeline: at,
    properties: { internal_info: { memory_layer: "Skill", read_only: imported, source_agent_id: "hermes", source_skill_id: id,
      source_kind: "skill", normalized_name: id, skill: { name: id, status: "active", eta: 0.5,
        procedure_json: { retrievalBlurb: "Release safely." } } } } };
}

describe("imported Skill body candidates", () => {
  it("bounds and deduplicates literal terms while prioritizing complete commands", () => {
    const query = compileRetrievalQuery(Array.from({ length: 25 }, (_, index) => `word${index}`).join(" ") + " NPM:DEPLOY:VERIFY npm:deploy:verify release%canary_stage");
    const terms = importedSkillBodyPatternTerms(query);
    expect(terms).toHaveLength(16);
    expect(new Set(terms).size).toBe(16);
    expect(terms.slice(0, 2)).toEqual(["npm:deploy:verify", "release%canary_stage"]);
    expect(compileRetrievalQuery("deploymentcanaryround7").patternTerms).toEqual([]);
  });

  it("preserves raw and extracted literals even when vector text paraphrases them", () => {
    const query = compileRetrievalQuery("the pnpm --filter @memmy/release canary:verify 灰度", {
      queryVecText: "validate release safety", keywords: ["scripts/check.sh", "deployment"]
    });
    const terms = importedSkillBodyPatternTerms(query);
    expect(terms).toEqual(expect.arrayContaining(["pnpm", "--filter", "@memmy/release", "canary:verify", "scripts/check.sh", "灰度"]));
    expect(terms).not.toContain("the");
  });

  it.each([4, 22, 60])("orders coverage before LIMIT despite %i newer partial matches", async count => {
    const { db } = fixture.createTestService();
    const repos = new Repositories(db.db);
    repos.memories.insert({ ...memory("target"), memoryValue: "灰度 pnpm --filter @memmy/release canary:verify" });
    for (let i = 0; i < count; i++) repos.memories.insert({ ...memory(`decoy-${i}`),
      memoryValue: "灰度 pnpm the unrelated guide", updatedAt: "2026-02-01T00:00:00.000Z" });
    const query = compileRetrievalQuery("灰度 pnpm --filter @memmy/release canary:verify");
    const terms = importedSkillBodyPatternTerms(query);
    for (const limit of [3, 5]) {
      const hits = repos.memories.searchImportedSkillBodyIds(terms, {}, limit);
      expect(hits[0]).toMatchObject({ id: "target", score: 1 });
      expect(hits[1]!.score).toBeLessThan(1);
      const pool = new IndexedCandidatePool({ repos, memoryHasImportPipeline: () => false });
      const result = await pool.indexedRetrievalCandidatePool({ userId: "local-user", layers: ["Skill"], currentAgentId: "cursor",
        compiledQuery: query,
        config: { tier1TopK: limit, tier2TopK: limit, tier3TopK: limit, candidatePoolFactor: 1, keywordTopK: limit, tagFilter: "off" } });
      expect(result.channelScoresByMemory.get("target")?.pattern).toBe(1);
      for (const row of result.memories.filter(row => row.id !== "target")) {
        expect(result.channelScoresByMemory.get(row.id)?.pattern).toBeLessThan(1);
      }
    }
  });

  it("applies imported scope before the limit and matches body text without expanding generated Skills", () => {
    const { db } = fixture.createTestService();
    const repos = new Repositories(db.db);
    repos.memories.insert(memory("imported"));
    for (let index = 0; index < 25; index += 1) repos.memories.insert(memory(`generated-${index}`, false));
    expect(repos.memories.searchImportedSkillBodyIds(["bodycandidatecanary"], { tags: ["release"] }, 1).map(hit => hit.id)).toEqual(["imported"]);
    expect(repos.memories.searchImportedSkillBodyIds(["bodycandidatecanary"], { excludedImportedSkillSourceAgentId: "Hermes" }, 1)).toEqual([]);
  });

  it("matches the body independently of metadata and tags", () => {
    const { db } = fixture.createTestService();
    const repos = new Repositories(db.db);
    const row = memory("bodycandidatecanary");
    repos.memories.insert({ ...row, memoryValue: "A different guide.", tags: ["bodycandidatecanary"] });
    expect(repos.memories.searchImportedSkillBodyIds(["bodycandidatecanary"])).toEqual([]);
  });

  it("counts an imported record once when both existing pattern and literal body routes find it", async () => {
    const { db } = fixture.createTestService();
    const repos = new Repositories(db.db);
    repos.memories.insert(memory("one-copy"));
    const pool = new IndexedCandidatePool({ repos, memoryHasImportPipeline: () => false });
    const result = await pool.indexedRetrievalCandidatePool({ userId: "local-user", layers: ["Skill"], currentAgentId: "cursor",
      compiledQuery: compileRetrievalQuery("灰度 npm:deploy:verify"),
      config: { tier1TopK: 5, tier2TopK: 5, tier3TopK: 5, candidatePoolFactor: 4, keywordTopK: 20, tagFilter: "off" } });
    expect(result.memories.map(row => row.id)).toEqual(["one-copy"]);
    expect(result.channelScoresByMemory.get("one-copy")?.pattern).toBe(1);
  });

  it("keeps legacy generated-Skill ranking separate from imported coverage", () => {
    const { db } = fixture.createTestService();
    const repos = new Repositories(db.db);
    repos.memories.insert({ ...memory("imported-old"), memoryValue: "灰度 发布" });
    repos.memories.insert({ ...memory("generated-old", false), memoryValue: "灰度 发布" });
    repos.memories.insert({ ...memory("generated-new", false), memoryValue: "灰度", updatedAt: "2026-02-01T00:00:00.000Z" });
    expect(repos.memories.searchPatternIds(["灰度", "发布"], { memoryLayer: "Skill" }, 3, true)).toEqual([
      { id: "generated-new", score: 1, channel: "pattern" },
      { id: "generated-old", score: 0.5, channel: "pattern" }
    ]);
    expect(repos.memories.searchImportedSkillPatternIds(["灰度", "发布"], {}, 3)).toEqual([
      { id: "imported-old", score: 1, channel: "pattern" }
    ]);
  });

  it("reads maintenance facts without hydrating vectors while preserving default getMany behavior", () => {
    const { db } = fixture.createTestService();
    const repos = new Repositories(db.db);
    repos.memories.insert(memory("fact-only"));
    repos.vectors.upsert("fact-only", { vectorField: "vec", vector: [1, 0, 0] }, at);
    const hydrate = vi.spyOn(repos.vectors, "getMany");
    expect(repos.memories.getMany(["fact-only"], { includeVectors: false })).toHaveLength(1);
    expect(hydrate).not.toHaveBeenCalled();
    expect(repos.memories.getMany(["fact-only"])).toHaveLength(1);
    expect(hydrate).toHaveBeenCalledTimes(1);
  });
});
