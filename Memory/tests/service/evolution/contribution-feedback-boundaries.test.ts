import { DEVICE_MEMORY_OWNER } from "../../../src/service/namespace/memory-owner.js";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { MemmyConfig } from "../../../src/config/index.js";
import {
  policyMetaFromMemory,
  skillMetaFromMemory,
  traceMetaFromMemory
} from "../../../src/algorithm/plugin-algorithms.js";
import { PolicyInductionEngine, type PolicyInductionDeps } from "../../../src/service/evolution/policy-induction.js";
import { SkillPipeline } from "../../../src/service/evolution/skill-pipeline.js";
import { SkillTrialResolver } from "../../../src/service/trials/skill-trial-resolver.js";
import { Repositories, type SkillTrialRecord } from "../../../src/storage/repositories.js";
import type { FeedbackRequest, MemoryRow } from "../../../src/types.js";
import { createFailingLlm, createMemoryServiceFixture, LEGACY_TEST_CONFIG } from "../../fixtures/memory-service-fixture.js";

const AT = "2026-11-09T00:00:00.000Z";
// Ordinary new rows, recall feedback, trials and relations share the device owner.
const USER = DEVICE_MEMORY_OWNER;
const fixture = createMemoryServiceFixture();
type Polarity = "positive" | "negative";

function row(id: string, layer: "L1" | "L2" | "Skill", data: Record<string, unknown>): MemoryRow {
  return {
    id, userId: USER, memoryLayer: layer, memoryType: "LongTermMemory", status: "activated", visibility: "private",
    timeline: AT, memoryValue: "Check the certificate before reconnecting", tags: [], info: {},
    version: 1, createdAt: AT, updatedAt: AT,
    properties: { internal_info: {
      memory_layer: layer, generated_by_memory_base: true,
      [layer === "L1" ? "trace" : layer === "L2" ? "policy" : "skill"]: data
    } }
  };
}

