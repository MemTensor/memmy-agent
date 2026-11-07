import "../../fixtures/isolated-user-home.js";
import { afterEach, describe, expect, it } from "vitest";
import { retrievalDocumentForMemory, retrievalDocumentIsCurrent, retrievalDocumentSourceHash, skillMetaFromMemory } from "../../../src/algorithm/plugin-algorithms.js";
import { embeddingTextForMemory, updateMemoryVectorField } from "../../../src/service/embedding/embedding-pipeline.js";
import { agentSkillConnectionKey, agentSkillInstallationsKey, importedSkillContentHash } from "../../../src/storage/imported-skill.js";
import { MemoryDb } from "../../../src/storage/db.js";
import { join } from "node:path";
import { Repositories } from "../../../src/storage/repositories.js";
import type { MemoryAddRequest, MemoryRow } from "../../../src/types.js";
import { stableHash } from "../../../src/utils/id.js";
import { sanitizeMemmyProtocolText } from "../../../src/utils/memmy-context-tags.js";
import { withLegacyImportedSkillWriter } from "../../fixtures/legacy-imported-skill-writer.js";
import { createCapturingEmbedder, createFailingLlm, createMemoryServiceFixture, runWorkerRounds } from "../../fixtures/memory-service-fixture.js";

const fixture = createMemoryServiceFixture();
afterEach(fixture.cleanup);
const namespace = { source: "hermes", profileId: "default", userId: "manual-skill-user" };
const content = "Run deploymentquartz checks before the release, then inspect the result.";
function setup() {
  return fixture.createTestService({ llm: createFailingLlm(), embedder: createCapturingEmbedder([]) });
}
function manual(overrides: Partial<MemoryAddRequest> = {}): MemoryAddRequest {
  // The Hermes tool sends exactly these fields, plus its active session id.
  return { namespace, source: "hermes", layer: "Skill", title: "release-check", content, tags: ["user-label"], ...overrides };
}
function directory(overrides: Partial<MemoryAddRequest> = {}): MemoryAddRequest {
  return manual({ sourceAgentId: "hermes", sourceSkillId: "release-check", sourceSkillPath: "/synthetic/release-check/SKILL.md",
    content: "---\nname: release-check\ndescription: Release verification.\n---\n" + content, ...overrides });
}
type Service = ReturnType<typeof setup>["service"];
type Db = ReturnType<typeof setup>["db"];
function row(db: Db, id: string): MemoryRow { return new Repositories(db.db).memories.getIncludingDeleted(id)!; }
function legacyManual(service: Service, overrides: Partial<MemoryAddRequest> = {}) {
  // The old processor inferred source_agent_id from source for every Skill.
  // Explicitly passing that already-inferred value replays the old stored shape.
  return withLegacyImportedSkillWriter(service, () => service.addMemory(manual({ sourceAgentId: "hermes", ...overrides })));
}
function installed(db: Db): unknown[] {
  return (new Repositories(db.db).runtime.getKv(agentSkillInstallationsKey("hermes"))?.value as { skills?: unknown[] })?.skills ?? [];
}

