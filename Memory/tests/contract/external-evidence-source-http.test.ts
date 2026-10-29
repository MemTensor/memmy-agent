import { afterEach, describe, expect, it } from "vitest";
import { createMemoryHttpServer, DEFAULT_MEMMY_CONFIG, type LlmClient } from "../../src/index.js";
import type { LlmMessage } from "../../src/model/types.js";
import { Repositories } from "../../src/storage/repositories.js";
import { createMemoryServiceFixture } from "../fixtures/memory-service-fixture.js";
import { lookupExternalEvidence, lookupExternalEvidenceSkill, externalEvidenceSourceMatchesMemory, externalEvidenceNamespaceForMemory } from "../../src/service/external-evidence-source.js";

const { cleanup, createTestService } = createMemoryServiceFixture();
afterEach(cleanup);
const namespace = { source: "memmy", profileId: "default", userId: "history-source-user" };
const record = {
  action: "upsert" as const, source: "computer_history",
  sourceRecordId: "2026-09-27T10-00-00Z-10min-summary",
  revision: "2026-09-27T10:10:00.000Z", title: "Release note",
  summary: "Reviewed the release note and recorded the remaining changes.",
  content: "# Release note\n\n## Memory summary\n\nReviewed the release note and recorded the remaining changes.",
  startedAt: "2026-09-27T10:00:00.000Z", endedAt: "2026-09-27T10:10:00.000Z",
  provenance: { historyId: "2026-09-27T10-00-00Z-10min-summary", applications: ["com.apple.TextEdit"] },
};

const skillDraft = { create: true, name: "review_release_note", summary: "Review a release note",
  trigger: "When reviewing release notes", selectedActionIds: ["a1", "a2", "a3", "a4"] };

function skillModel(completeJson: () => Promise<Record<string, unknown>>): LlmClient {
  return {
    config: DEFAULT_MEMMY_CONFIG.evolution, isConfigured: () => true,
    async complete() { return ""; },
    async completeJson<T extends Record<string, unknown>>() { return await completeJson() as T; },
    status: () => ({ provider: "test", configured: true, remote: false })
  };
}

function observationModel(): LlmClient {
  return {
    config: DEFAULT_MEMMY_CONFIG.summary, isConfigured: () => true,
    async complete() { return ""; },
    async completeJson<T extends Record<string, unknown>>(messages: LlmMessage[]) {
      const payload = JSON.parse(messages.find((message) => message.role === "user")!.content) as {
        sources: Array<{ id: string; content: string }>;
      };
      return { keep: true, title: "Release review context", summary: record.summary,
        items: [{ category: "context", text: record.summary, source_memory_id: payload.sources[0]!.id,
          evidence_quote: "Reviewed the release note and recorded the remaining changes." }] } as unknown as T;
    },
    status: () => ({ provider: "test", configured: true, remote: false })
  };
}

async function processSources(service: ReturnType<typeof createTestService>["service"]) {
  await service.runWorkerOnce(100);
  await service.runWorkerOnce(100);
}

async function seedSuggestion(service: ReturnType<typeof createTestService>["service"], scope: typeof namespace & { tenantId?: string } = namespace,
  process = true) {
  const secondId = "2026-09-27T10-10-00Z-10min-summary";
  service.syncExternalEvidence({ ...record, namespace: scope });
  service.syncExternalEvidence({ ...record, namespace: scope, sourceRecordId: secondId,
    provenance: { historyId: secondId } });
  if (process) await processSources(service);
  return { source: "computer_history", namespace: scope, groupId: "2026-09-27T06-00-00Z-6h-summary",
    revision: "2026-09-27T12:00:00.000Z", sourceRecordIds: [record.sourceRecordId, secondId],
    actions: [
      { sourceRecordId: record.sourceRecordId, text: "Open the draft" },
      { sourceRecordId: record.sourceRecordId, text: "Review the changes" },
      { sourceRecordId: secondId, text: "Record the outstanding issues" },
      { sourceRecordId: secondId, text: "Save the review" }
    ] };
}

