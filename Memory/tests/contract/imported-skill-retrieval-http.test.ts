import { createHash } from "node:crypto";
import { mkdirSync, rmSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { afterAll, afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createMemoryHttpServer, MemoryDb } from "../../src/index.js";
import { compileRetrievalQuery, skillMetaFromMemory } from "../../src/algorithm/plugin-algorithms.js";
import { createAgentSourceExecutor } from "../../src/agent-source/runtime.js";
import { createSourceRegistry } from "../../src/agent-source/adapters/source-registry.js";
import { createSkillTargetRegistry } from "../../src/agent-source/integration/target-registry.js";
import { embeddingTextForMemory } from "../../src/service/embedding/embedding-pipeline.js";
import { Repositories } from "../../src/storage/repositories.js";
import { createCapturingEmbedder, createFailingLlm, createMemoryServiceFixture, LEGACY_TEST_CONFIG } from "../fixtures/memory-service-fixture.js";

const isolated = await vi.hoisted(async () => {
  const fs = await import("node:fs");
  const os = await vi.importActual<typeof import("node:os")>("node:os");
  const path = await import("node:path");
  return { home: fs.mkdtempSync(path.join(os.tmpdir(), "pr780-retrieval-http-home-")) };
});
vi.mock("node:os", async importOriginal => ({
  ...await importOriginal<typeof import("node:os")>(), homedir: () => isolated.home
}));
const fixture = createMemoryServiceFixture();
const servers: Array<ReturnType<typeof createMemoryHttpServer>> = [];
const namespace = { source: "codex", profileId: "default", userId: "retrieval-http-user" };
beforeEach(() => {
  expect(homedir()).toBe(isolated.home);
  const home = join(isolated.home, ".memmy");
  mkdirSync(home, { recursive: true });
  writeFileSync(join(home, "config.yaml"), "{}");
  vi.stubEnv("MEMMY_HOME", home);
  vi.stubEnv("MEMMY_CONFIG", join(home, "config.yaml"));
  vi.stubEnv("MEMMY_MEMORY_HOME", join(home, "memory-service"));
  vi.stubEnv("MEMMY_CLOUD_SERVICE", "");
});
afterEach(async () => {
  while (servers.length) await new Promise<void>(resolve => servers.pop()!.close(() => resolve()));
  await fixture.cleanup();
  vi.restoreAllMocks();
  vi.unstubAllEnvs();
});
afterAll(() => rmSync(isolated.home, { recursive: true, force: true }));

async function harness() {
  const root = fixture.createTestRoot("pr780-retrieval-http-");
  const configPath = join(root, "config.json");
  const config = structuredClone(LEGACY_TEST_CONFIG);
  writeFileSync(configPath, JSON.stringify({ memmyMemory: config }));
  const db = new MemoryDb({ path: join(root, "memory.sqlite") });
  const seen: string[] = [];
  const llm = createFailingLlm();
  const service = fixture.createTestMemoryService({ db, mode: "dev", config, configPath,
    llm, skillLlm: llm, embedder: createCapturingEmbedder(seen) });
  const executor = createAgentSourceExecutor({ service, configPath, statePath: join(root, "sources.json"),
    scanStoreDirectory: join(root, "scans"), resolveAgentSkillRoot: () => null,
    sourceRegistry: createSourceRegistry([]), integrationRegistry: createSkillTargetRegistry([]) });
  const server = createMemoryHttpServer({ service, configPath, agentSourceExecutor: executor,
    startAgentSourceAutomation: false, workerStartupFallbackMs: 60_000, workerIdlePollMs: 60_000,
    pluginRuntimeAnalytics: { track() {}, async trackAwait() {}, async flush() {} },
    memoryAddAnalytics: { trackAddStarted() {}, trackAddSucceeded() {}, trackAddFailed() {} },
    auth: { localServiceToken: "fixture-token", allowAnonymous: false } });
  await new Promise<void>(resolve => server.listen(0, "127.0.0.1", resolve));
  servers.push(server);
  const address = server.address();
  if (!address || typeof address === "string") throw new Error("expected loopback server");
  const base = `http://127.0.0.1:${address.port}`;
  const request = async <T>(path: string, body: unknown) => {
    const response = await fetch(base + path, { method: "POST", headers: {
      "content-type": "application/json", authorization: "Bearer fixture-token"
    }, body: JSON.stringify(body) });
    expect(response.status).toBe(200);
    return await response.json() as T;
  };
  let sequence = 0;
  const add = async (input: { name: string; body: string; source?: string; description?: string; frontmatter?: boolean; tags?: string[]; modifiedAt?: string }) => {
    // This fixture exercises retrieval and ranking independently of Codex sidecar policy.
    const source = input.source ?? "claude_code";
    const content = input.frontmatter === false ? `# ${input.name}\n\n${input.body}`
      : `---\nname: ${input.name}\n${input.description === undefined ? "" : `description: ${JSON.stringify(input.description)}\n`}---\n${input.body}`;
    const added = await request<{ id: string }>("/api/v1/memory/add", { namespace, requestId: `source-${++sequence}`,
      adapterId: `agent-source:${source}`, layer: "Skill", title: input.name, content,
      source, sourceAgentId: source, sourceSkillId: input.name, sourceSkillPath: `/fixture/${source}/${input.name}/SKILL.md`,
      sourceContentHash: createHash("sha256").update(content).digest("hex"),
      createdAt: input.modifiedAt ?? "2026-01-01T00:00:00.000Z", tags: input.tags, deferProcessing: true });
    return { id: added.id, content };
  };
  const search = async (query: string, tags?: string[], source = "cursor", limit = 5) => {
    const session = await request<{ sessionId: string }>("/api/v1/sessions/open", {
      namespace: { ...namespace, source, sessionKey: `search-${++sequence}` }, source
    });
    const result = await request<{ debug: { hits: Array<{ id: string }> } }>("/api/v1/memory/search", {
      namespace: { ...namespace, source }, sessionId: session.sessionId, query, tags, layers: ["Skill"], verbose: true, limit
    });
    return result.debug.hits.map(hit => hit.id);
  };
  const repos = new Repositories(db.db);
  const removeVectors = () => {
    for (const memory of repos.memories.list({ memoryLayer: "Skill" }, 1000)) repos.memories.deleteVector(memory.id, "vec");
    expect(db.db.prepare("SELECT COUNT(*) AS n FROM memory_vector_entries").get()).toMatchObject({ n: 0 });
  };
  return { add, search, service, db, repos, seen, removeVectors, llm };
}

const lexicalTerms = [
  "deploymentcanaryround7",
  "db:migrate:verify",
  "npm:deploy:verify",
  "--canary-only",
  "scripts/rollout-verify.sh",
  "release%canary_stage",
  "deploy_" + "identifier".repeat(35)
];
describe("HTTP imported Skill body retrieval", () => {
  it.each(lexicalTerms)("recalls body-only %s with full-body retrieval and preserved description metadata", async term => {
    const h = await harness();
    const added = await h.add({ name: "release-runbook", description: "Safely release a service.", body: `Execute ${term} before shipping.` });
    await h.service.runWorkerOnce(100);
    await h.service.runWorkerOnce(100);
    const memory = h.repos.memories.get(added.id)!;
    expect(embeddingTextForMemory(memory)).toContain(term);
    expect(h.seen.some(text => text.includes(term))).toBe(true);
    const fts = h.db.db.prepare("SELECT memory_value FROM memories_fts WHERE id = ?").get(added.id) as { memory_value: string };
    expect(fts.memory_value).toContain(term);
    h.removeVectors();
    expect(await h.search(term)).toEqual([added.id]);
    expect(h.repos.memories.get(added.id)?.memoryValue).toBe(added.content);
  });

  it.each([4, 22, 60])("ranks exact command before %i newer overlapping skills at HTTP limits 3/5", async count => {
    const h = await harness();
    const target = await h.add({ name: "command-target", description: "Safe operations.",
      body: "灰度 pnpm --filter @memmy/release canary:verify" });
    for (let i = 0; i < count; i++) await h.add({ name: `decoy-${i}`, description: "Other operations.",
      body: "灰度 pnpm the unrelated guide", modifiedAt: "2026-02-01T00:00:00.000Z" });
    h.removeVectors();
    for (const limit of [3, 5]) {
      expect((await h.search("灰度 pnpm --filter @memmy/release canary:verify", undefined, "cursor", limit))[0]).toBe(target.id);
    }
  });

  it.each(["short", "missing"] as const)("preserves raw commands through a paraphrased extraction with %s description", async kind => {
    const h = await harness();
    const target = await h.add({ name: "extracted-target", description: kind === "short" ? "Safe operations." : undefined,
      body: "pnpm --filter @memmy/release canary:verify" });
    for (let i = 0; i < 22; i++) await h.add({ name: `extract-decoy-${i}`, description: "Other operations.",
      body: "the and for with pnpm unrelated guide", modifiedAt: "2026-02-01T00:00:00.000Z" });
    const completeJson = h.llm.completeJson.bind(h.llm);
    const extract = vi.spyOn(h.llm, "completeJson").mockImplementation(async (messages, options) => {
      if (options.operation.includes("retrieval.query.extract")) return {
        queryVecText: "validate release safety", keywords: ["deployment", "verification"]
      } as any;
      return completeJson(messages, options);
    });
    h.removeVectors();
    expect((await h.search("the pnpm --filter @memmy/release canary:verify", undefined, "cursor", 3))[0]).toBe(target.id);
    expect(extract.mock.calls.some(([, options]) => options.operation.includes("retrieval.query.extract"))).toBe(true);
  });

  it.each(["orchard irrigation", "灰度 发布"])("ranks ordinary lexical coverage for %s", async query => {
    const h = await harness();
    const target = await h.add({ name: "lexical-target", description: "A useful guide.", body: query });
    for (let i = 0; i < 22; i++) await h.add({ name: `lexical-decoy-${i}`, description: "A different guide.",
      body: query.split(" ")[0]!, modifiedAt: "2026-02-01T00:00:00.000Z" });
    h.removeVectors();
    expect((await h.search(query, undefined, "cursor", 3))[0]).toBe(target.id);
  });

  it("escapes percent and underscore literally in the imported body route", async () => {
    const h = await harness();
    const exact = await h.add({ name: "literal-release", description: "Release safely.", body: "Run release%canary_stage now." });
    const decoy = await h.add({ name: "different-release", source: "hermes", description: "Release safely.", body: "Run releaseXcanaryZstage now." });
    h.removeVectors();
    expect(await h.search("release%canary_stage")).toEqual([exact.id]);
    expect(await h.search("release%canary_stage")).not.toContain(decoy.id);
  });

  it("keeps a late command within the bounded lexical terms", async () => {
    const h = await harness();
    const added = await h.add({ name: "late-command", description: "Release safely.", body: "Execute npm:deploy:verify." });
    h.removeVectors();
    expect(await h.search("Please inspect this deployment carefully and consider the following many unrelated setup instructions before running npm:deploy:verify")).toEqual([added.id]);
    expect(compileRetrievalQuery("deploymentcanaryround7").patternTerms).toEqual([]);
  });

  it.each(["plain", "missing", "blank"] as const)("uses body retrieval fallback for %s description and a name summary", async kind => {
    const h = await harness();
    const marker = "plaintextfallbackcanary";
    const added = await h.add({ name: "plain-runbook", frontmatter: kind !== "plain", description: kind === "blank" ? " \t " : undefined,
      body: `Execute ${marker} safely.` });
    const memory = h.repos.memories.get(added.id)!;
    expect(memory.info.summary).toBe("plain-runbook");
    expect(skillMetaFromMemory(memory)?.retrievalBlurb).toBeUndefined();
    expect(embeddingTextForMemory(memory)).toContain(marker);
    const fts = h.db.db.prepare("SELECT memory_value FROM memories_fts WHERE id = ?").get(added.id) as { memory_value: string };
    expect(fts.memory_value).toContain(marker);
    h.removeVectors();
    expect(await h.search(marker)).toEqual([added.id]);
  });

  it("filters own sources and tags before filling lexical candidate slots", async () => {
    const h = await harness();
    for (let index = 0; index < 25; index += 1) await h.add({ name: `own-${index}`, source: "cursor", tags: ["release"],
      description: "Safely release.", body: "Read bodycandidatecanary." });
    const other = await h.add({ name: "other-source", source: "hermes", tags: ["release"], description: "Safely release.", body: "Read bodycandidatecanary." });
    await h.add({ name: "wrong-tag", source: "openclaw", tags: ["other"], description: "Safely release.", body: "Read bodycandidatecanary." });
    h.removeVectors();
    expect(await h.search("bodycandidatecanary", ["release"])).toEqual([other.id]);
    expect(await h.search("bodycandidatecanary", ["absent"])).toEqual([]);
  });

  it("refills same-name body candidates and selects the newest tag-eligible source outside the initial matches", async () => {
    const h = await harness();
    const distinct = await h.add({ name: "independent", source: "hermes", tags: ["release"], description: "Safely release.", body: "Read refillbodycanary." });
    for (let index = 0; index < 24; index += 1) await h.add({ name: "grouped", source: `agent-${index}`, tags: ["release"],
      description: "Safely release.", body: "Read refillbodycanary.", modifiedAt: "2026-02-01T00:00:00.000Z" });
    const newest = await h.add({ name: "grouped", source: "openclaw", tags: ["release"], description: "Safely release.", body: "A different checklist.", modifiedAt: "2026-03-01T00:00:00.000Z" });
    const wrongTag = await h.add({ name: "grouped", source: "hermes", tags: ["other"], description: "Safely release.", body: "A different checklist.", modifiedAt: "2026-04-01T00:00:00.000Z" });
    h.removeVectors();
    const ids = await h.search("refillbodycanary", ["release"]);
    expect(ids).toHaveLength(2);
    expect(new Set(ids)).toEqual(new Set([distinct.id, newest.id]));
    expect(ids).not.toContain(wrongTag.id);
  });
});
