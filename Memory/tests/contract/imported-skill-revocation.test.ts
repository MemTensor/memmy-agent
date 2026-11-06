import "../fixtures/isolated-user-home.js";
import { writeFileSync } from "node:fs";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { createMemoryHttpServer } from "../../src/index.js";
import { createAgentSourceExecutor } from "../../src/agent-source/runtime.js";
import { createSourceRegistry } from "../../src/agent-source/adapters/source-registry.js";
import { createSkillTargetRegistry } from "../../src/agent-source/integration/target-registry.js";
import { importedSkillContentHash } from "../../src/storage/imported-skill.js";
import { buildUserMemory } from "../../src/service/user-memory/user-memory.js";
import { Repositories } from "../../src/storage/repositories.js";
import { createCapturingEmbedder, createFailingLlm, createMemoryServiceFixture, LEGACY_TEST_CONFIG } from "../fixtures/memory-service-fixture.js";
const fixture = createMemoryServiceFixture();
const closers: Array<() => Promise<void>> = [];
afterEach(async () => { while (closers.length) await closers.pop()!(); vi.restoreAllMocks(); await fixture.cleanup(); });
const namespace = { source: "claude_code", profileId: "default", userId: "revocation-user" };
const marker = "SYNTHETIC-REVOKED-SKILL-BODY";
const config = { ...LEGACY_TEST_CONFIG, algorithm: { ...LEGACY_TEST_CONFIG.algorithm,
  enableQueryRewrite: false, enableUserMemoryRecall: false,
  retrieval: { ...LEGACY_TEST_CONFIG.algorithm.retrieval, llmFilterEnabled: true,
    llmFilterMinCandidates: 1, llmFilterMaxKeep: 10, skillInjectionMode: "full" as const } } };
