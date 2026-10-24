import { afterEach, describe, expect, it } from "vitest";
import { get_encoding } from "tiktoken";
import { DEFAULT_MEMMY_CONFIG, type LlmClient } from "../../../src/index.js";
import type { LlmCompletionOptions, LlmMessage } from "../../../src/model/types.js";
import { Repositories } from "../../../src/storage/repositories.js";
import { observationMemoryState } from "../../../src/service/observation-memory-state.js";
import { createMemoryServiceFixture, runWorkerRounds } from "../../fixtures/memory-service-fixture.js";

const { cleanup, createTestService } = createMemoryServiceFixture();
afterEach(cleanup);
const namespace = { source: "memmy", profileId: "default", userId: "validation-test-user" };
const evidence = {
  action: "upsert" as const, source: "computer_history", namespace,
  sourceRecordId: "2026-10-13T10-00-00-10min-summary", revision: "2026-10-13T10:10:00.000Z",
  title: "Approval review", summary: "Reviewed a pending approval.",
  content: "Recording hardware purchase is awaiting approval. PRIVATE_SOURCE_SENTINEL",
  startedAt: "2026-10-13T10:00:00.000Z", endedAt: "2026-10-13T10:10:00.000Z"
};
type Input = { sources: Array<{ id: string; content: string }> };
function grounded(input: Input) {
  return { keep: true, title: "Recording hardware approval", summary: "The hardware purchase is awaiting approval.",
    items: [{ category: "blocker", text: "The hardware purchase was awaiting approval at the time observed.",
      source_memory_id: input.sources[0]!.id, evidence_quote: "Recording hardware purchase is awaiting approval." }] };
}
function ungrounded(input: Input) {
  return { ...grounded(input), summary: "INVALID_OUTPUT_SENTINEL",
    items: [{ ...grounded(input).items[0]!, evidence_quote: "The purchase has already been approved." }] };
}
function model(generate: (input: Input, call: number, messages: LlmMessage[]) => unknown | Promise<unknown>) {
  const calls: LlmMessage[][] = [];
  const llm: LlmClient = {
    config: DEFAULT_MEMMY_CONFIG.summary, isConfigured: () => true,
    complete: async () => "", status: () => ({ provider: "test", configured: true, remote: false }),
    async completeJson<T extends Record<string, unknown>>(messages: LlmMessage[], options: LlmCompletionOptions): Promise<T> {
      expect(options).toMatchObject({ operation: "capture.observation_extract", temperature: 0,
        maxTokens: 2_400, retryTokenCeiling: 2_400 });
      calls.push(messages);
      return await generate(JSON.parse(messages[1]!.content) as Input, calls.length, messages) as T;
    }
  };
  return { llm, calls };
}

