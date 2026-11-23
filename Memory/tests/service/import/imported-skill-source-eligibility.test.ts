import "../../fixtures/isolated-user-home.js";
import { afterEach, describe, expect, it } from "vitest";
import { Repositories } from "../../../src/storage/repositories.js";
import { agentSkillConnectionKey } from "../../../src/storage/imported-skill.js";
import { updateMemoryVectorField } from "../../../src/service/embedding/embedding-pipeline.js";
import type { EvolutionJobRecord } from "../../../src/storage/repositories.js";
import type { MemoryFilter } from "../../../src/types.js";
import { withLegacyImportedSkillWriter } from "../../fixtures/legacy-imported-skill-writer.js";
import { createCapturingEmbedder, createFailingLlm, createMemoryServiceFixture } from "../../fixtures/memory-service-fixture.js";

const fixture = createMemoryServiceFixture();
afterEach(fixture.cleanup);
const namespace = { source: "cursor", profileId: "default", userId: "source-eligibility" };
const good = "---\nname: deploy-helper\ndescription: quartzdeploy guide.\n---\nCheck quartzdeploy before release.";
const forbidden = good.replace("---\nCheck", "disable-model-invocation: true\n---\nCheck");
const broken = good.replace("name: deploy-helper", "name: [broken-yaml");
type Service = ReturnType<typeof fixture.createTestService>["service"];
function legacy(service: Service, sourceAgentId: string, content: string, name = "deploy-helper") {
  const id = withLegacyImportedSkillWriter(service, () => service.addMemory({ namespace: { ...namespace, source: sourceAgentId },
    source: sourceAgentId, sourceAgentId, layer: "Skill", title: name, content, sourceSkillId: name,
    sourceSkillPath: `/synthetic/${sourceAgentId}/${name}/SKILL.md` }).id);
  // Persist the ordinary embedding job an older worker can leave behind; the
  // frozen writer fixture intentionally only reconstructs row persistence.
  const at = new Date().toISOString();
  const host = service as unknown as { repos: Repositories };
  host.repos.runtime.enqueueJob({ id: `legacy_embedding_${id}`, jobType: "embedding", status: "queued", targetMemoryId: id,
    userId: namespace.userId, payload: {}, attempts: 0, maxAttempts: 3, createdAt: at, updatedAt: at } as EvolutionJobRecord);
  return id;
}
function setup() {
  const inputs: string[] = [];
  const test = fixture.createTestService({ llm: createFailingLlm(), embedder: createCapturingEmbedder(inputs) });
  return { ...test, inputs, repos: new Repositories(test.db.db) };
}

