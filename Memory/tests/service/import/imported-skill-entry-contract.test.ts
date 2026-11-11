import { createHash } from "node:crypto";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { MemoryDb } from "../../../src/index.js";
import { skillMetaFromMemory } from "../../../src/algorithm/plugin-algorithms.js";
import { embeddingTextForMemory } from "../../../src/service/embedding/embedding-pipeline.js";
import type { AgentSkillReconcileSkill } from "../../../src/service/import/agent-skill-library.js";
import { MemoryRepository, Repositories } from "../../../src/storage/repositories.js";
import type { MemoryAddRequest, MemoryRow } from "../../../src/types.js";
import { firstLine } from "../../../src/utils/text.js";
import { sanitizeMemmyProtocolText } from "../../../src/utils/memmy-context-tags.js";
import { agentSkillInstallationsKey, IMPORTED_SKILL_RETRIEVAL_VERSION } from "../../../src/storage/imported-skill.js";
import { stableHash } from "../../../src/utils/id.js";
import { withLegacyImportedSkillWriter } from "../../fixtures/legacy-imported-skill-writer.js";
import { createCapturingEmbedder, createFailingLlm, createMemoryServiceFixture, runWorkerRounds } from "../../fixtures/memory-service-fixture.js";

const fixture = createMemoryServiceFixture();
afterEach(async () => { vi.restoreAllMocks(); await fixture.cleanup(); });
// These body/identity contracts use Hermes; Codex sidecar provenance has its own lifecycle suite.
const namespace = { source: "hermes", profileId: "default", userId: "skill-entry-contract-user" };
const marker = "BODY_ONLY_SENTINEL_83fa";
const description = "Diagnose sqlite migration failures safely.";
type Service = ReturnType<typeof fixture.createTestService>["service"];
type Db = ReturnType<typeof fixture.createTestService>["db"];
type Entry = "direct" | "scan";

function rawHash(content: string) { return createHash("sha256").update(content).digest("hex"); }
function source(version = "a", overrides: Partial<AgentSkillReconcileSkill> = {}): AgentSkillReconcileSkill {
  const content = `---\nname: entry-contract\ndescription: ${description}\n---\n# Procedure\n${marker} ${version}`;
  return { title: "entry-contract", sourceSkillId: "entry-contract", sourceSkillPath: "/synthetic/entry-contract/SKILL.md",
    content, contentHash: rawHash(content), modifiedAt: "2026-06-01T00:00:00.000Z", description, ...overrides };
}
function createService() {
  const seen: string[] = [];
  return { ...fixture.createTestService({ llm: createFailingLlm(), embedder: createCapturingEmbedder(seen) }), seen };
}
function add(service: Service, input: AgentSkillReconcileSkill, overrides: Partial<MemoryAddRequest> = {}) {
  return service.addMemory({ namespace, adapterId: "agent-source:hermes", source: "hermes", layer: "Skill",
    sourceAgentId: "hermes", sourceSkillId: input.sourceSkillId, sourceSkillPath: input.sourceSkillPath,
    sourceContentHash: input.contentHash, title: input.title, content: input.content, ...overrides });
}
function scan(service: Service, inputs: AgentSkillReconcileSkill[], sourceAgentId = "hermes") {
  return service.reconcileAgentSkills({ namespace, sourceAgentId, skills: inputs, complete: true });
}
function write(service: Service, input: AgentSkillReconcileSkill, entry: Entry): string {
  return entry === "direct" ? add(service, input).id : scan(service, [input]).skills[0]!.memoryId!;
}
function row(db: Db, id: string): MemoryRow { return new Repositories(db.db).memories.getIncludingDeleted(id)!; }
function versions(db: Db) { return new Repositories(db.db).memories.listImportedSkillsForSource("hermes"); }
function embeddingJobs(db: Db, id: string) {
  return (db.db.prepare("SELECT COUNT(*) AS n FROM evolution_jobs WHERE job_type = 'embedding' AND target_memory_id = ?").get(id) as { n: number }).n;
}
function expectRepresentation(db: Db, id: string, input: AgentSkillReconcileSkill) {
  const memory = row(db, id);
  expect(memory.memoryValue).toBe(input.content);
  expect(memory.info.summary).toBe(input.description);
  expect(memory.properties.internal_info.summary).toBe(input.description);
  expect(memory.properties.info?.summary).toBe(input.description);
  expect(memory.properties.internal_info.retrieval_representation_version).toBe(IMPORTED_SKILL_RETRIEVAL_VERSION);
  expect(memory.properties.internal_info.source_raw_content_hash).toBe(rawHash(input.content));
  expect(skillMetaFromMemory(memory)?.retrievalBlurb).toBe(input.description);
  expect(skillMetaFromMemory(memory)?.invocationGuide).toBe(input.content);
  expect(JSON.stringify(memory.properties)).not.toContain(marker);
  const fts = db.db.prepare("SELECT memory_value FROM memories_fts WHERE id = ?").get(id) as { memory_value: string };
  expect(fts.memory_value).toContain(input.description);
  expect(fts.memory_value).toContain(marker);
  expect(embeddingTextForMemory(memory)).toContain(marker);
}

