import { createHash } from "node:crypto";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { homedir, tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { readAgentSkillInventory } from "@memmy/agent-source-core";
import { createMemoryHttpServer, MemoryDb, MemoryService } from "../../src/index.js";
import { createAgentSourceExecutor } from "../../src/agent-source/runtime.js";
import { createSourceRegistry } from "../../src/agent-source/adapters/source-registry.js";
import { createSkillTargetRegistry } from "../../src/agent-source/integration/target-registry.js";
import { MemoryRepository, Repositories } from "../../src/storage/repositories.js";
import { agentSkillConnectionKey, currentImportedSkillVersion } from "../../src/storage/imported-skill.js";
import { embeddingTextForMemory } from "../../src/service/embedding/embedding-pipeline.js";
import { stableHash } from "../../src/utils/id.js";
import type { MemoryAddRequest, MemoryRow } from "../../src/types.js";
import { withLegacyImportedSkillWriter } from "../fixtures/legacy-imported-skill-writer.js";
import { createCapturingEmbedder, createFailingLlm, LEGACY_TEST_CONFIG } from "../fixtures/memory-service-fixture.js";

const isolated = await vi.hoisted(async () => {
  const fs = await import("node:fs");
  const os = await vi.importActual<typeof import("node:os")>("node:os");
  const path = await import("node:path");
  return { home: fs.mkdtempSync(path.join(os.tmpdir(), "pr780-http-entry-home-")) };
});
vi.mock("node:os", async (importOriginal) => ({
  ...await importOriginal<typeof import("node:os")>(), homedir: () => isolated.home
}));

const namespace = { source: "hermes", profileId: "default", userId: "http-user" };
const cleanup: Array<() => Promise<void>> = [];
beforeEach(() => {
  expect(homedir()).toBe(isolated.home);
  const memmyHome = join(isolated.home, ".memmy");
  mkdirSync(memmyHome, { recursive: true });
  writeFileSync(join(memmyHome, "config.yaml"), "{}");
  vi.stubEnv("MEMMY_HOME", memmyHome);
  vi.stubEnv("MEMMY_CONFIG", join(memmyHome, "config.yaml"));
  vi.stubEnv("MEMMY_MEMORY_HOME", join(memmyHome, "memory-service"));
  vi.stubEnv("MEMMY_APP_DATABASE", join(isolated.home, "unused-app.sqlite"));
});
afterEach(async () => {
  vi.restoreAllMocks();
  while (cleanup.length) await cleanup.pop()!();
  vi.unstubAllEnvs();
});
afterAll(() => rmSync(isolated.home, { recursive: true, force: true }));

type AddResult = { id: string; status: string; title: string; duplicate?: boolean };
// These entry and persistence contracts do not depend on Codex sidecar policy.
const sourceId = "hermes";
const skillId = "deploy-helper";
const description = "Safely release a deployment.";
function content(version: string) {
  return `---\nname: deploy-helper\ndescription: ${description}\n---\nBody-only marker deploymentcanary${version}. 灰度指引。\n`;
}
function hash(value: string) { return createHash("sha256").update(value).digest("hex"); }
function observation(version: string, requestId = `observe-${version}`): MemoryAddRequest {
  const value = content(version);
  return { namespace, requestId, adapterId: "agent-source:hermes", layer: "Skill", source: sourceId,
    sourceAgentId: sourceId, sourceSkillId: skillId, sourceSkillPath: `/fixture/skills/${skillId}/SKILL.md`,
    sourceSkillVersion: version, sourceContentHash: hash(value), title: skillId, content: value,
    tags: ["agent-source", "hermes"], createdAt: "2026-01-01T00:00:00.000Z", deferProcessing: true };
}

async function harness() {
  const root = mkdtempSync(join(tmpdir(), "pr780-http-entry-"));
  const configPath = join(root, "config.yaml");
  const sourceSkillPath = join(root, "source-skills", skillId, "SKILL.md");
  mkdirSync(join(sourceSkillPath, ".."), { recursive: true });
  writeFileSync(sourceSkillPath, content("A"));
  const config = { ...structuredClone(LEGACY_TEST_CONFIG), userId: namespace.userId };
  writeFileSync(configPath, JSON.stringify({ memmyMemory: config }));
  const inputs: string[] = [];
  let db: MemoryDb;
  let service: MemoryService;
  let server: ReturnType<typeof createMemoryHttpServer>;
  let baseUrl: string;
  const open = async () => {
    db = new MemoryDb({ path: join(root, "memory.sqlite") });
    const llm = createFailingLlm();
    service = new MemoryService({ db, mode: "dev", config, configPath, llm, skillLlm: llm,
      embedder: createCapturingEmbedder(inputs), fetchAppMemoryBudget: async () => null,
      l3FieldEnvironment: () => ({ machineId: "a".repeat(64), homeDir: root, tempRoots: [root] }),
      l3MachineProbe: () => new Promise(() => undefined) });
    const executor = createAgentSourceExecutor({ service, configPath, statePath: join(root, "sources.json"),
      scanStoreDirectory: join(root, "scans"), resolveAgentSkillRoot: () => null,
      sourceRegistry: createSourceRegistry([]), integrationRegistry: createSkillTargetRegistry([]) });
    server = createMemoryHttpServer({ service, configPath, agentSourceExecutor: executor,
      startAgentSourceAutomation: false, workerStartupFallbackMs: 60_000, workerIdlePollMs: 60_000,
      pluginRuntimeAnalytics: { track() {}, async trackAwait() {}, async flush() {} },
      memoryAddAnalytics: { trackAddStarted() {}, trackAddSucceeded() {}, trackAddFailed() {} },
      auth: { localServiceToken: "owner-token", allowAnonymous: false, scopedApiKeys: {
        "writer-token": { namespace, scopes: ["memory:read", "memory:write"] },
        "reader-token": { namespace, scopes: ["memory:read"] },
        "foreign-token": { namespace: { ...namespace, userId: "another-user" }, scopes: ["memory:read"] }
      } } });
    await new Promise<void>(resolve => server.listen(0, "127.0.0.1", resolve));
    const address = server.address();
    if (!address || typeof address === "string") throw new Error("expected loopback HTTP address");
    baseUrl = `http://127.0.0.1:${address.port}`;
  };
  const close = async () => {
    await new Promise<void>(resolve => server.close(() => resolve()));
    await service.stop();
    db.close();
  };
  await open();
  cleanup.push(async () => { await close(); rmSync(root, { recursive: true, force: true }); });
  const request = async <T = Record<string, unknown>>(method: string, path: string, body?: unknown, token: string | undefined = "owner-token") => {
    const response = await fetch(`${baseUrl}${path}`, { method,
      headers: { "content-type": "application/json", ...(token ? { authorization: `Bearer ${token}` } : {}) },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }) });
    return { status: response.status, body: await response.json() as T };
  };
  const add = (body: MemoryAddRequest) => request<AddResult>("POST", "/api/v1/memory/add", body);
  const rows = () => new Repositories(db.db).memories.listImportedSkillsForSource(sourceId);
  const row = (id: string): MemoryRow => new Repositories(db.db).memories.getIncludingDeleted(id)!;
  const reconcile = (input: Record<string, unknown>) => request("POST", "/api/v1/agent-skills/reconcile", {
    namespace, sourceAgentId: sourceId, complete: false, skills: [], ...input
  });
  const assertResponse = (result: Awaited<ReturnType<typeof add>>) => {
    expect(result.status).toBe(200);
    expect(result.body.status).toBe(row(result.body.id).status);
    expect(result.body.duplicate).toBeUndefined();
  };
  const drain = async () => { for (let i = 0; i < 4; i++) await service.runWorkerOnce(100); };
  return { request, add, rows, row, reconcile, assertResponse, drain, inputs, sourceSkillPath, configPath,
    get db() { return db; }, get service() { return service; },
    restart: async () => { await close(); await open(); } };
}