const unobserved = [
  { label: "raw invocation denial", source: "hermes", body: forbidden },
  { label: "raw malformed frontmatter", source: "hermes", body: broken },
  { label: "unobserved Codex sidecar", source: "codex", body: good }
];
describe("source eligibility before migration, candidate selection and embedding", () => {
  it.each(unobserved)("blocks $label in cold search, context and ordinary jobs", async ({ source, body }) => {
    const { service, repos, inputs } = setup();
    const id = legacy(service, source, body);
    expect(repos.memories.get(id)!.status).toBe("activated");
    expect((await service.search({ namespace, query: "quartzdeploy", layers: ["Skill"] })).hits.map(hit => hit.id)).not.toContain(id);
    const session = service.openSession({ namespace });
    const turn = await service.startTurn({ namespace, sessionId: session.sessionId, turnId: "cold", query: "quartzdeploy", layers: ["Skill"] });
    expect(turn.hits.map(hit => hit.id)).not.toContain(id);
    expect(turn.injectedContext?.markdown ?? "").not.toContain("quartzdeploy");
    inputs.length = 0;
    await service.runWorkerOnce(100);
    expect(inputs).toEqual([]);
    expect(repos.memories.hasVector(id, "vec")).toBe(false);
  });

  it.each(unobserved)("excludes $label from cold maintenance and retry work", async ({ source, body }) => {
    const { service, repos, inputs } = setup();
    const id = legacy(service, source, body);
    expect(await service.embeddingMaintenanceStats()).toMatchObject({ totalSlots: 0 });
    expect(await service.rebuildEmbeddings("rebuild")).toMatchObject({ enqueued: 0 });
    await service.runWorkerOnce(100);
    // Dimension discovery may send the fixed connectivity probe, never source bytes.
    expect(inputs.filter(text => text !== "Memmy model connectivity test")).toEqual([]);
    expect(repos.memories.hasVector(id, "vec")).toBe(false);
  });

  it.each(["explicit", "legacy"] as const)("selects a valid older same-name source despite %s disconnect", async mode => {
    const { service, repos, inputs } = setup();
    const allowed = legacy(service, "claude_code", good);
    const denied = legacy(service, "hermes", good + "\nDISCONNECTED_SOURCE_BODY");
    const row = repos.memories.get(denied)!;
    repos.memories.updateMaintenance({ ...row, properties: { ...row.properties,
      internal_info: { ...row.properties.internal_info, source_modified_at: "2099-01-01T00:00:00Z" } } });
    if (mode === "explicit") repos.runtime.setKv(agentSkillConnectionKey("hermes"), "disconnected");
    else {
      const marker = legacy(service, "hermes", "Connection evidence only.", "disconnect-marker");
      const record = repos.memories.get(marker)!;
      repos.memories.updateMaintenance({ ...record, status: "archived", properties: { ...record.properties,
        internal_info: { ...record.properties.internal_info, source_state: "disconnected" } } });
    }
    const hits = await service.search({ namespace, query: "quartzdeploy", layers: ["Skill"] });
    expect(hits.hits.map(hit => hit.id)).toEqual([allowed]);
    expect(repos.memories.latestImportedSkillsByName(["deploy-helper"]).get("deploy-helper")).toBe(allowed);
    inputs.length = 0;
    await service.rebuildEmbeddings("rebuild");
    await service.runWorkerOnce(100);
    expect(repos.memories.hasVector(allowed, "vec")).toBe(true);
    expect(repos.memories.hasVector(denied, "vec")).toBe(false);
    expect(inputs.length).toBeGreaterThan(0);
    expect(inputs.some(text => text.includes("DISCONNECTED_SOURCE_BODY"))).toBe(false);
  });

  it("quarantines a path-inherited legacy collision until an actual source observation", async () => {
    const { service, repos, inputs } = setup();
    const id = legacy(service, "hermes", good);
    const row = repos.memories.get(id)!;
    repos.memories.updateMaintenance({ ...row, properties: { ...row.properties, internal_info: {
      ...row.properties.internal_info, source_kind: "skill", turn_id: "deploy-helper"
    } } });
    expect((await service.search({ namespace, query: "quartzdeploy", layers: ["Skill"] })).hits).toEqual([]);
    inputs.length = 0;
    await service.runWorkerOnce(100);
    expect(inputs).toEqual([]);
    expect(repos.memories.hasVector(id, "vec")).toBe(false);
    const observed = service.reconcileAgentSkills({ namespace: { ...namespace, source: "hermes" }, sourceAgentId: "hermes", complete: false,
      skills: [{ sourceSkillId: "deploy-helper", sourceSkillPath: "/synthetic/hermes/deploy-helper/SKILL.md", title: "deploy-helper",
        content: good, contentHash: "fixture", modifiedAt: "2026-11-06T00:00:00Z" }] }).skills[0]!.memoryId!;
    expect(repos.memories.get(observed)!.status).toBe("activated");
    expect((await service.search({ namespace, query: "quartzdeploy", layers: ["Skill"] })).hits.map(hit => hit.id)).toContain(observed);
  });

  it("filters source-ineligible rows before every bounded candidate route", () => {
    const { service, repos } = setup();
    const allowed = legacy(service, "claude_code", good);
    const ids = [allowed, ...Array.from({ length: 40 }, (_, index) => legacy(service, "hermes", forbidden, `denied-${index}`))];
    for (const id of ids) {
      const row = repos.memories.get(id)!;
      repos.memories.updateMaintenance(updateMemoryVectorField({ ...row, updatedAt: id === allowed ? "2020-01-01T00:00:00Z" : "2030-01-01T00:00:00Z" }, "vec", [1, 0, 0], {
        provider: "local", model: "fixture", updatedAt: "2030-01-01T00:00:00Z"
      }));
    }
    const filter: MemoryFilter = { memoryLayer: "Skill", status: ["activated"], eligibleImportedSkillsOnly: true };
    const routes = [
      repos.memories.searchFtsIds("quartzdeploy", filter, 2),
      repos.memories.searchPatternIds(["quartzdeploy"], filter, 2),
      repos.memories.searchImportedSkillPatternIds(["quartzdeploy"], filter, 2),
      repos.memories.searchImportedSkillBodyIds(["quartzdeploy"], filter, 2),
      repos.memories.searchVectorIds([1, 0, 0], "vec", filter, 2)
    ];
    for (const route of routes) expect(route.map(hit => hit.id)).toEqual([allowed]);
  });

  it("retains a cold ordinary source and a Codex row with explicit observed allow", async () => {
    const { service, repos } = setup();
    const ordinary = legacy(service, "hermes", good, "ordinary");
    const codex = legacy(service, "codex", good, "observed");
    const row = repos.memories.get(codex)!;
    repos.memories.updateMaintenance({ ...row, properties: { ...row.properties, internal_info: {
      ...row.properties.internal_info, invocation: { allow_implicit_invocation: true }
    } } });
    await service.runWorkerOnce(100);
    expect(repos.memories.hasVector(ordinary, "vec")).toBe(true);
    expect(repos.memories.hasVector(codex, "vec")).toBe(true);
    expect((await service.search({ namespace, query: "quartzdeploy", layers: ["Skill"] })).hits.map(hit => hit.id))
      .toEqual(expect.arrayContaining([ordinary, codex]));
  });
});

