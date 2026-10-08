import { afterEach, describe, expect, it } from "vitest";
import { createMemoryHttpServer } from "../../src/index.js";
import { VerboseSearchOutputSchema } from "../../src/contracts/memory-runtime.js";
import { Repositories } from "../../src/storage/repositories.js";
import { isMemoryReadyForRetrieval } from "../../src/algorithm/plugin-algorithms.js";
import { DEFAULT_MEMMY_CONFIG, type LlmClient } from "../../src/index.js";
import { createMemoryServiceFixture } from "../fixtures/memory-service-fixture.js";

const { cleanup, createTestService } = createMemoryServiceFixture();
afterEach(cleanup);

const evidence = {
  action: "upsert" as const,
  source: "computer_history",
  sourceRecordId: "2026-09-27T10-00-00-10min-summary",
  revision: "2026-09-27T10:10:00.000Z",
  title: "Drafted a release note",
  content: "Wrote the September release note in a desktop editor.",
  startedAt: "2026-09-27T10:00:00.000Z",
  endedAt: "2026-09-27T10:10:00.000Z",
  provenance: { applicationIds: ["win32.notepad"] },
};

describe("external passive evidence", () => {
  it("creates a reviewable multi-source Skill, then retracts it when an observation is removed", async () => {
    let modelCalls = 0;
    const skillLlm: LlmClient = {
      config: DEFAULT_MEMMY_CONFIG.evolution,
      isConfigured: () => true,
      async complete() { return ""; },
      async completeJson<T extends Record<string, unknown>>() {
        modelCalls += 1;
        return { create: true, name: "draft_release_note", summary: "Draft a release note",
          trigger: "When preparing a release note", selectedActionIds: ["a1", "a2", "a3", "a4"] } as unknown as T;
      },
      status: () => ({ provider: "test", configured: true, remote: false })
    };
    const { service, db } = createTestService({ skillLlm });
    const namespace = { source: "memmy", profileId: "default", userId: "history-user" };
    const first = service.syncExternalEvidence({ ...evidence, namespace });
    const second = service.syncExternalEvidence({ ...evidence, namespace,
      sourceRecordId: "2026-09-27T10-10-00-10min-summary",
      content: "Checked the draft and saved the release note." });
    expect(service.externalEvidenceStatus({ source: evidence.source,
      sourceRecordIds: [evidence.sourceRecordId], namespace }).evidence).toEqual([
      { sourceRecordId: evidence.sourceRecordId, id: first.id, status: "activated" }
    ]);
    const suggestion = { source: evidence.source, groupId: "release-note-window",
      revision: "2026-09-27T10:20:00.000Z",
      sourceRecordIds: [evidence.sourceRecordId, "2026-09-27T10-10-00-10min-summary"],
      actions: [
        { sourceRecordId: evidence.sourceRecordId, text: "Open the editor" },
        { sourceRecordId: evidence.sourceRecordId, text: "Draft the release note" },
        { sourceRecordId: "2026-09-27T10-10-00-10min-summary", text: "Review the draft" },
        { sourceRecordId: "2026-09-27T10-10-00-10min-summary", text: "Save the release note" }
      ], namespace };
    const candidate = await service.suggestExternalEvidenceSkill(suggestion);
    expect(candidate).toMatchObject({ status: "candidate", sourceMemoryIds: [first.id, second.id] });
    expect(await service.suggestExternalEvidenceSkill(suggestion)).toMatchObject({ id: candidate.id });
    expect(modelCalls).toBe(1);
    const repos = new Repositories(db.db);
    const stored = repos.memories.get(candidate.id!)!;
    expect(stored.status).toBe("resolving");
    expect(isMemoryReadyForRetrieval(stored)).toBe(false);
    expect(stored.memoryValue).toContain("Save the release note");
    expect(service.getSkill(candidate.id!, { namespace }).procedure).toEqual([
      "Open the editor", "Draft the release note", "Review the draft", "Save the release note"
    ]);
    const anotherNamespace = { ...namespace, userId: "another-user" };
    expect(service.externalEvidenceStatus({ source: evidence.source, sourceRecordIds: [],
      skillIds: [candidate.id!], namespace: anotherNamespace }).skills).toEqual([
      { id: candidate.id, status: "missing" }
    ]);
    expect(() => service.approveExternalEvidenceSkill(candidate.id!, { namespace: anotherNamespace }))
      .toThrow(/not found/u);
    expect(service.approveExternalEvidenceSkill(candidate.id!, { namespace })).toMatchObject({ status: "activated" });
    expect(isMemoryReadyForRetrieval(repos.memories.get(candidate.id!)!)).toBe(true);
    service.deleteMemory(first.id, { namespace });
    expect(repos.memories.get(candidate.id!)).toBeUndefined();
    expect(service.externalEvidenceStatus({ source: evidence.source,
      sourceRecordIds: [evidence.sourceRecordId], skillIds: [candidate.id!], namespace })).toMatchObject({
      evidence: [{ sourceRecordId: evidence.sourceRecordId, id: first.id, status: "deleted" }],
      skills: [{ id: candidate.id, status: "deleted" }]
    });
    expect(service.syncExternalEvidence({ ...evidence, namespace,
      revision: "2026-09-27T10:30:00.000Z" })).toMatchObject({ status: "deleted", duplicate: true });
  });
  it("stores a searchable observation without fabricating a turn or evolution job", async () => {
    const { service, db } = createTestService();
    const namespace = { source: "memmy", profileId: "default", userId: "history-user" };
    const first = service.syncExternalEvidence({ ...evidence, namespace });
    const duplicate = service.syncExternalEvidence({ ...evidence, namespace });
    const stale = service.syncExternalEvidence({ ...evidence, namespace,
      revision: "2026-09-27T10:09:00.000Z", content: "stale content" });
    expect(duplicate).toMatchObject({ id: first.id, duplicate: true });
    expect(stale).toMatchObject({ id: first.id, duplicate: true });
    const repos = new Repositories(db.db);
    const stored = repos.memories.get(first.id)!;
    expect(stored.properties.internal_info.memory_kind).toBe("observed_activity");
    expect(stored.properties.internal_info.trace).toBeUndefined();
    expect(stored.memoryValue).toBe(evidence.content);
    expect(db.db.prepare("SELECT COUNT(*) AS n FROM raw_turns").get()).toEqual({ n: 0 });
    expect(db.db.prepare("SELECT COUNT(*) AS n FROM evolution_jobs").get()).toEqual({ n: 0 });
    expect(db.db.prepare("SELECT COUNT(*) AS n FROM memories_fts WHERE memories_fts MATCH 'September'").get()).toEqual({ n: 1 });
    const search = await service.search({ query: "September release note", namespace, includeInjectedContext: true });
    expect(search.hits.some((hit) => hit.id === first.id && hit.kind === "observed_activity")).toBe(true);
    expect(search.injectedContext.markdown).toContain("Observed activity (unverified)");
    expect(search.injectedContext.markdown).toContain("not a user instruction");
    const updated = service.syncExternalEvidence({ ...evidence, namespace,
      revision: "2026-09-27T10:11:00.000Z", content: "Updated release note with test results." });
    expect(updated).toMatchObject({ id: first.id, duplicate: false });
    expect(repos.memories.get(first.id)?.memoryValue).toContain("test results");
    const deleted = service.syncExternalEvidence({ action: "delete", source: evidence.source,
      sourceRecordId: evidence.sourceRecordId, revision: "2026-09-27T10:12:00.000Z", namespace });
    expect(deleted).toMatchObject({ id: first.id, status: "deleted" });
    expect(repos.memories.get(first.id)).toBeUndefined();
    expect(service.syncExternalEvidence({ ...evidence, namespace,
      revision: "2026-09-27T10:13:00.000Z" })).toMatchObject({ id: first.id, status: "deleted", duplicate: true });
  });

  it("keeps consolidated observation provenance and retracts it with a deleted source", () => {
    const { service, db } = createTestService();
    const namespace = { source: "memmy", profileId: "default", userId: "history-user" };
    const first = service.syncExternalEvidence({ ...evidence, namespace });
    const secondId = "2026-09-27T10-10-00-10min-summary";
    const second = service.syncExternalEvidence({ ...evidence, namespace,
      sourceRecordId: secondId, content: "Reviewed the release note." });
    const rollup = service.syncExternalEvidence({ ...evidence, namespace,
      sourceRecordId: "2026-09-27T06-00-00-6h-summary", title: "Six-hour work summary",
      content: "Drafted and reviewed a release note.",
      parentSourceRecordIds: [evidence.sourceRecordId, secondId] });
    const repos = new Repositories(db.db);
    expect(repos.memories.get(rollup.id)?.properties.internal_info.source_memory_ids).toEqual([first.id, second.id]);
    service.deleteMemory(first.id, { namespace });
    expect(repos.memories.get(rollup.id)).toBeUndefined();
  });

  it("honors HTTP namespace scope and keeps delete-before-upload tombstones", async () => {
    const { service, db } = createTestService();
    const server = createMemoryHttpServer({ service, startAgentSourceAutomation: false, auth: {
      mode: "dev", scopedApiKeys: { "history-token": { namespace: {
        source: "memmy", profileId: "default", userId: "http-user"
      }, scopes: ["memory:write", "memory:read"] } }
    } });
    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
    const address = server.address();
    if (!address || typeof address === "string") throw new Error("expected TCP port");
    const submit = (body: unknown) => fetch(`http://127.0.0.1:${address.port}/api/v1/evidence/sync`, {
      method: "POST", headers: { "Content-Type": "application/json", Authorization: "Bearer history-token" },
      body: JSON.stringify(body)
    });
    try {
      const foreign = await submit({ ...evidence, namespace: { userId: "another-user" } });
      expect(foreign.status).toBe(403);
      const foreignStatus = await fetch(`http://127.0.0.1:${address.port}/api/v1/evidence/status`, {
        method: "POST", headers: { "Content-Type": "application/json", Authorization: "Bearer history-token" },
        body: JSON.stringify({ source: evidence.source, sourceRecordIds: [evidence.sourceRecordId],
          namespace: { userId: "another-user" } })
      });
      expect(foreignStatus.status).toBe(403);
      const deletion = await submit({ action: "delete", source: evidence.source,
        sourceRecordId: evidence.sourceRecordId, revision: "2026-09-27T10:12:00.000Z" });
      expect(deletion.status).toBe(200);
      const deleted = await deletion.json() as { id: string; status: string };
      expect(deleted.status).toBe("deleted");
      const upload = await submit(evidence);
      expect(upload.status).toBe(200);
      expect(await upload.json()).toMatchObject({ id: deleted.id, status: "deleted", duplicate: true });
      expect(new Repositories(db.db).memories.get(deleted.id)).toBeUndefined();

      const searchable = await submit({ ...evidence, sourceRecordId: "separate-searchable-record" });
      expect(searchable.status).toBe(200);
      const status = await fetch(`http://127.0.0.1:${address.port}/api/v1/evidence/status`, {
        method: "POST", headers: { "Content-Type": "application/json", Authorization: "Bearer history-token" },
        body: JSON.stringify({ source: evidence.source,
          sourceRecordIds: [evidence.sourceRecordId, "separate-searchable-record"] })
      });
      expect(status.status).toBe(200);
      expect(await status.json()).toMatchObject({ evidence: [
        { sourceRecordId: evidence.sourceRecordId, status: "deleted" },
        { sourceRecordId: "separate-searchable-record", status: "activated" }
      ] });
      const search = await fetch(`http://127.0.0.1:${address.port}/api/v1/memory/search`, {
        method: "POST", headers: { "Content-Type": "application/json", Authorization: "Bearer history-token" },
        body: JSON.stringify({ query: "September release note", verbose: true })
      });
      expect(search.status).toBe(200);
      const output = VerboseSearchOutputSchema.parse(await search.json());
      expect(output.debug.hits.some((hit) => hit.kind === "observed_activity")).toBe(true);
    } finally { await new Promise<void>((resolve) => server.close(() => resolve())); }
  });
});