describe("manual Skill and directory observation contracts", () => {
  it.each(["hermes", "openclaw", "opencode", "deepseek"]) ("keeps a real %s tool Skill active with usable metadata", source => {
    const { db, service } = setup();
    const id = service.addMemory(manual({ source, namespace: { ...namespace, source } })).id;
    const memory = row(db, id);
    expect(memory.status).toBe("activated");
    expect(memory.properties.internal_info.read_only).not.toBe(true);
    expect(memory.properties.internal_info.source_agent_id).toBeUndefined();
    expect(skillMetaFromMemory(memory)).toMatchObject({ name: "release-check", status: "active", eta: 0.5, trialsAttempted: 0 });
    expect(embeddingTextForMemory(memory)).toContain("deploymentquartz");
    expect(installed(db)).toEqual([]);
  });

  it("recalls a saved tool Skill for its saving Agent and another Agent", async () => {
    const { service } = setup();
    const id = service.addMemory(manual()).id;
    await runWorkerRounds(service, 2, 30);
    for (const source of ["hermes", "cursor"]) {
      const session = service.openSession({ namespace: { ...namespace, source } });
      const result = await service.search({ sessionId: session.sessionId, query: "deploymentquartz", layers: ["Skill"], limit: 5 });
      expect(result.hits.map(hit => hit.id)).toContain(id);
    }
  });

  it("leaves a tool Skill body and lifecycle intact across scans and disconnect", () => {
    const { db, service } = setup();
    const id = service.addMemory(manual()).id;
    service.reconcileAgentSkills({ namespace, sourceAgentId: "hermes", skills: [], complete: true });
    service.reconcileAgentSkills({ namespace, sourceAgentId: "hermes", skills: [], complete: false, connectionState: "disconnected" });
    expect(row(db, id)).toMatchObject({ status: "activated", memoryValue: content });
    expect(installed(db)).toEqual([]);
    service.archiveMemory(id, { namespace });
    expect(service.reactivateSkill(id, { namespace }).status).toBe("activated");
    service.deleteMemory(id, { namespace });
    expect(row(db, id).status).toBe("deleted");
    expect(row(db, id).properties.internal_info.deleted_current).toBeUndefined();
  });

  it("uses normal protocol sanitization for a manual Skill", () => {
    const { db, service } = setup();
    const raw = content + "\n<memmy_memory_context>untrusted context</memmy_memory_context>\n\n\n\nFinal line   ";
    const id = service.addMemory(manual({ content: raw })).id;
    expect(row(db, id).memoryValue).toBe(sanitizeMemmyProtocolText(raw));
  });

  it.each([undefined, "", "---"])("resolves an omitted or invalid source title %s from frontmatter", title => {
    const { db, service } = setup();
    const id = service.addMemory(directory({ title })).id;
    expect(row(db, id).info.title).toBe("release-check");
    expect(row(db, id).properties.internal_info.normalized_name).toBe("release-check");
    expect(installed(db)).toEqual([{ sourceSkillId: "release-check", normalizedName: "release-check" }]);
    expect(embeddingTextForMemory(row(db, id))).not.toMatch(/^---/);
  });

  it("preserves a meaningful explicit title over the frontmatter name", () => {
    const { db, service } = setup();
    const id = service.addMemory(directory({ title: "Custom release title" })).id;
    expect(row(db, id).info.title).toBe("Custom release title");
  });

  it("preserves the scanned name and vector on an omitted direct title", async () => {
    const { db, service } = setup();
    const request = directory();
    const scan = { sourceSkillId: request.sourceSkillId!, sourceSkillPath: request.sourceSkillPath!, title: "release-check",
      content: request.content, contentHash: "declared-token", modifiedAt: "2026-01-01T00:00:00.000Z" };
    const id = service.reconcileAgentSkills({ namespace, sourceAgentId: "hermes", skills: [scan], complete: true }).skills[0]!.memoryId!;
    await runWorkerRounds(service, 2, 30);
    const before = db.db.prepare("SELECT COUNT(*) AS n FROM evolution_jobs WHERE job_type='embedding'").get();
    service.addMemory(directory({ title: undefined, tags: undefined }));
    expect(row(db, id).info.title).toBe("release-check");
    expect(new Repositories(db.db).memories.hasVector(id, "vec")).toBe(true);
    expect(db.db.prepare("SELECT COUNT(*) AS n FROM evolution_jobs WHERE job_type='embedding'").get()).toEqual(before);
  });

  it("updates explicitly supplied source tags and retains them on unknown scan metadata", () => {
    const { db, service } = setup();
    const id = service.addMemory(directory({ tags: ["old-user-label"] })).id;
    expect(row(db, id).tags).not.toContain("manual");
    service.addMemory(directory({ tags: ["replacement-label"] }));
    expect(row(db, id).tags).toContain("replacement-label");
    expect(row(db, id).tags).not.toContain("old-user-label");
    service.addMemory(directory({ tags: undefined }));
    expect(row(db, id).tags).toContain("replacement-label");
    const request = directory();
    service.reconcileAgentSkills({ namespace, sourceAgentId: "hermes", complete: false, skills: [{ sourceSkillId: request.sourceSkillId!,
      sourceSkillPath: request.sourceSkillPath!, title: request.title!, content: request.content, contentHash: "token", modifiedAt: "2026-01-01T00:00:00.000Z" }] });
    expect(row(db, id).tags).toContain("replacement-label");
  });

  it.each(["legacy active", "user archive", "source missing", "modern misclassified"])("repairs %s tool data without source evidence", state => {
    const { db, service } = setup();
    const id = legacyManual(service).id;
    const original = row(db, id);
    expect(original.properties.internal_info).not.toHaveProperty("source_skill_id");
    expect(original.properties.internal_info).not.toHaveProperty("source_skill_path");
    expect(original.properties.internal_info).not.toHaveProperty("source_kind");
    expect(original.properties.internal_info).not.toHaveProperty("import_state_version");
    if (state === "user archive") new Repositories(db.db).memories.archive(id, "2026-04-01T00:00:00.000Z");
    if (state === "source missing" || state === "modern misclassified") {
      const internal = { ...original.properties.internal_info, source_kind: "skill", import_state_version: 2,
        ...(state === "source missing" ? { archive_reason: "source_missing" } : {}) };
      new Repositories(db.db).memories.updateMaintenance({ ...original, status: state === "source missing" ? "archived" : original.status,
        properties: { ...original.properties, status: state === "source missing" ? "archived" : original.status, internal_info: internal } });
    }
    service.reconcileWorkerStartup(1);
    const repaired = row(db, id);
    expect(repaired.properties.internal_info.read_only).not.toBe(true);
    expect(repaired.memoryValue).toBe(content);
    expect(repaired.status).toBe(state === "user archive" ? "archived" : "activated");
    expect(skillMetaFromMemory(repaired)?.status).toBe(state === "user archive" ? "archived" : "active");
    expect(installed(db)).toEqual([]);
    service.reconcileAgentSkills({ namespace, sourceAgentId: "hermes", complete: true, skills: [], connectionState: "disconnected" });
    expect(row(db, id).memoryValue).toBe(content);
    service.reconcileWorkerStartup(1);
    expect(row(db, id).properties.internal_info.read_only).not.toBe(true);
  });

  it.each(["agent-source tag", "agent-source key", "skill turn", "directory id", "directory path", "new source agent only"])("retains genuine import evidence from %s", evidence => {
    const { db, service } = setup();
    const extra: Partial<MemoryAddRequest> = evidence === "agent-source tag" ? { tags: ["agent-source"] }
      : evidence === "agent-source key" ? { adapterId: "agent-source:hermes", requestId: "old-import" }
      : evidence === "skill turn" ? { sourceAgentId: undefined, turnId: "skill:old-release" }
      : evidence === "directory id" ? { sourceSkillId: "old-release" }
      : evidence === "directory path" ? { sourceSkillPath: "/old/release/SKILL.md" } : {};
    const id = evidence === "new source agent only" ? service.addMemory(manual({ sourceAgentId: "hermes" })).id : legacyManual(service, extra).id;
    service.reconcileWorkerStartup(1);
    expect(row(db, id).properties.internal_info.read_only).toBe(true);
    service.reconcileAgentSkills({ namespace, sourceAgentId: "hermes", complete: true, skills: [], connectionState: "disconnected" });
    expect(row(db, id).memoryValue).toBe("");
  });
  it("releases an old manual inventory entry before the first disconnect scan and preserves file/plugin facts", () => {
    const { db, service } = setup();
    const id = legacyManual(service).id;
    const repo = new Repositories(db.db);
    const original = row(db, id);
    const legacyKey = original.memoryKey!;
    repo.memories.updateMaintenance({ ...original, properties: { ...original.properties,
      internal_info: { ...original.properties.internal_info, import_state_version: 2, source_kind: "skill", source_skill_key: legacyKey } } });
    repo.runtime.setKv(agentSkillInstallationsKey("hermes"), { version: 1,
      skills: [{ sourceSkillId: legacyKey, normalizedName: "release-check" }, { sourceSkillId: "real-file", normalizedName: "real-file" }],
      registrations: [{ sourceSkillId: "plugin:known", normalizedName: "known-plugin" }] });
    service.reconcileAgentSkills({ namespace, sourceAgentId: "hermes", complete: false, skills: [], connectionState: "disconnected" });
    expect(row(db, id)).toMatchObject({ memoryValue: content, status: "activated", properties: { internal_info: { read_only: false } } });
    expect(repo.runtime.getKv(agentSkillInstallationsKey("hermes"))?.value).toEqual({ version: 1,
      skills: [{ sourceSkillId: "real-file", normalizedName: "real-file" }],
      registrations: [{ sourceSkillId: "plugin:known", normalizedName: "known-plugin" }] });
  });

  it("keeps an already stripped old manual Skill archived without inventing content", () => {
    const { db, service } = setup();
    const id = legacyManual(service).id;
    const original = row(db, id);
    new Repositories(db.db).memories.updateMaintenance({ ...original, memoryValue: "", status: "archived",
      properties: { ...original.properties, status: "archived", internal_info: { ...original.properties.internal_info,
        import_state_version: 2, source_kind: "skill", archive_reason: "disconnected", invocation_guide: "",
        skill: { ...original.properties.internal_info.skill as Record<string, unknown>, invocation_guide: "" } } } });
    service.reconcileWorkerStartup(1);
    expect(row(db, id)).toMatchObject({ memoryValue: "", status: "archived", properties: { internal_info: { read_only: false } } });
    expect(skillMetaFromMemory(row(db, id))?.invocationGuide).toBe("");
  });

  it("detaches a deleted manual row without resurrecting it", () => {
    const { db, service } = setup();
    const id = legacyManual(service).id;
    new Repositories(db.db).memories.softDelete(id, "2026-05-01T00:00:00.000Z");
    service.reconcileWorkerStartup(1);
    expect(row(db, id).status).toBe("deleted");
    expect(row(db, id).properties.internal_info.read_only).toBe(false);
  });

  it("clears explicit empty user tags while keeping source provenance", () => {
    const { db, service } = setup();
    const id = service.addMemory(directory({ tags: ["obsolete"] })).id;
    service.addMemory(directory({ tags: [] }));
    expect(row(db, id).tags).not.toContain("obsolete");
    expect(row(db, id).tags).not.toContain("manual");
    expect(row(db, id).tags).toContain("agent-source");
    service.reconcileWorkerStartup(1);
    expect(row(db, id).properties.internal_info.read_only).toBe(true);
  });

  it("uses frontmatter names for a manual Skill without an explicit title", () => {
    const { db, service } = setup();
    const id = service.addMemory(manual({ title: undefined, content: "---\nname: manually-saved\n---\n" + content })).id;
    expect(row(db, id).info.title).toBe("manually-saved");
    expect(skillMetaFromMemory(row(db, id))?.name).toBe("manually-saved");
  });

  it("retains a valid legacy manual document vector, index and matching model retry", () => {
    const { db, service } = setup();
    const id = legacyManual(service).id;
    const repos = new Repositories(db.db);
    const before = row(db, id);
    expect(before.properties.internal_info).not.toHaveProperty("import_state_version");
    expect(before.properties.internal_info).not.toHaveProperty("retrieval_representation_version");
    const indexed = updateMemoryVectorField(before, "vec", [1, 0, 0], {
      provider: "local", model: "capturing-test-embedding", updatedAt: before.updatedAt,
      sourceHash: retrievalDocumentSourceHash(before)
    });
    repos.memories.updateMaintenance(indexed);
    const retry = repos.runtime.enqueueEmbeddingRetry({ targetKind: "skill", targetId: id, vectorField: "vec",
      sourceText: retrievalDocumentForMemory(before) });
    const jobs = db.db.prepare("SELECT COUNT(*) AS n FROM evolution_jobs WHERE job_type='embedding'").get();
    service.reconcileWorkerStartup(1);
    const repaired = row(db, id);
    expect(repaired.properties.internal_info.read_only).toBe(false);
    expect(retrievalDocumentForMemory(repaired)).toBe(retrievalDocumentForMemory(before));
    expect(retrievalDocumentIsCurrent(repaired)).toBe(true);
    expect(repos.memories.hasVector(id, "vec")).toBe(true);
    expect(db.db.prepare("SELECT COUNT(*) AS n FROM evolution_jobs WHERE job_type='embedding'").get()).toEqual(jobs);
    expect(repos.runtime.getEmbeddingRetryByTarget("skill", id, "vec")).toEqual(retry);
  });

  it("preserves non-body procedure metadata while removing known imported short text", () => {
    const { db, service } = setup();
    const id = legacyManual(service).id;
    const before = row(db, id);
    new Repositories(db.db).memories.updateMaintenance({ ...before, properties: { ...before.properties,
      internal_info: { ...before.properties.internal_info, retrieval_representation_version: 2,
        procedure_json: { summary: before.memoryValue, retrievalBlurb: before.info.title, arguments: { region: "string" } },
        skill: { ...before.properties.internal_info.skill as Record<string, unknown>, trials_attempted: 4, trials_passed: 3,
          procedure_json: { summary: before.memoryValue, retrieval_blurb: before.info.title, steps: ["check release"], version: 7 } } } } });
    service.reconcileWorkerStartup(1);
    const internal = row(db, id).properties.internal_info;
    expect(internal.procedure_json).toEqual({ arguments: { region: "string" } });
    expect(internal.skill).toMatchObject({ trials_attempted: 4, trials_passed: 3,
      procedure_json: { steps: ["check release"], version: 7 } });
    expect(skillMetaFromMemory(row(db, id))?.retrievalBlurb).toBeUndefined();
    expect(skillMetaFromMemory(row(db, id))?.invocationGuide).toBe(before.memoryValue);
  });

  it.each(["---", "___", " _-- ", "   "])("ignores an invalid frontmatter name %s on a source observation", name => {
    const { db, service } = setup();
    const request = directory({ title: undefined, sourceSkillId: "valid-directory",
      content: `---\nname: ${JSON.stringify(name)}\ndescription: Release verification.\n---\n${content}` });
    const id = service.addMemory(request).id;
    expect(row(db, id).info.title).toBe("valid-directory");
    expect(row(db, id).properties.internal_info.normalized_name).toBe("valid-directory");
    expect(installed(db)).toEqual([{ sourceSkillId: "valid-directory", normalizedName: "valid-directory" }]);
  });

  it.each(["original writer", "round6 writer"].flatMap(writer => ["active", "user archive"].map(state => ({ writer, state }))))(
    "reuses $writer manual identity and trial history after repair of $state", ({ writer, state }) => {
    const { db, service } = setup();
    const oldKey = writer === "round6 writer"
      ? `manual:${stableHash(["Skill", "hermes", "release-check", importedSkillContentHash(content)]).slice(0, 20)}` : undefined;
    const id = withLegacyImportedSkillWriter(service, () => service.addMemory(manual()), { memoryKey: oldKey }).id;
    const before = row(db, id);
    expect(before.memoryKey).toBe(oldKey ?? `manual:${stableHash(`Skill:release-check:${content}`).slice(0, 20)}`);
    const repos = new Repositories(db.db);
    repos.memories.updateMaintenance({ ...before, properties: { ...before.properties, internal_info: {
      ...before.properties.internal_info,
      ...(writer === "round6 writer" ? { source_kind: "skill", import_state_version: 2,
        source_raw_content_hash: importedSkillContentHash(content) } : {}),
      skill: { ...before.properties.internal_info.skill as Record<string, unknown>, trials_attempted: 4, trials_passed: 3, eta: 0.7 }
    } } });
    if (state === "user archive") repos.memories.archive(id, "2026-06-01T00:00:00.000Z");
    service.reconcileWorkerStartup(1);
    const repaired = row(db, id);
    expect(skillMetaFromMemory(repaired)!.eta).toBe(0.7);
    const repeated = service.addMemory(manual());
    expect(repeated.id).toBe(id);
    expect(row(db, id).status).toBe(state === "user archive" ? "archived" : "activated");
    expect(skillMetaFromMemory(row(db, id))).toMatchObject({ trialsAttempted: 4, trialsPassed: 3, eta: skillMetaFromMemory(repaired)!.eta });
    expect(repos.memories.list({ memoryLayer: "Skill" }, 20)).toHaveLength(1);
    expect(service.addMemory(manual()).id).toBe(id);
  });

  it.each(["other source", "other profile", "other user"])("keeps an old manual alias isolated from %s", scope => {
    const { db, service } = setup();
    const oldKey = `manual:${stableHash(["Skill", "hermes", "release-check", importedSkillContentHash(content)]).slice(0, 20)}`;
    const id = withLegacyImportedSkillWriter(service, () => service.addMemory(manual()), { memoryKey: oldKey }).id;
    service.reconcileWorkerStartup(1);
    const original = service.addMemory(manual());
    const otherNamespace = scope === "other source" ? { ...namespace, source: "cursor" }
      : scope === "other profile" ? { ...namespace, profileId: "another-profile" } : { ...namespace, userId: "another-user" };
    const other = service.addMemory(manual({ namespace: otherNamespace, source: otherNamespace.source }));
    expect(original.id).toBe(id);
    expect(other.id).not.toBe(id);
    expect(row(db, id).userId).toBe(namespace.userId);
    expect(row(db, id).agentId).toBe("hermes");
    expect(service.addMemory(manual()).id).toBe(id);
  });

  it.each([false, true])("keeps a file-backed manual-shaped key separate when deleted=%s", deleted => {
    const { db, service } = setup();
    const file = service.addMemory(manual({ sourceAgentId: "hermes" }));
    if (deleted) service.deleteMemory(file.id, { namespace });
    const before = row(db, file.id);
    const tool = service.addMemory(manual());
    expect(tool.id).not.toBe(file.id);
    expect(row(db, file.id)).toEqual(before);
    expect(row(db, tool.id).properties.internal_info.read_only).toBe(false);
    expect(service.addMemory(manual()).id).toBe(tool.id);
  });

  it.each(["installed", "source missing"])("keeps only supported %s inventory facts when an old manual turn reused its directory id", state => {
    const { db, service } = setup();
    const request = directory();
    const file = service.reconcileAgentSkills({ namespace, sourceAgentId: "hermes", complete: true, skills: [{
      sourceSkillId: "release-check", sourceSkillPath: request.sourceSkillPath!, title: "release-check",
      content: request.content, contentHash: "file-content", modifiedAt: "2026-01-01T00:00:00.000Z"
    }] }).skills[0]!.memoryId!;
    if (state === "source missing") service.reconcileAgentSkills({ namespace, sourceAgentId: "hermes", complete: true, skills: [] });
    const tool = legacyManual(service, { turnId: "release-check" }).id;
    new Repositories(db.db).runtime.setKv(agentSkillInstallationsKey("hermes"), { version: 1,
      skills: [{ sourceSkillId: "release-check", normalizedName: "release-check" }], registrations: [] });
    expect(row(db, tool).properties.internal_info.source_skill_id).toBe("release-check");
    expect(row(db, tool).properties.internal_info.turn_id).toBe("release-check");
    expect(installed(db)).toEqual([{ sourceSkillId: "release-check", normalizedName: "release-check" }]);
    service.reconcileWorkerStartup(1);
    expect(row(db, tool).properties.internal_info.read_only).toBe(false);
    expect(row(db, file).properties.internal_info.read_only).toBe(true);
    const expected = state === "installed" ? [{ sourceSkillId: "release-check", normalizedName: "release-check" }] : [];
    expect(installed(db)).toEqual(expected);
    service.reconcileAgentSkills({ namespace, sourceAgentId: "hermes", skills: [], complete: false, connectionState: "disconnected" });
    expect(installed(db)).toEqual(expected);
  });

  it.each(["active", "user archive"])("preserves modern native trials and eta on repeated %s saves", state => {
    const { db, service } = setup();
    const id = service.addMemory(manual()).id;
    const before = row(db, id);
    new Repositories(db.db).memories.updateMaintenance({ ...before, properties: { ...before.properties,
      internal_info: { ...before.properties.internal_info, eta: 0.8,
        skill: { ...before.properties.internal_info.skill as Record<string, unknown>, trials_attempted: 6, trials_passed: 5, eta: 0.8 } } } });
    if (state === "user archive") service.archiveMemory(id, { namespace });
    expect(service.addMemory(manual()).id).toBe(id);
    expect(row(db, id).status).toBe(state === "user archive" ? "archived" : "activated");
    expect(skillMetaFromMemory(row(db, id))).toMatchObject({ trialsAttempted: 6, trialsPassed: 5, eta: 0.8 });
  });

  it("keeps a round6 raw manual key reusable after normal protocol sanitization", () => {
    const { db, service } = setup();
    const raw = content + "\n<memmy_memory_context>example</memmy_memory_context>\n\n\n\nlast line   ";
    const key = `manual:${stableHash(["Skill", "hermes", "release-check", importedSkillContentHash(raw)]).slice(0, 20)}`;
    const id = withLegacyImportedSkillWriter(service, () => service.addMemory(manual({ content: raw })), { memoryKey: key }).id;
    const before = row(db, id);
    new Repositories(db.db).memories.updateMaintenance({ ...before, memoryValue: raw, properties: { ...before.properties,
      internal_info: { ...before.properties.internal_info, source_kind: "skill", import_state_version: 2,
        source_raw_content_hash: importedSkillContentHash(raw), invocation_guide: raw,
        skill: { ...before.properties.internal_info.skill as Record<string, unknown>, invocation_guide: raw } } } });
    service.reconcileWorkerStartup(1);
    expect(service.addMemory(manual({ content: raw })).id).toBe(id);
    expect(row(db, id).memoryValue).toBe(sanitizeMemmyProtocolText(raw));
    expect(service.addMemory(manual({ content: sanitizeMemmyProtocolText(raw) })).id).toBe(id);
  });

  it.each(["startup", "partial disconnect"])("holds a real file for a rescan after a manual collision through %s", entry => {
    const { db, service } = setup();
    const request = directory();
    const observation = { sourceSkillId: "release-check", sourceSkillPath: request.sourceSkillPath!, title: "release-check",
      content: request.content, contentHash: "original-file", modifiedAt: "2026-01-01T00:00:00.000Z" };
    const file = service.reconcileAgentSkills({ namespace, sourceAgentId: "hermes", complete: true, skills: [observation] }).skills[0]!.memoryId!;
    const tool = legacyManual(service, { turnId: "release-check" }).id;
    expect(row(db, file).properties.internal_info.superseded_by_skill_id).toBe(tool);
    if (entry === "startup") service.reconcileWorkerStartup(1);
    else service.reconcileAgentSkills({ namespace, sourceAgentId: "hermes", complete: false, skills: [], connectionState: "disconnected" });
    expect(row(db, file)).toMatchObject({ status: "archived", memoryValue: entry === "startup" ? request.content : "", properties: { internal_info: {
      archive_reason: entry === "startup" ? "source_review_pending" : "disconnected"
    } } });
    expect(row(db, file).properties.internal_info.superseded_by_skill_id).toBeUndefined();
    expect(row(db, tool)).toMatchObject({ status: "activated", memoryValue: content, properties: { internal_info: { read_only: false } } });
    const observed = service.reconcileAgentSkills({ namespace, sourceAgentId: "hermes", complete: false,
      connectionState: "connected", skills: [observation] });
    expect(observed.skills[0]?.memoryId).toBe(file);
    expect(row(db, file)).toMatchObject({ status: "activated", memoryValue: request.content });
    expect(row(db, file).properties.internal_info.archive_reason).toBeUndefined();
    expect(row(db, tool).memoryValue).toBe(content);
  });

  it.each([false, true])("repairs a deleted current file after a manual collision while missing=%s", missing => {
    const { db, service } = setup();
    const request = directory();
    const observation = { sourceSkillId: "release-check", sourceSkillPath: request.sourceSkillPath!, title: "release-check",
      content: request.content, contentHash: "original-file", modifiedAt: "2026-01-01T00:00:00.000Z" };
    const file = service.reconcileAgentSkills({ namespace, sourceAgentId: "hermes", complete: true, skills: [observation] }).skills[0]!.memoryId!;
    if (missing) service.reconcileAgentSkills({ namespace, sourceAgentId: "hermes", complete: true, skills: [] });
    legacyManual(service, { turnId: "release-check" });
    service.deleteMemory(file, { namespace });
    // Cold deletion now repairs the collision before recording user intent.
    expect(row(db, file).properties.internal_info.deleted_current).toBe(!missing);
    service.reconcileWorkerStartup(1);
    expect(row(db, file).properties.internal_info.deleted_current).toBe(!missing);
    expect(row(db, file).properties.internal_info.superseded_by_skill_id).toBeUndefined();
    const next = service.reconcileAgentSkills({ namespace, sourceAgentId: "hermes", complete: true,
      skills: [{ ...observation, content: request.content + "\nNew file version.", contentHash: "new-file" }] });
    expect(next.skills[0]?.outcome).toBe(missing ? "created" : "deleted_by_user");
  });

  it("reuses a repaired old ordinary-tool turn key without treating it as a file", () => {
    const { db, service } = setup();
    const id = legacyManual(service, { turnId: "ordinary-tool-turn" }).id;
    expect(row(db, id).memoryKey).toMatch(/^skill\.import:/);
    service.reconcileWorkerStartup(1);
    expect(service.addMemory(manual({ turnId: "ordinary-tool-turn" })).id).toBe(id);
    expect(row(db, id).properties.internal_info.read_only).toBe(false);
  });

  it.each(["original writer", "round6 writer"])("reuses a cold %s tool Skill before startup migration", writer => {
    const { db, service } = setup();
    const key = writer === "round6 writer" ? `manual:${stableHash(["Skill", "hermes", "release-check", importedSkillContentHash(content)]).slice(0, 20)}` : undefined;
    const id = withLegacyImportedSkillWriter(service, () => service.addMemory(manual()), { memoryKey: key }).id;
    const before = row(db, id);
    if (writer === "round6 writer") new Repositories(db.db).memories.updateMaintenance({ ...before, properties: { ...before.properties,
      internal_info: { ...before.properties.internal_info, source_kind: "skill", import_state_version: 2 } } });
    expect(row(db, id).properties.internal_info.read_only).toBe(true);
    const replayed = service.addMemory(manual());
    expect(replayed.id).toBe(id);
    expect(row(db, id).properties.internal_info.read_only).toBe(false);
    service.reconcileWorkerStartup(1);
    expect(new Repositories(db.db).memories.list({ memoryLayer: "Skill" }, 20)).toHaveLength(1);
    expect(service.addMemory(manual()).id).toBe(id);
  });

  it("corrects a protected file inventory name after a same-id tool rename", () => {
    const { db, service } = setup();
    const request = directory();
    const body = request.content.replace("name: release-check", "name: file-alpha");
    service.reconcileAgentSkills({ namespace, sourceAgentId: "hermes", complete: true, skills: [{
      sourceSkillId: "release-check", sourceSkillPath: request.sourceSkillPath!, title: "file-alpha", content: body,
      contentHash: "file-alpha-bytes", modifiedAt: "2026-01-01T00:00:00.000Z"
    }] });
    legacyManual(service, { turnId: "release-check", title: "tool-beta" });
    const repos = new Repositories(db.db);
    repos.runtime.setKv(agentSkillInstallationsKey("hermes"), { version: 1,
      skills: [{ sourceSkillId: "release-check", normalizedName: "tool-beta" }, { sourceSkillId: "other-file", normalizedName: "keep-other" }],
      registrations: [{ sourceSkillId: "plugin:known", normalizedName: "keep-plugin" }] });
    service.reconcileWorkerStartup(1);
    expect(repos.runtime.getKv(agentSkillInstallationsKey("hermes"))?.value).toEqual({ version: 1,
      skills: [{ sourceSkillId: "release-check", normalizedName: "file-alpha" }, { sourceSkillId: "other-file", normalizedName: "keep-other" }],
      registrations: [{ sourceSkillId: "plugin:known", normalizedName: "keep-plugin" }] });
  });

  it.each(["original writer", "round6 writer"].flatMap(writer => ["cold", "after startup"].flatMap(entry =>
    [undefined, "   ", "---", "___"].map(inputTitle => ({ writer, entry, inputTitle }))))) (
    "reuses a $writer default-title alias through $entry with title=$inputTitle", ({ writer, entry, inputTitle }) => {
    const { db, service } = setup();
    const body = "---\nname: named-from-frontmatter\ndescription: Useful release steps.\n---\n" + content;
    const oldTitle = inputTitle?.trim() || "---";
    const key = writer === "round6 writer"
      ? `manual:${stableHash(["Skill", "hermes", oldTitle, importedSkillContentHash(body)]).slice(0, 20)}` : undefined;
    const request = manual({ content: body, title: inputTitle });
    const id = withLegacyImportedSkillWriter(service, () => service.addMemory(request), { memoryKey: key }).id;
    expect(row(db, id).info.title).toBe(oldTitle);
    expect(row(db, id).memoryKey).toBe(key ?? `manual:${stableHash(`Skill:${oldTitle}:${body}`).slice(0, 20)}`);
    expect(row(db, id).properties.internal_info.read_only).toBe(true);
    if (entry === "after startup") service.reconcileWorkerStartup(1);
    expect(service.addMemory(request).id).toBe(id);
    expect(row(db, id).info.title).toBe("named-from-frontmatter");
    expect(row(db, id).properties.internal_info.name).toBe("named-from-frontmatter");
    expect(skillMetaFromMemory(row(db, id))?.name).toBe("named-from-frontmatter");
    expect(new Repositories(db.db).memories.list({ memoryLayer: "Skill" }, 20)).toHaveLength(1);
    expect(service.addMemory(request).id).toBe(id);
  });

  it("keeps an explicitly renamed Skill separate from an old inferred title", () => {
    const { db, service } = setup();
    const body = "---\nname: named-from-frontmatter\n---\n" + content;
    const id = withLegacyImportedSkillWriter(service, () => service.addMemory(manual({ content: body, title: undefined }))).id;
    expect(row(db, id).info.title).toBe("---");
    const renamed = service.addMemory(manual({ content: body, title: "Explicit replacement" }));
    expect(renamed.id).not.toBe(id);
    expect(row(db, id).info.title).toBe("---");
    expect(row(db, renamed.id).info.title).toBe("Explicit replacement");
  });

});

 describe("round8 cold and legacy collision contracts", () => {
  it.each(["reactivate", "delete", "search"])("keeps a cold manual row independent through %s", async entry => {
    const { db, service } = setup();
    const id = legacyManual(service).id;
    const repos = new Repositories(db.db);
    repos.runtime.setKv(agentSkillConnectionKey("hermes"), "disconnected");
    if (entry === "reactivate") {
      repos.memories.archive(id, "2026-05-01T00:00:00.000Z");
      service.reactivateSkill(id, { namespace });
      expect(row(db, id).memoryValue).toBe(content);
    } else if (entry === "delete") {
      service.deleteMemory(id, { namespace });
      expect(row(db, id).properties.internal_info.deleted_current).toBeUndefined();
    } else {
      const session = service.openSession({ namespace });
      const result = await service.search({ sessionId: session.sessionId, query: "deploymentquartz", layers: ["Skill"], limit: 5 });
      expect(result.hits.map(hit => hit.id)).toContain(id);
      expect(result.hits.find(hit => hit.id === id)?.readOnly).not.toBe(true);
      expect(result.hits.find(hit => hit.id === id)?.sourceAgentId).toBeUndefined();
    }
  });
  it.each(["missing", "v2", "deleted-manual", "disconnected", "missing-delete"])("preserves collision facts across %s and repeated migration", kind => {
    const { db, service } = setup();
    const request = directory();
    const observation = { sourceSkillId: "release-check", sourceSkillPath: request.sourceSkillPath!, title: "release-check",
      content: request.content, contentHash: "original-file", modifiedAt: "2026-01-01T00:00:00.000Z" };
    const file = service.reconcileAgentSkills({ namespace, sourceAgentId: "hermes", complete: true, skills: [observation] }).skills[0]!.memoryId!;
    const tool = legacyManual(service, { turnId: "release-check" }).id;
    const repos = new Repositories(db.db);
    if (kind === "deleted-manual") repos.memories.softDelete(tool, "2026-05-01T00:00:00.000Z");
    if (kind === "disconnected" || kind === "missing-delete") {
      const old = row(db, tool);
      repos.memories.updateMaintenance({ ...old, status: "archived", properties: { ...old.properties, status: "archived",
        internal_info: { ...old.properties.internal_info, archive_reason: kind === "disconnected" ? "disconnected" : "source_missing" } } });
      if (kind === "missing-delete") service.deleteMemory(file, { namespace });
    }
    service.reconcileWorkerStartup(1);
    service.reconcileWorkerStartup(1);
    if (kind === "disconnected") {
      expect(repos.runtime.getKv(agentSkillConnectionKey("hermes"))?.value).toBe("disconnected");
      service.reconcileAgentSkills({ namespace, sourceAgentId: "hermes", complete: true, skills: [observation] });
      expect(row(db, file).memoryValue).toBe("");
    } else if (kind === "missing-delete") {
      expect(row(db, file).properties.internal_info.deleted_current).toBe(false);
      const next = service.reconcileAgentSkills({ namespace, sourceAgentId: "hermes", complete: true, skills: [{ ...observation, content: request.content + " V2" }] });
      expect(next.skills[0]?.outcome).toBe("created");
    } else if (kind === "deleted-manual") {
      expect(row(db, tool)).toMatchObject({ status: "deleted", properties: { internal_info: { read_only: false } } });
      const next = service.reconcileAgentSkills({ namespace, sourceAgentId: "hermes", complete: true, skills: [observation] });
      expect(next.skills[0]?.outcome).not.toBe("deleted_by_user");
      expect(row(db, file).status).toBe("activated");
    } else {
      service.reconcileAgentSkills({ namespace, sourceAgentId: "hermes", complete: true, skills: kind === "missing" ? [] : [{ ...observation, content: request.content + " V2" }] });
      expect(row(db, file).memoryValue).toBe(request.content);
      expect(row(db, file).properties.internal_info.archive_reason).toBe(kind === "missing" ? "source_missing" : "superseded");
    }
  });
});

