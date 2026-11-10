import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { DEFAULT_MEMMY_CONFIG } from "../../../src/config/index.js";
import { policyMetaFromMemory, skillMetaFromMemory, traceMetaFromMemory } from "../../../src/algorithm/plugin-algorithms.js";
import type { Embedder, LlmClient, LlmMessage } from "../../../src/model/types.js";
import { PolicyInductionEngine, updatePolicyStats } from "../../../src/service/evolution/policy-induction.js";
import { SkillPipeline } from "../../../src/service/evolution/skill-pipeline.js";
import { episodeInputRevision } from "../../../src/service/evolution/episode-revision.js";
import { profileIdFromMemory, projectIdFromMemory } from "../../../src/service/namespace/namespace-scope.js";
import { listL2Candidates, upsertL2Candidate } from "../../../src/service/evolution/l2-candidate-service.js";
import { MemoryDb } from "../../../src/storage/db.js";
import { L2_EXTRACTION_OPERATION_PREFIX, L2_EXTRACTION_SNAPSHOT_PREFIX } from "../../../src/storage/l2-extraction-keys.js";
import { Repositories, type EvolutionJobRecord } from "../../../src/storage/repositories.js";
import type { MemoryRow } from "../../../src/types.js";

const AT = "2026-11-10T06:00:00.000Z";
const databases: MemoryDb[] = [];
const directories: string[] = [];
afterEach(() => {
  vi.restoreAllMocks();
  for (const db of databases.splice(0)) db.close();
  for (const directory of directories.splice(0)) rmSync(directory, { recursive: true, force: true });
});

function memory(id: string, layer: "L1" | "L2" | "Skill", fields: Record<string, unknown>): MemoryRow {
  return { id, userId: "owner", memoryLayer: layer, memoryType: "LongTermMemory", status: "activated",
    visibility: "private", timeline: AT, createdAt: AT, updatedAt: AT, version: 1, tags: [], info: {},
    memoryValue: "Verify the actual required input before accepting the result.",
    properties: { internal_info: { memory_layer: layer, generated_by_memory_base: true,
      [layer === "L1" ? "trace" : layer === "L2" ? "policy" : "skill"]: fields } } };
}

/** Only model/embedding output is fixed. Production induceL2 installs the real
 * UnifiedL2ExtractionPipeline -> recomputePolicyStats -> SkillPipeline wiring. */
