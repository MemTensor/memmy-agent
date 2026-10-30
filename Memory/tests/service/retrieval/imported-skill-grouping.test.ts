import { createHash } from "node:crypto";
import { afterEach, describe, expect, it } from "vitest";
import type { AgentSkillReconcileSkill } from "../../../src/service/import/agent-skill-library.js";
import { compileRetrievalQuery } from "../../../src/algorithm/plugin-algorithms.js";
import { Repositories } from "../../../src/storage/repositories.js";
import { createCapturingEmbedder, createMemoryServiceFixture, runWorkerRounds } from "../../fixtures/memory-service-fixture.js";

const { cleanup, createTestService } = createMemoryServiceFixture();

afterEach(cleanup);

const userId = "imported-skill-grouping-user";

function skill(name: string, content: string, modifiedAt: string, sourceSkillId = name): AgentSkillReconcileSkill {
  return {
    sourceSkillId,
    sourceSkillPath: `/skills/${sourceSkillId}/SKILL.md`,
    title: name,
    content,
    contentHash: createHash("sha256").update(content).digest("hex"),
    modifiedAt
  };
}

type Service = ReturnType<typeof createTestService>["service"];
type Db = ReturnType<typeof createTestService>["db"];

const ROLLBACK = "Roll back the sqlite migration service after a failed deploy, then restore the backup, check the logs and tell the team.";

/** Rollback texts sit farther from every query than the other skills. */
function rankingEmbedder() {
  const embedder = createCapturingEmbedder([]);
  return {
    ...embedder,
    async embed(texts: string[]) {
      return texts.map((text) => text.includes("Roll back") ? [0.6, 0.8, 0] : [1, 0, 0]);
    }
  };
}

/** The record is not among the first round of Skill candidates of any route (default pool sizes). */
function expectOutsideFirstRound(db: Db, id: string, query: string): void {
  const repos = new Repositories(db.db);
  const filter = { memoryLayer: "Skill" as const, status: ["activated" as const, "resolving" as const], excludedImportedSkillSourceAgentId: "claude_code" };
  const compiled = compileRetrievalQuery(query);
  const first = [
    ...repos.memories.searchFtsIds(compiled.ftsMatch, filter, 20),
    ...repos.memories.searchPatternIds(compiled.patternTerms, filter, 20),
    ...repos.memories.searchVectorIds([1, 0, 0], "vec", filter, 12)
  ].map((hit) => hit.id);
  expect(first).not.toContain(id);
  // ...while a wider query does reach it, so a refill can.
  expect(repos.memories.searchVectorIds([1, 0, 0], "vec", filter, 100).map((hit) => hit.id)).toContain(id);
}

function importSkills(service: Service, sourceAgentId: string, skills: AgentSkillReconcileSkill[]): string[] {
  const result = service.reconcileAgentSkills({
    namespace: { source: sourceAgentId, profileId: "default", userId },
    sourceAgentId,
    complete: true,
    skills
  });
  return result.skills.map((item) => item.memoryId!);
}

async function recallSkillIds(service: Service, currentAgentId: string, query: string, limit = 5): Promise<string[]> {
  const session = service.openSession({ namespace: { source: currentAgentId, profileId: "default", userId } });
  const recall = await service.search({ sessionId: session.sessionId, query, layers: ["Skill"], limit });
  return recall.hits.map((hit) => hit.id);
}

