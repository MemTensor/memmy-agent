import { afterEach, describe, expect, it, vi } from "vitest";
import { DEFAULT_MEMMY_CONFIG, type LlmClient, type MemoryRow } from "../../../src/index.js";
import { Repositories } from "../../../src/storage/repositories.js";
import { refreshProjectAliases } from "../../../src/storage/device-scope.js";
import { sha256Hex } from "../../../src/contracts/index.js";
import { stableHash } from "../../../src/utils/id.js";
import { attachMemoryVector, memoryVectorEntries } from "../../../src/storage/memory-vector-state.js";
import { compileRetrievalQuery, retrievePluginMemories } from "../../../src/algorithm/plugin-algorithms.js";
import { deduplicateSameSourceL1Candidates } from "../../../src/service/retrieval/same-source-l1-dedup.js";
import { IndexedCandidatePool } from "../../../src/service/retrieval/indexed-candidate-pool.js";
import { createMemoryServiceFixture } from "../../fixtures/memory-service-fixture.js";

const fixture = createMemoryServiceFixture();
afterEach(() => { vi.restoreAllMocks(); fixture.cleanup(); });
const at = "2026-10-01T00:00:00.000Z";
const uri = "file:///workspace/shared", host = "a".repeat(64);
function setup(time = false, rewrite = false) {
  const config = structuredClone(DEFAULT_MEMMY_CONFIG);
  config.algorithm.enableQueryRewrite = rewrite;
  Object.assign(config.algorithm.retrieval, { minRecallScore: 0, relativeThresholdFloor: 0, smartSeed: false, llmFilterEnabled: false });
  const llm: LlmClient = {
    config: config.summary, isConfigured: () => time || rewrite,
    complete: async () => "{}",
    completeJson: async <T extends Record<string, unknown>>(_messages: unknown, options: {operation?: string}) =>
      (options.operation?.includes("rewrite") ? { queries: ["shared evidence alpha", "shared evidence beta"] } : time
        ? {queryVecText: "", keywords: [], timeFilter: {startAt: at, endAt: "2026-10-02T00:00:00.000Z"}}
        : {queryVecText: "shared evidence", keywords: ["shared"]}) as unknown as T,
    status: () => ({provider: "host", model: "fixture", configured: time || rewrite, remote: false})
  };
  const state = fixture.createTestService({ config, llm });
  const repos = new Repositories(state.db.db);
  function seed(id: string, owner: string | null, options: {
    turn?: string; step?: number | null; source?: string; profile?: string; project?: string;
    conversation?: string; tenant?: string; missingSource?: boolean; layer?: "L1" | "L2"; work?: boolean;
  } = {}) {
    const opened = state.service.openSession({ namespace: {source: options.source ?? "codex", profileId: options.profile ?? "default", sessionKey: id, userId: owner ?? undefined} });
    const workspaceId = owner ? sha256Hex(`${owner}\0local\0${host}\0${uri}`) : "device-workspace";
    const projectId = options.project ?? (owner ? `ws_${workspaceId}` : "device-project");
    const meta = {workspace_uri: options.project ? undefined : uri, workspace_host_id: host,
      tenant_id: options.tenant ?? null,
      source_namespace_key: stableHash({tenantId: options.tenant ?? null, projectId, workspaceId})};
    state.db.db.prepare("UPDATE sessions SET user_id=?,project_id=?,workspace_id=?,conversation_id=?,meta_json=? WHERE id=?")
      .run(owner, projectId, workspaceId, options.missingSource ? null : options.conversation ?? "native-chat", JSON.stringify(meta), opened.sessionId);
    refreshProjectAliases(state.db.db);
    const turn = options.turn ?? "native-turn";
    const row: MemoryRow = {
      id, userId: null, sessionId: opened.sessionId, timeline: at, agentId: options.source ?? "codex",
      memoryLayer: options.layer ?? "L1", memoryType: "LongTermMemory", status: "activated", visibility: "private",
      memoryKey: `trace:${id}`, memoryValue: "shared evidence unchanged", tags: ["trace"], appId: workspaceId, info: {turn_id: turn, project_id: projectId},
      properties: {internal_info: {memory_layer: options.layer ?? "L1", memory_kind: options.work ? "work_memory" : "trace", trace: {
        key: `trace:${id}`, ts: Date.parse(at), turn_id: turn, raw_turn_id: `raw-${id}`,
        ...(options.step === null ? {} : {step_index: options.step ?? 0}), sub_step_total: 1,
        userText: "shared evidence", agentText: "shared evidence", summary: "shared evidence",
        tool_calls: [], reflection: null, alpha: 0, tags: ["trace"], value: 1, priority: 1,
        error_signatures: [], vec_summary: [1,0,0], vec_action: [1,0,0], embedding_model: "capturing-test-embedding"
      }}}, contentHash: "same-content", version: 1, createdAt: at, updatedAt: at
    };
    repos.memories.insert(row);
    state.db.db.prepare("UPDATE memories SET user_id=? WHERE id=?").run(owner, id);
    return repos.memories.get(id)!;
  }
  return {...state, repos, seed};
}

