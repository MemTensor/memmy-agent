import { afterEach, describe, expect, it } from "vitest";
import { get_encoding } from "tiktoken";
import { DEFAULT_MEMMY_CONFIG, type LlmClient } from "../../../src/index.js";
import type { LlmMessage, LlmCompletionOptions } from "../../../src/model/types.js";
import { Repositories } from "../../../src/storage/repositories.js";
import { observationMemoryState } from "../../../src/service/observation-memory-state.js";
import { prepareObservationExtractionInput } from "../../../src/service/evidence/observation-memory-pipeline.js";
import { createCapturingEmbedder, createMemoryServiceFixture, runWorkerRounds } from "../../fixtures/memory-service-fixture.js";

const { cleanup, createTestService } = createMemoryServiceFixture();
afterEach(cleanup);
const namespace = { source: "memmy", profileId: "default", userId: "history-user" };
const evidence = {
  action: "upsert" as const, source: "computer_history", namespace,
  sourceRecordId: "2026-10-09T10-00-00-10min-summary", revision: "2026-10-09T10:10:00.000Z",
  title: "Task app housekeeping", summary: "Edited the procurement task.",
  content: "Recording hardware purchase is awaiting approval. WINDOW_SWITCH_ONLY_SENTINEL",
  startedAt: "2026-10-09T10:00:00.000Z", endedAt: "2026-10-09T10:10:00.000Z"
};
type Input = { aggregate: boolean; language?: string; sources: Array<{ id: string; content: string }> };
function model(generate: (input: Input) => unknown | Promise<unknown> = semantic): LlmClient {
  return { config: DEFAULT_MEMMY_CONFIG.summary, isConfigured: () => true,
    complete: async () => "", status: () => ({ provider: "test", configured: true, remote: false }),
    async completeJson<T extends Record<string, unknown>>(messages: LlmMessage[], options: LlmCompletionOptions) {
      if (options?.operation !== "capture.observation_extract") return {} as T;
      expect(options.retryTokenCeiling).toBe(2_400);
      return await generate(JSON.parse(String(messages[1]!.content)) as Input) as T;
    } };
}
function semantic(input: Input): unknown {
  const source = input.sources.find((item) => /purchase is awaiting approval/.test(item.content))!;
  const quote = source.content.includes("Recording hardware purchase is awaiting approval.") ? "Recording hardware purchase is awaiting approval." : "recording hardware purchase is awaiting approval.";
  return { keep: true, title: "Recording hardware procurement approval",
    summary: "Procurement approval is pending for the recording hardware purchase.",
    items: [{ category: "blocker", text: "The recording hardware purchase is awaiting approval.", evidence_quote: quote, source_memory_id: source.id }] };
}

function skillSuggestion(secondId: string) {
  return { source: evidence.source, namespace, groupId: "review-procurement", revision: evidence.revision,
    sourceRecordIds: [evidence.sourceRecordId, secondId], actions: [
      { sourceRecordId: evidence.sourceRecordId, text: "Open the procurement task list" },
      { sourceRecordId: evidence.sourceRecordId, text: "Find the hardware purchase task" },
      { sourceRecordId: secondId, text: "Check the approval status" },
      { sourceRecordId: secondId, text: "Record the pending approval follow-up" }
    ] };
}