describe("HTTP imported Skill observation state", () => {
  it.each(["absent", "allowed", "denied"] as const)("keeps direct Codex policy unknown until the actual %s sidecar is scanned", async policy => {
    const h = await harness();
    const codexNamespace = { ...namespace, source: "codex" };
    const request = { ...observation("A", "unobserved-codex"), namespace: codexNamespace,
      source: "codex", sourceAgentId: "codex", adapterId: "agent-source:codex", tags: ["agent-source", "codex"],
      sourceSkillPath: h.sourceSkillPath };
    if (policy !== "absent") {
      const agents = join(h.sourceSkillPath, "..", "agents");
      mkdirSync(agents, { recursive: true });
      writeFileSync(join(agents, "openai.yaml"), `policy:\n  allow_implicit_invocation: ${policy === "allowed"}\n`);
    }
    const added = await h.add(request);
    h.assertResponse(added);
    expect(added.body.status).toBe("archived");
    expect(h.row(added.body.id).properties.internal_info.archive_reason).toBe("policy_unknown");
    expect(h.row(added.body.id).properties.internal_info.invocation).not.toMatchObject({ policy_observed: true });
    expect((await h.request("POST", "/api/v1/skills/archive", { skillId: added.body.id, namespace: codexNamespace })).status).toBe(200);
    await h.restart();
    expect((await h.request("POST", "/api/v1/skills/reactivate", { skillId: added.body.id, namespace: codexNamespace })).status).toBe(200);
    expect(h.row(added.body.id).properties.internal_info.archive_reason).toBe("policy_unknown");
    await h.drain();
    expect(h.inputs.some(input => input.includes("Body-only marker"))).toBe(false);
    expect(new Repositories(h.db.db).memories.hasVector(added.body.id, "vec")).toBe(false);

    const inventory = await readAgentSkillInventory(join(h.sourceSkillPath, "..", ".."));
    expect(inventory.items).toHaveLength(1);
    const observed = await h.reconcile({ namespace: codexNamespace, sourceAgentId: "codex", complete: false,
      skills: inventory.items.map(item => ({ ...item, title: item.name ?? item.sourceSkillId })) });
    expect(observed.status).toBe(200);
    expect(h.row(added.body.id).properties.internal_info.invocation).toMatchObject({ policy_observed: true });
    const allowed = policy !== "denied";
    expect(h.row(added.body.id).status).toBe(allowed ? "activated" : "archived");
    expect(h.row(added.body.id).memoryValue).toBe(allowed ? request.content : "");
    await h.drain();
    expect(h.inputs.some(input => input.includes("Body-only marker"))).toBe(allowed);
    expect(new Repositories(h.db.db).memories.hasVector(added.body.id, "vec")).toBe(allowed);
  });

  it("reactivates a cold legacy manual through HTTP without source-disconnect body loss", async () => {
    const h = await harness();
    const body = "Manual coldhttpreactivatequartz release steps.";
    const old = withLegacyImportedSkillWriter(h.service, () => h.service.addMemory({ namespace, source: sourceId,
      layer: "Skill", title: "manual-cold", content: body }));
    const repos = new Repositories(h.db.db);
    repos.memories.archive(old.id, "2026-05-01T00:00:00.000Z");
    repos.runtime.setKv(agentSkillConnectionKey(sourceId), "disconnected");
    const result = await h.request("POST", "/api/v1/skills/reactivate", { skillId: old.id, namespace });
    expect(result.status).toBe(200);
    expect(h.row(old.id)).toMatchObject({ status: "activated", memoryValue: body });
  });

  it("reuses an old plugin tool Skill through HTTP before the startup fallback", async () => {
    const h = await harness();
    const request: MemoryAddRequest = { namespace, source: sourceId, layer: "Skill", title: "cold tool skill",
      content: "Run coldtoolquartz before release." };
    const old = withLegacyImportedSkillWriter(h.service, () => h.service.addMemory(request));
    expect(h.row(old.id).properties.internal_info.read_only).toBe(true);
    expect(h.row(old.id).properties.internal_info).not.toHaveProperty("import_state_version");
    const replay = await h.add(request);
    expect(replay.status).toBe(200);
    expect(replay.body.id).toBe(old.id);
    expect(h.row(old.id).properties.internal_info.read_only).toBe(false);
    h.service.reconcileWorkerStartup(1);
    expect(new Repositories(h.db.db).memories.list({ memoryLayer: "Skill" }, 20)).toHaveLength(1);
  });

  it("shares legacy skill-turn classification with the processor and bypasses response caching", async () => {
    const h = await harness();
    const base: MemoryAddRequest = { namespace, layer: "Skill", source: sourceId, turnId: "skill:legacy-deploy", adapterId: "rest-test", requestId: "same-turn-request",
      title: "legacy-deploy", content: "First legacy deployment procedure." };
    const a = await h.add(base);
    const b = await h.add({ ...base, content: "Second legacy deployment procedure." });
    h.assertResponse(b);
    expect(b.body.id).not.toBe(a.body.id);
    expect(h.row(a.body.id).status).toBe("archived");
    expect(h.row(b.body.id).properties.internal_info.read_only).toBe(true);
  });

  it("keeps plugin tool Skill writes manual while retaining ordinary HTTP idempotency", async () => {
    const h = await harness();
    const request: MemoryAddRequest = { namespace, source: sourceId, layer: "Skill", title: "tool procedure",
      content: "Run toolquartz before releasing.", adapterId: "rest-test", requestId: "ordinary-tool-save" };
    const a = await h.add(request);
    expect(a.status).toBe(200);
    expect(h.row(a.body.id).properties.internal_info.read_only).not.toBe(true);
    expect((await h.add(request)).body.id).toBe(a.body.id);
    expect((await h.add({ ...request, title: "Changed tool title" })).status).toBe(409);
    await h.reconcile({ complete: true, connectionState: "disconnected" });
    expect(h.row(a.body.id)).toMatchObject({ status: "activated", memoryValue: request.content });
  });

  it.each(["unique", "content-hash"] as const)("converges A to B to A with %s request ids", async (strategy) => {
    const h = await harness();
    const requestA = observation("A", strategy === "unique" ? "A-first" : `agent-source-skill:hermes:deploy-helper:${hash(content("A"))}`);
    const a = await h.add(requestA);
    const b = await h.add(observation("B", strategy === "unique" ? "B-next" : `agent-source-skill:hermes:deploy-helper:${hash(content("B"))}`));
    const restored = await h.add({ ...requestA, requestId: strategy === "unique" ? "A-last" : requestA.requestId });
    h.assertResponse(restored);
    expect(restored.body.id).toBe(a.body.id);
    expect(h.row(b.body.id).status).toBe("archived");
    expect(currentImportedSkillVersion(h.rows())?.id).toBe(a.body.id);
    expect(h.rows()).toHaveLength(2);
    expect(h.db.db.prepare("SELECT COUNT(*) AS n FROM idempotency_keys WHERE key LIKE 'memory.add:%'").get()).toMatchObject({ n: 0 });
  });

  it.each(["original", "v2"] as const)("ignores a persisted %s response cache after service restart", async (format) => {
    const h = await harness();
    const requestA = observation("A", "legacy-fixed-A");
    const a = await h.add(requestA);
    await h.add(observation("B"));
    const identity = { namespace, sourceAgentId: sourceId, sourceSkillId: skillId, sourceContentHash: requestA.sourceContentHash };
    const key = format === "v2" ? `memory.add:${requestA.adapterId}:agent-source-skill:v2:${stableHash(identity)}`
      : `memory.add:${requestA.adapterId}:${requestA.requestId}`;
    const fingerprint = format === "v2" ? { path: "/api/v1/memory/add", skill: identity }
      : { path: "/api/v1/memory/add", request: requestA };
    new Repositories(h.db.db).runtime.saveIdempotency(key, stableHash({ operation: "memory.add", fingerprint }), a.body);
    await h.restart();
    expect(h.db.db.prepare("SELECT key FROM idempotency_keys WHERE key = ?").get(key)).toBeTruthy();
    const restored = await h.add(requestA);
    h.assertResponse(restored);
    expect(currentImportedSkillVersion(h.rows())?.id).toBe(a.body.id);
  });

  it("records physical installation after deletion was released and the same hash is observed again", async () => {
    const h = await harness();
    const request = observation("A", "fixed-delete-observation");
    const a = await h.add(request);
    expect((await h.request("DELETE", `/api/v1/memory/${a.body.id}`, { namespace })).status).toBe(200);
    expect((await h.reconcile({ complete: true })).status).toBe(200);
    expect([...new Repositories(h.db.db).listInstalledSkillNamesForAgent(sourceId)]).toEqual([]);
    const observed = await h.add(request);
    h.assertResponse(observed);
    expect(observed.body.status).toBe("deleted");
    expect(new Repositories(h.db.db).listInstalledSkillNamesForAgent(sourceId)).toContain(skillId);
    expect(h.db.db.prepare("SELECT COUNT(*) AS n FROM memories_fts WHERE id = ?").get(a.body.id)).toMatchObject({ n: 0 });
  });

  it("refreshes same-hash path, source version and mtime through a fixed request id", async () => {
    const h = await harness();
    const original = observation("A", "fixed-metadata");
    const a = await h.add(original);
    const updated = await h.add({ ...original, sourceSkillPath: "/fixture/moved/deploy-helper/SKILL.md",
      sourceSkillVersion: "source-version-2", createdAt: "2026-02-01T00:00:00.000Z" });
    h.assertResponse(updated);
    expect(h.row(a.body.id).properties.internal_info).toMatchObject({ source_skill_path: "/fixture/moved/deploy-helper/SKILL.md", source_skill_version: "source-version-2" });
    expect(h.row(a.body.id).timeline).toBe("2026-02-01T00:00:00.000Z");
  });

  it("re-evaluates archive, missing source, disconnection and reconnection on the same hash", async () => {
    const h = await harness();
    const request = observation("A", "fixed-lifecycle");
    const a = await h.add(request);
    expect((await h.request("POST", "/api/v1/skills/archive", { skillId: a.body.id, namespace })).status).toBe(200);
    const archived = await h.add(request);
    h.assertResponse(archived);
    expect(archived.body.status).toBe("archived");
    expect((await h.request("POST", "/api/v1/skills/reactivate", { skillId: a.body.id, namespace })).status).toBe(200);
    await h.reconcile({ complete: true });
    expect(h.row(a.body.id).properties.internal_info.archive_reason).toBe("source_missing");
    const returned = await h.add(request);
    h.assertResponse(returned);
    expect(returned.body.status).toBe("activated");
    await h.reconcile({ connectionState: "disconnected", disconnected: true });
    const disconnected = await h.add(request);
    h.assertResponse(disconnected);
    expect(disconnected.body.status).toBe("archived");
    expect(h.row(a.body.id).memoryValue).toBe("");
    await h.reconcile({ connectionState: "connected" });
    const reconnected = await h.add(request);
    h.assertResponse(reconnected);
    expect(reconnected.body.status).toBe("activated");
    expect(h.row(a.body.id).memoryValue).toBe(request.content);
  });
});