describe("imported Skill entry contracts", () => {
  it.each(["tags", "title"])("re-embeds a changed rendered document after %s metadata changes", async field => {
    const { db, service } = createService(); const input = source();
    const id = add(service, input).id;
    await runWorkerRounds(service, 2, 50);
    const before = embeddingJobs(db, id);
    add(service, input, field === "tags" ? { tags: ["new-rendered-tag"] } : { title: "new-rendered-name" });
    expect(embeddingJobs(db, id)).toBe(before + 1);
    await runWorkerRounds(service, 2, 50);
    const memory = row(db, id);
    expect(embeddingTextForMemory(memory)).toContain(field === "tags" ? "new-rendered-tag" : "new-rendered-name");
    expect(embeddingTextForMemory(memory)).toContain(marker);
  });

  it("preserves scanner-only supporting-file metadata on a direct observation", () => {
    const { db, service } = createService(); const input = source("a", { hasSupportingFiles: true });
    const id = write(service, input, "scan");
    add(service, input, { sourceSkillPath: undefined });
    expect(row(db, id).properties.internal_info.source_skill_path).toBe(input.sourceSkillPath);
    expect(row(db, id).properties.internal_info.has_supporting_files).toBe(true);
    expect(service.getMemory(id, { namespace }).body).toContain("source dir: /synthetic/entry-contract");
  });

  it.each(([ ["direct"], ["scan"], ["direct", "scan"], ["scan", "direct"] ] as Entry[][]).map(entries => ({ entries })))(
    "persists the same single-body full retrieval representation through $entries", async ({ entries }) => {
    const { db, service, seen } = createService();
    const input = source();
    let id = "";
    for (const entry of entries) {
      const next = write(service, input, entry);
      if (id) expect(next).toBe(id);
      id = next;
    }
    expectRepresentation(db, id, input);
    expect(versions(db)).toHaveLength(1);
    expect(service.getMemory(id, { namespace }).body).toBe(input.content);
    expect(new Repositories(db.db).memories.searchPatternIds([marker], { memoryLayer: "Skill" }, 5).map(hit => hit.id)).toContain(id);
    await runWorkerRounds(service, 2, 50);
    expect(seen.length).toBeGreaterThan(0);
    expect(seen.some(text => text.includes(marker))).toBe(true);
  });

  it.each([
    { label: "missing", field: "", expected: undefined },
    { label: "empty", field: 'description: ""\n', expected: undefined },
    { label: "mapping", field: "description:\n  nested: value\n", expected: undefined },
    { label: "sequence", field: "description: [one, two]\n", expected: undefined },
    { label: "multiline", field: "description: >\n  Diagnose sqlite\n  migration failures safely.\n", expected: description }
  ].flatMap(test => (["direct", "scan"] as const).map(entry => ({ ...test, entry }))))(
    "separates display summary from retrieval fallback for $label metadata through $entry", ({ field, expected, entry }) => {
      const { db, service } = createService();
      const content = `---\nname: entry-contract\n${field}---\n${marker} body instructions.`;
      const input = source("a", { content, contentHash: rawHash(content), description: expected });
      const id = write(service, input, entry); const memory = row(db, id);
      expect(memory.info.summary).toBe(expected ?? input.title);
      expect(skillMetaFromMemory(memory)?.retrievalBlurb).toBe(expected);
      expect(embeddingTextForMemory(memory).includes(marker)).toBe(true);
      const fts = db.db.prepare("SELECT memory_value FROM memories_fts WHERE id = ?").get(id) as { memory_value: string };
      expect(fts.memory_value.includes(marker)).toBe(true);
      expect(JSON.stringify(memory.properties)).not.toContain(marker);
      expect(service.getMemory(id, { namespace }).body).toBe(content);
      expect(new Repositories(db.db).memories.searchPatternIds([marker], { memoryLayer: "Skill" }, 5).map(hit => hit.id)).toContain(id);
      const before = row(db, id); const jobs = embeddingJobs(db, id);
      expect(add(service, input).id).toBe(id);
      expect(scan(service, [input]).skills[0]?.memoryId).toBe(id);
      expect(row(db, id)).toMatchObject({ updatedAt: before.updatedAt, version: before.version });
      expect(embeddingJobs(db, id)).toBe(jobs);
    }
  );

  it.each(["\r\n", "\n"])("preserves raw Skill bytes including protocol-like text, whitespace and newline=%j", newline => {
    const { db, service } = createService();
    const content = ["---", "name: entry-contract", `description: ${description}`, "---", "<memmy-context>",
      "A legitimate document example.", "</memmy-context>", "line with trailing spaces   ", "", "", "", marker + "\u3000", ""].join(newline);
    const input = source("a", { content, contentHash: rawHash(content) });
    const id = add(service, input, { sourceContentHash: undefined }).id;
    expect(row(db, id).memoryValue).toBe(content);
    expect(row(db, id).properties.internal_info.source_content_hash).toBe(rawHash(content));
    expect(scan(service, [input]).skills[0]?.memoryId).toBe(id);
    expect(versions(db)).toHaveLength(1);
    expectRepresentation(db, id, input);
  });

  it("updates an explicit source mtime while preserving the known mtime when it is omitted", async () => {
    const { db, service } = createService(); const input = source();
    const firstDate = "2026-01-01T00:00:00.000Z"; const nextDate = "2026-02-01T00:00:00.000Z";
    const receivedBefore = Date.now();
    const id = add(service, input, { createdAt: firstDate }).id;
    expect(Date.parse(String(row(db, id).properties.internal_info.imported_at))).toBeGreaterThanOrEqual(receivedBefore);
    expect(Date.parse(String(row(db, id).properties.internal_info.imported_at))).toBeLessThanOrEqual(Date.now());
    await runWorkerRounds(service, 2, 50);
    const before = row(db, id); const jobs = embeddingJobs(db, id);
    add(service, input, { createdAt: nextDate, sourceSkillPath: "/moved/entry-contract/SKILL.md", sourceSkillVersion: "updated-label" });
    expect(row(db, id)).toMatchObject({ timeline: nextDate, updatedAt: before.updatedAt, version: before.version,
      properties: { internal_info: { source_modified_at: nextDate } } });
    add(service, input, { sourceSkillPath: undefined });
    expect(row(db, id)).toMatchObject({ timeline: nextDate, properties: { internal_info: { source_modified_at: nextDate,
      source_skill_path: "/moved/entry-contract/SKILL.md" } } });
    expect(embeddingJobs(db, id)).toBe(jobs);
  });

  it.each([true, false])("reuses a normalized provenance-tagged anonymous legacy user archive with explicit title=%s", explicitTitle => {
    const { db, service } = createService(); const base = source();
    const content = "\n\n<memmy_memory_context>\nA literal file example.\n</memmy_memory_context>\n" + base.content + "\n\n\nTail   \n";
    const input = { ...base, content, contentHash: rawHash(content) };
    const oldTitle = explicitTitle ? input.title : firstLine(sanitizeMemmyProtocolText(content));
    const request = { adapterId: undefined, sourceSkillId: undefined, sourceSkillPath: undefined, tags: ["agent-source"] };
    const old = withLegacyImportedSkillWriter(service, () => add(service, input, { ...request, title: oldTitle }));
    expect(row(db, old.id).memoryValue).toBe(sanitizeMemmyProtocolText(content));
    expect(row(db, old.id).memoryValue).not.toBe(content);
    expect(row(db, old.id).properties.internal_info).not.toHaveProperty("source_raw_content_hash");
    const key = row(db, old.id).memoryKey;
    expect(key).toBe(`manual:${stableHash(`Skill:${oldTitle}:${sanitizeMemmyProtocolText(content)}`).slice(0, 20)}`);
    service.archiveMemory(old.id, { namespace });
    const repeated = add(service, input, { ...request, title: explicitTitle ? input.title : undefined });
    expect(repeated).toMatchObject({ id: old.id, status: "archived" });
    expect(row(db, old.id).memoryKey).toBe(key);
    expect(row(db, old.id).memoryValue).toBe(content);
    expect(versions(db)).toHaveLength(1);
  });

  it("leaves repeated and metadata-only direct observations free of duplicate jobs and content rewrites", async () => {
    const { db, service } = createService();
    const input = source();
    const id = add(service, input, { tags: ["user-tag"] }).id;
    await runWorkerRounds(service, 2, 50);
    const before = row(db, id); const jobs = embeddingJobs(db, id);
    add(service, input, { tags: ["user-tag"] });
    add(service, { ...input, sourceSkillPath: "/moved/entry-contract/SKILL.md" }, { sourceSkillVersion: "metadata-version" });
    expect(row(db, id)).toMatchObject({ updatedAt: before.updatedAt, version: before.version,
      properties: { internal_info: { source_skill_path: "/moved/entry-contract/SKILL.md", source_skill_version: "metadata-version" } } });
    expect(row(db, id).tags).toContain("user-tag");
    expect(embeddingJobs(db, id)).toBe(jobs);
    expectRepresentation(db, id, input);
  });

  it.each(([["direct", "scan", "direct"], ["scan", "direct", "scan"]] as Entry[][]).map(entries => ({ entries })))(
    "keeps rollback and full retrieval representation coherent for $entries", async ({ entries }) => {
      const { db, service, seen } = createService();
      const a = source("a"); const b = source("b", { description: "Apply the alternate sqlite migration procedure." });
      b.content = b.content.replace(description, b.description!); b.contentHash = rawHash(b.content);
      const aId = write(service, a, entries[0]!); const bId = write(service, b, entries[1]!);
      expect(write(service, a, entries[2]!)).toBe(aId);
      expect(versions(db)).toHaveLength(2);
      expect(row(db, aId).status).toBe("activated");
      expect(row(db, bId)).toMatchObject({ status: "archived", properties: { internal_info: { archive_reason: "superseded", superseded_by_skill_id: aId } } });
      expectRepresentation(db, aId, a);
      await runWorkerRounds(service, 2, 50);
      expect(seen.some(text => text.includes(marker))).toBe(true);
    }
  );

  it.each([
    { label: "omitted", hash: undefined }, { label: "empty", hash: "" }, { label: "whitespace", hash: " \t " },
    { label: "version only", hash: undefined, version: "fixed-version" }
  ])("uses raw source SHA-256 for $label hash and reuses the id at the next scan", ({ hash, version }) => {
    const { db, service } = createService(); const input = source();
    const id = add(service, input, { sourceContentHash: hash, sourceSkillVersion: version }).id;
    expect(row(db, id).properties.internal_info.source_content_hash).toBe(rawHash(input.content));
    expect(scan(service, [input]).skills[0]?.memoryId).toBe(id);
    expect(versions(db)).toHaveLength(1);
    expectRepresentation(db, id, input);
  });

  it.each(["adapter request", "turn fallback"])("keeps immutable versions and lifecycle intent behind an old fixed %s key", mode => {
    const { db, service } = createService(); const a = source("a"); const b = source("b");
    const request = { sourceAgentId: undefined, sourceSkillId: undefined, sourceSkillPath: undefined,
      requestId: "fixed-observation", ...(mode === "turn fallback" ? { turnId: "fixed-turn" } : {}) };
    const legacyKey = mode === "turn fallback" ? "memory.add:agent-source:hermes:turn:fixed-turn" : "memory.add:agent-source:hermes:fixed-observation";
    const first = withLegacyImportedSkillWriter(service, () => add(service, a, request), { memoryKey: legacyKey });
    const originalKey = row(db, first.id).memoryKey;
    service.archiveMemory(first.id, { namespace });
    const second = add(service, b, request);
    expect(second.id).not.toBe(first.id);
    expect(row(db, first.id).memoryValue).toBe(a.content);
    expect(row(db, second.id)).toMatchObject({ status: "archived", properties: { internal_info: { archive_reason: "user" } } });
    expect(row(db, first.id).memoryKey).toBe(originalKey);
    expect(add(service, a, request)).toMatchObject({ id: first.id, status: "archived" });
    expect(versions(db)).toHaveLength(2);
    expect(service.reactivateSkill(first.id, { namespace }).status).toBe("activated");
    service.deleteMemory(second.id, { namespace });
    const third = add(service, source("c"), request);
    expect(third.status).toBe("activated");
    service.deleteMemory(third.id, { namespace });
    expect(add(service, source("d"), request)).toMatchObject({ id: third.id, status: "deleted" });
  });

  it("keeps different explicit directory identities separate when sourceAgentId is inferred and requestId is fixed", () => {
    const { db, service } = createService(); const input = source();
    const request = { sourceAgentId: undefined, requestId: "same-client-request" };
    const first = withLegacyImportedSkillWriter(service, () => add(service, { ...input, sourceSkillId: "directory-a" }, request),
      { memoryKey: "memory.add:agent-source:hermes:same-client-request" });
    service.archiveMemory(first.id, { namespace });
    const second = add(service, { ...input, sourceSkillId: "directory-b" }, request);
    expect(second.id).not.toBe(first.id);
    expect(row(db, first.id)).toMatchObject({ status: "archived", properties: { internal_info: { source_skill_id: "directory-a", archive_reason: "user" } } });
    expect(row(db, second.id)).toMatchObject({ status: "activated", properties: { internal_info: { source_skill_id: "directory-b" } } });
    service.deleteMemory(first.id, { namespace });
    expect(add(service, { ...input, sourceSkillId: "directory-b" }, request).status).toBe("activated");
    expect(versions(db)).toHaveLength(2);
  });

  it.each([undefined, "fixed-version"])("distinguishes long bodies with a common 20k prefix and version=%s", version => {
    const { db, service } = createService();
    const first = source(); first.content += "x".repeat(22_000) + "-FIRST"; first.contentHash = rawHash(first.content);
    const second = { ...first, content: first.content.slice(0, -6) + "-OTHER" }; second.contentHash = rawHash(second.content);
    expect(stableHash(first.content)).toBe(stableHash(second.content));
    const a = add(service, first, { sourceContentHash: undefined, sourceSkillVersion: version });
    const b = add(service, second, { sourceContentHash: undefined, sourceSkillVersion: version });
    expect(a.id).not.toBe(b.id);
    expect(row(db, a.id).memoryKey).not.toBe(row(db, b.id).memoryKey);
    expect(row(db, a.id).memoryValue).toBe(first.content);
    expect(row(db, b.id).memoryValue).toBe(second.content);
    expect(scan(service, [first]).skills[0]?.memoryId).toBe(a.id);
    expect(versions(db)).toHaveLength(2);
  });

  it.each(["active", "user archive", "old deletion"])("reuses an old stableHash version while preserving its %s and key", state => {
    const { db, service } = createService(); const input = source();
    const legacyHash = stableHash(input.content);
    const id = withLegacyImportedSkillWriter(service, () => add(service, input, { sourceContentHash: legacyHash }).id);
    const key = row(db, id).memoryKey;
    expect(key).toBe(`skill.import:${stableHash(["hermes", input.sourceSkillId, legacyHash]).slice(0, 20)}`);
    expect(row(db, id).properties.internal_info).not.toHaveProperty("source_raw_content_hash");
    if (state === "user archive") new Repositories(db.db).memories.archive(id);
    if (state === "old deletion") new Repositories(db.db).memories.softDelete(id);
    service.reconcileWorkerStartup(1);
    const result = scan(service, [input]).skills[0]!;
    if (state === "old deletion") expect(result.outcome).toBe("deleted_by_user");
    else {
      expect(result.memoryId).toBe(id);
      expect(row(db, id).status).toBe(state === "user archive" ? "archived" : "activated");
    }
    expect(versions(db)).toHaveLength(1);
    expect(row(db, id).memoryKey).toBe(key);
    expect(row(db, id).properties.internal_info.source_content_hash).toBe(legacyHash);
    if (state === "old deletion") expect(row(db, id).properties.internal_info).not.toHaveProperty("source_raw_content_hash");
    else expect(row(db, id).properties.internal_info.source_raw_content_hash).toBe(rawHash(input.content));
  });

  it.each(["live", "delete before startup", "delete after startup"].flatMap(state =>
    ["declared raw", "legacy computed"].map(hashStyle => ({ state, hashStyle }))))(
    "preserves legacy sanitized-source provenance for $state with $hashStyle hash", ({ state, hashStyle }) => {
    const { db, service } = createService(); const original = source();
    const content = original.content + "\n<memmy_memory_context>\nA legitimate file example.\n</memmy_memory_context>\n\n\n\nTrailing spaces   \r\n";
    const a = { ...original, content, contentHash: rawHash(content) };
    const sanitized = sanitizeMemmyProtocolText(content);
    expect(sanitized).not.toBe(content);
    const declaredHash = hashStyle === "declared raw" ? a.contentHash : stableHash(sanitized);
    const id = withLegacyImportedSkillWriter(service, () => add(service, a, { sourceContentHash: declaredHash })).id;
    expect(row(db, id).memoryValue).toBe(sanitized);
    expect(row(db, id).properties.internal_info.source_content_hash).toBe(declaredHash);
    expect(row(db, id).properties.internal_info).not.toHaveProperty("source_raw_content_hash");
    if (state === "live") {
      service.reconcileWorkerStartup(1);
      expect(row(db, id).properties.internal_info).not.toHaveProperty("source_raw_content_hash");
      expect(scan(service, [a]).skills[0]?.memoryId).toBe(id);
      expect(row(db, id).memoryValue).toBe(content);
      expect(row(db, id).properties.internal_info.source_raw_content_hash).toBe(rawHash(content));
    } else {
      withLegacyImportedSkillWriter(service, () => add(service, source("b")));
      if (state === "delete after startup") service.reconcileWorkerStartup(1);
      service.deleteMemory(id, { namespace });
      expect(row(db, id).properties.internal_info).not.toHaveProperty("source_raw_content_hash");
      service.reconcileWorkerStartup(1);
      expect(scan(service, [a]).skills[0]?.outcome).toBe("deleted_by_user");
      expect(versions(db)).toHaveLength(2);
      expect(row(db, id)).toMatchObject({ status: "deleted", memoryValue: "", properties: { internal_info: { deleted_current: false } } });
      expect(scan(service, [source("c")]).skills[0]?.outcome).toBe("created");
    }
  });

  it("replaces the old installation alias during a partial exact-path identity upgrade", () => {
    const { db, service } = createService(); const a = source("a", { title: "old-alpha" });
    const id = add(service, a, { sourceSkillId: undefined }).id;
    const b = source("b", { title: "new-beta", sourceSkillId: "relative-directory" });
    service.reconcileAgentSkills({ namespace, sourceAgentId: "hermes", complete: false, skills: [b] });
    expect([...new Repositories(db.db).listInstalledSkillNamesForAgent("hermes")]).toEqual(["new-beta"]);
    expect(row(db, id).properties.internal_info.source_skill_id).toBe("relative-directory");
  });

  it("retains a known installed name across a malformed complete exact-path identity upgrade", () => {
    const { db, service } = createService(); const a = source("a", { title: "known-alpha" });
    add(service, a, { sourceSkillId: undefined });
    const content = "---\nname: broken\n" + marker;
    const b = source("b", { content, contentHash: rawHash(content), description: undefined,
      title: "relative-directory", sourceSkillId: "relative-directory" });
    scan(service, [b]);
    expect([...new Repositories(db.db).listInstalledSkillNamesForAgent("hermes")]).toEqual(["known-alpha"]);
  });

  it("replaces a seeded legacy row-id installation alias when a fixed adapter source receives a new version", () => {
    const { db, service } = createService(); const a = source("a", { title: "old-alpha" });
    const request = { sourceAgentId: undefined, sourceSkillId: undefined, sourceSkillPath: undefined, requestId: "legacy-fixed" };
    const old = withLegacyImportedSkillWriter(service, () => add(service, a, request));
    new Repositories(db.db).runtime.setKv(agentSkillInstallationsKey("hermes"), { version: 1,
      skills: [{ sourceSkillId: old.id, normalizedName: "old-alpha" }], registrations: [] }, row(db, old.id).updatedAt);
    add(service, source("b", { title: "new-beta" }), request);
    expect([...new Repositories(db.db).listInstalledSkillNamesForAgent("hermes")]).toEqual(["new-beta"]);
  });

  it("preserves explicit caller hash tokens while using verified raw bytes for mixed-entry identity", () => {
    const { db, service } = createService(); const input = source();
    const id = add(service, input, { sourceContentHash: "caller-supplied-token" }).id;
    const key = row(db, id).memoryKey;
    expect(scan(service, [input]).skills[0]?.memoryId).toBe(id);
    add(service, input, { sourceContentHash: "different-observation-token" });
    service.reconcileWorkerStartup(1);
    expect(versions(db)).toHaveLength(1);
    expect(row(db, id).memoryKey).toBe(key);
    expect(row(db, id).properties.internal_info.source_content_hash).toBe("caller-supplied-token");
    expect(embeddingJobs(db, id)).toBe(1);
  });

  it.each([false, true])("repairs damaged v1 representation across restart and preserves the first backup=%s", async backup => {
    const original = createService(); let { db, service } = original;
    const input = source(); const id = write(service, input, "scan");
    const repos = new Repositories(db.db); const before = row(db, id);
    const legacySummary = "Original pre-upgrade summary."; const legacyBlurb = "Original pre-upgrade retrieval blurb.";
    const internal: MemoryRow["properties"]["internal_info"] = { ...before.properties.internal_info, retrieval_representation_version: 1,
      summary: "---", invocation_guide: input.content, procedure_json: { summary: input.content },
      skill: { ...(before.properties.internal_info.skill as Record<string, unknown>), invocation_guide: input.content, procedure_json: { summary: input.content } },
      ...(backup ? { retrieval_previous: { summary: legacySummary, blurb: legacyBlurb } } : {}) };
    if (!backup) delete internal.retrieval_previous;
    delete internal.source_raw_content_hash;
    repos.memories.updateMaintenance({ ...before, info: { ...before.info, summary: "---" },
      properties: { ...before.properties, info: { ...before.properties.info, summary: "---" }, internal_info: internal } });
    await service.stop(); db.close();
    db = new MemoryDb({ path: join(original.root, "memory.sqlite") });
    const seen: string[] = [];
    service = fixture.createTestMemoryService({ db, mode: "dev", llm: createFailingLlm(), embedder: createCapturingEmbedder(seen) });
    service.reconcileWorkerStartup(1);
    expectRepresentation(db, id, input);
    const repaired = row(db, id);
    service.reconcileWorkerStartup(1);
    expect(row(db, id)).toMatchObject({ updatedAt: repaired.updatedAt, version: repaired.version });
    if (backup) expect(row(db, id).properties.internal_info.retrieval_previous).toEqual({ summary: legacySummary, blurb: legacyBlurb });
    expect(service.restoreImportedSkillRetrievalText(1)).toEqual({ restored: 1 });
    const restored = row(db, id);
    expect(restored.properties.internal_info.retrieval_representation_version).toBeUndefined();
    expect(restored.info.summary).toBe(backup ? legacySummary : "---");
    expect(embeddingTextForMemory(restored)).toContain(marker);
    expect(skillMetaFromMemory(restored)?.retrievalBlurb).toBe(backup ? legacyBlurb : undefined);
    expect(skillMetaFromMemory(restored)?.invocationGuide).toBe(input.content);
    expect(JSON.stringify(restored.properties)).not.toContain(marker);
    await runWorkerRounds(service, 2, 50);
    expect(seen.some(text => text.includes(marker))).toBe(true);
  });

  it.each(["upgrade", "rollback"])("repairs a missing vector during %s even when its old document marker matched", async operation => {
    const { db, service } = createService(); const input = source();
    const id = write(service, input, "scan");
    await runWorkerRounds(service, 2, 50);
    const before = row(db, id); const jobs = embeddingJobs(db, id);
    const repos = new Repositories(db.db);
    repos.memories.deleteVector(id, "vec");
    repos.memories.updateMaintenance({ ...before, properties: { ...before.properties, internal_info: {
      ...before.properties.internal_info, retrieval_representation_version: operation === "upgrade" ? 1 : 2,
      retrieval_previous: { blurb: description, summary: description }
    } } });
    if (operation === "upgrade") service.reconcileWorkerStartup(1);
    else service.restoreImportedSkillRetrievalText(1);
    expect(repos.memories.hasVector(id, "vec")).toBe(false);
    expect(embeddingJobs(db, id)).toBe(jobs + 1);
    await runWorkerRounds(service, 2, 50);
    expect(repos.memories.hasVector(id, "vec")).toBe(true);
    expect(embeddingJobs(db, id)).toBe(jobs + 1);
  });

  it("preserves a valid full-document vector and its matching model retry during metadata upgrade", async () => {
    const { db, service } = createService(); const input = source();
    const id = add(service, input).id; await runWorkerRounds(service, 2, 50);
    const repos = new Repositories(db.db); const before = row(db, id); const jobs = embeddingJobs(db, id);
    const pending = repos.runtime.enqueueEmbeddingRetry({ targetKind: "skill", targetId: id, vectorField: "vec",
      sourceText: embeddingTextForMemory(before) });
    repos.memories.updateMaintenance({ ...before, properties: { ...before.properties, internal_info: {
      ...before.properties.internal_info, retrieval_representation_version: 1, invocation_guide: input.content,
      procedure_json: { summary: input.content, retrievalBlurb: description },
      skill: { ...(before.properties.internal_info.skill as Record<string, unknown>), invocation_guide: input.content,
        procedure_json: { summary: input.content, retrievalBlurb: description } }
    } } });
    service.reconcileWorkerStartup(1);
    expect(repos.memories.hasVector(id, "vec")).toBe(true);
    expect(embeddingJobs(db, id)).toBe(jobs);
    expect(repos.runtime.getEmbeddingRetryByTarget("skill", id, "vec")).toEqual(pending);
    expectRepresentation(db, id, input);
    add(service, input); scan(service, [input]);
    expect(repos.memories.hasVector(id, "vec")).toBe(true);
    expect(embeddingJobs(db, id)).toBe(jobs);
    expect(repos.runtime.getEmbeddingRetryByTarget("skill", id, "vec")).toEqual(pending);
  });

  it("repairs a missing vector on an unchanged observation once with pending-job deduplication", async () => {
    const { db, service } = createService(); const input = source();
    const id = add(service, input).id;
    await runWorkerRounds(service, 2, 50);
    const jobs = embeddingJobs(db, id); new Repositories(db.db).memories.deleteVector(id, "vec");
    add(service, input); scan(service, [input]);
    expect(embeddingJobs(db, id)).toBe(jobs + 1);
  });

  it("normalizes raw frontmatter errors before complete installation observations and retains a known name", () => {
    const { db, service } = createService();
    const a = source("a", { title: "known-alpha", sourceSkillId: "directory" });
    const missing = source("b", { title: "missing-sibling", sourceSkillId: "missing-sibling", sourceSkillPath: "/synthetic/missing-sibling/SKILL.md" });
    scan(service, [a, missing]);
    const content = `---\nname: known-alpha\n${marker}`;
    scan(service, [{ ...a, title: "directory", content, contentHash: rawHash(content), description: undefined, frontmatterError: undefined }]);
    const repos = new Repositories(db.db);
    expect([...repos.listInstalledSkillNamesForAgent("hermes")]).toEqual(["known-alpha"]);
    const current = versions(db).find(memory => memory.properties.internal_info.source_content_hash === rawHash(content))!;
    expect(current).toMatchObject({ status: "archived", memoryValue: "", info: { title: "known-alpha" },
      properties: { internal_info: { archive_reason: "policy_unknown" } } });
    db.db.prepare("DELETE FROM runtime_kv WHERE key LIKE 'agent-skill-installations:%'").run();
    expect([...repos.listInstalledSkillNamesForAgent("hermes")]).toEqual(["known-alpha"]);
  });

  it.each(["manual", "frontmatter", "codex policy", "disconnect"])("keeps restricted %s observations identity-only with a raw-byte tombstone fact", policy => {
    const { db, service } = createService(); let input = source();
    if (policy === "manual") {
      input.content = input.content.replace("---\n# Procedure", "disable-model-invocation: true\n---\n# Procedure");
      input.contentHash = rawHash(input.content); input.disableModelInvocation = true;
    }
    if (policy === "frontmatter") {
      input.content = "---\nname: broken\n" + marker; input.contentHash = rawHash(input.content); input.frontmatterError = "unclosed frontmatter";
    }
    if (policy === "codex policy") scan(service, [{ ...input, allowImplicitInvocation: false }], "codex");
    if (policy === "disconnect") service.reconcileAgentSkills({ namespace, sourceAgentId: "hermes", skills: [], complete: false, connectionState: "disconnected" });
    const id = add(service, input, policy === "codex policy"
      ? { source: "codex", sourceAgentId: "codex", adapterId: "agent-source:codex" } : {}).id;
    expect(row(db, id)).toMatchObject({ status: "archived", memoryValue: "", properties: { internal_info: { source_raw_content_hash: rawHash(input.content) } } });
    expect(JSON.stringify(row(db, id).properties)).not.toContain(marker);
    expect(db.db.prepare("SELECT COUNT(*) AS n FROM memories_fts WHERE id = ?").get(id)).toEqual({ n: 0 });
    expect(db.db.prepare("SELECT COUNT(*) AS n FROM memory_vector_entries WHERE memory_id = ?").get(id)).toEqual({ n: 0 });
    expect(embeddingJobs(db, id)).toBe(0);
  });

  it("bridges an exact same path when only the old observation lacks an explicit directory id", () => {
    const { db, service } = createService(); const input = source();
    const id = add(service, input, { sourceSkillId: undefined }).id;
    service.archiveMemory(id, { namespace });
    expect(scan(service, [input]).skills[0]?.memoryId).toBe(id);
    expect(versions(db)).toHaveLength(1);
    expect(row(db, id)).toMatchObject({ status: "archived", properties: { internal_info: { source_skill_id: input.sourceSkillId, archive_reason: "user" } } });
    const otherId = scan(service, [{ ...input, sourceSkillId: "another-explicit-directory" }]).skills[0]?.memoryId;
    expect(otherId).not.toBe(id);
  });

  it.each(["direct", "scan"] as const)("rolls back partial writes when the %s observation cannot archive its predecessor", entry => {
    const { db, service } = createService(); const a = source("a"); const b = source("b", { title: "observed-new-name" });
    const id = write(service, a, entry); const before = row(db, id); const jobs = embeddingJobs(db, id);
    vi.spyOn(MemoryRepository.prototype, "update").mockImplementationOnce(() => { throw new Error("synthetic predecessor failure"); });
    if (entry === "direct") expect(() => add(service, b)).toThrow("synthetic predecessor failure");
    else expect(scan(service, [b]).skills[0]?.outcome).toBe("failed");
    vi.restoreAllMocks();
    expect(versions(db)).toHaveLength(1);
    expect(row(db, id)).toEqual(before);
    expect(embeddingJobs(db, id)).toBe(jobs);
    expect([...new Repositories(db.db).listInstalledSkillNamesForAgent("hermes")]).toEqual([entry === "direct" ? a.title : b.title]);
  });
});