describe("round8 migration transaction and visibility", () => {
  it("does not seed a ghost installation from a cold deleted manual", async () => {
    const { db, service } = setup();
    const real = service.addMemory(directory({ source: "cursor", sourceAgentId: "cursor", namespace: { ...namespace, source: "cursor" } })).id;
    const deleted = legacyManual(service).id;
    const repos = new Repositories(db.db);
    repos.memories.softDelete(deleted, "2026-05-01T00:00:00.000Z");
    expect(repos.memories.legacyInstalledSkillsForAgent("hermes").skills).toEqual([]);
    const session = service.openSession({ namespace });
    const found = await service.search({ sessionId: session.sessionId, query: "deploymentquartz", layers: ["Skill"], limit: 5 });
    expect(found.hits.map(hit => hit.id)).toContain(real);
  });
  it("rolls back detachment and connection facts when collision repair fails", () => {
    const { db, service } = setup();
    const file = service.addMemory(directory()).id;
    const manualId = legacyManual(service, { turnId: "release-check" }).id;
    const repos = new Repositories(db.db);
    const original = row(db, manualId);
    repos.memories.updateMaintenance({ ...original, status: "archived", properties: { ...original.properties, status: "archived",
      internal_info: { ...original.properties.internal_info, archive_reason: "disconnected" } } });
    const before = row(db, manualId);
    db.db.exec(`CREATE TRIGGER fail_collision BEFORE UPDATE ON memories WHEN OLD.id = '${file}' BEGIN SELECT RAISE(ABORT, 'injected collision failure'); END`);
    expect(() => service.reconcileAgentSkills({ namespace, sourceAgentId: "hermes", complete: false, skills: [] })).toThrow("injected collision failure");
    expect(row(db, manualId)).toEqual(before);
    expect(repos.runtime.getKv(agentSkillConnectionKey("hermes"))).toBeUndefined();
    db.db.exec("DROP TRIGGER fail_collision");
    service.reconcileWorkerStartup(1);
    expect(row(db, manualId).properties.internal_info.read_only).toBe(false);
    expect(repos.runtime.getKv(agentSkillConnectionKey("hermes"))?.value).toBe("disconnected");
  });
  it.each(["present", "source_missing", "disconnected", "invocation_policy", "policy_unknown"])("preserves body only when collision source restriction is %s", restriction => {
    const { db, service } = setup();
    const file = service.addMemory(directory()).id;
    legacyManual(service, { turnId: "release-check" });
    const repos = new Repositories(db.db);
    const old = row(db, file);
    repos.memories.updateMaintenance({ ...old, properties: { ...old.properties,
      internal_info: { ...old.properties.internal_info, source_state: restriction } } });
    service.reconcileWorkerStartup(1);
    const result = row(db, file);
    expect(result.memoryValue).toBe(["present", "source_missing"].includes(restriction) ? directory().content : "");
    expect(result.status).toBe("archived");
    expect(repos.memories.hasVector(file, "vec")).toBe(false);
  });
});

