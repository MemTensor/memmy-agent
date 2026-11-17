import { afterEach, describe, expect, it } from "vitest";
import { createMemoryHttpServer, closeMemoryHttpServer } from "../../src/server/http.js";
import type { AgentSourceExecutor } from "../../src/agent-source/runtime.js";
import { MemoryDb } from "../../src/storage/db.js";
import { Repositories, type RecallEventRecord } from "../../src/storage/repositories.js";
import { SCHEMA_VERSION } from "../../src/storage/schema.js";
import { DEVICE_MEMORY_OWNER } from "../../src/service/namespace/memory-owner.js";
import { DEFAULT_NAMESPACE_SOURCE, type RecallHit, type RuntimeNamespace } from "../../src/types.js";
import { createMemoryServiceFixture } from "../fixtures/memory-service-fixture.js";
import { join } from "node:path";

const fixture = createMemoryServiceFixture();
afterEach(fixture.cleanup);
const a = { source: "codex", profileId: "profile-a", userId: "owner-a" };
const b = { source: "codex", profileId: "profile-b", userId: "owner-b", projectId: "project-b", workspaceId: "workspace-b" };
const defaults = { source: DEFAULT_NAMESPACE_SOURCE, profileId: "default", userId: "owner-default" };

async function setup() {
  const f = fixture.createTestService();
  const repos = new Repositories(f.db.db);
  let sequence = 0;
  const server = createMemoryHttpServer({ service: f.service, startAgentSourceAutomation: false,
    agentSourceExecutor: { dispose() {}, startAutomation() {} } as unknown as AgentSourceExecutor,
    workerStartupFallbackMs: 3600000, workerPostHealthDelayMs: 3600000, workerIdlePollMs: 3600000,
    auth: { localServiceToken: "local", cloudAccessTokens: { "cloud-a": a }, scopedApiKeys: {
      a: { namespace: a, scopes: ["memory:read"] }, b: { namespace: b, scopes: ["memory:read"] },
      "a-switched": { namespace: { ...a, userId: "other-account" }, scopes: ["memory:read"] },
      "a-in-b-profile": { namespace: { ...b, userId: a.userId }, scopes: ["memory:read"] },
      "b-project-default": { namespace: { ...b, projectId: undefined }, scopes: ["memory:read"] },
      unbound: { namespace: { source: a.source, profileId: a.profileId }, scopes: ["memory:read"] },
      defaults: { namespace: defaults, scopes: ["memory:read"] }
    } } });
  await new Promise<void>(resolve => server.listen(0, "127.0.0.1", resolve));
  const address = server.address();
  if (!address || typeof address === "string") throw new Error("No fixture listener");
  const call = async (path: string, token: string, body?: unknown, headers: Record<string, string> = {}) => {
    const response = await fetch(`http://127.0.0.1:${address.port}/api/v1/${path}`, {
      method: body === undefined ? "GET" : "POST", headers: { authorization: `Bearer ${token}`, "content-type": "application/json", ...headers },
      ...(body === undefined ? {} : { body: JSON.stringify(body) })
    });
    return { status: response.status, body: await response.json() as any };
  };
  const evidence = (queryId: string, token: string, headers?: Record<string, string>) => call(`memory/recalls/${encodeURIComponent(queryId)}`, token, undefined, headers);
  const search = (queryId: string, token: string, query: string, extra: Record<string, unknown> = {}) => call("memory/search", token,
    { query, turnId: queryId, layers: ["L1"], verbose: true, ...extra });
  const memory = (namespace: RuntimeNamespace, label: string, legacy = false, layer: "L1" | "Skill" = "L1") => {
    const added = f.service.addMemory({ namespace, layer, content: label });
    if (legacy) f.db.db.prepare("UPDATE memories SET user_id=? WHERE id=?").run(namespace.userId, added.id);
    return repos.memories.get(added.id)!;
  };
  const complete = async (namespace: RuntimeNamespace, label: string) => {
    const session = f.service.openSession({ namespace });
    const result = await f.service.completeTurn(label, { sessionId: session.sessionId,
      query: `Inspect ${label}.ts and preserve its release checks`, answer: `The ${label} checks are preserved`,
      toolCalls: [{ name: "read_file", input: { path: `${label}.ts` }, output: "fixture source" }] });
    return { session, result };
  };
  const hit = (id: string, marker: string, extra: Partial<RecallHit> = {}): RecallHit => ({
    ...repos.memories.toListItem(repos.memories.get(id)!), snippet: marker, title: marker, tags: [marker], score: 1, source: "search", ...extra
  });
  const member = (value: RecallHit): NonNullable<RecallHit["members"]>[number] => ({ id: value.id, kind: value.kind,
    memoryLayer: value.memoryLayer, status: value.status, content: value.snippet,
    createdAt: value.createdAt ?? new Date().toISOString(), updatedAt: value.updatedAt ?? new Date().toISOString(), retrievalRoute: "l1" });
  const event = (queryId: string, options: { owner?: string; namespace?: unknown; query?: string; hits?: RecallHit[];
    sessionId?: string; episodeId?: string; turnId?: string; candidateMemoryIds?: string[]; injectedMemoryIds?: string[] } = {}) => {
    sequence += 1;
    const scope = Object.prototype.hasOwnProperty.call(options, "namespace") ? options.namespace : a;
    const record: RecallEventRecord = { id: `recall-scope-${sequence}`, userId: options.owner ?? DEVICE_MEMORY_OWNER,
      queryId, query: options.query ?? `query-${sequence}`, layers: ["L1"], hitMemoryIds: options.hits?.map(item => item.id) ?? [],
      request: { ...(scope === undefined ? {} : { namespace: scope }), recallEvidence: { hits: options.hits ?? [] } },
      createdAt: new Date(Date.now() + sequence * 1000).toISOString(),
      sessionId: options.sessionId, episodeId: options.episodeId, turnId: options.turnId,
      candidateMemoryIds: options.candidateMemoryIds, injectedMemoryIds: options.injectedMemoryIds };
    repos.runtime.insertRecallEvent(record);
    return record;
  };
  return { ...f, repos, call, evidence, search, memory, complete, hit, member, event, close: () => closeMemoryHttpServer(server) };
}