const observationIdentity = [
  ["sourceAgentId", " hermes "], ["sourceSkillId", " deploy-helper "], ["sourceSkillPath", " /fixture/SKILL.md "],
  ["sourceSkillVersion", " v1 "], ["sourceContentHash", hash(content("A"))],
  ["adapterId", "agent-source:hermes"], ["tags", [" agent-source "]]
] as const;
describe("HTTP imported observation classification and ordinary idempotency", () => {
  it.each(observationIdentity)("accepts repeated metadata observations identified only by %s", async (field, value) => {
    const h = await harness();
    const request = { namespace, adapterId: "rest-test", requestId: "fixed-observation", source: "hermes", layer: "Skill" as const,
      title: skillId, content: content("A"), deferProcessing: true, [field]: value };
    expect((await h.add(request)).status).toBe(200);
    const observed = await h.add({ ...request, createdAt: "2026-02-01T00:00:00.000Z" });
    expect(observed.status).toBe(200);
    expect(observed.body.duplicate).toBeUndefined();
  });

  it.each(["L1", "Skill"] as const)("retains ordinary %s request replay and conflict behavior", async (layer) => {
    const h = await harness();
    const request = { namespace, adapterId: "rest-test", requestId: "ordinary-request", source: "manual", layer,
      content: "Ordinary manually created memory.", title: "ordinary", deferProcessing: true };
    expect((await h.add(request)).status).toBe(200);
    const duplicate = await h.add(request);
    expect(duplicate.status).toBe(200);
    expect(duplicate.body.duplicate).toBe(true);
    expect((await h.add({ ...request, title: "renamed" })).status).toBe(409);
  });


  it("keeps whitespace-only identity fields and unrelated tags on ordinary request idempotency", async () => {
    const h = await harness();
    const request = { namespace, adapterId: "rest-test", requestId: "blank-source-identity", source: "manual", layer: "Skill" as const,
      title: "manual Skill", content: "Ordinary memory.", sourceAgentId: "  ", sourceSkillId: "", sourceSkillPath: " ",
      sourceSkillVersion: "\t", sourceContentHash: " ", tags: [" agent-source-other "], deferProcessing: true };
    expect((await h.add(request)).status).toBe(200);
    expect((await h.add({ ...request, title: "renamed" })).status).toBe(409);
  });

  it("keeps authentication, scope and authoritative namespace gates ahead of imported observation handling", async () => {
    const h = await harness();
    const request = observation("A");
    expect((await h.request("POST", "/api/v1/memory/add", request, "reader-token")).status).toBe(403);
    expect((await h.request("POST", "/api/v1/memory/add", request, "invalid-token")).status).toBe(401);
    expect(h.rows()).toHaveLength(0);
    const created = await h.request<AddResult>("POST", "/api/v1/memory/add", { ...request,
      namespace: { ...namespace, userId: "foreign-request-body" } }, "writer-token");
    expect(created.status).toBe(200);
    expect(h.row(created.body.id).userId).toBe(namespace.userId);
    // The personal local panel retains its existing shared read behavior.
    expect((await h.request("GET", `/api/v1/memory/${created.body.id}`, undefined, "foreign-token")).status).toBe(200);
  });
});