// Each scenario has its own disposable DB. No worker is started; model, embedding,
// budget and machine-probe dependencies are supplied by the offline fixture.
function scenario(sourceAValue: number) {
  const config: MemmyConfig = structuredClone(LEGACY_TEST_CONFIG);
  config.algorithm.l2Induction.mode = "unified";
  config.algorithm.l2Induction.minEpisodesForActivation = 1;
  config.algorithm.l2Induction.minEpisodesForInduction = 1;
  config.algorithm.feedback.useLlm = false;
  const llm = createFailingLlm();
  const { db, service } = fixture.createTestService({ config, llm, skillLlm: llm });
  const repos = new Repositories(db.db);
  const skills = new SkillPipeline({ repos, config, namespaceIdFromMemory: () => "feedback-boundary" } as unknown as ConstructorParameters<typeof SkillPipeline>[0]);
  const trials = new SkillTrialResolver({ repos, config } as unknown as ConstructorParameters<typeof SkillTrialResolver>[0]);
  const engine = new PolicyInductionEngine({
    repos, config, nowIso: () => AT,
    traceMeta: (memory: MemoryRow | null | undefined) => memory ? traceMetaFromMemory(memory) : null,
    enqueueJob: vi.fn(), enqueueChange: vi.fn(), namespaceIdFromMemory: () => "feedback-boundary",
    onSkillRewardDrift: (policy: NonNullable<ReturnType<typeof policyMetaFromMemory>>, at: string) =>
      skills.applySkillRewardDriftForPolicy(policy, at)
  } as unknown as PolicyInductionDeps);

  repos.memories.insert(row("source-a", "L1", { value: sourceAValue, alpha: 1, episode_id: "episode-a", vec_summary: [1, 0] }));
  repos.memories.insert(row("source-b", "L1", { value: 1, alpha: 1, episode_id: "episode-b", vec_summary: [1, 0] }));
  repos.memories.insert(row("policy", "L2", {
    schema_version: 1, status: "active", gain: 0.8, support: 2,
    source_trace_ids: ["source-a", "source-b"], source_episode_ids: ["episode-a", "episode-b"]
  }));
  repos.memories.insert(row("skill", "Skill", {
    eta: 0.8, status: "active", source_policy_ids: ["policy"], trials_attempted: 0, trials_passed: 0
  }));
  for (const source of ["source-a", "source-b"]) {
    repos.runtime.insertTracePolicyLink({ userId: USER, l1MemoryId: source, l2MemoryId: "policy", relation: "supports" });
  }

  function recompute() {
    engine.recomputePolicyStats("policy", AT, "episode-a");
  }
  function score(value: number) {
    const source = repos.memories.get("source-a")!;
    repos.memories.update({ ...source, properties: { ...source.properties, internal_info: {
      ...source.properties.internal_info,
      trace: { ...(source.properties.internal_info.trace as object), value }
    } } });
    recompute();
  }
  function request(polarity: Polarity, label: string): FeedbackRequest {
    repos.runtime.insertRecallEvent({
      id: `recall-${label}`, userId: USER, namespaceId: "feedback-boundary", query: "certificate", layers: ["L2"],
      candidateMemoryIds: ["policy"], injectedMemoryIds: ["policy"], hitMemoryIds: ["policy"],
      outcome: "pending", request: {}, createdAt: AT
    });
    return {
      namespace: { source: "codex", profileId: "default", userId: USER },
      adapterId: "feedback-boundary-test", requestId: `feedback-${label}`,
      recallEventId: `recall-${label}`, channel: "explicit", polarity, magnitude: 0.5
    };
  }
  async function feedback(polarity: Polarity, label: string) {
    const feedbackRequest = request(polarity, label);
    const response = await service.feedback(feedbackRequest);
    // Recall feedback currently has no immediate Skill callback. This is the
    // actual later stats-refresh path, not an invented synchronous dependency.
    recompute();
    return { request: feedbackRequest, response };
  }
  function trial() {
    const record: SkillTrialRecord = {
      id: "independent-skill-trial", userId: USER, skillMemoryId: "skill", episodeId: "episode-trial",
      status: "pass", outcome: "success", createdAt: AT, resolvedAt: AT
    };
    repos.runtime.insertSkillTrial(record);
    trials.updateSkillTrialStats(record, AT);
    return record;
  }
  function snapshot() {
    const policy = policyMetaFromMemory(repos.memories.get("policy")!)!;
    const skill = skillMetaFromMemory(repos.memories.get("skill")!)!;
    return {
      gain: policy.gain, support: policy.support, policyStatus: policy.status,
      sourceTraceIds: [...policy.sourceTraceIds].sort(), sourceEpisodeIds: [...policy.sourceEpisodeIds].sort(),
      eta: skill.eta, skillStatus: skill.status, trialsAttempted: skill.trialsAttempted, trialsPassed: skill.trialsPassed
    };
  }
  recompute();
  return { repos, service, recompute, score, request, feedback, trial, snapshot, trials };
}

function expectEquivalent(actual: ReturnType<ReturnType<typeof scenario>["snapshot"]>, expected: typeof actual) {
  expect(actual.gain).toBeCloseTo(expected.gain, 12);
  expect(actual.eta).toBeCloseTo(expected.eta, 12);
  const { gain: _gain, eta: _eta, ...actualState } = actual;
  const { gain: _expectedGain, eta: _expectedEta, ...expectedState } = expected;
  expect(actualState).toEqual(expectedState);
}

afterEach(async () => {
  vi.restoreAllMocks();
  await fixture.cleanup();
});