describe("recall evidence authenticated scope", () => {
  it("authorizes real DEVICE search evidence independently of empty hits", async () => {
    const f = await setup();
    try {
      const foreign = f.memory(b, "Formal private B memory");
      expect((await f.search("formal-device-b", "b", "Formal private B query")).status).toBe(200);
      const stored = f.repos.runtime.getRecallEventByQueryId("formal-device-b")!;
      expect(stored.userId).toBe(DEVICE_MEMORY_OWNER);
      expect((stored.request as any).namespace).toMatchObject(b);
      expect((await f.call(`memory/${foreign.id}`, "a")).status).toBe(404);
      expect((await f.evidence("formal-device-b", "a")).status).toBe(404);
      expect((await f.evidence("formal-device-b", "cloud-a")).status).toBe(404);
      expect((await f.evidence("formal-device-b", "b")).body.query).toBe("Formal private B query");
      expect((await f.evidence("formal-device-b", "a-in-b-profile")).body.query).toBe("Formal private B query");
      expect((await f.evidence("formal-device-b", "local")).status).toBe(200);
    } finally { await f.close(); }
  });

  it("selects the caller's older DEVICE event despite more than 32 foreign turnId collisions", async () => {
    const f = await setup();
    try {
      expect((await f.search("same-native-turn", "a", "A original query")).status).toBe(200);
      expect((await f.search("same-native-turn", "b", "B private query")).status).toBe(200);
      for (let i = 0; i < 40; i++) f.event("same-native-turn", { namespace: b, query: `B collision ${i}` });
      expect((await f.evidence("same-native-turn", "a")).body.query).toBe("A original query");
      expect((await f.evidence("same-native-turn", "a-switched")).body.query).toBe("A original query");
      expect((await f.evidence("same-native-turn", "b")).body.query).toBe("B collision 39");
      expect((await f.evidence("same-native-turn", "local")).body.query).toBe("B collision 39");
    } finally { await f.close(); }
  });

  it.each(["tenantId", "source", "profileId", "projectId", "workspaceId"] as const)(
    "rejects an independently different captured %s without relying on another field", async field => {
      const f = await setup();
      try {
        f.event("one-field-scope", { namespace: { ...b, [field]: "foreign-field" } });
        expect((await f.evidence("one-field-scope", "b")).status).toBe(404);
        expect((await f.evidence("one-field-scope", "local")).status).toBe(200);
      } finally { await f.close(); }
    }
  );

  it("matches the canonical effective project when projectId defaults to workspaceId", async () => {
    const f = await setup();
    try {
      f.event("project-alias", { namespace: { ...b, projectId: b.workspaceId } });
      expect((await f.evidence("project-alias", "b-project-default")).status).toBe(200);
      f.event("project-alias", { namespace: { ...b, projectId: undefined } });
      expect((await f.evidence("project-alias", "b-project-default")).status).toBe(200);
    } finally { await f.close(); }
  });

  it("keeps legacy raw-owner and explicit profile boundaries when query IDs collide", async () => {
    const f = await setup();
    try {
      const own = f.memory(a, "Legacy own hit", true), foreign = f.memory(b, "Legacy foreign hit", true);
      f.event("legacy-collision", { owner: a.userId, namespace: a, query: "Legacy A query", hits: [f.hit(own.id, "OWN_LEGACY")] });
      f.event("legacy-collision", { owner: a.userId, namespace: { ...b, userId: a.userId }, query: "Same UID foreign profile", hits: [f.hit(foreign.id, "FOREIGN_LEGACY")] });
      expect((await f.evidence("legacy-collision", "a")).body.query).toBe("Legacy A query");
      expect((await f.evidence("legacy-collision", "a-switched")).status).toBe(404);
      expect((await f.evidence("legacy-collision", "a-in-b-profile")).body.query).toBe("Same UID foreign profile");
      expect((await f.evidence("legacy-collision", "b")).status).toBe(404);
      expect((await f.evidence("legacy-collision", "local")).body.query).toBe("Same UID foreign profile");
    } finally { await f.close(); }
  });

  it.each([undefined, {}, { source: a.source }, { profileId: a.profileId }, { source: "", profileId: a.profileId }])(
    "rejects unknown captured scope %j nonlocally while local management can read it", async namespace => {
      const f = await setup();
      try {
        f.event("unknown-scope", { owner: a.userId, namespace, query: "Unknown legacy scope" });
        expect((await f.evidence("unknown-scope", "a")).status).toBe(404);
        expect((await f.evidence("unknown-scope", "local")).body.query).toBe("Unknown legacy scope");
      } finally { await f.close(); }
    }
  );

  it("allows explicit default source/profile with an omitted project and denies forged missing-user scope", async () => {
    const f = await setup();
    try {
      f.event("explicit-defaults", { namespace: defaults });
      expect((await f.evidence("explicit-defaults", "defaults")).status).toBe(200);
      f.event("missing-auth-user");
      expect((await f.evidence("missing-auth-user", "unbound", { "x-memmy-user-id": a.userId })).status).toBe(404);
      expect((await f.evidence("missing-auth-user", "a")).status).toBe(200);
    } finally { await f.close(); }
  });

  it("skips contradictory session events without hiding an older valid event of the same scope", async () => {
    const f = await setup();
    try {
      const own = await f.complete(a, "event-own"), foreign = await f.complete(b, "event-foreign");
      f.event("context-collision", { query: "Valid own context", sessionId: own.session.sessionId, episodeId: own.result.episodeId });
      for (let i = 0; i < 40; i++) f.event("context-collision", { query: "Contradictory private context", sessionId: foreign.session.sessionId, episodeId: foreign.result.episodeId });
      expect((await f.evidence("context-collision", "a")).body.query).toBe("Valid own context");
      expect((await f.evidence("context-collision", "local")).body.query).toBe("Contradictory private context");
    } finally { await f.close(); }
  });

  it("keeps only wholly authorized hit snapshots and validates every member and source reference", async () => {
    const f = await setup();
    try {
      const own = await f.complete(a, "hit-own"), foreign = await f.complete(b, "hit-foreign");
      const ownHit = f.hit(own.result.l1MemoryId!, "OWN_HIT", { sourceTurnId: own.result.rawTurnId });
      const ownOther = f.memory(a, "Another authorized memory"), foreignSkill = f.memory(b, "Foreign skill", false, "Skill");
      const foreignHit = f.hit(foreign.result.l1MemoryId!, "FOREIGN_HIT");
      const goodMerged = { ...ownHit, snippet: "OWN_MERGED", title: "OWN_MERGED", tags: ["OWN_MERGED"],
        members: [f.member(ownHit), f.member(f.hit(ownOther.id, "OWN_MEMBER"))], memberMemoryIds: [ownHit.id, ownOther.id] };
      const mixed = { ...goodMerged, snippet: "FOREIGN_AGGREGATE", title: "FOREIGN_TITLE", tags: ["FOREIGN_TAG"],
        members: [f.member(ownHit), f.member(foreignHit)], memberMemoryIds: [ownHit.id, foreignHit.id] };
      const hiddenMember = { ...goodMerged, memberMemoryIds: [ownHit.id, ownOther.id, foreignHit.id], snippet: "FOREIGN_MEMBER_IDS" };
      const foreignTurn = { ...ownHit, sourceTurnId: foreign.result.rawTurnId, snippet: "FOREIGN_SOURCE_TURN" };
      const foreignSource = { ...ownHit, sourceSkillId: foreignSkill.id, sourceSkillVersion: "FOREIGN_VERSION", snippet: "FOREIGN_SOURCE_SKILL" };
      f.event("mixed-hits", { hits: [ownHit, goodMerged, foreignHit, mixed, hiddenMember, foreignTurn, foreignSource],
        candidateMemoryIds: [ownHit.id, foreignHit.id, "missing-memory"], injectedMemoryIds: [ownOther.id, foreignSkill.id] });
      const result = await f.evidence("mixed-hits", "a");
      expect(result.status).toBe(200);
      expect(result.body.hits.map((hit: RecallHit) => hit.snippet)).toEqual(["OWN_HIT", "OWN_MERGED"]);
      expect(JSON.stringify(result.body)).not.toContain("FOREIGN");
      expect(result.body.diagnostics).toMatchObject({ candidateMemoryIds: [ownHit.id], injectedMemoryIds: [ownOther.id] });
      expect((await f.evidence("mixed-hits", "local")).body.hits).toHaveLength(7);
    } finally { await f.close(); }
  });

  it("retains a proven UserMemory member and rejects a mixed-scope member snapshot", async () => {
    const f = await setup();
    try {
      const own = await f.complete(a, "user-member-own"), foreign = await f.complete(b, "user-member-foreign");
      for (const [id, turn] of [["user-own", own], ["user-foreign", foreign]] as const) f.repos.userMemories.insert({ id,
        userId: "ignored-account", sourceTurnId: turn.result.rawTurnId, sourceTurnRefs: [turn.result.rawTurnId], memoryTypes: ["User Preference"],
        content: id, normalizedUserTextHash: id, status: "active", createdAt: new Date().toISOString(), updatedAt: new Date().toISOString() });
      const top = f.hit(own.result.l1MemoryId!, "OWN_USER_MERGE", { sourceTurnId: own.result.rawTurnId });
      const userMember = (id: string): NonNullable<RecallHit["members"]>[number] => ({ id, kind: "user_memory", memoryLayer: "UserMemory", status: "active",
        content: id, createdAt: new Date().toISOString(), updatedAt: new Date().toISOString(), retrievalRoute: "user_memory" });
      const good = { ...top, members: [f.member(top), userMember("user-own")], memberMemoryIds: [top.id, "user-own"] };
      const mixed = { ...good, snippet: "FOREIGN_USER_MERGE", members: [...good.members, userMember("user-foreign")], memberMemoryIds: [...good.memberMemoryIds, "user-foreign"] };
      f.event("user-members", { hits: [good, mixed], candidateMemoryIds: ["user-own", "user-foreign"] });
      const result = await f.evidence("user-members", "a");
      expect(result.body.hits).toHaveLength(1);
      expect(result.body.hits[0].members.map((item: { id: string }) => item.id)).toEqual([top.id, "user-own"]);
      expect(result.body.diagnostics.candidateMemoryIds).toEqual(["user-own"]);
    } finally { await f.close(); }
  });

  it("retains an authorized opaque external Skill origin and rejects forged snapshot origin metadata", async () => {
    const f = await setup();
    try {
      const skill = f.service.addMemory({ namespace: a, layer: "Skill", source: a.source, sourceAgentId: "native-agent",
        sourceSkillId: "opaque-external-skill-slug", sourceSkillVersion: "1", content: "OWN_EXTERNAL_SKILL" });
      const internal = f.repos.memories.get(skill.id)!.properties.internal_info;
      expect(internal).toMatchObject({ read_only: true, source_skill_id: "opaque-external-skill-slug" });
      expect(f.repos.memories.get("opaque-external-skill-slug")).toBeUndefined();
      const valid = f.hit(skill.id, "OWN_EXTERNAL_SKILL", { source: "skill", readOnly: true,
        sourceAgentId: "native-agent", sourceSkillId: "opaque-external-skill-slug", sourceSkillVersion: "1" });
      const otherOwnedSkill = f.memory(a, "Other owned skill", false, "Skill");
      const forged = { ...valid, snippet: "FOREIGN_EXTERNAL_SNAPSHOT", sourceSkillId: otherOwnedSkill.id };
      f.event("external-origin", { hits: [valid, forged] });
      const result = await f.evidence("external-origin", "a");
      expect(result.body.hits).toEqual([valid]);
      expect((await f.evidence("external-origin", "local")).body.hits).toHaveLength(2);
    } finally { await f.close(); }
  });

  it("requires raw-turn proof before returning capture diagnostics and filters all recorded memory IDs", async () => {
    const f = await setup();
    try {
      const own = await f.complete(a, "capture-own"), foreign = await f.complete(b, "capture-foreign");
      const setCapture = (rawId: string) => {
        const raw = f.repos.runtime.getRawTurn(rawId)!;
        f.repos.runtime.updateRawTurn({ ...raw, messagePayload: { ...raw.messagePayload,
          turn_complete: { ...raw.messagePayload?.turn_complete as object, memory_capture: {
            status: "completed", decided_at: new Date().toISOString(),
            l1: [{ memory_id: own.result.l1MemoryId, written: true, policy_eligible: true }, { memory_id: foreign.result.l1MemoryId, written: true, policy_eligible: true }],
            user_memory: { written: true, action: "confirmed", memory_id: "unproven-user-memory" }, unexpected: "FOREIGN_DIAGNOSTIC" }
          } } });
      };
      setCapture(own.result.rawTurnId);
      f.event("capture-evidence", { sessionId: own.session.sessionId, episodeId: own.result.episodeId, turnId: "capture-own" });
      const result = await f.evidence("capture-evidence", "a");
      expect(result.body.diagnostics.capture.l1.map((entry: { memory_id: string }) => entry.memory_id)).toEqual([own.result.l1MemoryId]);
      expect(result.body.diagnostics.capture.user_memory).toBeUndefined();
      expect(JSON.stringify(result.body)).not.toContain("FOREIGN_DIAGNOSTIC");
      f.db.db.prepare("UPDATE raw_turns SET user_id=? WHERE id=?").run(b.userId, own.result.rawTurnId);
      f.event("capture-no-raw-proof", { sessionId: own.session.sessionId, turnId: "capture-own" });
      expect((await f.evidence("capture-no-raw-proof", "a")).body.diagnostics.capture).toBeUndefined();
      expect((await f.evidence("capture-no-raw-proof", "local")).body.diagnostics.capture.status).toBe("completed");
    } finally { await f.close(); }
  });
});