function scanObservation(value: string, sourceSkillPath: string) {
  return { sourceSkillId: skillId, sourceSkillPath, title: skillId, content: value,
    contentHash: hash(value), description, modifiedAt: "2026-01-01T00:00:00.000Z", version: "source-version-1" };
}

function assertCanonical(h: Awaited<ReturnType<typeof harness>>, id: string, value = content("A")) {
  const memory = h.row(id);
  expect(memory.memoryValue).toBe(value);
  expect(memory.info.summary).toBe(description);
  expect(memory.properties.internal_info.source_raw_content_hash).toBe(hash(value));
  const document = embeddingTextForMemory(memory);
  expect(document).toContain(description);
  expect(document).toContain("Body-only marker");
  expect(JSON.stringify(memory.properties)).not.toContain("Body-only marker");
  const fts = h.db.db.prepare("SELECT memory_value FROM memories_fts WHERE id = ?").get(id) as { memory_value: string };
  expect(fts.memory_value).toBe(document);
  return document;
}

describe("HTTP and reconciliation share canonical Skill persistence", () => {
  it.each(["http-first", "reconcile-first"] as const)("keeps one raw-hash version and full retrieval representation with %s", async (order) => {
    const h = await harness();
    const request = { ...observation("A", "fixed-canonical"), sourceContentHash: undefined, sourceSkillPath: h.sourceSkillPath };
    if (order === "http-first") await h.add(request);
    else await h.reconcile({ complete: true, skills: [scanObservation(request.content, h.sourceSkillPath)] });
    const id = h.rows()[0]!.id;
    if (order === "http-first") await h.reconcile({ complete: true, skills: [scanObservation(request.content, h.sourceSkillPath)] });
    else h.assertResponse(await h.add(request));
    expect(h.rows()).toHaveLength(1);
    expect(currentImportedSkillVersion(h.rows())?.id).toBe(id);
    await h.drain();
    const document = assertCanonical(h, id);
    expect(h.inputs).toContain(document);
    expect(h.inputs.some(input => input.includes("Body-only marker"))).toBe(true);
    const detail = await h.request<{ body: string; summary: string }>("GET", `/api/v1/memory/${id}`);
    expect(detail.status).toBe(200);
    expect(detail.body.body).toBe(request.content);
    expect(detail.body.summary).toBe(description);
    const vectors = () => h.db.db.prepare("SELECT COUNT(*) AS n FROM memory_vector_entries WHERE memory_id = ?").get(id) as { n: number };
    expect(vectors().n).toBeGreaterThan(0);
    const repositories = new Repositories(h.db.db);
    repositories.memories.deleteVector(id, "vec");
    repositories.memories.deleteVector(id, "vec_summary");
    repositories.memories.deleteVector(id, "vec_action");
    expect(vectors().n).toBe(0);
    const session = await h.request<{ sessionId: string }>("POST", "/api/v1/sessions/open", {
      namespace: { ...namespace, source: "cursor" }, source: "cursor"
    });
    expect(session.status).toBe(200);
    expect(repositories.runtime.getSession(session.body.sessionId)).toMatchObject({ source: "cursor", userId: namespace.userId });
    expect([...repositories.listInstalledSkillNamesForAgent("cursor")]).toEqual([]);
    const searchCall = vi.spyOn(h.service, "search");
    const ftsCalls = vi.spyOn(MemoryRepository.prototype, "searchFtsIds");
    const patternCalls = vi.spyOn(MemoryRepository.prototype, "searchPatternIds");
    const bodyCalls = vi.spyOn(MemoryRepository.prototype, "searchImportedSkillBodyIds");
    const searched = await h.request<{ debug: { hits: Array<{ id: string }> } }>("POST", "/api/v1/memory/search", {
      namespace: { ...namespace, source: "cursor" }, sessionId: session.body.sessionId,
      query: "deploymentcanaryA", layers: ["Skill"], verbose: true
    });
    expect(searched.status).toBe(200);
    expect(searchCall.mock.calls.at(-1)?.[0].namespace).toMatchObject({ source: "cursor", userId: namespace.userId });
    const keywordRouteCalls = patternCalls.mock.calls.map(([terms, filter]) => ({ terms, filter }));
    const bodyRouteCalls = bodyCalls.mock.calls.map(([terms, filter]) => ({ terms, filter }));
    const actualFilter = ftsCalls.mock.calls.at(-1)?.[1];
    expect(actualFilter).toMatchObject({ memoryLayer: "Skill", excludedImportedSkillSourceAgentId: "cursor" });
    const bodyKeywordIds = repositories.memories.searchPatternIds(["deploymentcanarya"], actualFilter).map(hit => hit.id);
    expect(bodyKeywordIds).toContain(id);
    const canonical = h.row(id);
    const internal = canonical.properties.internal_info;
    const storedSkill = internal.skill as Record<string, unknown>;
    let legacyShortHits: string[] = [];
    let legacyFullFtsHits: string[] = [];
    try {
      repositories.memories.updateMaintenance({ ...canonical, properties: { ...canonical.properties, internal_info: {
        ...internal, invocation_guide: canonical.memoryValue,
        procedure_json: { ...(internal.procedure_json as object), summary: canonical.memoryValue },
        skill: { ...storedSkill, invocation_guide: canonical.memoryValue,
          procedure_json: { ...(storedSkill.procedure_json as object), summary: canonical.memoryValue } }
      } } });
      expect(embeddingTextForMemory(h.row(id))).toBe(document);
      const searchBaseline = async (kind: string) => {
        const baselineSession = await h.request<{ sessionId: string }>("POST", "/api/v1/sessions/open", {
          namespace: { ...namespace, source: "cursor", sessionKey: `body-baseline-${order}-${kind}` }, source: "cursor"
        });
        const result = await h.request<{ debug: { hits: Array<{ id: string }> } }>("POST", "/api/v1/memory/search", {
          namespace: { ...namespace, source: "cursor" }, sessionId: baselineSession.body.sessionId,
          query: "deploymentcanaryA", layers: ["Skill"], verbose: true
        });
        return result.body.debug.hits.map(hit => hit.id);
      };
      h.db.db.prepare("UPDATE memories_fts SET memory_value = ? WHERE id = ?").run(`${skillId}\n${description}`, id);
      legacyShortHits = await searchBaseline("short");
      h.db.db.prepare("UPDATE memories_fts SET memory_value = ? WHERE id = ?").run(canonical.memoryValue, id);
      legacyFullFtsHits = await searchBaseline("full");
    } finally { repositories.memories.updateMaintenance(canonical); }
    const evidence = { effectiveRequest: searchCall.mock.calls.at(-1)?.[0],
      sessionSource: repositories.runtime.getSession(session.body.sessionId)?.source,
      currentAgentInstallations: [...repositories.listInstalledSkillNamesForAgent("cursor")],
      ftsCalls: ftsCalls.mock.calls.map(([match, filter], i) => ({ match, filter, ids: ftsCalls.mock.results[i]?.value })),
      keywordRouteCalls, bodyRouteCalls, bodyKeywordIds, legacyShortHits, legacyFullFtsHits };
    // Imported body literals remain reachable with short FTS and no vectors,
    // independently of the four legacy property copies.
    expect(keywordRouteCalls).toEqual([]);
    expect(bodyRouteCalls.some(call => call.terms.includes("deploymentcanarya"))).toBe(true);
    expect(searched.body.debug.hits.map(hit => hit.id), JSON.stringify(evidence)).toEqual(legacyShortHits);
    expect(legacyShortHits).toEqual([id]);
    expect(legacyFullFtsHits, JSON.stringify(evidence)).toContain(id);
    expect(document).toContain("灰度");
    const keywordSession = await h.request<{ sessionId: string }>("POST", "/api/v1/sessions/open", {
      namespace: { ...namespace, source: "cursor", sessionKey: `http-body-keyword-${order}` }, source: "cursor"
    });
    expect(keywordSession.status).toBe(200);
    const bodyKeyword = await h.request<{ debug: { hits: Array<{ id: string }> } }>("POST", "/api/v1/memory/search", {
      namespace: { ...namespace, source: "cursor" }, sessionId: keywordSession.body.sessionId,
      query: "灰度", layers: ["Skill"], verbose: true
    });
    expect(bodyKeyword.status).toBe(200);
    expect(patternCalls.mock.calls.some(([terms]) => terms.includes("灰度"))).toBe(true);
    expect(bodyKeyword.body.debug.hits.map(hit => hit.id)).toContain(id);
    expect(vectors().n).toBe(0);
    assertCanonical(h, id);
  });

  it.each([false, true])("shares path-only=%s no-hash observations and treats sourceSkillVersion as metadata", async (pathOnly) => {
    const h = await harness();
    const initial = { ...observation("A", "same-source-version"), sourceSkillPath: h.sourceSkillPath,
      sourceSkillId: pathOnly ? undefined : skillId, sourceContentHash: undefined, sourceSkillVersion: "unchanged-version" };
    const a = await h.add(initial);
    h.assertResponse(a);
    await h.reconcile({ complete: true, skills: [scanObservation(initial.content, h.sourceSkillPath)] });
    expect(h.rows()).toHaveLength(1);
    expect(h.rows()[0]!.id).toBe(a.body.id);
    const b = await h.add({ ...initial, content: content("B") });
    h.assertResponse(b);
    expect(b.body.id).not.toBe(a.body.id);
    const restored = await h.add(initial);
    h.assertResponse(restored);
    expect(restored.body.id).toBe(a.body.id);
    expect(currentImportedSkillVersion(h.rows())?.id).toBe(a.body.id);
    expect(h.rows()).toHaveLength(2);
    await h.drain();
    assertCanonical(h, a.body.id);
  });

  it("observes distinct raw versions even when an old client reuses its explicit hash token", async () => {
    const h = await harness();
    const initial = { ...observation("A", "fixed-legacy-token"), sourceContentHash: "old-client-hash-token" };
    const a = await h.add(initial);
    h.assertResponse(a);
    const b = await h.add({ ...initial, content: content("B") });
    h.assertResponse(b);
    expect(b.body.id).not.toBe(a.body.id);
    const restored = await h.add(initial);
    h.assertResponse(restored);
    expect(restored.body.id).toBe(a.body.id);
    expect(h.rows()).toHaveLength(2);
    expect(h.rows().every(memory => memory.properties.internal_info.source_content_hash === "old-client-hash-token")).toBe(true);
    expect(h.row(a.body.id).properties.internal_info.source_raw_content_hash).toBe(hash(content("A")));
    expect(h.row(b.body.id).properties.internal_info.source_raw_content_hash).toBe(hash(content("B")));
    expect(currentImportedSkillVersion(h.rows())?.id).toBe(a.body.id);
  });

  it("distinguishes long source bodies that share the old 20k-truncated hash", async () => {
    const h = await harness();
    const prefix = content("A") + "Long shared source paragraph.\n".repeat(1_000);
    const aBody = prefix + "Tail-only instruction ALPHA.\n";
    const bBody = prefix + "Tail-only instruction BRAVO.\n";
    expect(stableHash(aBody)).toBe(stableHash(bBody));
    expect(hash(aBody)).not.toBe(hash(bBody));
    const request = { ...observation("A", "old-long-body-fixed-id"), content: aBody, sourceContentHash: stableHash(aBody) };
    const a = await h.add(request);
    h.assertResponse(a);
    const b = await h.add({ ...request, content: bBody });
    h.assertResponse(b);
    expect(b.body.id).not.toBe(a.body.id);
    const restored = await h.add(request);
    h.assertResponse(restored);
    expect(restored.body.id).toBe(a.body.id);
    expect(h.rows()).toHaveLength(2);
    expect(currentImportedSkillVersion(h.rows())?.id).toBe(a.body.id);
    await h.drain();
    assertCanonical(h, a.body.id, aBody);
    const detail = await h.request<{ body: string }>("GET", `/api/v1/memory/${a.body.id}`);
    expect(detail.body.body).toBe(aBody);
  });

  it("does not queue another embedding or alter business timestamps for metadata-only observations", async () => {
    const h = await harness();
    const request = observation("A", "metadata-with-vector");
    const added = await h.add(request);
    await h.drain();
    const before = h.row(added.body.id);
    const calls = h.inputs.length;
    const jobs = () => h.db.db.prepare("SELECT COUNT(*) AS n FROM evolution_jobs WHERE job_type = 'embedding' AND target_memory_id = ?").get(added.body.id);
    const queuedBefore = jobs();
    const updated = await h.add({ ...request, sourceSkillPath: "/fixture/moved/SKILL.md", sourceSkillVersion: "new-label",
      createdAt: "2026-04-01T00:00:00.000Z" });
    h.assertResponse(updated);
    expect(h.row(added.body.id).updatedAt).toBe(before.updatedAt);
    expect(h.row(added.body.id).timeline).toBe("2026-04-01T00:00:00.000Z");
    expect(jobs()).toEqual(queuedBefore);
    await h.drain();
    expect(h.inputs).toHaveLength(calls);
    assertCanonical(h, added.body.id);
  });

  it("repairs a previously marked representation through HTTP and keeps it after restart", async () => {
    const h = await harness();
    const request = observation("A", "old-short-representation");
    const added = await h.add(request);
    const memory = h.row(added.body.id);
    const internal = memory.properties.internal_info;
    const oldSkill = internal.skill as Record<string, unknown>;
    new Repositories(h.db.db).memories.updateMaintenance({ ...memory, info: { ...memory.info, summary: "---" },
      properties: { ...memory.properties, internal_info: { ...internal, summary: "---", retrieval_representation_version: 1,
        invocation_guide: memory.memoryValue,
        procedure_json: { ...(internal.procedure_json as object), retrievalBlurb: undefined, summary: memory.memoryValue },
        skill: { ...oldSkill, invocation_guide: memory.memoryValue,
          procedure_json: { ...(oldSkill.procedure_json as object), retrievalBlurb: undefined, summary: memory.memoryValue } } } } });
    h.assertResponse(await h.add(request));
    assertCanonical(h, added.body.id);
    await h.restart();
    h.assertResponse(await h.add(request));
    await h.drain();
    const document = assertCanonical(h, added.body.id);
    expect(h.inputs).toContain(document);
  });

  it("preserves raw CRLF and Unicode whitespace bytes while matching a scan's SHA256", async () => {
    const h = await harness();
    const raw = content("A").replace("Body-only marker", "<memmy>Keep these document bytes.</memmy>\n\n\nBody-only marker")
      .replace("deploymentcanaryA", "deploymentcanaryA 中文 α").replaceAll("\n", "\r\n") + "\u00a0\u2003\n";
    const request = { ...observation("A", "raw-unicode-observation"), content: raw, sourceContentHash: undefined,
      sourceSkillPath: h.sourceSkillPath };
    const added = await h.add(request);
    h.assertResponse(added);
    expect(h.row(added.body.id).properties.internal_info.source_content_hash).toBe(hash(raw));
    await h.reconcile({ complete: true, skills: [scanObservation(raw, h.sourceSkillPath)] });
    expect(h.rows()).toHaveLength(1);
    expect(h.rows()[0]!.id).toBe(added.body.id);
    await h.drain();
    assertCanonical(h, added.body.id, raw);
    const detail = await h.request<{ body: string }>("GET", `/api/v1/memory/${added.body.id}`);
    expect(detail.body.body).toBe(raw);
  });

  it("retains the public field whitelist and memory capture gate", async () => {
    const h = await harness();
    const untrusted = { ...observation("A"), status: "deleted", readOnly: false, summary: "client summary override" };
    const added = await h.add(untrusted);
    h.assertResponse(added);
    expect(h.row(added.body.id).status).toBe("activated");
    expect(h.row(added.body.id).info.summary).toBe(description);
    writeFileSync(h.configPath, JSON.stringify({ memmyMemory: { ...LEGACY_TEST_CONFIG, userId: namespace.userId,
      algorithm: { ...LEGACY_TEST_CONFIG.algorithm, enableMemoryAdd: false } } }));
    h.service.reloadConfig({ restartFailedProcessing: false });
    expect((await h.add(observation("B"))).status).toBe(403);
    expect(h.rows()).toHaveLength(1);
  });
});