describe("same-source L1 deduplication without UID", () => {
  it.each(["profile", "source", "conversation"])("preserves the recorded %s when the same session is reopened", boundary => {
    const {db, repos, service} = setup();
    const rows: MemoryRow[] = [];
    for (const profile of ["a", "b"]) {
      const namespace = {source: boundary === "source" && profile === "b" ? "claude" : "codex",
        profileId: boundary === "profile" ? `profile-${profile}` : "default", userId: `user-${profile}`,
        sessionKey: `host-${profile}`, projectId: "project-p", workspaceId: "workspace-w"};
      const opened = service.openSession({namespace, meta: {conversationId: boundary === "conversation" ? `conversation-${profile}` : "native-conversation"}});
      const turn = service.completeTurn("native-turn", {sessionId: opened.sessionId, namespace,
        query: "Please inspect the project and report its test command.", answer: "The test command is npm test.",
        toolCalls: [{id: "read", name: "read_file", input: {path: "package.json"}}], toolResults: [{id: "read", output: "npm test"}]});
      const row = repos.memories.get(turn.l1MemoryId!)!;
      expect(row.info.profile_id).toBe(namespace.profileId); rows.push(row);
      repos.runtime.upsertCandidatePoolTrace({id: `candidate-${profile}`, userId: null, sessionId: opened.sessionId,
        sourceMemoryId: row.id, candidateKey: "policy", candidateValue: "same evidence", score: 1,
        evidence: {}, createdAt: at, updatedAt: at});
    }
    const a = rows[0]!, b = rows[1]!;
    service.openSession({sessionId: a.sessionId, namespace: {source: b.agentId!, profileId: b.info.profile_id as string,
      projectId: "project-p", workspaceId: "workspace-w"}, meta: {conversationId: b.conversationId}});
    repos.runtime.markCandidatePoolPromoted({candidateKey: "policy", sourceMemoryIds: [b.id], policyId: "policy-b", at});
    expect(db.db.prepare("SELECT id,status FROM l2_candidate_pool ORDER BY id").all()).toEqual([
      {id: "candidate-a", status: "pending"}, {id: "candidate-b", status: "promoted"}
    ]);
    repos.memories.softDelete(a.id);
    const history = db.db.prepare("SELECT * FROM memories ORDER BY id").all();
    expect(repos.memories.nativeDuplicates(b)).toEqual({ids: [b.id], deleted: false});
    expect(deduplicateSameSourceL1Candidates({repos, memories: [b]}).memories.map(row => row.id)).toEqual([b.id]);
    expect(db.db.prepare("SELECT * FROM memories ORDER BY id").all()).toEqual(history);
  });

  it.each([
    ["project", false], ["project", true], ["workspace", false], ["workspace", true]
  ] as const)("does not propagate deletion or L2 promotion after a session changes %s (deleted before move=%s)", async (boundary, deletedBeforeMove) => {
    const {db, repos, service, seed} = setup();
    const a = seed("a", "account-a", {project: boundary === "project" ? "project-a" : "shared-project"});
    const b = seed("b", "account-b", {project: boundary === "project" ? "project-b" : "shared-project"});
    // Historical hook sessions need not have a frozen source_namespace_key.
    db.db.prepare("UPDATE sessions SET meta_json='{}' WHERE id IN (?,?)").run(a.sessionId, b.sessionId);
    for (const memory of [a, b]) repos.runtime.upsertCandidatePoolTrace({
      id: `candidate-${memory.id}`, userId: null, sessionId: memory.sessionId, sourceMemoryId: memory.id,
      candidateKey: "shared-policy", candidateValue: "shared evidence", score: 1, evidence: {}, createdAt: at, updatedAt: at
    });
    if (deletedBeforeMove) repos.memories.softDelete("a");
    service.openSession({sessionId: a.sessionId, namespace: {source: "codex", profileId: "default",
      userId: "account-a", projectId: b.info.project_id as string, workspaceId: b.appId}});
    expect(repos.memories.nativeDuplicates(a)).toEqual({ids: ["a"], deleted: deletedBeforeMove});
    expect(repos.memories.nativeDuplicates(b)).toEqual({ids: ["b"], deleted: false});
    if (!deletedBeforeMove) {
      expect(deduplicateSameSourceL1Candidates({repos, memories: [a, b]}).memories).toHaveLength(2);
      repos.memories.softDelete("a");
    }
    const history = db.db.prepare("SELECT * FROM memories ORDER BY id").all();
    for (const userId of ["account-a", "account-b", "new-account"]) {
      const result = await service.search({namespace: {source: "codex", profileId: "default", userId},
        query: "shared evidence", layers: ["L1"], limit: 10});
      expect(result.hits.map(hit => hit.id)).toEqual(["b"]);
      expect(repos.runtime.listPendingCandidatePool({userId}).map(row => row.sourceMemoryId)).toEqual(["b"]);
    }
    expect(repos.memories.nativeDuplicates(repos.memories.getIncludingDeleted("a")!)).toEqual({ids: ["a"], deleted: true});
    repos.runtime.markCandidatePoolPromoted({candidateKey: "shared-policy", sourceMemoryIds: ["b"], policyId: "policy-b", at});
    expect(db.db.prepare("SELECT source_memory_id,status FROM l2_candidate_pool ORDER BY source_memory_id").all())
      .toEqual([{source_memory_id: "a", status: "pending"}, {source_memory_id: "b", status: "promoted"}]);
    expect(db.db.prepare("SELECT * FROM memories ORDER BY id").all()).toEqual(history);
  });

  it.each([["account-a", "account-b"], ["account-a", "account-a"], [null, null], ["account-a", null]])(
    "folds same-source copies (%s / %s), preserving rows, content and channel scores", (a, b) => {
      const {db, repos, seed} = setup();
      seed("copy-a", a); seed("copy-b", b);
      const before = db.db.prepare("SELECT * FROM memories ORDER BY id").all();
      const memories = [repos.memories.get("copy-b")!, repos.memories.get("copy-a")!];
      const result = deduplicateSameSourceL1Candidates({memories, repos,
        channelScoresByMemory: new Map([["copy-a", {fts: 0.2}], ["copy-b", {fts: 0.9, vec_summary: 0.8}]])});
      expect(result.memories.map(m => m.id)).toEqual(["copy-a"]);
      expect(result.channelScoresByMemory.get("copy-a")).toMatchObject({fts: 0.9, vec_summary: 0.8});
      expect(db.db.prepare("SELECT * FROM memories ORDER BY id").all()).toEqual(before);
    }
  );

  it("uses the latest same-source revision when only an older copy is a candidate", () => {
    const makeMemory = (input: {id: string; value: string; summary: string; updatedAt: string; version: number}): MemoryRow => ({
      id: input.id, timeline: at, userId: null, agentId: "codex", memoryType: "LongTermMemory",
      status: "activated", visibility: "private", memoryKey: `trace:${input.id}`, memoryValue: input.value,
      tags: ["trace"], info: {}, memoryLayer: "L1", contentHash: stableHash(input.value), version: input.version,
      createdAt: at, updatedAt: input.updatedAt,
      properties: {internal_info: {memory_layer: "L1", memory_kind: "trace", trace: {
        summary: input.summary, userText: "shared evidence", agentText: input.value, tool_calls: [], reflection: null
      }}}
    });
    const older = attachMemoryVector(makeMemory({id: "copy-a", value: "original evidence", summary: "original summary", updatedAt: at, version: 1}), {
      vectorField: "vec_summary", vector: [1, 0, 0], embeddingModel: "old-model"
    });
    const newer = attachMemoryVector(makeMemory({id: "copy-b", value: "revised evidence", summary: "revised summary",
      updatedAt: "2026-10-02T00:00:00.000Z", version: 2}), {
      vectorField: "vec_summary", vector: [0, 1, 0], embeddingModel: "new-model"
    });
    const byId = new Map([[older.id, older], [newer.id, newer]]);
    const repos = {memories: {
      nativeDuplicates: () => ({ids: ["copy-a", "copy-b"], deleted: false}),
      getMany: (ids: string[]) => ids.flatMap(id => byId.get(id) ? [byId.get(id)!] : [])
    }} as unknown as Repositories;

    const result = deduplicateSameSourceL1Candidates({
      memories: [older], repos,
      channelScoresByMemory: new Map([
        ["copy-a", {fts: 0.99, vec_summary: 0.95}],
        ["copy-b", {fts: 0.1}]
      ])
    });

    expect(result.memories.map(memory => memory.id)).toEqual(["copy-b"]);
    expect(result.memories[0]?.memoryValue).toBe("revised evidence");
    expect(memoryVectorEntries(result.memories[0]!)).toMatchObject([
      {vectorField: "vec_summary", vector: [0, 1, 0], embeddingModel: "new-model"}
    ]);
    expect(result.channelScoresByMemory.get("copy-b")).toBeUndefined();
    expect(result.memoryIdByMemoryId).toEqual(new Map([["copy-a", "copy-b"], ["copy-b", "copy-b"]]));
    expect(memoryVectorEntries(older)).toHaveLength(1);

    const config = structuredClone(DEFAULT_MEMMY_CONFIG);
    Object.assign(config.algorithm.retrieval, {
      minRecallScore: 0, relativeThresholdFloor: 0, smartSeed: false, llmFilterEnabled: false, minTraceSim: 0.1
    });
    const retrieval = retrievePluginMemories({
      query: "revised evidence", queryVector: [0, 1, 0], memories: result.memories, layers: ["L1"], limit: 1,
      channelScoresByMemory: result.channelScoresByMemory, config: config.algorithm.retrieval
    });
    expect(retrieval.hits.map(hit => hit.id)).toEqual(["copy-b"]);

    const fallback = deduplicateSameSourceL1Candidates({
      memories: [older], repos, isMemoryEligible: memory => memory.id === "copy-a"
    });
    expect(fallback.memories.map(memory => memory.id)).toEqual(["copy-a"]);

    const outOfScopeLatest = deduplicateSameSourceL1Candidates({
      memories: [older], repos,
      isMemoryEligible: () => true,
      isMemoryInScope: memory => memory.id === "copy-a"
    });
    expect(outOfScopeLatest.memories).toEqual([]);
  });

  it("expands an L1 route when same-source copies fill its candidate slots", async () => {
    const {repos, seed} = setup();
    seed("copy-a", "account-a");
    seed("copy-b", "account-b");
    seed("distinct-c", "account-c", {turn: "distinct-turn"});
    const routeFilters: Array<{excludedIds?: string[]}> = [];
    vi.spyOn(repos.memories, "searchFtsIds").mockImplementation((_match, filter = {}, limit = 20) => {
      routeFilters.push(filter);
      return ["copy-a", "copy-b", "distinct-c"]
        .filter(id => !filter.excludedIds?.includes(id))
        .slice(0, limit)
        .map((id, index) => ({id, score: 1 / (index + 1), channel: "fts"}));
    });
    const candidatePool = new IndexedCandidatePool({repos, memoryHasImportPipeline: () => false});
    const result = await candidatePool.indexedRetrievalCandidatePool({
      userId: null,
      compiledQuery: {
        ...compileRetrievalQuery("shared evidence"),
        patternTerms: [],
        structuralFragments: []
      },
      layers: ["L1"],
      config: {
        tier1TopK: 1,
        tier2TopK: 2,
        tier3TopK: 1,
        candidatePoolFactor: 1,
        keywordTopK: 2,
        tagFilter: "off"
      }
    });
    const collapsed = deduplicateSameSourceL1Candidates({memories: result.memories, repos});

    expect(routeFilters).toHaveLength(2);
    expect(routeFilters[0]?.excludedIds).toEqual([]);
    expect(routeFilters[1]?.excludedIds).toEqual(expect.arrayContaining(["copy-a", "copy-b"]));
    expect(collapsed.memories.map(memory => memory.id)).toEqual(["copy-a", "distinct-c"]);
  });

  it.each([
    {turn: "other-turn"}, {step: 1}, {project: "other-project"}, {conversation: "other-chat"},
    {source: "cursor"}, {profile: "other-profile"}, {tenant: "other-tenant"},
    {missingSource: true}, {layer: "L2" as const}, {work: true}
  ])("does not collapse equal content with a different or incomplete source: %j", options => {
    const {repos, seed} = setup();
    seed("a", "account-a"); seed("b", "account-b", options);
    expect(deduplicateSameSourceL1Candidates({repos, memories: repos.memories.list({}, 100)}).memories).toHaveLength(2);
  });

  it("does not let an unreturned deleted copy or recent raw turn reappear through a sibling", () => {
    const {repos, seed} = setup();
    seed("a", "account-a"); const b = seed("b", "account-b");
    expect(deduplicateSameSourceL1Candidates({repos, memories: [b], excludeTraceRawTurnIds: new Set(["raw-a"])}).memories).toEqual([]);
    repos.memories.softDelete("a");
    expect(deduplicateSameSourceL1Candidates({repos, memories: [b]}).memories).toEqual([]);
  });

  it.each([false, true])("search integration returns one historical copy for every account (time filter=%s)", async time => {
    const {db, repos, service, seed} = setup(time);
    seed("a", "account-a"); seed("b", "account-b"); seed("c", null, {turn: "different-turn"});
    const before = db.db.prepare("SELECT * FROM memories ORDER BY id").all();
    for (const userId of ["account-a", "account-b", "new-account"]) {
      const result = await service.search({namespace: {source: "codex", profileId: "default", userId}, query: "shared evidence", layers: ["L1"], limit: 10});
      expect(result.hits.map(hit => hit.id).sort()).toEqual(["a", "c"]);
      expect(result.sourceMemoryIds.sort()).toEqual(["a", "c"]);
    }
    expect(db.db.prepare("SELECT * FROM memories ORDER BY id").all()).toEqual(before);
    repos.memories.softDelete("b");
    const result = await service.search({namespace: {source: "codex", profileId: "default", userId: "new-account"}, query: "shared evidence", layers: ["L1"], limit: 10});
    expect(result.hits.map(hit => hit.id)).toEqual(["c"]);
  });

  it("uses the same historical source for repair suggestions across accounts", async () => {
    const {db, repos, service, seed} = setup();
    seed("a", "account-a"); seed("b", "account-b");
    const before = db.db.prepare("SELECT * FROM memories ORDER BY id").all();
    for (const userId of ["account-a", "account-b", "new-account"]) {
      const session = service.openSession({namespace: {source: "codex", profileId: "default", userId}});
      const result = await service.repairSuggestion({sessionId: session.sessionId, issue: "shared evidence"});
      expect(result.sourceMemoryIds).toEqual(["a"]);
    }
    expect(db.db.prepare("SELECT * FROM memories ORDER BY id").all()).toEqual(before);
    repos.memories.softDelete("a");
    const session = service.openSession({namespace: {source: "codex", profileId: "default", userId: "account-b"}});
    const result = await service.repairSuggestion({sessionId: session.sessionId, issue: "shared evidence"});
    expect(result.sourceMemoryIds).toEqual([]);
  });

  it("folds copies returned by separate query rewrites before final fusion", async () => {
    const {repos, service, seed} = setup(false, true);
    seed("a", "account-a"); seed("b", "account-b");
    const pool = vi.spyOn(IndexedCandidatePool.prototype, "indexedRetrievalCandidatePool");
    pool.mockResolvedValueOnce({memories: [repos.memories.get("a")!], channelScoresByMemory: new Map([["a", {vec_summary: 1}], ["b", {vec_summary: 1}]])});
    pool.mockResolvedValueOnce({memories: [repos.memories.get("b")!], channelScoresByMemory: new Map([["a", {vec_summary: 1}], ["b", {vec_summary: 1}]])});
    const result = await service.search({namespace: {source: "codex", profileId: "default", userId: "account-b"}, query: "shared evidence", layers: ["L1"], limit: 10});
    expect(pool).toHaveBeenCalledTimes(2);
    expect(result.hits.map(hit => hit.id)).toEqual(["a"]);
    expect(result.sourceMemoryIds).toEqual(["a"]);
  });
});