describe("History meaningful-memory processing", () => {
  it.each([
    ["ja-JP", "録音機器の購入承認", "録音機器の購入承認は、観察時点ではまだ確認されていません。"],
    ["fr-FR", "Approbation du matériel audio", "L’approbation de cet achat n’était pas confirmée au moment observé."],
    ["zh-Hant-TW", "錄音設備採購審批", "觀察當時，錄音設備採購的審批狀態尚未確認。"],
  ])("extracts and indexes %s prose without injecting English category headings or changing evidence protocol", async (language, title, text) => {
    const languages: Array<string | undefined> = [], embedded: string[] = [];
    const { service, db } = createTestService({ config: { ...DEFAULT_MEMMY_CONFIG, language }, embedder: createCapturingEmbedder(embedded),
      llm: model((input) => {
        languages.push(input.language);
        return { keep: true, title, summary: text, items: [{ category: "blocker", text,
          evidence_quote: "Recording hardware purchase is awaiting approval.", source_memory_id: input.sources[0]!.id }] };
      }) });
    const row = service.syncExternalEvidence(evidence);
    await runWorkerRounds(service, 2);
    const saved = new Repositories(db.db).memories.get(row.id)!;
    expect(languages).toEqual([language]);
    expect(saved.info).toMatchObject({ title, summary: text });
    expect(saved.memoryValue).toBe(`# ${title}\n\n- ${text}`);
    expect(observationMemoryState(saved)).toMatchObject({ status: "processed", items: [{ category: "blocker", text,
      evidence_quote: "Recording hardware purchase is awaiting approval.", source_memory_id: row.id }] });
    expect(embedded.some((body) => body.includes(text))).toBe(true);
    expect(service.memoryProcessingStatus([row.id]).items[0]?.state).toBe("ready");
  });

  it.each([1, 37])("keeps %i long Chinese sources in complete JSON within the actual summary input budget", (sourceCount) => {
    const longChinese = "观察时录音硬件采购审批状态未确认，需核实采购单进度并保留报销凭据。".repeat(420);
    const sources = Array.from({ length: sourceCount }, (_value, index) => ({
      id: `observation_${index.toString().padStart(4, "0")}_0123456789abcdef`,
      title: `录音硬件采购与审批工作上下文第${index + 1}份记录`,
      summary: "观察到采购任务中的审批、购买和报销子任务，观察时未见完成证据。".repeat(35),
      content: `开始片段${index}：需核实录音硬件采购审批。${longChinese}结束片段${index}：报销前需核对采购凭据。`,
      revision: evidence.revision, contentHash: `source-hash-${index}`
    }));
    const prepared = prepareObservationExtractionInput({ language: "zh-CN", observedAt: evidence.startedAt,
      aggregate: sourceCount > 1, sources });
    const encoder = get_encoding("cl100k_base");
    try {
      expect(prepared.messages.reduce((total, message) => total + encoder.encode(message.content, [], []).length, 0)).toBeLessThanOrEqual(5_000);
    } finally { encoder.free(); }
    const payload = JSON.parse(prepared.messages[1]!.content) as { sources: Array<{ id: string; title: string; content: string; truncated: boolean }> };
    expect(payload.sources.map((source) => source.id)).toEqual(sources.map((source) => source.id));
    expect(payload.sources).toHaveLength(sourceCount);
    for (const source of payload.sources) {
      expect(source.title).not.toBe("");
      expect(source).not.toHaveProperty("summary");
      expect(source.content).not.toBe("");
      expect(source.content).not.toContain("\uFFFD");
      expect(source.truncated).toBe(true);
    }
    for (const [index, source] of prepared.sources.entries()) {
      expect(source.evidenceFragments).toHaveLength(2);
      for (const fragment of source.evidenceFragments!) expect(sources[index]!.content).toContain(fragment);
    }
  });

  it("rejects a quote fabricated by joining the two retained ends of long evidence", async () => {
    const longContent = "录音硬件采购申请需要核实审批状态，采购和报销子任务的完成状态尚未确认。".repeat(420);
    const { service } = createTestService({ llm: model((input) => {
      const source = input.sources[0]!;
      const [head, tail] = source.content.split("\n\n");
      expect(head).toBeTruthy(); expect(tail).toBeTruthy();
      return { keep: true, title: "拼接后的错误事实", summary: "该断言横跨被省略的原文。",
        items: [{ category: "context", text: "拼接断言不可作为连续证据。", source_memory_id: source.id,
          evidence_quote: `${head!.slice(-8)} ${tail!.slice(0, 8)}` }] };
    }) });
    const row = service.syncExternalEvidence({ ...evidence, content: longContent });
    expect((await service.runWorkerOnce(1)).failed).toBe(1);
    expect(service.memoryProcessingStatus([row.id]).items[0]?.errorMessage).toContain("not grounded");
    expect((await service.search({ query: "拼接断言", namespace })).hits).toEqual([]);
  });

  it.each(["...", "…", "……"])("accepts a quote shortened with %s inside one source line", async (ellipsis) => {
    const content = "系统弹出 codesign 想要访问钥匙串中「Mac Developer ID」密钥的授权框，要求输入登录钥匙串密码，你两次点击拒绝。\n签名流程未获授权。";
    const { service, db } = createTestService({ llm: model((input) => ({ keep: true, title: "代码签名授权受阻",
      summary: "代码签名请求钥匙串授权时被拒绝。", items: [{ category: "blocker", text: "代码签名请求钥匙串授权时被拒绝两次。",
        source_memory_id: input.sources[0]!.id, evidence_quote: `系统弹出 codesign 想要访问钥匙串中「Mac Developer ID」密钥的授权框${ellipsis}你两次点击拒绝` }] })) });
    const row = service.syncExternalEvidence({ ...evidence, content });
    await runWorkerRounds(service, 2);
    expect(observationMemoryState(new Repositories(db.db).memories.get(row.id)!)?.status).toBe("processed");
  });

  it("rejects an ellipsis that splices two separate source lines", async () => {
    const { service } = createTestService({ llm: model((input) => ({ keep: true, title: "方案结论", summary: "拼接出的结论。",
      items: [{ category: "decision", text: "A 方案已确认并被否决。", source_memory_id: input.sources[0]!.id, evidence_quote: "已确认 A 方案...B 方案被否决" }] })) });
    const row = service.syncExternalEvidence({ ...evidence, content: "已确认 A 方案可行。\nB 方案被否决。" });
    expect((await service.runWorkerOnce(1)).failed).toBe(1);
    expect(service.memoryProcessingStatus([row.id]).items[0]?.errorMessage).toContain("not grounded");
  });

  it("extracts reusable context and indexes the meaning while retaining raw provenance", async () => {
    const embedded: string[] = [];
    const { service, db } = createTestService({ llm: model(), embedder: createCapturingEmbedder(embedded),
      config: { ...DEFAULT_MEMMY_CONFIG, language: "en-US" } });
    const row = service.syncExternalEvidence(evidence);
    const repos = new Repositories(db.db);
    expect(service.memoryProcessingStatus([row.id]).items[0]?.state).toBe("summary_pending");
    expect((await service.search({ query: "Recording hardware", namespace })).hits).toEqual([]);
    expect(db.db.prepare("SELECT COUNT(*) AS n FROM raw_turns").get()).toEqual({ n: 0 });
    await runWorkerRounds(service, 2);
    const saved = repos.memories.get(row.id)!;
    expect(saved.info.title).toBe("Recording hardware procurement approval");
    expect(saved.info.summary).not.toBe(saved.info.title);
    expect(saved.memoryValue).toContain("## Blockers and open questions");
    expect(saved.memoryValue).not.toContain("WINDOW_SWITCH_ONLY_SENTINEL");
    expect(saved.properties.internal_info.external_evidence).toMatchObject({ source_content: evidence.content,
      source_title: evidence.title, source_summary: evidence.summary });
    expect(observationMemoryState(saved)).toMatchObject({ status: "processed", schema_version: 1 });
    expect(service.memoryProcessingStatus([row.id]).items[0]?.state).toBe("ready");
    expect(embedded.some((text) => text.includes("Procurement approval is pending"))).toBe(true);
    expect(embedded.some((text) => text.includes("WINDOW_SWITCH_ONLY_SENTINEL"))).toBe(false);
    expect(saved.createdAt).toBe(evidence.startedAt);
    expect((await service.search({ query: "procurement approval", namespace })).hits.some((hit) => hit.id === row.id)).toBe(true);
    const generation = observationMemoryState(saved)?.generation;
    service.syncExternalEvidence({ ...evidence, revision: "2026-10-09T10:11:00.000Z" });
    expect(observationMemoryState(repos.memories.get(row.id)!)?.generation).toBe(generation);
    expect(repos.memories.get(row.id)?.memoryValue).toBe(saved.memoryValue);
  });

  it("skips incidental activity without causing repeated source upload or recall", async () => {
    const { service, db } = createTestService({ llm: model(() => ({ keep: false, reason: "Only incidental window switching was observed." })) });
    const row = service.syncExternalEvidence(evidence);
    await runWorkerRounds(service, 2);
    const repos = new Repositories(db.db), saved = repos.memories.get(row.id)!;
    expect(saved.status).toBe("archived");
    expect(saved.memoryValue).toBe("");
    expect(observationMemoryState(saved)).toMatchObject({ status: "skipped", skip_reason: "Only incidental window switching was observed." });
    expect(service.externalEvidenceStatus({ source: evidence.source, sourceRecordIds: [evidence.sourceRecordId], namespace }).evidence[0]?.status).toBe("activated");
    expect(service.syncExternalEvidence(evidence).duplicate).toBe(true);
    expect((await service.search({ query: "Recording hardware", namespace })).hits).toEqual([]);
    expect(repos.memories.hasVector(row.id, "vec_summary")).toBe(false);
  });

  it("keeps an unconfigured model pending and supports completed text-only memory", async () => {
    let configured = false;
    const unconfigured = createTestService({ llm: { ...model(), isConfigured: () => configured } });
    const pending = unconfigured.service.syncExternalEvidence(evidence);
    const initial = unconfigured.service.memoryProcessingStatus([pending.id]).items[0]!;
    expect(initial).toMatchObject({ state: "summary_pending", retryAction: "open_settings", errorCode: "summary_model_unconfigured", attemptCount: 0 });
    await runWorkerRounds(unconfigured.service, 2);
    expect(unconfigured.service.memoryProcessingStatus([pending.id]).items[0]).toMatchObject({ state: "summary_pending", activeJobId: initial.activeJobId,
      retryAction: "open_settings", errorCode: "summary_model_unconfigured", attemptCount: 0 });
    expect((await unconfigured.service.search({ query: "Recording hardware", namespace })).hits).toEqual([]);
    expect(new Repositories(unconfigured.db.db).runtime.getJob(initial.activeJobId!)?.status).toBe("queued");
    configured = true;
    await runWorkerRounds(unconfigured.service, 2);
    expect(unconfigured.service.memoryProcessingStatus([pending.id]).items[0]).toMatchObject({ state: "ready", retryAction: "retry", errorCode: null, errorMessage: null });
    const { service } = createTestService({ llm: model(), config: { ...DEFAULT_MEMMY_CONFIG,
      algorithm: { ...DEFAULT_MEMMY_CONFIG.algorithm, capture: { ...DEFAULT_MEMMY_CONFIG.algorithm.capture, embedAfterCapture: false } } } });
    const row = service.syncExternalEvidence(evidence);
    await runWorkerRounds(service, 2);
    expect(service.memoryProcessingStatus([row.id]).items[0]?.state).toBe("ready_text_only");
    expect((await service.search({ query: "procurement approval", namespace })).hits.some((hit) => hit.id === row.id)).toBe(true);
  });

  it("reports a queued first attempt as waiting and only a recorded failure as an automatic retry", async () => {
    let available = false;
    const { service } = createTestService({ llm: model((input) => {
      if (!available) throw new Error("429 temporarily rate limited");
      return semantic(input);
    }) });
    const row = service.syncExternalEvidence(evidence);
    expect(service.memoryProcessingStatus([row.id]).items[0]).toMatchObject({ state: "summary_pending",
      errorCode: null, errorMessage: null, autoRetryScheduled: false });
    expect((await service.runWorkerOnce(1)).failed).toBe(1);
    expect(service.memoryProcessingStatus([row.id]).items[0]).toMatchObject({ state: "summary_pending",
      errorCode: "transient_provider_error", autoRetryScheduled: true });
    available = true;
    await runWorkerRounds(service, 2);
    expect(service.memoryProcessingStatus([row.id]).items[0]).toMatchObject({ state: "ready", autoRetryScheduled: false });
  });

  it("extracts a fresh History window before an older Agent-history backlog", async () => {
    const { service, db } = createTestService({ llm: model() });
    const session = service.openSession({ namespace: { ...namespace, source: "cursor" } });
    const backlog = Array.from({ length: 3 }, (_value, index) => service.completeTurn(`cursor-backfill-${index}`, {
      sessionId: session.sessionId, query: `Old Cursor question ${index}`, answer: `Old Cursor answer ${index}`
    }).l1MemoryId);
    const backdate = db.db.prepare("UPDATE memories SET created_at = ? WHERE id = ?");
    backlog.forEach((id, index) => backdate.run(`2026-08-18T0${index}:00:00.000Z`, id));
    const history = service.syncExternalEvidence(evidence);
    const run = await service.runWorkerOnce(1, { priorityCohortOnly: true });
    expect(run.jobs).toEqual([expect.objectContaining({ jobType: "observation_extract", targetMemoryId: history.id })]);
    expect(observationMemoryState(new Repositories(db.db).memories.get(history.id)!)?.status).toBe("processed");
  });

  it("marks an already queued observation when model configuration becomes unavailable", async () => {
    let configured = true;
    const { service } = createTestService({ llm: { ...model(), isConfigured: () => configured } });
    const row = service.syncExternalEvidence(evidence);
    const queuedJobId = service.memoryProcessingStatus([row.id]).items[0]?.activeJobId;
    configured = false;
    service.reconcileWorkerStartup();
    expect(service.memoryProcessingStatus([row.id]).items[0]).toMatchObject({ state: "summary_pending", activeJobId: queuedJobId,
      retryAction: "open_settings", errorCode: "summary_model_unconfigured", attemptCount: 0 });
    expect((await service.runWorkerOnce(1)).leased).toBe(0);
    configured = true;
    await runWorkerRounds(service, 2);
    expect(service.memoryProcessingStatus([row.id]).items[0]).toMatchObject({ state: "ready", errorCode: null, errorMessage: null });
  });

  it("startup repair selects the current generation even when old raw content hashes match", async () => {
    const { service, db } = createTestService({ llm: model() });
    const row = service.syncExternalEvidence(evidence);
    service.syncExternalEvidence({ ...evidence, title: "More specific procurement task", revision: "2026-10-09T10:11:00.000Z" });
    const before = service.memoryProcessingStatus([row.id]).items[0]!;
    service.reconcileWorkerStartup();
    expect(service.memoryProcessingStatus([row.id]).items[0]?.activeJobId).toBe(before.activeJobId);
    await runWorkerRounds(service, 3);
    expect(observationMemoryState(new Repositories(db.db).memories.get(row.id)!)?.status).toBe("processed");
    expect(service.memoryProcessingStatus([row.id]).items[0]?.state).toBe("ready");
  });

  it("rejects ungrounded output, then retries through the observation processor", async () => {
    let valid = false;
    const { service } = createTestService({ llm: model((input) => valid ? semantic(input) : {
      keep: true, title: "Invented result", summary: "Purchase is complete",
      items: [{ category: "progress", text: "The purchase is complete.", source_memory_id: input.sources[0]!.id, evidence_quote: "The purchase is complete." }]
    }) });
    const row = service.syncExternalEvidence(evidence);
    await runWorkerRounds(service, 3);
    expect(service.memoryProcessingStatus([row.id]).items[0]).toMatchObject({ state: "failed", stage: "summary" });
    valid = true;
    expect(service.retryMemoryProcessing(row.id, { namespace }).job?.jobType).toBe("observation_extract");
    await runWorkerRounds(service, 2);
    expect(service.memoryProcessingStatus([row.id]).items[0]?.state).toBe("ready");
  });

  it("cannot write an old extraction after the source was updated or deleted", async () => {
    let release!: () => void;
    let entered!: () => void;
    const started = new Promise<void>((resolve) => { entered = resolve; });
    const wait = new Promise<void>((resolve) => { release = resolve; });
    const { service, db } = createTestService({ llm: model(async (input) => { entered(); await wait; return semantic(input); }) });
    const row = service.syncExternalEvidence(evidence);
    const run = service.runWorkerOnce(1);
    await started;
    service.syncExternalEvidence({ ...evidence, revision: "2026-10-09T10:12:00.000Z",
      content: `${evidence.content} New constraint: reimbursement must wait.` });
    const repos = new Repositories(db.db);
    const newerGeneration = observationMemoryState(repos.memories.get(row.id)!)?.generation;
    release(); await run;
    expect(observationMemoryState(repos.memories.get(row.id)!)).toMatchObject({ status: "pending", generation: newerGeneration });
    await runWorkerRounds(service, 2);
    expect(observationMemoryState(repos.memories.get(row.id)!)?.status).toBe("processed");
    service.deleteMemory(row.id, { namespace });
    await runWorkerRounds(service, 2);
    expect(repos.memories.get(row.id)).toBeUndefined();
  });

  it("keeps each in-flight extraction on one language snapshot while reload affects later work", async () => {
    let config: typeof DEFAULT_MEMMY_CONFIG = { ...DEFAULT_MEMMY_CONFIG, language: "en-US" };
    let entered!: () => void, release!: () => void;
    const started = new Promise<void>((resolve) => { entered = resolve; });
    const blocked = new Promise<void>((resolve) => { release = resolve; });
    const languages: Array<string | undefined> = [];
    let first = true;
    const { service, db } = createTestService({ config, configLoader: () => ({ config }), llm: model(async (input) => {
      languages.push(input.language);
      if (first) { first = false; entered(); await blocked; }
      return semantic(input);
    }) });
    const row = service.syncExternalEvidence(evidence);
    const run = service.runWorkerOnce(1);
    await started;
    config = { ...config, language: "zh-CN" };
    service.reloadConfig({ restartFailedProcessing: false });
    release(); await run;
    const repos = new Repositories(db.db);
    expect(repos.memories.get(row.id)?.memoryValue).toContain("## Blockers and open questions");
    expect(repos.memories.get(row.id)?.memoryValue).not.toContain("## 阻碍与未决问题");
    const later = service.syncExternalEvidence({ ...evidence, sourceRecordId: "2026-10-09T10-10-00-10min-summary" });
    await runWorkerRounds(service, 2);
    expect(languages).toEqual(["en-US", "zh-CN"]);
    expect(repos.memories.get(later.id)?.memoryValue).toContain("## 阻碍与未决问题");
    expect(repos.memories.get(row.id)?.memoryValue).toContain("## Blockers and open questions");
  });

  it("consolidates processed parents and invalidates derived memory when a parent changes", async () => {
    const inputs: Input[] = [];
    const { service, db } = createTestService({ llm: model((input) => { inputs.push(input); return semantic(input); }) });
    const first = service.syncExternalEvidence(evidence);
    await runWorkerRounds(service, 2);
    const derived = service.syncExternalEvidence({ ...evidence, sourceRecordId: "2026-10-09T06-00-00-6h-summary",
      content: "Six hours of activity in the task app.", parentSourceRecordIds: [evidence.sourceRecordId] });
    await runWorkerRounds(service, 2);
    const aggregate = inputs.find((input) => input.aggregate)!;
    expect(aggregate.sources[1]?.content).toContain("The recording hardware purchase is awaiting approval.");
    expect(aggregate.sources[1]?.content).not.toContain("WINDOW_SWITCH_ONLY_SENTINEL");
    const repos = new Repositories(db.db);
    expect(observationMemoryState(repos.memories.get(derived.id)!)?.status).toBe("processed");
    service.syncExternalEvidence({ ...evidence, revision: "2026-10-09T10:20:00.000Z", content: `${evidence.content} New pending follow-up.` });
    expect(observationMemoryState(repos.memories.get(derived.id)!)?.status).toBe("pending");
    expect(repos.memories.hasVector(derived.id, "vec_summary")).toBe(false);
    await service.runWorkerOnce(10, { targetMemoryIds: [first.id] });
    await runWorkerRounds(service, 3);
    expect(observationMemoryState(repos.memories.get(derived.id)!)?.status).toBe("processed");
    service.deleteMemory(first.id, { namespace });
    expect(repos.memories.get(derived.id)).toBeUndefined();
  });

  it("keeps a newer embedding job independent when a revision produces the same semantic body", async () => {
    let release!: () => void, entered!: () => void, blocked = true;
    const started = new Promise<void>((resolve) => { entered = resolve; });
    const wait = new Promise<void>((resolve) => { release = resolve; });
    const base = createCapturingEmbedder([]);
    const embedder = { ...base, async embed(texts: string[], role?: "document" | "query") {
      if (blocked) { blocked = false; entered(); await wait; }
      return base.embed(texts, role);
    } };
    const { service, db } = createTestService({ llm: model(), embedder });
    const row = service.syncExternalEvidence(evidence);
    await service.runWorkerOnce(1);
    const oldEmbedding = service.runWorkerOnce(1);
    await started;
    service.syncExternalEvidence({ ...evidence, revision: "2026-10-09T10:12:00.000Z", content: `${evidence.content} Extra window switch.` });
    await service.runWorkerOnce(1);
    const jobs = db.db.prepare("SELECT id, status FROM evolution_jobs WHERE target_memory_id = ? AND job_type = 'embedding'").all(row.id) as Array<{ id: string; status: string }>;
    expect(jobs).toHaveLength(2);
    expect(new Set(jobs.map((job) => job.id)).size).toBe(2);
    const newerJob = jobs.find((job) => job.status === "queued")!;
    release(); await oldEmbedding;
    expect(service.memoryProcessingStatus([row.id]).items[0]).toMatchObject({ state: "embedding_pending", activeJobId: newerJob.id });
    await service.runWorkerOnce(1);
    expect(service.memoryProcessingStatus([row.id]).items[0]?.state).toBe("ready");
  });

  it("defers missing parents without consuming attempts and never revives a deleted parent", async () => {
    const { service, db } = createTestService({ llm: model() });
    const derived = service.syncExternalEvidence({ ...evidence, sourceRecordId: "2026-10-09T06-00-00-6h-summary",
      parentSourceRecordIds: [evidence.sourceRecordId] });
    await runWorkerRounds(service, 4);
    expect(db.db.prepare("SELECT status, attempts FROM evolution_jobs WHERE target_memory_id = ?").get(derived.id)).toEqual({ status: "queued", attempts: 0 });
    service.syncExternalEvidence({ action: "delete", source: evidence.source, sourceRecordId: evidence.sourceRecordId,
      revision: "2026-10-09T10:30:00.000Z", namespace });
    expect(new Repositories(db.db).memories.get(derived.id)).toBeUndefined();
    const late = service.syncExternalEvidence({ ...evidence, sourceRecordId: "2026-10-09T12-00-00-6h-summary",
      parentSourceRecordIds: [evidence.sourceRecordId] });
    expect(late.status).toBe("deleted");
    expect(service.syncExternalEvidence({ ...evidence, sourceRecordId: "2026-10-09T12-00-00-6h-summary",
      revision: "2026-10-09T11:00:00.000Z", parentSourceRecordIds: [evidence.sourceRecordId] }).status).toBe("deleted");
  });

  it("drains legacy backfill in bounded batches, preserving IDs and deletion decisions", async () => {
    const { service, db } = createTestService({ llm: model() });
    const repos = new Repositories(db.db), ids: string[] = [];
    for (let index = 0; index < 4; index++) {
      const row = service.syncExternalEvidence({ ...evidence, sourceRecordId: `legacy-history-${index}` });
      ids.push(row.id);
      const memory = repos.memories.get(row.id)!;
      const internal = { ...memory.properties.internal_info }; delete internal.observation_memory;
      repos.memories.update({ ...memory, properties: { ...memory.properties, internal_info: internal } });
    }
    db.db.prepare("DELETE FROM evolution_jobs").run();
    db.db.prepare("DELETE FROM memory_processing_state").run();
    service.deleteMemory(ids[3]!, { namespace });
    service.reconcileWorkerStartup(1);
    expect(db.db.prepare("SELECT COUNT(*) AS n FROM evolution_jobs").get()).toEqual({ n: 1 });
    await runWorkerRounds(service, 8, 1);
    for (const id of ids.slice(0, 3)) expect(observationMemoryState(repos.memories.get(id)!)?.status).toBe("processed");
    expect(repos.memories.get(ids[3]!)).toBeUndefined();
    expect(repos.memories.listUnprocessedObservations()).toEqual([]);
    const oldCount = (db.db.prepare("SELECT COUNT(*) AS n FROM evolution_jobs").get() as { n: number }).n;
    service.reconcileWorkerStartup(1);
    expect((db.db.prepare("SELECT COUNT(*) AS n FROM evolution_jobs").get() as { n: number }).n).toBe(oldCount);
  });

  it("automatically activates and indexes a useful Skill after meaningful processing", async () => {
    let skillCalls = 0, skillInput: Record<string, unknown> | undefined;
    const skillLlm: LlmClient = { ...model(),
      async completeJson<T extends Record<string, unknown>>(messages: LlmMessage[], _options: LlmCompletionOptions) {
        skillCalls++; skillInput = JSON.parse(messages[1]!.content) as Record<string, unknown>;
        return { create: true, name: "review_procurement", summary: "Review procurement approval", trigger: "When following up procurement",
          selectedActionIds: ["a1", "a2", "a3", "a4"] } as unknown as T;
      } };
    const { service, db } = createTestService({ llm: model(), skillLlm });
    const first = service.syncExternalEvidence(evidence);
    const secondId = "2026-10-09T10-10-00-10min-summary";
    service.syncExternalEvidence({ ...evidence, sourceRecordId: secondId });
    const suggestion = skillSuggestion(secondId);
    expect(await service.suggestExternalEvidenceSkill(suggestion)).toEqual({ status: "pending", reason: "source_memory_processing" });
    expect(skillCalls).toBe(0);
    await runWorkerRounds(service, 2);
    const candidate = await service.suggestExternalEvidenceSkill(suggestion);
    expect(candidate.status).toBe("active");
    expect(skillCalls).toBe(1);
    expect(JSON.stringify(skillInput?.meaningfulMemories)).toContain("The recording hardware purchase is awaiting approval.");
    expect(JSON.stringify(skillInput?.meaningfulMemories)).not.toContain("WINDOW_SWITCH_ONLY_SENTINEL");
    const repos = new Repositories(db.db);
    expect(repos.memories.get(candidate.id!)?.status).toBe("activated");
    expect(repos.memories.get(candidate.id!)?.properties.internal_info.external_evidence_candidate).toMatchObject({ activation_mode: "automatic_history" });
    expect(repos.memories.get(candidate.id!)?.properties.internal_info.skill).toMatchObject({ verification: { execution_verified: false } });
    expect(repos.memories.hasVector(candidate.id!, "vec")).toBe(false);
    await runWorkerRounds(service, 1);
    expect(repos.memories.hasVector(candidate.id!, "vec")).toBe(true);
    expect((await service.search({ query: "procurement approval", namespace, layers: ["Skill"] })).hits.some((hit) => hit.id === candidate.id)).toBe(true);
    expect(db.db.prepare("SELECT COUNT(*) AS n FROM skill_trials").get()).toEqual({ n: 0 });
    service.syncExternalEvidence({ ...evidence, revision: "2026-10-09T11:00:00.000Z", content: `${evidence.content} A new follow-up is visible.` });
    expect(repos.memories.get(candidate.id!)).toBeUndefined();
    expect(observationMemoryState(repos.memories.get(first.id)!)?.status).toBe("pending");
  });

  it("keeps Skill generation pending while a source is being summarized", async () => {
    let release!: () => void;
    let entered!: () => void;
    const started = new Promise<void>((resolve) => { entered = resolve; });
    const wait = new Promise<void>((resolve) => { release = resolve; });
    let skillCalls = 0;
    const { service } = createTestService({ llm: model(async (input) => { entered(); await wait; return semantic(input); }),
      skillLlm: model(() => { skillCalls++; return { create: true }; }) });
    const first = service.syncExternalEvidence(evidence);
    const secondId = "2026-10-09T10-10-00-10min-summary";
    service.syncExternalEvidence({ ...evidence, sourceRecordId: secondId });
    const run = service.runWorkerOnce(1);
    await started;
    try {
      expect(service.memoryProcessingStatus([first.id]).items[0]?.state).toBe("summarizing");
      expect(await service.suggestExternalEvidenceSkill(skillSuggestion(secondId)))
        .toEqual({ status: "pending", reason: "source_memory_processing" });
      expect(skillCalls).toBe(0);
    } finally {
      release();
      await run;
    }
  });

  it.each(["model_unconfigured", "automatic_retry", "failed"] as const)(
    "does not hide a source %s behind normal Skill processing", async (state) => {
      const configured = state !== "model_unconfigured";
      const { service } = createTestService({ llm: { ...model(() => { throw new Error("429 temporarily rate limited"); }),
        isConfigured: () => configured } });
      const first = service.syncExternalEvidence(evidence);
      const secondId = "2026-10-09T10-10-00-10min-summary";
      service.syncExternalEvidence({ ...evidence, sourceRecordId: secondId });
      if (state !== "model_unconfigured") await runWorkerRounds(service, state === "failed" ? 3 : 1);
      expect(service.memoryProcessingStatus([first.id]).items[0]).toMatchObject(state === "model_unconfigured"
        ? { state: "summary_pending", errorCode: "summary_model_unconfigured", retryAction: "open_settings" }
        : state === "automatic_retry" ? { state: "summary_pending", errorCode: "transient_provider_error" }
        : { state: "failed", errorCode: "transient_provider_error" });
      await expect(service.suggestExternalEvidenceSkill(skillSuggestion(secondId))).rejects.toMatchObject({
        code: "conflict", status: 409, message: state === "model_unconfigured"
          ? "source summary model is not configured" : "source meaningful memory requires retry"
      });
    }
  );

  it("generates the Skill after retrying a failed source without re-uploading ready sources", async () => {
    let available = false;
    let skillCalls = 0;
    let release!: () => void;
    let entered!: () => void;
    const started = new Promise<void>((resolve) => { entered = resolve; });
    const wait = new Promise<void>((resolve) => { release = resolve; });
    const { service } = createTestService({ llm: model(async (input) => {
      if (input.sources[0]!.content.includes("WINDOW_SWITCH_ONLY_SENTINEL")) {
        if (!available) throw new Error("observation extraction item is not grounded in its source");
        entered();
        await wait;
      }
      return semantic(input);
    }), skillLlm: { ...model(), async completeJson<T extends Record<string, unknown>>() {
      skillCalls++;
      return { create: true, name: "review_procurement", summary: "Review procurement approval", trigger: "When following up procurement",
        selectedActionIds: ["a1", "a2", "a3", "a4"] } as unknown as T;
    } } });
    const first = service.syncExternalEvidence(evidence);
    const secondId = "2026-10-09T10-10-00-10min-summary";
    const second = service.syncExternalEvidence({ ...evidence, sourceRecordId: secondId,
      content: evidence.content.replace("WINDOW_SWITCH_ONLY_SENTINEL", "") });
    const suggestion = skillSuggestion(secondId);
    await runWorkerRounds(service, 3);
    expect(service.memoryProcessingStatus([first.id, second.id]).items).toEqual([
      expect.objectContaining({ state: "failed", errorCode: "processing_failed", attemptCount: 3 }),
      expect.objectContaining({ state: "ready" })
    ]);
    await expect(service.suggestExternalEvidenceSkill(suggestion)).rejects.toMatchObject({
      code: "conflict", message: "source meaningful memory requires retry"
    });
    expect(skillCalls).toBe(0);
    available = true;
    expect(service.retryMemoryProcessing(first.id, { namespace })).toMatchObject({ accepted: true,
      processing: { state: "summary_pending", manualRetryCount: 1 }, job: { jobType: "observation_extract" } });
    expect(await service.suggestExternalEvidenceSkill(suggestion)).toEqual({ status: "pending", reason: "source_memory_processing" });
    const run = service.runWorkerOnce(1);
    await started;
    try {
      expect(service.memoryProcessingStatus([first.id]).items[0]).toMatchObject({ state: "summarizing", errorCode: "processing_failed" });
      expect(await service.suggestExternalEvidenceSkill(suggestion)).toEqual({ status: "pending", reason: "source_memory_processing" });
    } finally {
      release();
      await run;
    }
    await runWorkerRounds(service, 2);
    const result = await service.suggestExternalEvidenceSkill(suggestion);
    expect(result).toMatchObject({ status: "active" });
    expect(await service.suggestExternalEvidenceSkill(suggestion)).toMatchObject({ id: result.id, status: "active" });
    expect(skillCalls).toBe(1);
  });

  it("does not turn skipped incidental observations into Skills", async () => {
    let skillCalls = 0;
    const { service } = createTestService({ llm: model(() => ({ keep: false, reason: "No later-use work context." })),
      skillLlm: model(() => { skillCalls++; return { create: true }; }) });
    const secondId = "2026-10-09T10-10-00-10min-summary";
    service.syncExternalEvidence(evidence);
    service.syncExternalEvidence({ ...evidence, sourceRecordId: secondId });
    await runWorkerRounds(service, 2);
    const result = await service.suggestExternalEvidenceSkill({ source: evidence.source, namespace,
      groupId: "incidental", revision: evidence.revision, sourceRecordIds: [evidence.sourceRecordId, secondId],
      actions: Array.from({ length: 4 }, (_, index) => ({ sourceRecordId: index < 2 ? evidence.sourceRecordId : secondId, text: "Switch windows" })) });
    expect(result).toEqual({ status: "skipped", reason: "no_meaningful_source_memory" });
    expect(skillCalls).toBe(0);
  });
});
