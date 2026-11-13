import { afterEach, describe, expect, it } from "vitest";
import type { DEFAULT_MEMMY_CONFIG } from "../../src/index.js";
import { createMemoryHttpServer, closeMemoryHttpServer } from "../../src/server/http.js";
import type { AgentSourceExecutor } from "../../src/agent-source/runtime.js";
import { Repositories } from "../../src/storage/repositories.js";
import { createMemoryServiceFixture, LEGACY_TEST_CONFIG } from "../fixtures/memory-service-fixture.js";
import { upsertL2Candidate } from "../../src/service/evolution/l2-candidate-service.js";
import { DEVICE_MEMORY_OWNER } from "../../src/service/namespace/memory-owner.js";

const fixture = createMemoryServiceFixture();
afterEach(fixture.cleanup);
const scope = { userId: "historical-owner", source: "codex", profileId: "default" };
async function setup(mixed = false) {
  const config: typeof DEFAULT_MEMMY_CONFIG=structuredClone(LEGACY_TEST_CONFIG);
  if (mixed) { config.algorithm.l2Induction.mode="unified"; config.algorithm.l2Induction.useLlm=true; }
  const { service, db } = fixture.createTestService({config});
  const repos = new Repositories(db.db);
  const episodeIds: string[] = [];
  for (const kind of ["historical", "device"]) {
    const session = service.openSession({ namespace: scope });
    const turn = await service.completeTurn(kind, { sessionId: session.sessionId, namespace: scope,
      query: "Verify the parser with the requested input.", answer: "The requested input has been verified." });
    episodeIds.push(turn.episodeId!);
    // Explicit fixture-only history: production's new writes retain the device owner.
    if (kind === "historical") for (const [table, id] of [["sessions", turn.sessionId], ["episodes", turn.episodeId], ["raw_turns", turn.rawTurnId], ["memories", turn.l1MemoryId]])
      db.db.prepare(`UPDATE ${table} SET user_id=? WHERE id=?`).run(scope.userId, id);
  }
  if (mixed) {
    const episode=repos.runtime.getEpisode(episodeIds[0]!)!;
    const correction=await service.completeTurn("device-correction", {sessionId:episode.sessionId,episodeId:episode.id,
      namespace:scope,query:"Continue the same parser verification",answer:"A new parser correction still needs checking"});
    expect(correction.episodeId).toBe(episode.id);
    expect(repos.memories.get(correction.l1MemoryId)?.userId).toBe(DEVICE_MEMORY_OWNER);
    repos.runtime.closeEpisode(episode.id,{closeReason:"finalized"});
    db.db.prepare("DELETE FROM evolution_jobs").run();
    for (const id of repos.runtime.getEpisode(episode.id)!.l1MemoryIds) {
      const source=repos.memories.get(id)!;
      upsertL2Candidate(repos,{sourceMemoryId:id,userId:source.userId,route:"negative"});
    }
  }
  const writes = ["memory:read", "memory:write"];
  const server = createMemoryHttpServer({ service, startAgentSourceAutomation: false,
    agentSourceExecutor: { dispose() {}, startAutomation() {} } as unknown as AgentSourceExecutor,
    workerStartupFallbackMs: 3600000, workerPostHealthDelayMs: 3600000, workerIdlePollMs: 3600000,
    auth: { localServiceToken: "local", cloudAccessTokens: { cloud: scope, "cloud-unbound": {source:"codex",profileId:"default"} }, scopedApiKeys: {
      scoped: { namespace: scope, scopes: writes },
      other: { namespace: { ...scope, userId: "other-account" }, scopes: writes },
      profile: { namespace: { ...scope, profileId: "foreign" }, scopes: writes },
      project: { namespace: { ...scope, projectId: "foreign" }, scopes: writes },
      workspace: { namespace: { ...scope, workspaceId: "foreign" }, scopes: writes },
      tenant: { namespace: { ...scope, tenantId: "foreign" }, scopes: writes },
      session: { namespace: { ...scope, sessionKey: "foreign" }, scopes: writes },
      unbound: { namespace: { source: "codex", profileId: "default" }, scopes: writes },
      readonly: { namespace: scope, scopes: ["memory:read"] }
    } } });
  await new Promise<void>(resolve => server.listen(0, "127.0.0.1", resolve));
  const address = server.address(); if (!address || typeof address === "string") throw Error("Missing test port");
  const call = async (id: string, token: string, retry = false, body: unknown = {}, headers: Record<string, string> = {}) => {
    const response = await fetch(`http://127.0.0.1:${address.port}/api/v1/panel/tasks/${id}/experience-processing${retry ? "/retry" : ""}`, {
      method: retry ? "POST" : "GET", headers: { authorization: `Bearer ${token}`, "content-type": "application/json", ...headers },
      ...(retry ? {body: JSON.stringify(body)} : {}) });
    return { status: response.status, body: await response.json() };
  };
  return { service, repos, db, episodeIds, call, close: () => closeMemoryHttpServer(server) };
}
describe("experience recovery local device library and authenticated scope", () => {
  it("permits the local panel to read and retry both historical and device records without migrating owners", async () => {
    const f = await setup();
    try {
      const before = f.episodeIds.map(id => f.repos.runtime.getEpisode(id));
      for (const id of f.episodeIds) for (const retry of [false, true]) {
        const result = await f.call(id, "local", retry, {}, {"x-memmy-user-id": "new-account"});
        expect(result.status).toBe(200);
      }
      for (const id of f.episodeIds) expect((await f.call(id, "local", false, {}, {"x-memmy-tenant-id":"foreign"})).status).toBe(403);
      expect(f.episodeIds.map(id => f.repos.runtime.getEpisode(id))).toEqual(before);
    } finally { await f.close(); }
  });
  it("allows matching scoped history and proven device data, but keeps historical ownership", async () => {
    const f = await setup();
    try {
      for (const retry of [false, true]) {
        for (const id of f.episodeIds) for (const token of ["scoped", "cloud"]) expect((await f.call(id, token, retry)).status).toBe(200);
        expect((await f.call(f.episodeIds[1]!, "other", retry)).status).toBe(200);
        expect((await f.call(f.episodeIds[0]!, "other", retry)).status).toBe(403);
      }
    } finally { await f.close(); }
  });
  it("rejects out-of-scope profile, project, workspace, tenant and session before reading or enqueueing", async () => {
    const f = await setup();
    try {
      const before = f.episodeIds.map(id => f.repos.runtime.getEpisode(id));
      for (const token of ["profile", "project", "workspace", "tenant", "session", "unbound", "cloud-unbound"])
        for (const id of f.episodeIds) for (const retry of [false, true]) expect((await f.call(id, token, retry)).status, `${token} ${id} ${retry}`).toBe(403);
      expect(f.episodeIds.map(id => f.repos.runtime.getEpisode(id))).toEqual(before);
      expect(f.db.db.prepare("SELECT COUNT(*) AS count FROM evolution_jobs WHERE job_type='l2_induction'").get()).toEqual({count:0});
    } finally { await f.close(); }
  });
  it("rejects forged namespace body, unbound credentials and read-only writes", async () => {
    const f = await setup();
    try {
      const id = f.episodeIds[0]!;
      expect((await f.call(id, "other", true, {namespace:scope})).status).toBe(403);
      expect((await f.call(id, "profile", true, {namespace:scope})).status).toBe(403);
      expect((await f.call(id, "unbound", true, {namespace:scope})).status).toBe(403);
      expect((await f.call(id, "unbound", false, {}, {"x-memmy-user-id":scope.userId})).status).toBe(403);
      expect((await f.call(id, "profile", false, {}, {"x-memmy-profile-id":"default"})).status).toBe(403);
      expect((await f.call(id, "readonly", true)).status).toBe(403);
      expect((await f.call(id, "wrong-token")).status).toBe(401);
    } finally { await f.close(); }
  });
  it("reports the pending and failed device correction of a historical task through the real read-only HTTP route",async()=>{
    const f=await setup(true);
    try {
      const id=f.episodeIds[0]!;
      const before=f.db.db.prepare("SELECT * FROM l2_candidate_pool ORDER BY id").all();
      for (const token of ["local","scoped"]) {
        const result=await f.call(id,token);
        expect(result.status).toBe(200);
        expect(result.body).toMatchObject({state:"pending",pendingCount:2,canRetry:true});
      }
      expect(f.db.db.prepare("SELECT * FROM l2_candidate_pool ORDER BY id").all()).toEqual(before);
      f.db.db.prepare("UPDATE l2_candidate_pool SET status='promoted' WHERE user_id=?").run(scope.userId);
      const source=f.repos.runtime.getEpisode(id)!.l1MemoryIds.map(id=>f.repos.memories.get(id)!).find(source=>source.userId===DEVICE_MEMORY_OWNER)!;
      const at=new Date().toISOString();
      f.repos.runtime.enqueueJob({id:"device-only-failed",jobType:"l2_induction",userId:DEVICE_MEMORY_OWNER,episodeId:id,
        sessionId:source.sessionId,targetMemoryId:source.id,payload:{unified:true},status:"dead_letter",attempts:1,maxAttempts:1,
        lastError:"l2 extraction: correction budget exhausted",createdAt:at,updatedAt:at});
      expect((await f.call(id,"local")).body).toMatchObject({state:"failed",pendingCount:1,canRetry:true,jobId:"device-only-failed"});
      expect((await f.call(id,"other")).status).toBe(403);
      expect(f.repos.runtime.getEpisode(id)!.userId).toBe(scope.userId);
      expect(f.repos.memories.get(source.id)!.userId).toBe(DEVICE_MEMORY_OWNER);
    } finally { await f.close(); }
  });

});