for (const queue of ["ordinary", "retry"] as const) {
  for (const failure of [false, true]) {
    it.each(["connection", "raw_policy"] as const)(`${queue} completion/failure=${failure} rechecks %s after await`, async restriction => {
      let entered!: () => void;
      let finish!: () => void;
      const started = new Promise<void>(resolve => { entered = resolve; });
      const release = new Promise<void>(resolve => { finish = resolve; });
      let armed = false;
      const base = createCapturingEmbedder([]);
      const embed = async (texts: string[]) => {
        if (armed) { entered(); await release; if (failure) throw new Error("fixture model failed"); }
        return texts.map(() => [1, 0, 0]);
      };
      const { db, service } = fixture.createTestService({ llm: createFailingLlm(), embedder: {
        ...base, embed, async embedOne(text: string) { return (await embed([text]))[0]!; }
      } });
      const repos = new Repositories(db.db);
      const id = legacy(service, "hermes", good);
      if (queue === "retry") { await service.runWorkerOnce(100); await service.rebuildEmbeddings("rebuild"); }
      armed = true;
      const work = service.runWorkerOnce(1, { targetMemoryIds: [id] });
      await started;
      try {
        if (restriction === "connection") repos.runtime.setKv(agentSkillConnectionKey("hermes"), "disconnected");
        else {
          const row = repos.memories.get(id)!;
          repos.memories.updateMaintenance({ ...row, memoryValue: forbidden });
        }
      } finally { finish(); }
      await work;
      expect(repos.memories.hasVector(id, "vec")).toBe(false);
      expect(repos.runtime.getEmbeddingRetryByTarget("skill", id, "vec")).toBeUndefined();
    });
  }
}
