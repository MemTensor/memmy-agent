import { afterEach, describe, expect, it, vi } from "vitest";
import { DEFAULT_MEMMY_CONFIG, type LlmClient, type MemoryRow } from "../../../src/index.js";
import { Repositories } from "../../../src/storage/repositories.js";
import { refreshProjectAliases } from "../../../src/storage/device-scope.js";
import { sha256Hex } from "../../../src/contracts/index.js";
import { stableHash } from "../../../src/utils/id.js";
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
      id, userId: null, sessionId: opened.sessionId, timeline: at, agentId: "codex",
      memoryLayer: options.layer ?? "L1", memoryType: "LongTermMemory", status: "activated", visibility: "private",
      memoryKey: `trace:${id}`, memoryValue: "shared evidence unchanged", tags: ["trace"], info: {turn_id: turn},
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
