import { afterEach, describe, expect, it } from "vitest";
import { DEFAULT_MEMMY_CONFIG, type LlmClient } from "../../../src/index.js";
import type { LlmMessage, LlmCompletionOptions } from "../../../src/model/types.js";
import type { MemoryRow } from "../../../src/types.js";
import { Repositories } from "../../../src/storage/repositories.js";
import { stableHash } from "../../../src/utils/id.js";
import { externalSkillGeneration } from "../../../src/service/evidence/history-skill-policy.js";
import { createCapturingEmbedder, createMemoryServiceFixture, runWorkerRounds } from "../../fixtures/memory-service-fixture.js";

const { createTestService, cleanup } = createMemoryServiceFixture();
afterEach(cleanup);
const namespace = { source: "memmy", profileId: "default", userId: "automatic-history-user", tenantId: "tenant-a" };
const ids = ["2026-10-09T10-00-00Z-10min-summary", "2026-10-09T10-10-00Z-10min-summary"];
const revision = "2026-10-09T10:20:00.000Z";
const evidence = { action: "upsert" as const, source: "computer_history", namespace, sourceRecordId: ids[0]!, revision,
  title: "Release review", summary: "Release note review had outstanding changes at the time observed.",
  content: "Release note review had outstanding changes at the time observed.",
  provenance: { summarySource: "model_narrated_computer_history", summaryFactCheck: "not_independently_verified" },
  startedAt: "2026-10-09T10:00:00.000Z", endedAt: "2026-10-09T10:10:00.000Z" };
const actions = ["Open the release draft", "Review the release changes", "Record the outstanding issue", "Save the revised draft"]
  .map((text, index) => ({ sourceRecordId: ids[index < 2 ? 0 : 1]!, text }));
const draft = { create: true, name: "review_release", summary: "Review a release note and record changes.",
  trigger: "When reviewing a release note", selectedActionIds: ["a1", "a2", "a3", "a4"] };

function observationModel(): LlmClient {
  return { config: DEFAULT_MEMMY_CONFIG.summary, isConfigured: () => true,
    complete: async () => "", status: () => ({ provider: "test", configured: true, remote: false }),
    async completeJson<T extends Record<string, unknown>>(messages: LlmMessage[]) {
      const source = (JSON.parse(messages[1]!.content) as { sources: Array<{ id: string; content: string }> }).sources[0]!;
      return { keep: true, title: "Release review context", summary: source.content,
        items: [{ category: "context", text: source.content, source_memory_id: source.id, evidence_quote: source.content }] } as unknown as T;
    } };
}
function skillModel(generate: () => unknown = () => draft): LlmClient {
  return { ...observationModel(), async completeJson<T extends Record<string, unknown>>(_messages: LlmMessage[], _options: LlmCompletionOptions) {
    return generate() as T;
  } };
}
type Service = ReturnType<typeof createTestService>["service"];
async function seed(service: Service, source = "computer_history", groupId = "release-workflow", content = evidence.content) {
  for (const id of ids) service.syncExternalEvidence({ ...evidence, source, sourceRecordId: id, summary: content, content });
  await runWorkerRounds(service, 2);
  return { source, namespace, groupId, revision, sourceRecordIds: ids, actions };
}
function legacyCandidate(template: MemoryRow, id: string): MemoryRow {
  const origin = template.properties.internal_info.external_evidence_candidate as Record<string, unknown>;
  const { activation_mode: _mode, activated_at: _at, generated_content_hash: _hash, content_generation: _generation, ...oldOrigin } = origin;
  const skill = template.properties.internal_info.skill as Record<string, unknown>;
  const oldLine = "Observed computer workflow candidate; review before activation.";
  const value = template.memoryValue.replace("Procedure learned from observed actions; execution outcome is not verified.", oldLine);
  return { ...template, id, memoryKey: `${template.memoryKey}:${id}`, memoryValue: value, contentHash: stableHash(value),
    status: "resolving", version: 1, updatedAt: template.createdAt, info: { ...template.info, status: "candidate", eta: 0 },
    properties: { ...template.properties, status: "resolving", internal_info: { ...template.properties.internal_info,
      external_evidence_candidate: oldOrigin, skill: { ...skill, status: "candidate", eta: 0, invocation_guide: value } } } };
}