describe("task contribution corrections across independent recall feedback and Skill boundaries", () => {
  it.each(["positive", "negative"] as const)(
    "replays independent %s recall feedback and a later Skill trial through success/failure/success",
    async polarity => {
      const actual = scenario(1);
      const failureControl = scenario(-1);
      const successControl = scenario(1);
      for (const state of [actual, failureControl, successControl]) {
        const beforeFeedback = state.snapshot().gain;
        await state.feedback(polarity, "independent-recall");
        expect(state.snapshot().gain).toBeCloseTo(beforeFeedback + (polarity === "positive" ? 0.01 : -0.01), 12);
        state.trial();
      }
      const sourceB = actual.repos.memories.get("source-b");
      const savedTrial = actual.repos.runtime.listSkillTrials({ skillMemoryId: "skill", limit: -1 });
      const success = actual.snapshot();
      expectEquivalent(success, successControl.snapshot());

      actual.score(-1);
      // Failure is checked before restoration: a frozen checkpoint can falsely
      // pass a round-trip-only test while retaining the withdrawn task's gain.
      expectEquivalent(actual.snapshot(), failureControl.snapshot());
      expect(actual.snapshot().gain).not.toBeCloseTo(success.gain, 12);
      expect(actual.snapshot()).toMatchObject({ sourceTraceIds: ["source-b"], support: 1, trialsAttempted: 1, trialsPassed: 1 });
      expect(actual.repos.memories.get("source-b")).toEqual(sourceB);
      expect(actual.repos.runtime.listSkillTrials({ skillMemoryId: "skill", limit: -1 })).toEqual(savedTrial);

      actual.score(1);
      expectEquivalent(actual.snapshot(), successControl.snapshot());
      const policyAfterRestore = actual.repos.memories.get("policy");
      const skillAfterRestore = actual.repos.memories.get("skill");
      actual.recompute();
      actual.recompute();
      expect(actual.repos.memories.get("policy")).toEqual(policyAfterRestore);
      expect(actual.repos.memories.get("skill")).toEqual(skillAfterRestore);
      expect(actual.repos.memories.get("source-b")).toEqual(sourceB);
      expect(actual.repos.runtime.listSkillTrials({ skillMemoryId: "skill", limit: -1 })).toEqual(savedTrial);
    }
  );

  it("deduplicates the public feedback request and preserves distinct opposing feedback events", async () => {
    const actual = scenario(1);
    const before = actual.snapshot().gain;
    const request = actual.request("positive", "first");
    const first = await actual.service.feedback(request);
    expect(actual.snapshot().gain).toBeCloseTo(before + 0.01, 12);
    const afterFirst = actual.repos.memories.get("policy");
    const duplicate = await actual.service.feedback(request);
    expect(duplicate).toMatchObject({ feedbackId: first.feedbackId, duplicate: true });
    expect(actual.repos.memories.get("policy")).toEqual(afterFirst);
    await expect(actual.service.feedback({ ...request, polarity: "negative" })).rejects.toThrow("idempotency");
    expect(actual.repos.memories.get("policy")).toEqual(afterFirst);
    actual.recompute();
    await actual.feedback("negative", "second");

    const control = scenario(-1);
    await control.feedback("positive", "first");
    await control.feedback("negative", "second");
    actual.score(-1);
    expectEquivalent(actual.snapshot(), control.snapshot());
    expect(actual.repos.memories.get("policy")!.properties.internal_info.recall).toMatchObject({
      positive: 1, negative: 1, total: 2
    });
    expect(actual.repos.runtime.listFeedback({ userId: USER, limit: 20 })).toHaveLength(2);
    const settled = actual.snapshot();
    actual.recompute();
    expectEquivalent(actual.snapshot(), settled);
  });

  it("keeps a user archive through feedback, source correction and trial refresh until explicit reactivation", async () => {
    const actual = scenario(1);
    await actual.feedback("positive", "before-archive");
    const savedTrial = actual.trial();
    expect(actual.service.archiveMemory("skill", { reason: "User deliberately hid this skill" })).toMatchObject({ status: "archived" });
    actual.score(-1);
    await actual.feedback("negative", "while-archived");
    actual.trials.updateSkillTrialStats(savedTrial, AT);
    expect(actual.repos.memories.get("skill")).toMatchObject({
      status: "archived", properties: { internal_info: { skill_manually_archived: true } }
    });
    expect(actual.snapshot()).toMatchObject({ trialsAttempted: 1, trialsPassed: 1 });

    expect(actual.service.reactivateSkill("skill")).toMatchObject({ status: "activated" });
    actual.score(1);
    expect(actual.repos.memories.get("skill")).toMatchObject({
      status: "activated", properties: { internal_info: { skill_manually_archived: false } }
    });
    expect(actual.snapshot()).toMatchObject({ trialsAttempted: 1, trialsPassed: 1 });
    expect(actual.repos.runtime.listSkillTrials({ skillMemoryId: "skill", limit: -1 })).toEqual([savedTrial]);
    const changeSources = actual.repos.runtime.listChanges(USER, 100).map(change => change.source);
    expect(changeSources).toContain("panel.archive");
    expect(changeSources).toContain("panel.reactivate");
  });
});