describe("round8 durable batched migration", () => {
  it("repairs mixed live/deleted rows in batches and remains stable after reopening SQLite", async () => {
    const { db, service, root } = setup();
    const repos = new Repositories(db.db);
    const ids: string[] = [];
    for (let n = 0; n < 6; n++) {
      // Interleave genuine rows with manuals, including modern-marked misclassifications.
      service.addMemory(directory({ sourceAgentId: `source-${n}`, sourceSkillId: `file-${n}` }));
      const id = legacyManual(service, { title: `manual-${n}`, content: content + n }).id;
      ids.push(id);
      if (n % 2 === 1) repos.memories.softDelete(id, "2026-05-01T00:00:00.000Z");
    }
    service.reconcileWorkerStartup(1);
    const after = ids.map(id => row(db, id));
    expect(after.map(memory => memory.properties.internal_info.read_only)).toEqual(ids.map(() => false));
    expect(after.map(memory => memory.status)).toEqual(["activated", "deleted", "activated", "deleted", "activated", "deleted"]);
    await service.stop();
    db.close();
    const reopenedDb = new MemoryDb({ path: join(root, "memory.sqlite") });
    const reopened = fixture.createTestMemoryService({ db: reopenedDb, mode: "dev", llm: createFailingLlm() });
    reopened.reconcileWorkerStartup(1);
    const reopenedRepos = new Repositories(reopenedDb.db);
    for (const before of after) expect(reopenedRepos.memories.getIncludingDeleted(before.id)).toEqual(before);
  });
  it("keeps collision bytes unavailable for retrieval and embedding until a source scan", async () => {
    const { db, service } = setup();
    const file = service.addMemory(directory()).id;
    legacyManual(service, { turnId: "release-check", content: "A distinct manual procedure." });
    service.reconcileWorkerStartup(1);
    await runWorkerRounds(service, 2, 30);
    expect(row(db, file)).toMatchObject({ status: "archived", memoryValue: directory().content,
      properties: { internal_info: { archive_reason: "source_review_pending" } } });
    expect(new Repositories(db.db).memories.hasVector(file, "vec")).toBe(false);
    const session = service.openSession({ namespace: { ...namespace, source: "cursor" } });
    const result = await service.search({ sessionId: session.sessionId, query: "deploymentquartz", layers: ["Skill"], limit: 5 });
    expect(result.hits.map(hit => hit.id)).not.toContain(file);
  });
});