function harness(initialSources: Array<{ id: string; episode: string }> = [], options: { path?: string; seed?: boolean } = {}) {
  const db = new MemoryDb({ path: options.path ?? ":memory:" }); databases.push(db);
  const repos = new Repositories(db.db), config = structuredClone(DEFAULT_MEMMY_CONFIG);
  config.algorithm.l2Induction.mode = "unified";
  config.algorithm.l2Induction.useLlm = true;
  config.algorithm.capture.embedAfterCapture = false;
  const requests: Array<{ ids: string[]; episodes: string[] }> = [];
  let sequence = 0;
  const llm = { isConfigured: () => true, completeJson: async (messages: LlmMessage[]) => {
    const input = JSON.parse(messages[2]!.content) as {
      L1_RECORDS: Array<{ id: string; episode_id: string }>;
      HISTORICAL_L2_CANDIDATES: Array<{ id: string; version: number }>;
    };
    const target = input.HISTORICAL_L2_CANDIDATES.find(row => row.id === "policy");
    if (!target) throw new Error("fixture did not recall the existing policy");
    requests.push({ ids: input.L1_RECORDS.map(row => row.id), episodes: input.L1_RECORDS.map(row => row.episode_id) });
    return { operations: [{ operation: "support", l1_ids: input.L1_RECORDS.map(row => row.id), target_l2: { id: target.id, version: target.version } }] };
  } } as unknown as LlmClient;
  const embedder = { config: { provider: "local", model: "fixture", batchSize: 16 },
    embed: async (texts: string[]) => texts.map(() => [1, 0]) } as unknown as Embedder;
  const skills = new SkillPipeline({ repos, config, namespaceIdFromMemory: () => undefined } as unknown as ConstructorParameters<typeof SkillPipeline>[0]);
  const engine = new PolicyInductionEngine({ repos, config, skillLlm: llm, embedder, nowIso: () => AT,
    episodeRevision: episodeId => episodeInputRevision(repos, episodeId),
    projectIdFromMemory, profileIdFromMemory,
    traceMeta: row => row ? traceMetaFromMemory(row) : null,
    namespaceIdFromMemory: () => undefined,
    enqueueChange: change => { repos.runtime.appendChange(change); },
    enqueueJob: input => ({ ...input, id: `queued-${++sequence}`, payload: input.payload ?? {}, status: "queued",
      attempts: 0, maxAttempts: 3, createdAt: AT, updatedAt: AT }) as EvolutionJobRecord,
    buildMemory: () => { throw new Error("support must not create another policy"); },
    upsertEvolutionMemory: row => repos.memories.upsertByKey(row),
    onSkillRewardDrift: (policy, at) => skills.applySkillRewardDriftForPolicy(policy, at)
  });
  const sourceIds = initialSources.map(row => row.id), episodeIds = [...new Set(initialSources.map(row => row.episode))];
  if (options.seed !== false) {
    repos.memories.insert(memory("policy", "L2", { schema_version: 2, content_revision: 1, lesson_type: "check",
      title: "Actual input verification", trigger: "Before accepting a result", procedure: "Run the actual input.",
      verification: "Check the assertion", boundary: "", status: "candidate", gain: 0, raw_gain: 0,
      support: episodeIds.length, successful_episode_count: episodeIds.length,
      source_trace_ids: sourceIds, successful_source_trace_ids: sourceIds, source_episode_ids: episodeIds,
      generation_method: "model", experience_type: "success_pattern", evidence_polarity: "positive", skill_eligible: true }));
    repos.memories.insert(memory("skill", "Skill", { eta: 0.8, status: "active", source_policy_ids: ["policy"], trials_attempted: 0, trials_passed: 0 }));
    repos.memories.insert(memory("unrelated-skill", "Skill", { eta: 0.73, status: "active", source_policy_ids: ["unrelated-policy"], trials_attempted: 2, trials_passed: 1 }));
  }
  function addTrace(id: string, episode: string, value = 1) {
    repos.memories.insert(memory(id, "L1", { episode_id: episode, value, alpha: 1, priority: 1,
      summary: "Verify actual input", userText: "Check this input", agentText: "The assertion passes", vec_summary: [1, 0] }));
  }
  for (const source of options.seed === false ? [] : initialSources) {
    addTrace(source.id, source.episode);
    repos.runtime.insertTracePolicyLink({ userId: "owner", l1MemoryId: source.id, l2MemoryId: "policy", relation: "supports" });
  }
  function admit(id: string) { upsertL2Candidate(repos, { userId: "owner", sourceMemoryId: id, route: "ordinary", at: AT }); }
  async function support(id: string) {
    admit(id);
    const episodeId = traceMetaFromMemory(repos.memories.get(id)!)!.episodeId!;
    const job: EvolutionJobRecord = { id: `induce-${++sequence}`, userId: "owner", jobType: "l2_induction", episodeId,
      targetMemoryId: id, payload: {}, status: "leased", attempts: 1, maxAttempts: 3, createdAt: AT, updatedAt: AT };
    await engine.induceL2(job);
  }
  function score(id: string, value: number, explicit: boolean) {
    const row = repos.memories.get(id)!;
    repos.memories.update({ ...row, properties: { ...row.properties, internal_info: { ...row.properties.internal_info,
      trace: { ...(row.properties.internal_info.trace as object), value } } } });
    engine.recomputePolicyStats("policy", AT, explicit ? traceMetaFromMemory(row)!.episodeId : undefined);
  }
  function state() {
    const policy = repos.memories.get("policy")!, skill = repos.memories.get("skill")!;
    return { policy: policyMetaFromMemory(policy)!, skill: skillMetaFromMemory(skill)!,
      policyHistory: policy.properties.internal_info.policy_revision_history as { events: Array<{ id: string; type?: string; sources?: string[] }>; latestInput: unknown },
      skillHistory: skill.properties.internal_info.skill_revision_history as { events: Array<{ id: string; type: string }> } };
  }
  function close() {
    const index = databases.indexOf(db);
    if (index >= 0) { databases.splice(index, 1); db.close(); }
  }
  return { db, repos, engine, requests, addTrace, admit, support, score, state, close };
}