describe("imported skill grouping in recall", () => {
  it("recalls one copy of a same-named skill: the most recently modified one", async () => {
    const { service } = createTestService();
    const [older] = importSkills(service, "codex", [skill("Systematic Debugging", "Find the root cause of a failing sqlite migration before fixing it.", "2026-01-01T00:00:00.000Z")]);
    const [newer] = importSkills(service, "hermes", [skill("systematic_debugging", "Investigate sqlite migration bugs: reproduce, isolate, then fix.", "2026-06-01T00:00:00.000Z")]);
    await runWorkerRounds(service, 2, 50);

    const hits = await recallSkillIds(service, "claude_code", "debug a failing sqlite migration");

    expect(hits).toContain(newer);
    expect(hits).not.toContain(older);
  });

  it("uses the newest copy even when only an older copy matched the query", async () => {
    const { service } = createTestService();
    const [older] = importSkills(service, "codex", [skill("release-check", "Verify the sqlite migration release evidence step by step.", "2026-01-01T00:00:00.000Z")]);
    const [newer] = importSkills(service, "hermes", [skill("release-check", "Checklist before shipping.", "2026-06-01T00:00:00.000Z")]);
    await runWorkerRounds(service, 2, 50);

    const hits = await recallSkillIds(service, "claude_code", "sqlite migration release evidence");

    expect(hits).toContain(newer);
    expect(hits).not.toContain(older);
  });

  it("recalls no copy when the current Agent already has a skill of that name", async () => {
    const { service } = createTestService();
    const [codexCopy] = importSkills(service, "codex", [skill("brainstorming", "Brainstorm sqlite migration designs before coding.", "2026-01-01T00:00:00.000Z")]);
    service.reconcileAgentSkills({
      namespace: { source: "claude_code", profileId: "default", userId },
      sourceAgentId: "claude_code",
      complete: true,
      skills: [],
      registrations: [{ sourceSkillId: "plugin:superpowers@m/brainstorming", sourceSkillPath: "/p/SKILL.md", name: "brainstorming" }],
      registrationsComplete: true
    });
    await runWorkerRounds(service, 2, 50);

    expect(await recallSkillIds(service, "claude_code", "brainstorm sqlite migration designs")).not.toContain(codexCopy);
    expect(await recallSkillIds(service, "cursor", "brainstorm sqlite migration designs")).toContain(codexCopy);
  });

  it("lets other Agents' copies through once a skill the user archived is gone at its source", async () => {
    const { service } = createTestService();
    const [own] = importSkills(service, "codex", [skill("brainstorming", "Brainstorm sqlite migration designs before coding.", "2026-01-01T00:00:00.000Z")]);
    const [hermesCopy] = importSkills(service, "hermes", [skill("brainstorming", "Brainstorm sqlite migration designs with sketches.", "2026-02-01T00:00:00.000Z")]);
    service.archiveMemory(own!, { namespace: { source: "codex", profileId: "default", userId } });
    await runWorkerRounds(service, 2, 50);
    expect(await recallSkillIds(service, "codex", "brainstorm sqlite migration designs")).not.toContain(hermesCopy);

    importSkills(service, "codex", []);

    expect(await recallSkillIds(service, "codex", "brainstorm sqlite migration designs")).toContain(hermesCopy);
  });

  it("keeps the current Agent's own imported skills out of the candidate queries", async () => {
    const { db, service } = createTestService();
    importSkills(service, "codex", Array.from({ length: 30 }, (_, index) =>
      skill(`own-${index}`, `Resume the sqlite migration task number ${index}.`, "2026-01-01T00:00:00.000Z")));
    const [other] = importSkills(service, "hermes", [skill("resume-helper", "Resume an interrupted sqlite migration task.", "2026-01-01T00:00:00.000Z")]);
    const repos = new Repositories(db.db);
    const filter = { memoryLayer: "Skill" as const, status: ["activated" as const], excludedImportedSkillSourceAgentId: "Codex" };

    const fts = repos.memories.searchFtsIds("sqlite", filter, 5).map((hit) => hit.id);
    const pattern = repos.memories.searchPatternIds(["sqlite"], filter, 5).map((hit) => hit.id);

    expect(fts).toEqual([other]);
    expect(pattern).toEqual([other]);
    expect(repos.memories.searchPatternIds(["sqlite"], { ...filter, excludedImportedSkillSourceAgentId: undefined }, 5)).toHaveLength(5);
  });

  it("refills candidates when same-named copies filled the first round", async () => {
    const { db, service } = createTestService({ embedder: rankingEmbedder() });
    // Written first and ranked last by every route, so no route reaches it in the first round.
    const [distinct] = importSkills(service, "hermes", [skill("rollback", ROLLBACK, "2026-01-01T00:00:00.000Z")]);
    for (let index = 0; index < 25; index += 1) {
      importSkills(service, `agent-${index}`, [skill("deploy", `Deploy the sqlite migration service, copy ${index}.`, `2026-01-${String(index + 1).padStart(2, "0")}T00:00:00.000Z`)]);
    }
    await runWorkerRounds(service, 4, 100);
    expectOutsideFirstRound(db, distinct!, "sqlite migration service deploy");

    const hits = await recallSkillIds(service, "claude_code", "sqlite migration service deploy");

    expect(hits).toContain(distinct);
    expect(hits.filter((id) => id !== distinct)).toHaveLength(1);
  });

  it("keeps refilling while every new candidate is a skill the current Agent already has", async () => {
    const { db, service } = createTestService({ embedder: rankingEmbedder() });
    // No text matches the query words, so only the vector route finds these:
    // it returns 12 at first and every round drops all it finds.
    const [available] = importSkills(service, "hermes", [skill("rollback", "Roll back a broken release and restore the backup.", "2026-01-01T00:00:00.000Z")]);
    for (let index = 0; index < 24; index += 1) {
      importSkills(service, `agent-${index}`, [skill(`ship-${index}`, `Ship the package to production, step ${index}.`, "2026-01-02T00:00:00.000Z")]);
    }
    service.reconcileAgentSkills({
      namespace: { source: "claude_code", profileId: "default", userId },
      sourceAgentId: "claude_code",
      complete: true,
      skills: [],
      registrations: Array.from({ length: 24 }, (_, index) => ({
        sourceSkillId: `plugin:tools@m/ship-${index}`,
        sourceSkillPath: `/p/ship-${index}/SKILL.md`,
        name: `ship-${index}`
      })),
      registrationsComplete: true
    });
    await runWorkerRounds(service, 4, 100);
    expectOutsideFirstRound(db, available!, "sqlite migration service deploy");

    expect(await recallSkillIds(service, "claude_code", "sqlite migration service deploy")).toEqual([available]);
  });
});