async function withServer(
  service: ReturnType<typeof createTestService>["service"],
  run: (post: (route: string, body: unknown) => Promise<Response>) => Promise<void>
): Promise<void> {
  const server = createMemoryHttpServer({ service, startAgentSourceAutomation: false, auth: {
    mode: "dev", scopedApiKeys: { "history-source-token": { namespace, scopes: ["memory:write", "memory:read"] } }
  } });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const address = server.address();
  if (!address || typeof address === "string") throw new Error("expected TCP port");
  const post = (route: string, body: unknown) => fetch(`http://127.0.0.1:${address.port}/api/v1/${route}`, {
    method: "POST", headers: { "content-type": "application/json", authorization: "Bearer history-source-token" },
    body: JSON.stringify(body)
  });
  try { await run(post); }
  finally { await new Promise<void>((resolve) => server.close(() => resolve())); }
}

describe("external evidence producer identity over HTTP", () => {
  it("returns pending without creating a Skill until source memories are processed", async () => {
    let skillCalls = 0;
    const { service, db } = createTestService({ llm: observationModel(), skillLlm: skillModel(async () => {
      skillCalls++;
      return skillDraft;
    }) });
    const suggestion = await seedSuggestion(service, namespace, false);
    await withServer(service, async (post) => {
      const pending = await post("evidence/skills/suggest", suggestion);
      expect(pending.status).toBe(200);
      expect(await pending.json()).toEqual({ status: "pending", reason: "source_memory_processing" });
      expect(skillCalls).toBe(0);
      expect(db.db.prepare("SELECT COUNT(*) AS n FROM memories WHERE memory_layer = 'Skill'").get()).toEqual({ n: 0 });
      await processSources(service);
      const completed = await post("evidence/skills/suggest", suggestion);
      expect(completed.status).toBe(200);
      const result = await completed.json() as { id: string; status: string };
      expect(result).toMatchObject({ status: "active" });
      const duplicate = await post("evidence/skills/suggest", suggestion);
      expect(await duplicate.json()).toMatchObject({ id: result.id, status: "active" });
      expect(skillCalls).toBe(1);
    });
  });

  it.each(["unconfigured", "failed"] as const)("keeps %s source processing actionable over HTTP", async (state) => {
    const { service } = createTestService({ llm: { ...observationModel(), isConfigured: () => state !== "unconfigured",
      async completeJson() {
        throw new Error("observation extraction item is not grounded in its source");
      } } });
    const suggestion = await seedSuggestion(service, namespace, false);
    if (state === "failed") {
      for (let round = 0; round < 3; round++) await service.runWorkerOnce(100);
    }
    await withServer(service, async (post) => {
      const response = await post("evidence/skills/suggest", suggestion);
      expect(response.status).toBe(409);
      expect(await response.json()).toMatchObject({ error: { code: "conflict", message: state === "unconfigured"
        ? "source summary model is not configured" : "source meaningful memory requires retry" } });
    });
  });

  it("preserves producer source independently of authenticated namespace and separates producers", async () => {
    const { service, db } = createTestService();
    const repos = new Repositories(db.db);
    await withServer(service, async (post) => {
      const response = await post("evidence/sync", { ...record, namespace });
      expect(response.status).toBe(200);
      const saved = await response.json() as { id: string };
      const memory = repos.memories.get(saved.id)!;
      expect(memory.agentId).toBe("memmy");
      expect(memory.info.source).toBe("computer_history");
      expect(memory.properties.internal_info.external_evidence).toMatchObject({
        source: "computer_history", sourceRecordId: record.sourceRecordId, provenance: record.provenance
      });
      expect(memory.tags).toContain("computer_history");
      const otherResponse = await post("evidence/sync", { ...record, source: "browser_bookmark", namespace });
      expect(otherResponse.status).toBe(200);
      const other = await otherResponse.json() as { id: string };
      expect(other.id).not.toBe(saved.id);
      expect(repos.memories.get(other.id)?.info.source).toBe("browser_bookmark");
      const status = await post("evidence/status", { source: "computer_history", sourceRecordIds: [record.sourceRecordId], namespace });
      expect(await status.json()).toMatchObject({ evidence: [{ id: saved.id, status: "activated" }] });
      const forbidden = await post("evidence/sync", { ...record, namespace: { ...namespace, userId: "another-user" } });
      expect(forbidden.status).toBe(403);
    });
  });

  it("keeps legacy History IDs and tombstones after correcting producer source", async () => {
    const { service, db } = createTestService();
    const repos = new Repositories(db.db);
    const legacy = service.syncExternalEvidence({ ...record, source: "memmy", namespace });
    expect(lookupExternalEvidence(repos.memories, namespace, "computer_history", record.sourceRecordId).memory?.id)
      .toBe(legacy.id);
    await withServer(service, async (post) => {
      const status = await post("evidence/status", { source: "computer_history", sourceRecordIds: [record.sourceRecordId], namespace });
      expect(await status.json()).toMatchObject({ evidence: [{ id: legacy.id, status: "activated" }] });
      const newer = await post("evidence/sync", { ...record, namespace, revision: "2026-09-27T10:11:00.000Z" });
      expect(await newer.json()).toMatchObject({ id: legacy.id, status: "activated" });
      expect(repos.memories.get(legacy.id)?.properties.internal_info.external_evidence).toMatchObject({ source: "computer_history" });
      service.deleteMemory(legacy.id, { namespace });
      const retry = await post("evidence/sync", { ...record, namespace, revision: "2026-09-27T10:12:00.000Z" });
      expect(await retry.json()).toMatchObject({ id: legacy.id, status: "deleted", duplicate: true });
      expect(db.db.prepare("SELECT COUNT(*) AS n FROM memories WHERE memory_layer = 'L1'").get()).toEqual({ n: 1 });
      const deleted = await post("evidence/status", { source: "computer_history", sourceRecordIds: [record.sourceRecordId], namespace });
      expect(await deleted.json()).toMatchObject({ evidence: [{ id: legacy.id, status: "deleted" }] });
    });
  });

  it("honors legacy delete-before-upload tombstones and ignores unrelated legacy producer records", () => {
    const { service, db } = createTestService();
    const repos = new Repositories(db.db);
    const deletion = service.syncExternalEvidence({ action: "delete", source: "memmy", namespace,
      sourceRecordId: record.sourceRecordId, revision: record.revision });
    expect(lookupExternalEvidence(repos.memories, namespace, "computer_history", record.sourceRecordId).memory?.id)
      .toBe(deletion.id);
    const unrelated = service.syncExternalEvidence({ ...record, source: "memmy", namespace,
      sourceRecordId: "unrelated-resource", provenance: {} });
    expect(lookupExternalEvidence(repos.memories, namespace, "computer_history", "unrelated-resource").memory)
      .toBeUndefined();
    expect(repos.memories.get(unrelated.id)).toBeDefined();
    expect(externalEvidenceSourceMatchesMemory(repos.memories.get(unrelated.id)!, "computer_history")).toBe(false);
  });

  it("keeps legacy Skill candidate identity and removals after correcting producer source", async () => {
    const skillLlm: LlmClient = {
      config: DEFAULT_MEMMY_CONFIG.evolution, isConfigured: () => true,
      async complete() { return ""; },
      async completeJson<T extends Record<string, unknown>>() {
        return { create: true, name: "review_release_note", summary: "Review a release note", trigger: "When reviewing release notes",
          selectedActionIds: ["a1", "a2", "a3", "a4"] } as unknown as T;
      },
      status: () => ({ provider: "test", configured: true, remote: false })
    };
    const { service, db } = createTestService({ skillLlm, llm: observationModel() });
    const repos = new Repositories(db.db);
    service.syncExternalEvidence({ ...record, source: "memmy", namespace });
    const secondId = "2026-09-27T10-10-00Z-10min-summary";
    service.syncExternalEvidence({ ...record, source: "memmy", namespace, sourceRecordId: secondId,
      provenance: { historyId: secondId } });
    await processSources(service);
    const suggestion = { source: "memmy", namespace, groupId: "2026-09-27T06-00-00Z-6h-summary",
      revision: "2026-09-27T12:00:00.000Z", sourceRecordIds: [record.sourceRecordId, secondId],
      actions: [
        { sourceRecordId: record.sourceRecordId, text: "Open the draft" },
        { sourceRecordId: record.sourceRecordId, text: "Review the changes" },
        { sourceRecordId: secondId, text: "Record the outstanding issues" },
        { sourceRecordId: secondId, text: "Save the review" }
      ] };
    const legacy = await service.suggestExternalEvidenceSkill(suggestion);
    expect(legacy.status).toBe("active");
    expect(lookupExternalEvidenceSkill(repos.memories, namespace, "computer_history", suggestion.groupId, suggestion.revision).memory?.id)
      .toBe(legacy.id);
    for (const sourceRecordId of ["document-1", "document-2"]) {
      service.syncExternalEvidence({ ...record, source: "memmy", namespace, sourceRecordId, provenance: {} });
    }
    await processSources(service);
    const unrelatedSuggestion = { ...suggestion, groupId: "documents-workflow", sourceRecordIds: ["document-1", "document-2"],
      actions: suggestion.actions.map((action, index) => ({ ...action, sourceRecordId: index < 2 ? "document-1" : "document-2" })) };
    const unrelated = await service.suggestExternalEvidenceSkill(unrelatedSuggestion);
    expect(lookupExternalEvidenceSkill(repos.memories, namespace, "computer_history", unrelatedSuggestion.groupId,
      unrelatedSuggestion.revision).memory).toBeUndefined();
    expect(externalEvidenceSourceMatchesMemory(repos.memories.get(unrelated.id!)!, "computer_history")).toBe(false);
    await withServer(service, async (post) => {
      const retried = await post("evidence/skills/suggest", { ...suggestion, source: "computer_history" });
      expect(retried.status).toBe(200);
      expect(await retried.json()).toMatchObject({ id: legacy.id, status: "active" });
      const status = await post("evidence/status", { source: "computer_history", namespace,
        sourceRecordIds: [], skillIds: [legacy.id] });
      expect(await status.json()).toMatchObject({ skills: [{ id: legacy.id, status: "activated" }] });
      expect(db.db.prepare("SELECT COUNT(*) AS n FROM memories WHERE memory_layer = 'Skill'").get()).toEqual({ n: 2 });
      service.deleteMemory(legacy.id!, { namespace });
      const afterDeletion = await post("evidence/skills/suggest", { ...suggestion, source: "computer_history" });
      expect(await afterDeletion.json()).toMatchObject({ status: "skipped", reason: "candidate_removed" });
    });
  });

  it("isolates source updates, derived invalidation and deletions across tenants", () => {
    const { service, db } = createTestService();
    const repos = new Repositories(db.db);
    const scopeA = { ...namespace, tenantId: "tenant-a" };
    const scopeB = { ...namespace, tenantId: "tenant-b" };
    const sourceA = service.syncExternalEvidence({ ...record, namespace: scopeA });
    const sourceB = service.syncExternalEvidence({ ...record, namespace: scopeB });
    const aggregate = { ...record, sourceRecordId: "2026-09-27T06-00-00Z-6h-summary",
      parentSourceRecordIds: [record.sourceRecordId], provenance: {} };
    const aggregateA = service.syncExternalEvidence({ ...aggregate, namespace: scopeA });
    const aggregateB = service.syncExternalEvidence({ ...aggregate, namespace: scopeB });
    const generationA = repos.memories.get(aggregateA.id)!.properties.internal_info.observation_memory;
    const generationB = repos.memories.get(aggregateB.id)!.properties.internal_info.observation_memory;
    service.syncExternalEvidence({ ...record, namespace: scopeA, revision: "2026-09-27T10:11:00.000Z",
      content: `${record.content}\nThe remaining blocker is missing approval.` });
    expect(repos.memories.get(aggregateA.id)!.properties.internal_info.observation_memory).not.toEqual(generationA);
    expect(repos.memories.get(aggregateB.id)!.properties.internal_info.observation_memory).toEqual(generationB);
    expect(() => service.deleteMemory(sourceB.id, { namespace: scopeA })).toThrow(/different namespace/u);
    service.deleteMemory(sourceA.id, { namespace: scopeA });
    expect(repos.memories.getIncludingDeleted(aggregateA.id)?.status).toBe("deleted");
    expect(repos.memories.get(aggregateB.id)?.status).toBe("activated");
    expect(repos.memories.get(sourceB.id)?.status).toBe("activated");
    const tombstone = service.syncExternalEvidence({ action: "delete", source: "computer_history", namespace: scopeA,
      sourceRecordId: "2026-09-27T11-00-00Z-10min-summary", revision: record.revision });
    expect(externalEvidenceNamespaceForMemory(repos.memories.getIncludingDeleted(tombstone.id)!)).toMatchObject(scopeA);
  });

  it("keeps Skill review and status in the source tenant", async () => {
    const { service, db } = createTestService({ skillLlm: skillModel(async () => skillDraft), llm: observationModel() });
    const repos = new Repositories(db.db);
    const scopeA = { ...namespace, tenantId: "tenant-a" };
    const scopeB = { ...namespace, tenantId: "tenant-b" };
    const candidateA = await service.suggestExternalEvidenceSkill(await seedSuggestion(service, scopeA));
    const candidateB = await service.suggestExternalEvidenceSkill(await seedSuggestion(service, scopeB));
    expect(candidateB.id).not.toBe(candidateA.id);
    expect(service.externalEvidenceStatus({ source: "computer_history", namespace: scopeB,
      sourceRecordIds: [], skillIds: [candidateA.id!] }).skills).toEqual([{ id: candidateA.id, status: "missing" }]);
    expect(() => service.approveExternalEvidenceSkill(candidateA.id!, { namespace: scopeB })).toThrow(/not found/u);
    expect(repos.memories.get(candidateA.id!)?.status).toBe("activated");
    expect(service.externalEvidenceStatus({ source: "computer_history", namespace: scopeA,
      sourceRecordIds: [], skillIds: [candidateA.id!] }).skills).toEqual([{ id: candidateA.id, status: "activated" }]);
    const sourceA = lookupExternalEvidence(repos.memories, scopeA, "computer_history", record.sourceRecordId).memory!;
    service.deleteMemory(sourceA.id, { namespace: scopeA });
    expect(repos.memories.getIncludingDeleted(candidateA.id!)?.status).toBe("deleted");
    expect(repos.memories.get(candidateB.id!)?.status).toBe("activated");
  });

  it("lets the shared panel delete History retained under its original user ID after config changes", () => {
    const { service, db } = createTestService();
    const repos = new Repositories(db.db);
    const originalScope = { ...namespace, userId: "original-config-user" };
    const currentScope = { ...namespace, userId: "changed-config-user" };
    const source = service.syncExternalEvidence({ ...record, namespace: originalScope });
    const aggregate = service.syncExternalEvidence({ ...record, namespace: originalScope,
      sourceRecordId: "2026-09-27T06-00-00Z-6h-summary", parentSourceRecordIds: [record.sourceRecordId] });
    expect(service.panelItems({ namespace: currentScope, layer: "L1" }).items.map((item) => item.id)).toContain(source.id);
    expect(service.deleteMemory(source.id, { namespace: currentScope }).status).toBe("deleted");
    expect(repos.memories.getIncludingDeleted(aggregate.id)?.status).toBe("deleted");
    // The adapter still reconciles with its durable original namespace.
    expect(service.externalEvidenceStatus({ source: "computer_history", namespace: originalScope,
      sourceRecordIds: [record.sourceRecordId] }).evidence).toEqual([
      { sourceRecordId: record.sourceRecordId, id: source.id, status: "deleted" }
    ]);
  });

  it.each(["deleted", "activated"] as const)("respects a concurrent candidate that the user %s while a suggestion is in flight", async (decision) => {
    const resolvers: Array<(value: Record<string, unknown>) => void> = [];
    const { service, db } = createTestService({ skillLlm: skillModel(() => new Promise((resolve) => resolvers.push(resolve))), llm: observationModel() });
    const repos = new Repositories(db.db);
    const suggestion = await seedSuggestion(service);
    const first = service.suggestExternalEvidenceSkill(suggestion);
    const second = service.suggestExternalEvidenceSkill(suggestion);
    expect(resolvers).toHaveLength(2);
    resolvers[0]!(skillDraft);
    const candidate = await first;
    if (decision === "deleted") service.deleteMemory(candidate.id!, { namespace });
    else {
      const current = repos.memories.get(candidate.id!)!;
      service.updateExternalEvidenceSkill(current.id, { body: `${current.memoryValue}\n\nHuman revision.`, expectedVersion: current.version }, { namespace });
    }
    resolvers[1]!(skillDraft);
    const concurrentResult = await second;
    expect(concurrentResult).toMatchObject(decision === "deleted"
      ? { status: "skipped", reason: "candidate_removed" }
      : { status: "active", id: candidate.id });
    expect(repos.memories.getIncludingDeleted(candidate.id!)?.status).toBe(decision);
    expect(db.db.prepare("SELECT COUNT(*) AS n FROM memories WHERE memory_layer = 'Skill'").get()).toEqual({ n: 1 });
  });
});