describe("MEMMY-647 unified support with real statistical propagation", () => {
  it.each([false, true])("restores identical final evidence without an extra Skill contribution (explicit reward trigger: %s)", async explicit => {
    const h = harness([{ id: "a", episode: "A" }, { id: "b", episode: "B" }, { id: "c", episode: "C" }]);
    const untouched = h.repos.memories.get("unrelated-skill");
    await h.support("c");
    const initial = h.state();
    // Independent oracle: successful values are 1 and baseline is .5. The seed
    // already has support, so gain is .4*.5 + .6*0 = .2; eta is .7*.8 + .3*.2.
    expect(initial.policy.gain).toBeCloseTo(0.2, 12);
    expect(initial.skill.eta).toBeCloseTo(0.62, 12);
    expect(initial.policyHistory.events).toHaveLength(1);
    for (const value of [-0.55, -0.55, 1, 1]) h.score("c", value, explicit);
    const restored = h.state();
    expect(restored.policyHistory.latestInput).toEqual(initial.policyHistory.latestInput);
    expect.soft(restored.policyHistory.events).toHaveLength(1);
    expect.soft(restored.skillHistory.events).toHaveLength(1);
    expect.soft(restored.policy.gain).toBeCloseTo(0.2, 12);
    expect.soft(restored.skill.eta).toBeCloseTo(0.62, 12);
    expect(restored.policy.sourceEpisodeIds.sort()).toEqual(["A", "B", "C"]);
    expect(h.repos.memories.get("policy")!.info.successful_episode_count).toBe(3);
    expect(h.repos.memories.get("unrelated-skill")).toEqual(untouched);
    await h.support("c");
    expect(h.state().skill.eta).toBe(restored.skill.eta);
  });

  it("does not mistake a second episode's automatic support write for a manual checkpoint", async () => {
    const h = harness(); h.addTrace("a", "A"); h.addTrace("b", "B");
    await h.support("a");
    expect(h.state().skill.eta).toBeCloseTo(0.71, 12);
    await h.support("b");
    const second = h.state();
    expect.soft(second.policyHistory.events.filter(event => event.type === "checkpoint")).toEqual([]);
    expect.soft(second.policyHistory.events).toHaveLength(2);
    // A and B are genuine independent sources, each with unchanged .5 gain.
    expect.soft(second.skill.eta).toBeCloseTo(0.7 * 0.71 + 0.3 * 0.5, 12);
    expect(second.policy.support).toBe(2);
    expect(second.policy.sourceEpisodeIds.sort()).toEqual(["A", "B"]);
    await h.support("b");
    expect(h.state().skill.eta).toBe(second.skill.eta);
    expect(h.requests).toHaveLength(2);
  });

  it("batches traces of one episode without consuming another episode or counting one task twice", async () => {
    const h = harness();
    h.addTrace("a1", "A"); h.addTrace("a2", "A"); h.addTrace("b", "B");
    h.admit("a1"); h.admit("a2"); h.admit("b");
    await h.support("a1");
    expect(h.requests[0]!.ids.sort()).toEqual(["a1", "a2"]);
    expect(h.requests[0]!.episodes).toEqual(["A", "A"]);
    expect(h.state().policy.support).toBe(1);
    expect(listL2Candidates(h.repos, { userId: "owner", episodeId: "B" }).map(row => row.sourceMemoryId)).toEqual(["b"]);
    await h.support("b");
    expect(h.requests[1]!.ids).toEqual(["b"]);
    expect(h.state().policy.sourceEpisodeIds.sort()).toEqual(["A", "B"]);
    expect(h.state().policy.support).toBe(2);
    expect(h.repos.runtime.listTracePolicyLinks({ l2MemoryId: "policy", limit: -1 })).toHaveLength(3);
  });

  it("uses the same complete reference evidence during failure through implicit and explicit entrances", async () => {
    const implicit = harness([{ id: "a", episode: "A" }, { id: "b", episode: "B" }, { id: "c", episode: "C" }]);
    const explicit = harness([{ id: "a", episode: "A" }, { id: "b", episode: "B" }, { id: "c", episode: "C" }]);
    for (const h of [implicit, explicit]) await h.support("c");
    implicit.score("c", -0.55, false);
    explicit.score("c", -0.55, true);
    const left = implicit.state(), right = explicit.state();
    const input = left.policyHistory.latestInput as { reference: Array<{ id: string; value: number }> };
    expect.soft(input.reference).toEqual(expect.arrayContaining([expect.objectContaining({ id: "c", value: -0.55 })]));
    expect.soft(left.policyHistory.latestInput).toEqual(right.policyHistory.latestInput);
    // With A/B successful and C=-.55 as a comparison record, the raw gain is
    // 1 - (-.55 + 5 * ((1 + 1 - .55) / 3)) / 6; existing support uses alpha=.4.
    const gain = 0.4 * (1 - (-0.55 + 5 * (1.45 / 3)) / 6);
    for (const current of [left, right]) {
      expect.soft(current.policy.gain).toBeCloseTo(gain, 12);
      expect.soft(current.skill.eta).toBeCloseTo(0.7 * 0.8 + 0.3 * gain, 12);
      expect(current.policy.sourceEpisodeIds.sort()).toEqual(["A", "B", "C"]);
    }
  });

  it("updates an existing episode's evidence when a new trace arrives without inventing another task contribution", async () => {
    const h = harness(); h.addTrace("a1", "A"); await h.support("a1");
    const original = h.state();
    h.addTrace("a2", "A"); await h.support("a2");
    const revised = h.state();
    expect(revised.policy.sourceTraceIds.sort()).toEqual(["a1", "a2"]);
    expect(revised.policy.sourceEpisodeIds).toEqual(["A"]);
    expect(revised.policy.support).toBe(1);
    expect.soft(revised.policyHistory.events).toHaveLength(1);
    expect.soft(revised.skillHistory.events).toHaveLength(1);
    expect.soft(revised.policy.gain).toBeCloseTo(0.5, 12);
    expect.soft(revised.skill.eta).toBeCloseTo(0.71, 12);
    expect.soft(revised.skill.eta).toBe(original.skill.eta);
  });

  it.each(["foreign-owner", "unrelated-crowd"] as const)("keeps the owning task's complete comparison evidence after adding %s records", async pollution => {
    const h = harness([{ id: "a", episode: "A" }]);
    h.addTrace("reference-a", "A", 0.2);
    await h.support("a");
    const initial = h.state();
    // One successful value=1, unrelated-to-policy reference=.2, blended
    // baseline=(.2 + 5*.5)/6=.45. Existing source gain=.4*(1-.45)=.22.
    expect(initial.policy.gain).toBeCloseTo(0.22, 12);
    expect(initial.skill.eta).toBeCloseTo(0.626, 12);
    if (pollution === "foreign-owner") {
      h.repos.memories.insert({ ...memory("foreign-a", "L1", { episode_id: "A", value: -1,
        summary: "Another owner's evidence", alpha: 1 }), userId: "another-owner" });
    } else {
      h.repos.transaction(() => {
        for (let index = 0; index < 2001; index++) h.repos.memories.insert({
          ...memory(`newer-unrelated-${index}`, "L1", { episode_id: `unrelated-${index}`, value: 0.1,
            summary: "Independent task", alpha: 1 }), createdAt: "2026-11-10T07:00:00.000Z"
        });
      });
    }
    h.engine.recomputePolicyStats("policy", AT);
    const after = h.state();
    expect.soft(after.policyHistory.latestInput).toEqual(initial.policyHistory.latestInput);
    expect.soft(after.policy.gain).toBeCloseTo(0.22, 12);
    expect.soft(after.skill.eta).toBeCloseTo(0.626, 12);
    expect.soft(after.policyHistory.events).toHaveLength(1);
  });

  it("retains source identity through file database close/reopen and pipeline reconstruction", async () => {
    const directory = mkdtempSync(join(tmpdir(), "memmy647-contribution-")); directories.push(directory);
    const path = join(directory, "memory.sqlite");
    const original = harness([{ id: "a", episode: "A" }, { id: "b", episode: "B" }, { id: "c", episode: "C" }], { path });
    await original.support("c");
    const initial = original.state(), unrelated = original.repos.memories.get("unrelated-skill");
    original.score("c", -0.55, false);
    const withdrawn = original.state();
    original.close();

    // This closes the real SQLite connection and reconstructs repositories and
    // pipelines. It does not claim to restart a process or an evolution worker.
    const reopened = harness([], { path, seed: false });
    expect(reopened.state().policyHistory).toEqual(withdrawn.policyHistory);
    expect(reopened.state().skillHistory).toEqual(withdrawn.skillHistory);
    reopened.score("c", 1, false);
    await reopened.support("c");
    const restored = reopened.state();
    expect(restored.policyHistory.latestInput).toEqual(initial.policyHistory.latestInput);
    expect(restored.policyHistory.events).toHaveLength(1);
    expect(restored.skillHistory.events).toHaveLength(1);
    expect(restored.policy.gain).toBeCloseTo(0.2, 12);
    expect(restored.skill.eta).toBeCloseTo(0.62, 12);
    expect(restored.policy.sourceEpisodeIds.sort()).toEqual(["A", "B", "C"]);
    expect(reopened.repos.memories.get("unrelated-skill")).toEqual(unrelated);
    const savedPolicy = reopened.repos.memories.get("policy"), savedSkill = reopened.repos.memories.get("skill");
    reopened.close();

    const repeated = harness([], { path, seed: false });
    repeated.engine.recomputePolicyStats("policy", AT);
    await repeated.support("c");
    expect(repeated.requests).toHaveLength(0);
    expect(repeated.repos.memories.get("policy")).toEqual(savedPolicy);
    expect(repeated.repos.memories.get("skill")).toEqual(savedSkill);
  });

  it("rolls back unified support, links, contribution writes and commit markers when the Skill write fails, then retries once", async () => {
    const h = harness(); h.addTrace("a", "A"); h.admit("a");
    const beforePolicy = h.repos.memories.get("policy"), beforeSkill = h.repos.memories.get("skill");
    const beforeCandidate = listL2Candidates(h.repos, { userId: "owner", episodeId: "A" })[0]!;
    const operationKeys = () => h.db.db.prepare("SELECT key FROM runtime_kv WHERE key LIKE ? ORDER BY key")
      .all(`${L2_EXTRACTION_OPERATION_PREFIX}%`);
    const snapshots = () => (h.db.db.prepare("SELECT value_json FROM runtime_kv WHERE key LIKE ? ORDER BY key")
      .all(`${L2_EXTRACTION_SNAPSHOT_PREFIX}%`) as Array<{ value_json: string }>).map(row => JSON.parse(row.value_json) as { status: string });
    const beforeOperations = operationKeys();
    const originalUpdate = h.repos.memories.update.bind(h.repos.memories);
    const fault = vi.spyOn(h.repos.memories, "update").mockImplementation(row => {
      if (row.id === "skill") throw new Error("synthetic Skill persistence failure");
      return originalUpdate(row);
    });
    await expect(h.support("a")).rejects.toThrow("synthetic Skill persistence failure");
    fault.mockRestore();
    expect(h.repos.memories.get("policy")).toEqual(beforePolicy);
    expect(h.repos.memories.get("skill")).toEqual(beforeSkill);
    expect(h.repos.runtime.listTracePolicyLinks({ l2MemoryId: "policy", limit: -1 })).toEqual([]);
    expect(operationKeys()).toEqual(beforeOperations);
    expect(snapshots()).not.toContainEqual(expect.objectContaining({ status: "committed" }));
    expect(listL2Candidates(h.repos, { userId: "owner", episodeId: "A" })).toEqual([beforeCandidate]);

    // The validated model decision survives as retry input; none of its state
    // changes were committed. Reuse it without another paid model request.
    await h.support("a");
    const committed = h.state();
    expect(h.requests).toHaveLength(1);
    expect(operationKeys()).toHaveLength(1);
    expect(snapshots().filter(row => row.status === "committed")).toHaveLength(1);
    expect(listL2Candidates(h.repos, { userId: "owner", episodeId: "A" })).toEqual([]);
    expect(h.repos.runtime.listTracePolicyLinks({ l2MemoryId: "policy", limit: -1 })).toHaveLength(1);
    expect(committed.policyHistory.events).toHaveLength(1);
    expect(committed.skillHistory.events).toHaveLength(1);
    expect(committed.skill.eta).toBeCloseTo(0.71, 12);
    await h.support("a");
    expect(h.requests).toHaveLength(1);
    expect(operationKeys()).toHaveLength(1);
    expect(h.state().skillHistory).toEqual(committed.skillHistory);
  });

  it.each([undefined, 0.81])("writes current derived confidence once while preserving explicit confidence (%s)", explicitConfidence => {
    const original = memory("confidence-policy", "L2", { schema_version: 2, status: "candidate", support: 0, gain: 0,
      ...(explicitConfidence === undefined ? {} : { policy_confidence: explicitConfidence }) });
    const input = { support: 1, gain: 0.3, rawGain: 0.4, status: "candidate" as const,
      sourceEpisodeIds: ["A"], sourceTraceIds: ["a"], updatedAt: AT };
    const first = updatePolicyStats(original, input), expected = explicitConfidence ?? 0.8;
    expect.soft(first.info.policy_confidence).toBe(expected);
    expect.soft(first.properties.info?.policy_confidence).toBe(expected);
    expect.soft(first.properties.internal_info.policy_confidence).toBe(expected);
    expect(updatePolicyStats(first, input)).toEqual(first);
  });
});