it("installs the recall lookup index when an existing current-schema database is reopened", () => {
  const path = join(fixture.createTestRoot("recall-index-"), "memory.sqlite");
  const first = new MemoryDb({ path });
  expect(first.schemaVersion().version).toBe(SCHEMA_VERSION);
  first.db.exec("DROP INDEX IF EXISTS idx_recall_events_query_created");
  first.close();
  const reopened = new MemoryDb({ path });
  try {
    expect(reopened.schemaVersion().version).toBe(SCHEMA_VERSION);
    expect(reopened.db.prepare("SELECT 1 FROM sqlite_master WHERE type='index' AND name='idx_recall_events_query_created'").get()).toBeDefined();
    const plan = reopened.db.prepare("EXPLAIN QUERY PLAN SELECT * FROM recall_events WHERE query_id=? ORDER BY created_at DESC LIMIT 1").all("query");
    expect(JSON.stringify(plan)).toContain("idx_recall_events_query_created");
  } finally { reopened.close(); }
});

it("adds the recall lookup index only after a supported legacy query_id column is upgraded", () => {
  const path = join(fixture.createTestRoot("recall-legacy-index-"), "memory.sqlite");
  const legacy = new MemoryDb({ path });
  legacy.db.exec("DROP INDEX IF EXISTS idx_recall_events_query_created; ALTER TABLE recall_events DROP COLUMN query_id");
  legacy.db.prepare("DELETE FROM schema_migrations").run();
  legacy.db.prepare("INSERT INTO schema_migrations(id,version,applied_at,checksum) VALUES('recall-legacy',2,'2026-01-01','fixture')").run();
  legacy.close();
  const upgraded = new MemoryDb({ path });
  try {
    expect(upgraded.schemaVersion().version).toBe(SCHEMA_VERSION);
    expect(upgraded.db.prepare("PRAGMA table_info(recall_events)").all()).toEqual(expect.arrayContaining([expect.objectContaining({ name: "query_id" })]));
    expect(upgraded.db.prepare("SELECT 1 FROM sqlite_master WHERE type='index' AND name='idx_recall_events_query_created'").get()).toBeDefined();
  } finally { upgraded.close(); }
});
