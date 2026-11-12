import { afterEach, describe, expect, it } from "vitest";
import type { LlmClient, MemoryRow } from "../../../src/index.js";
import { Repositories } from "../../../src/storage/repositories.js";
import { DEVICE_MEMORY_OWNER } from "../../../src/service/namespace/memory-owner.js";
import { assignedEpisodeId, createMemoryServiceFixture, LEGACY_TEST_CONFIG, settleCaptureAssignments } from "../../fixtures/memory-service-fixture.js";
import { insertActivePolicyMemory, insertTracePolicyLinkForTest, makeTraceEligibleForL2,
  queueSkillCrystallizationJobForTest } from "../../fixtures/evolution-fixture.js";
import { createNoToolSkillLlm } from "./evolution-llm-stubs.js";

const fixture = createMemoryServiceFixture();
afterEach(fixture.cleanup);
const LEGACY = "historical-skill-evidence-owner";
const PROFILE = "skill-evidence-profile";
const PROJECT = "skill-evidence-project";
type Prompt = { evidence: Array<{ id: string }>; counter_examples?: Array<{ id: string }> };

// The fixed model only records the actual public worker's prompt and declines
// generation. No Skill helper or evidence collector is invoked directly.
async function setup() {
  const prompts: Prompt[] = [];
  const base = createNoToolSkillLlm();
  const model: LlmClient = {
    ...base,
    async completeJson<T extends Record<string, unknown>>(messages: Parameters<LlmClient["completeJson"]>[0],
      options: Parameters<LlmClient["completeJson"]>[1]): Promise<T> {
      if (options.operation.startsWith("skill.")) {
        prompts.push(JSON.parse(messages.find(message => message.role === "user")!.content) as Prompt);
        return { skip: true } as unknown as T;
      }
      return base.completeJson<T>(messages, options);
    }
  };
  const config = structuredClone(LEGACY_TEST_CONFIG);
  config.algorithm.capture.embedAfterCapture = false;
  config.algorithm.capture.synthReflection = false;
  config.algorithm.skill.directFromTrace = false;
  config.algorithm.skill.cooldownMs = 0;
  const { db, service } = fixture.createTestService({ config, llm: model, skillLlm: model });
  const repos = new Repositories(db.db);
  const session = service.openSession({ namespace: { source: "codex", profileId: PROFILE, projectId: PROJECT } });
  const source = await service.completeTurn("skill-evidence-source", { sessionId: session.sessionId,
    query: "Run pytest, inspect failures and retry after fixing the issue",
    answer: "Inspected the pytest failure, fixed it and verified the focused test passes." });
  await settleCaptureAssignments(service);
  const episodeId = assignedEpisodeId(service, source);
  makeTraceEligibleForL2(db, source.l1MemoryId);
  repos.runtime.closeEpisode(episodeId, { closeReason: "finalized" });
  repos.runtime.updateEpisodeReward(episodeId, { rTask: 1, rewardDetail: { source: "synthetic-success" } });
  // Explicit pre-upgrade fixture. All later local writes still use normal repos.
  for (const [table, id] of [["sessions", session.sessionId], ["episodes", episodeId],
    ["raw_turns", source.rawTurnId], ["memories", source.l1MemoryId]]) {
    db.db.prepare(`UPDATE ${table} SET user_id = ? WHERE id = ?`).run(LEGACY, id);
  }
  insertActivePolicyMemory(db, { id: "skill-evidence-policy", userId: DEVICE_MEMORY_OWNER,
    sessionId: session.sessionId, agentId: "codex", appId: PROJECT, profileId: PROFILE,
    sourceTraceId: source.l1MemoryId, sourceEpisodeId: episodeId });
  db.db.prepare("UPDATE memories SET info_json = json_set(info_json, '$.project_id', ?) WHERE id = ?")
    .run(PROJECT, "skill-evidence-policy");
  insertTracePolicyLinkForTest(db, { userId: LEGACY, l1MemoryId: source.l1MemoryId, l2MemoryId: "skill-evidence-policy" });
  // Other capture jobs are outside this evidence-selection regression.
  db.db.prepare("UPDATE evolution_jobs SET status = 'succeeded'").run();
  let runIndex = 0;
  async function run() {
    const jobId = `skill-evidence-job-${++runIndex}`;
    queueSkillCrystallizationJobForTest(db, { id: jobId, userId: DEVICE_MEMORY_OWNER,
      sessionId: session.sessionId, episodeId, policyId: "skill-evidence-policy" });
    await service.runWorkerOnce(1, { targetMemoryIds: ["skill-evidence-policy"] });
    expect(repos.runtime.getJob(jobId), "real Skill job should reach the fixed model").toMatchObject({ status: "succeeded" });
    expect(prompts).toHaveLength(runIndex);
    return prompts.at(-1)!;
  }
  return { db, repos, service, source, episodeId, sessionId: session.sessionId, run };
}
type Context = Awaited<ReturnType<typeof setup>>;
type InvalidContext = "profile" | "project" | "missing-raw" | "redacted-raw";