describe("observation validation correction", () => {
  it("saves the original Markdown span when the model drops bold presentation markers", async () => {
    const content = "- **业务时点**: 2026-10-22 开工前\n- **计划周**: 2026-10-19 — 2026-10-23";
    const quote = "业务时点: 2026-10-22 开工前\n- **计划周**: 2026-10-19 — 2026-10-23";
    const { llm, calls } = model((input) => ({ ...grounded(input), items: [{ ...grounded(input).items[0]!, evidence_quote: quote }] }));
    const { service, db } = createTestService({ llm });
    const row = service.syncExternalEvidence({ ...evidence, content });
    await runWorkerRounds(service, 2);
    const state = observationMemoryState(new Repositories(db.db).memories.get(row.id)!);
    expect(calls).toHaveLength(1);
    expect(state?.status).toBe("processed");
    const savedQuote = (state?.items as Array<{ evidence_quote: string }>)[0]!.evidence_quote;
    expect(savedQuote).toContain("**业务时点**:");
    expect(content).toContain(savedQuote);
    expect(savedQuote).not.toBe(quote);
    expect(service.memoryProcessingStatus([row.id]).items[0]?.state).toBe("ready");
  });

  it("does not expose generated metadata summaries as quoteable source content", async () => {
    const { llm, calls } = model(grounded);
    const { service, db } = createTestService({ llm });
    const sourceSummary = "METADATA_ONLY_SUMMARY_SENTINEL";
    const row = service.syncExternalEvidence({ ...evidence, summary: sourceSummary });
    await runWorkerRounds(service, 2);
    const input = JSON.parse(calls[0]![1]!.content) as Input;
    expect(input.sources[0]).not.toHaveProperty("summary");
    expect(calls[0]![1]!.content).not.toContain(sourceSummary);
    expect(new Repositories(db.db).memories.get(row.id)!.properties.internal_info.external_evidence)
      .toMatchObject({ source_summary: sourceSummary });
  });

  it("identifies the failing item without echoing its private quote or the prior output", async () => {
    const { llm, calls } = model((input, call) => call === 1
      ? { ...grounded(input), items: [grounded(input).items[0], ungrounded(input).items[0]] }
      : grounded(input));
    const { service } = createTestService({ llm });
    const row = service.syncExternalEvidence(evidence);
    await runWorkerRounds(service, 2);
    expect(calls).toHaveLength(2);
    const feedback = calls[1]![0]!.content.slice(calls[0]![0]!.content.length);
    expect(feedback).toContain("Item 2 failed.");
    expect(feedback).not.toContain("PRIVATE_SOURCE_SENTINEL");
    expect(feedback).not.toContain("already been approved");
    expect(feedback).not.toContain(row.id);
    expect(service.memoryProcessingStatus([row.id]).items[0]?.state).toBe("ready");
  });

  it("does not regenerate a valid first response", async () => {
    const { llm, calls } = model(grounded);
    const { service } = createTestService({ llm });
    const row = service.syncExternalEvidence(evidence);
    await runWorkerRounds(service, 2);
    expect(calls).toHaveLength(1);
    expect(service.memoryProcessingStatus([row.id]).items[0]?.state).toBe("ready");
  });

  it.each([
    ["semantic_json", () => null],
    ["semantic_fields", (input: Input) => ({ ...grounded(input), title: "" })],
    ["item_shape", (input: Input) => ({ ...grounded(input), items: ["invalid item"] })],
    ["item_fields", (input: Input) => ({ ...grounded(input), items: [{ ...grounded(input).items[0]!, category: "invented" }] })],
    ["source_id", (input: Input) => ({ ...grounded(input), items: [{ ...grounded(input).items[0]!, source_memory_id: "WRONG_SOURCE_ID_SENTINEL" }] })],
    ["quote_grounding", ungrounded]
  ] as const)("corrects %s once with the same sources and safe feedback", async (reason, invalid) => {
    const { llm, calls } = model((input, call) => call === 1 ? invalid(input) : grounded(input));
    const { service, db } = createTestService({ llm });
    const row = service.syncExternalEvidence(evidence);
    await runWorkerRounds(service, 2);
    expect(calls).toHaveLength(2);
    expect(calls[1]![1]).toEqual(calls[0]![1]);
    const feedback = calls[1]![0]!.content.slice(calls[0]![0]!.content.length);
    expect(feedback).toContain(`failed validation: ${reason}`);
    expect(feedback).toContain("original schema and exact source quotes");
    expect(feedback).not.toContain("PRIVATE_SOURCE_SENTINEL");
    expect(feedback).not.toContain("INVALID_OUTPUT_SENTINEL");
    expect(feedback).not.toContain("WRONG_SOURCE_ID_SENTINEL");
    expect(service.memoryProcessingStatus([row.id]).items[0]?.state).toBe("ready");
    const saved = new Repositories(db.db).memories.get(row.id)!;
    expect(observationMemoryState(saved)).toMatchObject({ status: "processed", items: grounded({ sources: [{ id: row.id, content: evidence.content }] }).items });
    expect(saved.memoryValue).not.toContain("INVALID_OUTPUT_SENTINEL");
  });

  it("leaves two invalid responses to the existing bounded worker retry without writing invalid items", async () => {
    const { llm, calls } = model(ungrounded);
    const { service, db } = createTestService({ llm });
    const row = service.syncExternalEvidence(evidence);
    expect((await service.runWorkerOnce(1)).failed).toBe(1);
    expect(calls).toHaveLength(2);
    expect(service.memoryProcessingStatus([row.id]).items[0]).toMatchObject({
      state: "summary_pending", errorCode: "processing_failed", attemptCount: 1,
      errorMessage: "observation extraction item is not grounded in its source (quote_grounding) [item 1]"
    });
    await runWorkerRounds(service, 2);
    expect(calls).toHaveLength(6);
    expect(service.memoryProcessingStatus([row.id]).items[0]).toMatchObject({ state: "failed", attemptCount: 3 });
    const repos = new Repositories(db.db);
    expect(observationMemoryState(repos.memories.get(row.id)!)).toMatchObject({ status: "pending" });
    expect(repos.memories.hasVector(row.id, "vec_summary")).toBe(false);
    expect((await service.search({ query: "already been approved", namespace })).hits).toEqual([]);
  });

  it("does not classify a provider failure as a correctable model response", async () => {
    const { llm, calls } = model(() => { throw new Error("503 provider unavailable"); });
    const { service } = createTestService({ llm });
    const row = service.syncExternalEvidence(evidence);
    expect((await service.runWorkerOnce(1)).failed).toBe(1);
    expect(calls).toHaveLength(1);
    expect(service.memoryProcessingStatus([row.id]).items[0]?.state).toBe("summary_pending");
  });

  it("keeps correction input and output within the summary client's fixed token limits", async () => {
    const longContent = `${evidence.content}\n${"观察到采购审批状态尚未确认，需核实后续进展。".repeat(800)}`.slice(0, 15_900);
    const { llm, calls } = model((input, call) => call === 1 ? ungrounded(input) : grounded(input));
    const { service } = createTestService({ llm });
    service.syncExternalEvidence({ ...evidence, content: longContent });
    await service.runWorkerOnce(1);
    expect(calls).toHaveLength(2);
    const encoder = get_encoding("cl100k_base");
    try {
      for (const messages of calls) {
        expect(messages.reduce((sum, message) => sum + encoder.encode(message.content, [], []).length, 0)).toBeLessThanOrEqual(5_280);
      }
    } finally { encoder.free(); }
  });

  it.each(["delete", "update"] as const)("does not save a correction after source %s", async (change) => {
    let release!: () => void, entered!: () => void;
    const started = new Promise<void>((resolve) => { entered = resolve; });
    const wait = new Promise<void>((resolve) => { release = resolve; });
    const { llm, calls } = model(async (input, call) => {
      if (call === 1) return ungrounded(input);
      entered(); await wait;
      return grounded(input);
    });
    const { service, db } = createTestService({ llm });
    const row = service.syncExternalEvidence(evidence);
    const run = service.runWorkerOnce(1);
    await started;
    const repos = new Repositories(db.db);
    let newerGeneration: unknown;
    try {
      if (change === "delete") service.deleteMemory(row.id, { namespace });
      else {
        service.syncExternalEvidence({ ...evidence, revision: "2026-10-13T10:12:00.000Z", content: "New source content replaces the previous approval context." });
        newerGeneration = observationMemoryState(repos.memories.get(row.id)!)?.generation;
      }
    } finally { release(); await run; }
    expect(calls).toHaveLength(2);
    if (change === "delete") expect(repos.memories.get(row.id)).toBeUndefined();
    else {
      const saved = repos.memories.get(row.id)!;
      expect(observationMemoryState(saved)).toMatchObject({ status: "pending", generation: newerGeneration });
      expect(saved.memoryValue).toBe("New source content replaces the previous approval context.");
      expect(saved.info.title).toBe(evidence.title);
    }
  });
});