describe("automatic History Skill lifecycle", () => {
  it.each([
    { app: "zh-CN", mode: "follow_policy", expected: "zh-CN" },
    { app: "en-US", mode: "follow_policy", expected: "en-US" },
    { app: "ja-JP", mode: "follow_policy", expected: "ja-JP" },
    { app: "zh-CN", mode: "en", expected: "en-US" },
    { app: "en-US", mode: "zh", expected: "zh-CN" },
    { app: "ja-JP", mode: "en", expected: "en-US" },
    { app: "ja-JP", mode: "zh", expected: "zh-CN" },
    { app: undefined, mode: "follow_policy", expected: "en-US" },
    { app: undefined, mode: "follow_policy", expected: "zh-CN", content: "发布说明仍有待修改的项目，需要核实后再保存。" },
  ] as const)("reuses the service Skill language policy for App $app, mode $mode and target $expected", async (item) => {
    const summaries: Record<string, string> = { "zh-CN": "根据观察整理的发布说明检查步骤，实际执行结果尚未验证。",
      "en-US": "Release review steps learned from observations; execution has not been verified.",
      "ja-JP": "観察から整理した操作手順です。実際の実行結果はまだ検証されていません。" };
    const triggers: Record<string, string> = { "zh-CN": "检查发布说明时", "en-US": "When reviewing release notes", "ja-JP": "リリースノートを確認するとき" };
    const requests: Array<{ language: string; system: string }> = [];
    const skillLlm: LlmClient = { ...observationModel(), async completeJson<T extends Record<string, unknown>>(messages: LlmMessage[]) {
      const { language } = JSON.parse(messages[1]!.content) as { language: string };
      requests.push({ language, system: messages[0]!.content });
      return { ...draft, summary: summaries[language], trigger: triggers[language] } as unknown as T;
    } };
    const { service, db } = createTestService({ llm: observationModel(), skillLlm, config: { ...DEFAULT_MEMMY_CONFIG,
      language: item.app, algorithm: { ...DEFAULT_MEMMY_CONFIG.algorithm,
        skill: { ...DEFAULT_MEMMY_CONFIG.algorithm.skill, outputLanguageMode: item.mode } } } });
    const result = await service.suggestExternalEvidenceSkill(await seed(service, "computer_history", "release-workflow",
      "content" in item ? item.content : undefined));
    expect(result.status).toBe("active");
    expect(requests).toHaveLength(1);
    expect(requests[0]!.language).toBe(item.expected);
    expect(requests[0]!.system).toContain(item.expected === "zh-CN" ? "All natural-language answers MUST be in Simplified Chinese"
      : item.expected === "en-US" ? "All natural-language answers MUST be in English" : "BCP 47 locale ja-JP");
    const saved = new Repositories(db.db).memories.get(result.id!)!;
    expect(saved.properties.internal_info.skill).toMatchObject({ procedure_json: { triggerContext: triggers[item.expected] },
      verification: { execution_verified: false } });
    expect(saved.memoryValue).toContain(triggers[item.expected]);
  });

  it("keeps each automatic Skill step linked to its observed source without copying action text into metadata", async () => {
    const { service, db } = createTestService({ llm: observationModel(),
      skillLlm: skillModel(() => ({ ...draft, selectedActionIds: ["a1", "a3", "a4"] })) });
    const result = await service.suggestExternalEvidenceSkill(await seed(service));
    expect(result.status).toBe("active");
    const repos = new Repositories(db.db);
    const saved = repos.memories.get(result.id!)!;
    const origin = saved.properties.internal_info.external_evidence_candidate as Record<string, unknown>;
    expect(origin.generatedStepSources).toEqual([
      { stepIndex: 0, actionId: "a1", actionIndex: 0, sourceRecordId: ids[0],
        sourceMemoryId: result.sourceMemoryIds![0], textHash: stableHash(actions[0]!.text) },
      { stepIndex: 1, actionId: "a3", actionIndex: 2, sourceRecordId: ids[1],
        sourceMemoryId: result.sourceMemoryIds![1], textHash: stableHash(actions[2]!.text) },
      { stepIndex: 2, actionId: "a4", actionIndex: 3, sourceRecordId: ids[1],
        sourceMemoryId: result.sourceMemoryIds![1], textHash: stableHash(actions[3]!.text) }
    ]);
    expect(JSON.stringify(origin.generatedStepSources)).not.toContain(actions[0]!.text);
    expect(repos.memories.get(result.sourceMemoryIds![0]!)?.properties.internal_info.external_evidence)
      .toMatchObject({ provenance: evidence.provenance });
    expect(repos.memories.get(result.sourceMemoryIds![0]!)?.properties.internal_info.observation_memory)
      .toMatchObject({ items: [expect.objectContaining({ source_memory_id: result.sourceMemoryIds![0], evidence_quote: evidence.content })] });
    expect(saved.properties.internal_info.skill).toMatchObject({ verification: {
      execution_verified: false, summaryFactCheck: "not_independently_verified"
    } });
  });

  it("keeps the summary fact-check status unknown for pre-marker History sources", async () => {
    const { service, db } = createTestService({ llm: observationModel(), skillLlm: skillModel() });
    const { provenance: _provenance, ...legacyEvidence } = evidence;
    for (const id of ids) service.syncExternalEvidence({ ...legacyEvidence, sourceRecordId: id });
    await runWorkerRounds(service, 2);
    const result = await service.suggestExternalEvidenceSkill({ source: "computer_history", namespace,
      groupId: "legacy-release-workflow", revision, sourceRecordIds: ids, actions });
    expect(new Repositories(db.db).memories.get(result.id!)?.properties.internal_info.skill)
      .toMatchObject({ verification: { execution_verified: false, summaryFactCheck: "unknown" } });
  });

  it.each(["zh-CN", "fr-FR"])("keeps an existing English candidate in English when activating after App language changes to %s", async (language) => {
    let config: typeof DEFAULT_MEMMY_CONFIG = { ...DEFAULT_MEMMY_CONFIG, language: "en-US" };
    let generated = 0;
    const { service, db } = createTestService({ config, configLoader: () => ({ config }), llm: observationModel(),
      skillLlm: skillModel(() => { generated++; return draft; }) });
    const repos = new Repositories(db.db);
    const result = await service.suggestExternalEvidenceSkill(await seed(service));
    const old = repos.memories.insert(legacyCandidate(repos.memories.get(result.id!)!, "legacy-english"));
    config = { ...config, language };
    service.reloadConfig({ restartFailedProcessing: false });
    service.reconcileWorkerStartup();
    const saved = repos.memories.get(old.id)!;
    const summary = "Procedure learned from observed actions; execution outcome is not verified.";
    expect(saved.status).toBe("activated");
    expect(saved.memoryValue).toBe(old.memoryValue.replace("Observed computer workflow candidate; review before activation.", summary));
    expect(saved.properties.internal_info.skill).toMatchObject({ procedure_json: { summary }, verification: { execution_verified: false } });
    expect(generated).toBe(1);
  });

  it("uses one locale snapshot for automatic Skill generation and its observed/unverified summary, without a translation call", async () => {
    let config: typeof DEFAULT_MEMMY_CONFIG = { ...DEFAULT_MEMMY_CONFIG, language: "ja-JP" };
    let entered!: () => void, release!: () => void;
    const started = new Promise<void>((resolve) => { entered = resolve; });
    const blocked = new Promise<void>((resolve) => { release = resolve; });
    const languages: string[] = [], prompts: string[] = [];
    const summaries: Record<string, string> = { "ja-JP": "観察から整理した操作手順です。実際の実行結果はまだ検証されていません。",
      "fr-FR": "Procédure tirée des observations ; son exécution réelle n’a pas été vérifiée." };
    const triggers: Record<string, string> = { "ja-JP": "リリースノートを確認するとき", "fr-FR": "Lors de la revue d’une note de version" };
    const skillLlm: LlmClient = { ...observationModel(), async completeJson<T extends Record<string, unknown>>(messages: LlmMessage[]) {
      const { language } = JSON.parse(messages[1]!.content) as { language: string };
      languages.push(language); prompts.push(messages[0]!.content);
      if (languages.length === 1) { entered(); await blocked; }
      return { ...draft, summary: summaries[language], trigger: triggers[language] } as unknown as T;
    } };
    const { service, db } = createTestService({ config, configLoader: () => ({ config }), llm: observationModel(), skillLlm });
    const suggestion = await seed(service);
    const first = service.suggestExternalEvidenceSkill(suggestion);
    await started;
    config = { ...config, language: "fr-FR" };
    service.reloadConfig({ restartFailedProcessing: false });
    release();
    const result = await first;
    const saved = new Repositories(db.db).memories.get(result.id!)!;
    expect(saved.memoryValue).toContain(summaries["ja-JP"]);
    expect(saved.memoryValue).toContain(triggers["ja-JP"]);
    expect(saved.memoryValue).not.toContain("Procedure learned from observed actions");
    expect(saved.properties.internal_info.skill).toMatchObject({ procedure_json: { summary: summaries["ja-JP"], triggerContext: triggers["ja-JP"] },
      verification: { execution_verified: false } });
    expect(prompts[0]).toContain("summary must explicitly say this procedure was learned from observations and its actual execution outcome has not been verified");
    expect(prompts[0]).toContain("preserving JSON keys, action IDs");
    const later = await service.suggestExternalEvidenceSkill({ ...suggestion, groupId: "later-localized-workflow" });
    expect(new Repositories(db.db).memories.get(later.id!)?.memoryValue).toContain(summaries["fr-FR"]);
    expect(languages).toEqual(["ja-JP", "fr-FR"]);
    // Existing guides keep their language; only the next generation changes.
    expect(new Repositories(db.db).memories.get(result.id!)?.memoryValue).toBe(saved.memoryValue);
  });

  it("keeps other producer Skills on their existing review workflow", async () => {
    const { service, db } = createTestService({ llm: observationModel(), skillLlm: skillModel() });
    const result = await service.suggestExternalEvidenceSkill(await seed(service, "custom_observer"));
    const repos = new Repositories(db.db);
    expect(result.status).toBe("candidate");
    service.reconcileWorkerStartup();
    expect(repos.memories.get(result.id!)?.status).toBe("resolving");
    expect(service.approveExternalEvidenceSkill(result.id!, { namespace }).status).toBe("activated");
  });

  it("skips mechanical window/page exposure and refuses model-selected nonsemantic or reordered steps", async () => {
    let calls = 0, response: unknown = draft;
    const { service } = createTestService({ llm: observationModel(), skillLlm: skillModel(() => { calls++; return response; }) });
    const suggestion = await seed(service);
    const mechanical = ["Activate Editor (`editor`) and verify its main content window is visible.",
      "Confirm the front browser page in Browser is now https://example.com before continuing.", "Switch windows", "View the page"]
      .map((text, index) => ({ sourceRecordId: ids[index < 2 ? 0 : 1]!, text }));
    expect(await service.suggestExternalEvidenceSkill({ ...suggestion, actions: mechanical })).toEqual({ status: "skipped", reason: "no_semantic_workflow_actions" });
    expect(calls).toBe(0);
    response = { ...draft, selectedActionIds: ["a1", "a2", "a3"] };
    expect(await service.suggestExternalEvidenceSkill({ ...suggestion, actions: [...mechanical.slice(0, 3), actions[3]!] }))
      .toEqual({ status: "skipped", reason: "ungrounded_workflow" });
    response = { ...draft, selectedActionIds: ["a2", "a1", "a3", "a4"] };
    expect(await service.suggestExternalEvidenceSkill(suggestion)).toEqual({ status: "skipped", reason: "ungrounded_workflow" });
    response = { create: false };
    expect(await service.suggestExternalEvidenceSkill(suggestion)).toEqual({ status: "skipped", reason: "no_coherent_workflow" });
  });

  it("automatically upgrades untouched legacy candidates without changing edited, rejected or deleted ones", async () => {
    const { service, db } = createTestService({ llm: observationModel(), skillLlm: skillModel() });
    const repos = new Repositories(db.db);
    const result = await service.suggestExternalEvidenceSkill(await seed(service));
    const template = repos.memories.get(result.id!)!;
    const untouched = repos.memories.insert(legacyCandidate(template, "legacy-untouched"));
    const edited = repos.memories.insert({ ...legacyCandidate(template, "legacy-edited"), version: 2,
      memoryValue: "Human changed this guide." });
    const rejected = repos.memories.insert({ ...legacyCandidate(template, "legacy-rejected"), status: "archived" });
    const deleted = repos.memories.insert(legacyCandidate(template, "legacy-deleted"));
    repos.memories.softDelete(deleted.id);
    service.reconcileWorkerStartup();
    expect(repos.memories.get(untouched.id)?.status).toBe("activated");
    expect(repos.memories.get(untouched.id)?.memoryValue).not.toContain("review before activation");
    expect(repos.memories.get(edited.id)?.status).toBe("resolving");
    expect(repos.memories.get(edited.id)?.memoryValue).toBe("Human changed this guide.");
    expect(repos.memories.get(rejected.id)?.status).toBe("archived");
    expect(repos.memories.get(deleted.id)).toBeUndefined();
    await runWorkerRounds(service, 2);
    expect(repos.memories.hasVector(untouched.id, "vec")).toBe(true);
  });

  it("preserves human edits through CAS, revisions and source changes, then revokes them on source deletion", async () => {
    const { service, db } = createTestService({ llm: observationModel(), skillLlm: skillModel() });
    const repos = new Repositories(db.db), suggestion = await seed(service);
    const result = await service.suggestExternalEvidenceSkill(suggestion);
    const original = repos.memories.get(result.id!)!;
    const body = '---\nname: review_release_revised\ndescription: >\n  Human revised release review\n  with a verification step.\n---\n\n# Revised release review\n\n### When to use\nWhen the current release is ready for review\n\n### Procedure\n1. Review the draft.\n2. Verify the current result.';
    const saved = service.updateExternalEvidenceSkill(original.id, { body, expectedVersion: original.version },
      { namespace: { ...namespace, userId: "other-user" } });
    expect(saved).toMatchObject({ status: "activated", version: original.version + 1 });
    expect(() => service.updateExternalEvidenceSkill(original.id, { body: "Stale write", expectedVersion: original.version }, { namespace }))
      .toThrow(/changed since editing/u);
    const current = repos.memories.get(original.id)!;
    expect(current.memoryValue).toBe(body);
    expect(current.info.title).toBe("review_release_revised");
    expect(current.info.summary).toContain("with a verification step.");
    expect(service.getSkill(current.id, { namespace }).invocationGuide).toBe(body);
    expect(service.getSkill(current.id, { namespace }).procedure).toEqual([body]);
    expect(current.properties.internal_info.external_evidence_candidate).toMatchObject({ human_modified: true, sourceMemoryIds: original.info.source_memory_ids });
    expect((current.properties.internal_info.external_evidence_candidate as Record<string, unknown>).generatedStepSources).toBeUndefined();
    expect(await service.suggestExternalEvidenceSkill(suggestion)).toMatchObject({ status: "active", id: original.id });
    service.reconcileWorkerStartup();
    expect(repos.memories.get(original.id)?.memoryValue).toBe(body);
    service.syncExternalEvidence({ ...evidence, revision: "2026-10-09T10:21:00.000Z" });
    expect(repos.memories.get(original.id)?.status).toBe("activated");
    service.syncExternalEvidence({ ...evidence, revision: "2026-10-09T10:22:00.000Z", content: `${evidence.content} A changed scope was observed.` });
    expect(repos.memories.get(original.id)?.status).toBe("archived");
    expect(repos.memories.get(original.id)?.memoryValue).toBe(body);
    expect(repos.memories.get(original.id)?.properties.internal_info.external_evidence_candidate).toMatchObject({ source_status: "changed", human_modified: true });
    await runWorkerRounds(service, 2);
    expect(await service.suggestExternalEvidenceSkill(suggestion)).toMatchObject({ status: "skipped", reason: "skill_archived" });
    const archived = repos.memories.get(original.id)!;
    service.updateExternalEvidenceSkill(original.id, { body, expectedVersion: archived.version }, { namespace });
    expect(repos.memories.get(original.id)?.status).toBe("activated");
    const sourceId = (original.info.source_memory_ids as string[])[0]!;
    service.deleteMemory(sourceId, { namespace });
    expect(repos.memories.get(original.id)).toBeUndefined();
  });

  it("allows an explicit human revision to finish an old unresolved History guide", async () => {
    const { service, db } = createTestService({ llm: observationModel(), skillLlm: skillModel() });
    const repos = new Repositories(db.db);
    const result = await service.suggestExternalEvidenceSkill(await seed(service));
    const legacy = repos.memories.insert({ ...legacyCandidate(repos.memories.get(result.id!)!, "legacy-human-revision"), version: 2 });
    service.reconcileWorkerStartup();
    expect(repos.memories.get(legacy.id)?.status).toBe("resolving");
    expect(service.updateExternalEvidenceSkill(legacy.id, { body: "# Review release\n\nA human revised guide.", expectedVersion: legacy.version }).status).toBe("activated");
  });

  it("does not apply an old leased embedding after an edit with identical body text", async () => {
    let entered!: () => void, release!: () => void;
    const started = new Promise<void>((resolve) => { entered = resolve; });
    const blocked = new Promise<void>((resolve) => { release = resolve; });
    let hold = true;
    const base = createCapturingEmbedder([]);
    const { service, db } = createTestService({ llm: observationModel(), skillLlm: skillModel(), embedder: {
      ...base, async embed(texts, role) { if (role === "query" && hold) { entered(); await blocked; } return base.embed(texts, role); }
    } });
    const repos = new Repositories(db.db);
    const result = await service.suggestExternalEvidenceSkill(await seed(service));
    const row = repos.memories.get(result.id!)!;
    const oldGeneration = externalSkillGeneration(row);
    const run = service.runWorkerOnce(1);
    await started;
    service.updateExternalEvidenceSkill(row.id, { body: row.memoryValue, expectedVersion: row.version }, { namespace });
    const pending = service.memoryProcessingStatus([row.id]).items[0]!;
    expect(externalSkillGeneration(repos.memories.get(row.id)!)).not.toBe(oldGeneration);
    release(); hold = false; await run;
    expect(service.memoryProcessingStatus([row.id]).items[0]).toMatchObject({ state: "embedding_pending", activeJobId: pending.activeJobId });
    expect(repos.memories.hasVector(row.id, "vec")).toBe(false);
    service.reconcileWorkerStartup();
    expect(service.memoryProcessingStatus([row.id]).items[0]?.activeJobId).toBe(pending.activeJobId);
    await runWorkerRounds(service, 2);
    expect(repos.memories.hasVector(row.id, "vec")).toBe(true);
    expect(service.memoryProcessingStatus([row.id]).items[0]?.state).toBe("ready");
  });

  it("does not let an upgraded legacy embedding failure overwrite the processing state of a later same-body edit", async () => {
    let entered!: () => void, rejectOld!: (error: Error) => void;
    const started = new Promise<void>((resolve) => { entered = resolve; });
    const blocked = new Promise<void>((_resolve, reject) => { rejectOld = reject; });
    let hold = false;
    const base = createCapturingEmbedder([]);
    const { service, db } = createTestService({ llm: observationModel(), skillLlm: skillModel(), embedder: {
      ...base, async embed(texts, role) { if (role === "query" && hold) { entered(); await blocked; } return base.embed(texts, role); }
    } });
    const repos = new Repositories(db.db);
    const result = await service.suggestExternalEvidenceSkill(await seed(service));
    await runWorkerRounds(service, 2);
    const legacy = repos.memories.insert({ ...legacyCandidate(repos.memories.get(result.id!)!, "legacy-approved-embedding"), version: 2 });
    service.approveExternalEvidenceSkill(legacy.id, { namespace });
    const approved = repos.memories.get(legacy.id)!;
    const oldJobId = service.memoryProcessingStatus([legacy.id]).items[0]!.activeJobId!;
    expect(externalSkillGeneration(approved)).toBeTypeOf("string");
    const oldPayload = db.db.prepare("SELECT payload_json FROM evolution_jobs WHERE id = ?").get(oldJobId) as { payload_json: string };
    expect(JSON.parse(oldPayload.payload_json).externalSkillGeneration).toBe(externalSkillGeneration(approved));

    // Reproduce a durable embedding leased from an approved Skill saved before generations existed.
    db.db.prepare("UPDATE memories SET properties_json = json_remove(properties_json, '$.internal_info.external_evidence_candidate.content_generation') WHERE id = ?").run(legacy.id);
    db.db.prepare("UPDATE evolution_jobs SET payload_json = json_remove(payload_json, '$.externalSkillGeneration') WHERE id = ?").run(oldJobId);
    hold = true;
    const run = service.runWorkerOnce(1);
    await started;
    service.updateExternalEvidenceSkill(legacy.id, { body: approved.memoryValue, expectedVersion: approved.version }, { namespace });
    const pending = service.memoryProcessingStatus([legacy.id]).items[0]!;
    expect(pending.activeJobId).not.toBe(oldJobId);
    rejectOld(new Error("legacy embedding unavailable")); hold = false; await run;
    expect(service.memoryProcessingStatus([legacy.id]).items[0]).toMatchObject({
      state: "embedding_pending", activeJobId: pending.activeJobId, errorCode: pending.errorCode, failedAt: pending.failedAt
    });
    expect(repos.memories.hasVector(legacy.id, "vec")).toBe(false);
    await runWorkerRounds(service, 2);
    expect(repos.memories.hasVector(legacy.id, "vec")).toBe(true);
    expect(service.memoryProcessingStatus([legacy.id]).items[0]?.state).toBe("ready");
  });
});