function insertContext(c: Context, id: string, value: number, options: {
  invalid?: InvalidContext; owner?: string; unrelated?: boolean; newer?: boolean;
} = {}) {
  const seed = structuredClone(c.repos.memories.get(c.source.l1MemoryId)!);
  const trace = seed.properties.internal_info.trace as Record<string, unknown>;
  const profileId = options.invalid === "profile" ? "another-profile" : PROFILE;
  const projectId = options.invalid === "project" ? "another-project" : PROJECT;
  const at = options.newer ? "2099-01-01T00:00:00.000Z" : seed.createdAt;
  const info = { ...seed.info, profile_id: profileId, project_id: projectId };
  const next: MemoryRow = { ...seed, id, memoryKey: undefined, memoryValue: `Context ${id}`,
    info, createdAt: at, updatedAt: at,
    properties: { ...seed.properties, info, internal_info: { ...seed.properties.internal_info,
      trace: { ...trace, summary: `Context ${id}`, userText: `pytest context ${id}`,
        agentText: `pytest verification detail ${id}`, value,
        ...(options.unrelated ? { episode_id: `unrelated-${id}` } : {}) } } } };
  if (options.invalid === "missing-raw" || options.invalid === "redacted-raw") {
    const rawId = `context-raw-${id}`;
    if (options.invalid === "redacted-raw") {
      const raw = c.repos.runtime.getRawTurn(c.source.rawTurnId)!;
      c.repos.runtime.insertRawTurn({ ...raw, id: rawId, turnId: rawId, redactedAt: at });
    }
    next.info.raw_turn_id = rawId;
    next.properties.info = { ...next.info };
    next.properties.internal_info.source_raw_turn_id = rawId;
    next.properties.internal_info.raw_turn_id = rawId;
    (next.properties.internal_info.trace as Record<string, unknown>).raw_turn_id = rawId;
  }
  c.repos.memories.insert(next);
  if ((options.owner ?? LEGACY) !== DEVICE_MEMORY_OWNER) {
    c.db.db.prepare("UPDATE memories SET user_id = ? WHERE id = ?").run(options.owner ?? LEGACY, id);
  }
}

describe("MEMMY-647 v1.2.8 Skill evidence selection at the production worker boundary", () => {
  it.each([LEGACY, DEVICE_MEMORY_OWNER])("keeps valid same-task context and counterexamples across retained owner %s", async owner => {
    const c = await setup();
    insertContext(c, "valid-context", 0.8, { owner });
    insertContext(c, "valid-counterexample", -0.8, { owner });
    const prompt = await c.run();
    expect(prompt.evidence.map(item => item.id)).toContain(c.source.l1MemoryId);
    expect(prompt.evidence.map(item => item.id)).toContain("valid-context");
    expect((prompt.counter_examples ?? []).map(item => item.id)).toContain("valid-counterexample");
  });

  it.each(["profile", "project", "missing-raw", "redacted-raw"] as const)(
    "does not send invalid %s context as either successful evidence or a failure counterexample", async invalid => {
      const c = await setup();
      insertContext(c, "invalid-positive", 0.8, { invalid });
      insertContext(c, "invalid-negative", -0.8, { invalid });
      const prompt = await c.run();
      expect.soft(prompt.evidence.map(item => item.id)).toEqual([c.source.l1MemoryId]);
      expect.soft(prompt.counter_examples ?? []).toEqual([]);
    }
  );

  it("does not lose accepted-task context or counterexamples behind a global page of unrelated L1 rows", async () => {
    const c = await setup();
    insertContext(c, "old-valid-context", 0.8);
    insertContext(c, "old-valid-counterexample", -0.8);
    c.repos.transaction(() => {
      for (let index = 0; index < 1001; index++) {
        insertContext(c, `recent-unrelated-${index}`, 0.8, { unrelated: true, newer: true, owner: DEVICE_MEMORY_OWNER });
      }
    });
    const prompt = await c.run();
    expect(prompt.evidence.map(item => item.id)).toContain(c.source.l1MemoryId);
    expect.soft(prompt.evidence.map(item => item.id)).toContain("old-valid-context");
    expect.soft((prompt.counter_examples ?? []).map(item => item.id)).toContain("old-valid-counterexample");
  });
});