describe("anonymous legacy source ambiguity", () => {
  it("keeps an evidence-free old manual archive separate from a new explicit source observation", () => {
    const { db, service } = setup();
    const id = legacyManual(service).id;
    service.archiveMemory(id, { namespace });
    const observed = service.addMemory(manual({ sourceAgentId: "hermes" }));
    expect(observed.id).not.toBe(id);
    expect(row(db, id)).toMatchObject({ status: "archived", memoryValue: content });
    service.reconcileWorkerStartup(1);
    expect(row(db, id)).toMatchObject({ status: "archived", memoryValue: content, properties: { internal_info: { source_kind: "manual", read_only: false } } });
    expect(row(db, observed.id).properties.internal_info.source_kind).toBe("file");
  });
});

describe("round6 missing-scan evidence", () => {
  it("keeps a deleted missing version content-scoped when old supersession overwrote its reason", () => {
    const { db, service } = setup();
    const file = service.addMemory(directory()).id;
    service.reconcileAgentSkills({ namespace, sourceAgentId: "hermes", complete: true, skills: [] });
    const tool = legacyManual(service, { turnId: "release-check" }).id;
    const repos = new Repositories(db.db);
    const old = row(db, file);
    // The round6 supersede writer overwrote the prior missing reason; its
    // complete empty installation inventory is still the independent fact.
    repos.memories.updateMaintenance({ ...old, properties: { ...old.properties, internal_info: {
      ...old.properties.internal_info, archive_reason: "superseded", superseded_by_skill_id: tool,
      source_state: undefined
    } } });
    service.deleteMemory(file, { namespace });
    expect(row(db, file).properties.internal_info.deleted_current).toBe(false);
    service.reconcileWorkerStartup(1);
    expect(row(db, file).properties.internal_info.deleted_current).toBe(false);
    const next = service.addMemory(directory({ content: directory().content + " New bytes." }));
    expect(next.status).toBe("activated");
  });
});

describe("collision policy evidence", () => {
  it.each(["disabled invocation", "implicit invocation disabled", "malformed metadata"])("strips genuine file bytes with %s even after supersession replaced its reason", policy => {
    const { db, service } = setup();
    const file = service.addMemory(directory()).id;
    legacyManual(service, { turnId: "release-check" });
    const repos = new Repositories(db.db);
    const old = row(db, file);
    repos.memories.updateMaintenance({ ...old, properties: { ...old.properties, internal_info: {
      ...old.properties.internal_info,
      ...(policy === "malformed metadata" ? { frontmatter_error: "Malformed source YAML" }
        : { invocation: policy === "disabled invocation" ? { disable_model_invocation: true } : { allow_implicit_invocation: false } })
    } } });
    service.reconcileWorkerStartup(1);
    expect(row(db, file).memoryValue).toBe("");
    expect(row(db, file).properties.internal_info.archive_reason).toBe(policy === "malformed metadata" ? "policy_unknown" : "invocation_policy");
  });
});