type Service = ReturnType<typeof fixture.createTestService>["service"];
function observation() {
  const content = `---\nname: synthetic-workflow\ndescription: synthetic workflow marker\n---\nPerform ${marker} synthetic workflow marker.`;
  return { sourceSkillId: "synthetic-workflow", sourceSkillPath: "/fixture/synthetic-workflow/SKILL.md", title: "synthetic-workflow", content,
    contentHash: importedSkillContentHash(content), modifiedAt: "2026-11-01T00:00:00.000Z" };
}
function imported(service: Service) { return service.reconcileAgentSkills({ namespace, sourceAgentId: "codex", complete: true, skills: [observation()] }).skills[0]!.memoryId!; }
function revoke(service: Service, id: string, transition: string) {
  if (transition === "delete") service.deleteMemory(id, { namespace });
  else if (transition === "archive") service.archiveMemory(id, { namespace });
  else if (transition === "superseded") service.reconcileAgentSkills({ namespace, sourceAgentId: "codex", complete: true,
    skills: [{ ...observation(), content: observation().content + " New version.", contentHash: importedSkillContentHash(observation().content + " New version.") }] });
  else if (transition === "policy") service.reconcileAgentSkills({ namespace, sourceAgentId: "codex", complete: true, skills: [{ ...observation(), disableModelInvocation: true }] });
  else if (transition === "installed") service.reconcileAgentSkills({ namespace, sourceAgentId: "claude_code", complete: true, skills: [], registrations: [{ sourceSkillId: "plugin:fixture/synthetic-workflow", sourceSkillPath: "/fixture/plugin/SKILL.md", name: "synthetic-workflow" }], registrationsComplete: true });
  else service.reconcileAgentSkills({ namespace, sourceAgentId: "codex", complete: false, connectionState: "disconnected", skills: [] });
}
function gate() {
  let enter!: () => void; let release!: () => void;
  const entered = new Promise<void>(resolve => { enter = resolve; });
  const released = new Promise<void>(resolve => { release = resolve; });
  return { entered, released, enter: () => enter(), release: () => release() };
}
async function harness() {
  const llm = { ...createFailingLlm(), isConfigured: () => false };
  const h = fixture.createTestService({ config: structuredClone(config), llm, embedder: createCapturingEmbedder([]) });
  const configPath = join(h.root, "config.json"); writeFileSync(configPath, JSON.stringify({ memmyMemory: config }));
  const executor = createAgentSourceExecutor({ service: h.service, configPath, statePath: join(h.root, "sources.json"), scanStoreDirectory: join(h.root, "scans"), resolveAgentSkillRoot: () => null, sourceRegistry: createSourceRegistry([]), integrationRegistry: createSkillTargetRegistry([]) });
  const server = createMemoryHttpServer({ service: h.service, configPath, agentSourceExecutor: executor, startAgentSourceAutomation: false, workerStartupFallbackMs: 60_000, workerIdlePollMs: 60_000,
    pluginRuntimeAnalytics: { track() {}, async trackAwait() {}, async flush() {} }, memoryAddAnalytics: { trackAddStarted() {}, trackAddSucceeded() {}, trackAddFailed() {} }, auth: { localServiceToken: "fixture-token", allowAnonymous: false } });
  await new Promise<void>(resolve => server.listen(0, "127.0.0.1", resolve));
  closers.push(async () => { await new Promise<void>(resolve => server.close(() => resolve())); await executor.dispose(); });
  const address = server.address(); if (!address || typeof address === "string") throw new Error("expected loopback server");
  const post = async (path: string, request: unknown) => {
    const response = await fetch(`http://127.0.0.1:${address.port}${path}`, { method: "POST", headers: { "content-type": "application/json", authorization: "Bearer fixture-token" }, body: JSON.stringify(request) });
    expect(response.status).toBe(200); return await response.json() as any;
  };
  return { ...h, post };
}
describe("imported Skill asynchronous recall and response copies", () => {
  it.each(["delete", "disconnect", "archive", "policy", "installed", "superseded"])("revalidates %s while the filter is awaiting and excludes every log copy", async transition => {
    const pending = gate();
    const llm = { ...createFailingLlm(), async completeJson(_messages: unknown, options: { operation: string }) {
      if (options.operation.includes("filter")) { pending.enter(); await pending.released; return { selected: [1] }; }
      return { queryVecText: "synthetic workflow marker", keywords: ["synthetic", "workflow", "marker"] };
    } };
    const { service, db } = fixture.createTestService({ config: structuredClone(config), llm: llm as any, embedder: createCapturingEmbedder([]) });
    const id = imported(service);
    const response = service.search({ namespace, query: "synthetic workflow marker", layers: ["Skill"], includeInjectedContext: true });
    await pending.entered; revoke(service, id, transition); pending.release();
    const result = await response;
    expect(result.hits.map(hit => hit.id)).not.toContain(id); expect(JSON.stringify(result)).not.toContain(marker);
    for (const [table, column] of [["api_logs", "output_json"], ["recall_events", "request_json"]]) expect(db.db.prepare(`SELECT COUNT(*) AS n FROM ${table} WHERE ${column} LIKE ?`).get(`%${marker}%`)).toEqual({ n: 0 });
  });
  it.each(["memory.search", "turn.start"].flatMap(operation => ["delete", "disconnect", "archive", "policy", "superseded"].map(transition => ({ operation, transition }))))("does not replay revoked Skills from public $operation after $transition", async ({ operation, transition }) => {
    const h = await harness(); const id = imported(h.service); const session = await h.post("/api/v1/sessions/open", { namespace });
    const path = operation === "memory.search" ? "/api/v1/memory/search" : "/api/v1/turns/start";
    const request = { namespace, sessionId: session.sessionId, adapterId: "fixture", requestId: operation, query: "synthetic workflow marker", layers: ["Skill"], verbose: true, includeInjectedContext: true };
    expect(JSON.stringify(await h.post(path, request))).toContain(marker); revoke(h.service, id, transition);
    expect(h.db.db.prepare("SELECT COUNT(*) AS n FROM idempotency_keys WHERE response_json LIKE ?").get(`%${marker}%`)).toEqual({ n: 0 });
    const retried = await h.post(path, request);
    const hits = operation === "memory.search" ? retried.debug.hits : retried.hits;
    expect(hits.map((hit: { id: string }) => hit.id)).not.toContain(id);
    if (transition !== "superseded") expect(JSON.stringify(retried)).not.toContain(marker);
  });
  it("scrubs old add summary copies and rejects a late recalled snapshot cache writer", async () => {
    const h = await harness(); const id = imported(h.service); const repos = new Repositories(h.db.db);
    const request = { namespace, adapterId: "fixture", requestId: "late", query: "synthetic workflow marker", layers: ["Skill"] as const };
    const recalled = await h.service.search(request as any);
    repos.runtime.saveIdempotency("memory.add:fixture:old", "old", { id, summary: marker, details: [{ traceId: id, summary: marker }] });
    const pending = gate(); const result = h.service.idempotent("memory.search", request, request, async () => { pending.enter(); await pending.released; return recalled; });
    await pending.entered; revoke(h.service, id, "delete"); pending.release();
    expect(JSON.stringify(await result)).not.toContain(marker);
    expect(h.db.db.prepare("SELECT COUNT(*) AS n FROM idempotency_keys WHERE response_json LIKE ?").get(`%${marker}%`)).toEqual({ n: 0 });
    expect(repos.runtime.getIdempotency("memory.add:fixture:old")?.response).toMatchObject({ id });
  });
  it("revalidates before a fallback model sees candidates revoked during the primary filter", async () => {
    const pending = gate();
    const fallbackInputs: unknown[] = [];
    const primary = { ...createFailingLlm(), async completeJson(_messages: unknown, options: { operation: string }) {
      if (options.operation.includes("filter")) { pending.enter(); await pending.released; throw new Error("synthetic primary failure"); }
      return { queryVecText: "synthetic workflow marker", keywords: ["synthetic", "workflow", "marker"] };
    } };
    const fallback = { ...createFailingLlm(), async completeJson(messages: unknown) { fallbackInputs.push(messages); return { selected: [1] }; } };
    const { service } = fixture.createTestService({ config: structuredClone(config), llm: primary as any, skillLlm: fallback as any, embedder: createCapturingEmbedder([]) });
    const id = imported(service);
    const response = service.search({ namespace, query: "synthetic workflow marker", layers: ["Skill"] });
    await pending.entered;
    revoke(service, id, "delete");
    pending.release();
    expect((await response).hits).toEqual([]);
    expect(fallbackInputs).toEqual([]);
  });

  it("validates already-stored and late-written snapshots while preserving unrelated idempotency", async () => {
    const { service, db } = fixture.createTestService({ config: structuredClone(config), llm: { ...createFailingLlm(), isConfigured: () => false } });
    const repos = new Repositories(db.db);
    const id = imported(service);
    const response = await service.search({ namespace, query: "synthetic workflow marker", layers: ["Skill"] });
    revoke(service, id, "disconnect");
    // Simulate a snapshot left by an older release, bypassing the repaired writer.
    db.db.prepare("INSERT INTO idempotency_keys (key, request_hash, response_json, created_at) VALUES (?, ?, ?, ?)")
      .run("memory.search:fixture:old", "old", JSON.stringify(response), "2026-11-01T00:00:00Z");
    expect(repos.runtime.getIdempotency("memory.search:fixture:old")).toBeUndefined();
    repos.runtime.saveIdempotency("turn.start:fixture:late", "late", response);
    expect(repos.runtime.getIdempotency("turn.start:fixture:late")).toBeUndefined();
    const manual = { id: "manual-fixture", summary: marker };
    repos.runtime.saveIdempotency("memory.add:fixture:manual", "manual", manual);
    expect(repos.runtime.getIdempotency("memory.add:fixture:manual")?.response).toEqual(manual);
    expect(db.db.prepare("SELECT COUNT(*) AS n FROM idempotency_keys WHERE response_json LIKE ?").get(`%${id}%`)).toEqual({ n: 0 });
  });

  it("revalidates after the user-memory vector await before sending a later filter prompt", async () => {
    const pending = gate();
    const filterInputs: unknown[] = [];
    const llm = { ...createFailingLlm(), async completeJson(messages: unknown, options: { operation: string }) {
      if (options.operation.includes("filter")) { filterInputs.push(messages); return { selected: [1] }; }
      return { queryVecText: "synthetic workflow marker", keywords: ["synthetic", "workflow", "marker"] };
    } };
    const embedder = { ...createCapturingEmbedder([]), async embedOne() {
      pending.enter();
      await pending.released;
      return [1, 0, 0];
    } };
    const { service, db } = fixture.createTestService({ config: structuredClone(config), llm: llm as any, embedder });
    const id = imported(service);
    const repos = new Repositories(db.db);
    repos.userMemories.insert({ ...buildUserMemory({ id: "fixture-user-memory", sourceTurnId: "fixture-turn", userId: namespace.userId,
      memoryTypes: ["User Preference"], content: "synthetic workflow marker", createdAt: "2026-11-01T00:00:00Z" }), embedding: [1, 0, 0] });
    const response = service.search({ namespace, query: "synthetic workflow marker", layers: ["Skill", "L1"] });
    await pending.entered;
    revoke(service, id, "delete");
    pending.release();
    expect((await response).hits).toEqual([]);
    expect(JSON.stringify(filterInputs)).not.toContain(marker);
  });

  it("repairs already-stored deleted add and recall snapshots at worker startup", async () => {
    const { service, db } = fixture.createTestService({ config: structuredClone(config), llm: { ...createFailingLlm(), isConfigured: () => false } });
    const id = imported(service);
    const response = await service.search({ namespace, query: "synthetic workflow marker", layers: ["Skill"] });
    revoke(service, id, "delete");
    const insert = db.db.prepare("INSERT INTO idempotency_keys (key, request_hash, response_json, created_at) VALUES (?, ?, ?, ?)");
    insert.run("memory.search:fixture:startup", "search", JSON.stringify(response), "2026-11-01T00:00:00Z");
    insert.run("memory.add:fixture:startup", "add", JSON.stringify({ id, summary: marker }), "2026-11-01T00:00:00Z");
    service.reconcileWorkerStartup();
    expect(db.db.prepare("SELECT COUNT(*) AS n FROM idempotency_keys WHERE response_json LIKE ?").get(`%${marker}%`)).toEqual({ n: 0 });
    expect(new Repositories(db.db).runtime.getIdempotency("memory.add:fixture:startup")?.response).toMatchObject({ id, summary: "" });
  });

  it.each(["delete", "disconnect"])("revalidates public turn-start after search completed before %s", async transition => {
    const h = await harness();
    const id = imported(h.service);
    const session = await h.post("/api/v1/sessions/open", { namespace });
    const pending = gate();
    const retrieval = (h.service as unknown as { retrieval: { search: Service["search"] } }).retrieval;
    const search = retrieval.search.bind(retrieval);
    vi.spyOn(retrieval, "search").mockImplementation(async request => {
      const response = await search(request);
      pending.enter();
      await pending.released;
      return response;
    });
    const response = h.post("/api/v1/turns/start", { namespace, sessionId: session.sessionId,
      adapterId: "fixture", requestId: "turn-after-search", query: "synthetic workflow marker", layers: ["Skill"] });
    await pending.entered;
    revoke(h.service, id, transition);
    pending.release();
    expect(JSON.stringify(await response)).not.toContain(marker);
    expect(h.db.db.prepare("SELECT COUNT(*) AS n FROM idempotency_keys WHERE response_json LIKE ?").get(`%${marker}%`)).toEqual({ n: 0 });
  });

  it("keeps an ordinary manual Skill when an imported filter candidate is revoked", async () => {
    const pending = gate();
    const llm = { ...createFailingLlm(), async completeJson(_messages: unknown, options: { operation: string }) {
      if (options.operation.includes("filter")) { pending.enter(); await pending.released; return { selected: [1, 2] }; }
      return { queryVecText: "synthetic workflow marker", keywords: ["synthetic", "workflow", "marker"] };
    } };
    const { service } = fixture.createTestService({ config: structuredClone(config), llm: llm as any });
    const id = imported(service);
    const manual = await service.addMemory({ namespace, layer: "Skill", title: "Manual fixture", content: "synthetic workflow marker MANUAL-KEPT", deferProcessing: true });
    const response = service.search({ namespace, query: "synthetic workflow marker", layers: ["Skill"] });
    await pending.entered;
    revoke(service, id, "delete");
    pending.release();
    const result = await response;
    expect(result.hits.map(hit => hit.id)).toContain(manual.id);
    expect(JSON.stringify(result)).not.toContain(marker);
    expect(JSON.stringify(result)).toContain("MANUAL-KEPT");
  });

});
