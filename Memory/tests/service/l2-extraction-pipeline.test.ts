import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { DEFAULT_MEMMY_CONFIG } from "../../src/config/index.js";
import type { Embedder, LlmClient } from "../../src/model/types.js";
import { MemoryDb } from "../../src/storage/db.js";
import { Repositories, type EvolutionJobRecord } from "../../src/storage/repositories.js";
import type { MemoryRow } from "../../src/types.js";
import { listL2Candidates, upsertL2Candidate } from "../../src/service/evolution/l2-candidate-service.js";
import { L2_EXTRACTION_SYSTEM_PROMPT, validateL2ExtractionResult } from "../../src/service/evolution/l2-extraction-contract.js";
import { UnifiedL2ExtractionPipeline, l2ComparisonText, cosineSimilarity } from "../../src/service/evolution/l2-extraction-pipeline.js";

const AT = "2026-10-28T00:00:00.000Z";
const lesson = { type: "check", title: "Check totals", applicability: "Before export", content: "Compare unrounded totals.", verification: "Recompute the sum.", exclusions: "" };

function row(id: string, layer: "L1" | "L2" = "L1"): MemoryRow {
  return { id, userId: "u", timeline: AT, memoryLayer: layer, memoryType: "LongTermMemory", status: "activated",
    visibility: "private", memoryValue: "Check unrounded totals before exporting.", tags: [], info: {}, version: 1, createdAt: AT, updatedAt: AT,
    properties: { internal_info: { memory_layer: layer, memory_kind: layer === "L1" ? "trace" : "policy",
      ...(layer === "L1" ? { trace: { episode_id: "e", userText: "Verify totals", agentText: "Found a mismatch",
        tool_calls: [{ name: "test", arguments: {}, result: "mismatch" }], value: -1, summary: "Export validation" } }
        : { policy: { title: "Totals", trigger: "Export", procedure: "Full procedure including unrounded totals", verification: "Full verification", boundary: "Full exclusions",
          experience_type: "failure_avoidance", evidence_polarity: "negative", status: "active", source_trace_ids: [] } }) } }
  };
}

describe("unified L2 strict operation contract", () => {
  it("accepts support plus a new increment from the same L1", () => {
    expect(validateL2ExtractionResult({ operations: [
      { operation: "support", l1_ids: ["l1"], target_l2: { id: "l2", version: 2 } },
      { operation: "create", l1_ids: ["l1"], new_l2: lesson }
    ] }, ["l1"], new Map([["l2", 2]]))).toHaveLength(2);
  });
  it.each([
    { operations: [] },
    { operations: [{ operation: "ignore", l1_ids: ["invented"] }] },
    { operations: [{ operation: "support", l1_ids: ["l1"], target_l2: { id: "l2", version: 1 } }] },
    { operations: [{ operation: "ignore", l1_ids: ["l1"], reason: "not allowed" }] },
    { operations: [{ operation: "support", l1_ids: ["l1"], target_l2: { id: "l2", version: 2 } },
      { operation: "refute", l1_ids: ["l1"], target_l2: { id: "l2", version: 2 } }] }
  ])("rejects omissions, invented IDs, stale targets, extra fields and conflicts", (output) => {
    expect(() => validateL2ExtractionResult(output, ["l1"], new Map([["l2", 2]]))).toThrow();
  });
});

describe("unified L2 extraction persistence", () => {
  let db: MemoryDb, repos: Repositories;
  let respond = vi.fn();
  let embed = vi.fn();
  let configured = true;
  let sequence = 0;
  let config = structuredClone(DEFAULT_MEMMY_CONFIG);
  const job = (): EvolutionJobRecord => ({ id: "job", jobType: "l2_induction", userId: "u", episodeId: "e",
    targetMemoryId: "l1", payload: {}, status: "leased", attempts: 1, maxAttempts: 3, createdAt: AT, updatedAt: AT });
  function pipeline(onPolicyRevised?: (policyId: string, at: string) => void) {
    return new UnifiedL2ExtractionPipeline({ repos, config, nowIso: () => AT,
      onPolicyRevised,
      skillLlm: { isConfigured: () => configured, completeJson: respond } as unknown as LlmClient,
      embedder: { config: { provider: "local", model: "fixture", batchSize: 16 }, embed } as unknown as Embedder,
      namespaceIdFromMemory: () => undefined,
      enqueueJob: vi.fn(() => job()),
      upsertEvolutionMemory: (memory) => repos.memories.upsertByKey(memory),
      buildMemory: (input) => ({ ...row(`new-${++sequence}`, "L2"), memoryKey: input.key as string,
        status: "resolving", memoryValue: input.value as string, info: input.info as Record<string, unknown>,
        properties: { internal_info: { memory_layer: "L2", memory_kind: "policy", ...(input.internal as object) } } })
    });
  }
  function admit(feedback = false) {
    repos.memories.insert(row("l1"));
    upsertL2Candidate(repos, { userId: "u", sourceMemoryId: "l1", route: feedback ? "feedback" : "negative", at: AT,
      ...(feedback ? { signal: { eventId: "feedback", route: "feedback" as const, text: "Check totals before export.",
        fallback: { ...lesson, type: "check" as const, applicability: [lesson.applicability], content: [lesson.content],
          verification: [lesson.verification], exclusions: [] } } } : {}) });
  }
  beforeEach(() => {
    db = new MemoryDb({ path: ":memory:" }); repos = new Repositories(db.db);
    respond = vi.fn(async () => ({ operations: [{ operation: "create", l1_ids: ["l1"], new_l2: lesson }] }));
    embed = vi.fn(async (texts: string[]) => texts.map(() => [1, 0]));
    configured = true; sequence = 0; config = structuredClone(DEFAULT_MEMMY_CONFIG);
    config.algorithm.capture.embedAfterCapture = false;
  });
  afterEach(() => db?.close());

  it("deduplicates identical documents without dropping candidates and reuses vectors after model failure", async () => {
    admit();
    for (const id of ["old-a", "old-b", "old-c"]) repos.memories.insert(row(id, "L2"));
    respond.mockRejectedValueOnce(new Error("temporary model failure"));
    await expect(pipeline().induce(job())).rejects.toThrow("temporary model failure");
    const firstInput = JSON.parse(respond.mock.calls[0]![0][2].content);
    expect(firstInput.HISTORICAL_L2_CANDIDATES.map((item: { id: string }) => item.id).sort())
      .toEqual(["old-a", "old-b", "old-c"]);
    const docs = embed.mock.calls.filter(call => call[1] === "document").flatMap(call => call[0]);
    expect(docs).toEqual([l2ComparisonText(row("old-a", "L2"))]);
    const calls = embed.mock.calls.length;
    respond.mockResolvedValue({ operations: [{ operation: "ignore", l1_ids: ["l1"] }] });
    await pipeline().induce(job());
    expect(embed).toHaveBeenCalledTimes(calls);
    expect(JSON.parse(respond.mock.calls[1]![0][2].content)).toEqual(firstInput);
  });

  it("preserves threshold, tie order and top-K with interleaved duplicate documents", async () => {
    admit();
    const cases = [
      ["a", "high", [1, 0]], ["b", "low", [0, 1]], ["c", "high", [1, 0]],
      ["d", "middle", [0.8, 0.6]], ["e", "edge", [0.6, 0.8]],
      ["f", "middle", [0.8, 0.6]], ["g", "negative", [-1, 0]]
    ] as const;
    config.algorithm.l2Induction.recallTopK = 3;
    config.algorithm.l2Induction.recallCosine = 0.6;
    const byTitle = new Map(cases.map(([, title, vector]) => [title as string, [...vector]]));
    for (const [id, title] of cases) {
      const memory = row(id, "L2");
      (memory.properties.internal_info.policy as Record<string, unknown>).title = title;
      repos.memories.insert(memory);
    }
    embed.mockImplementation(async (texts: string[], role: string) => texts.map(text =>
      role === "query" ? [1, 0] : byTitle.get(JSON.parse(text).title)!));
    respond.mockResolvedValue({ operations: [{ operation: "ignore", l1_ids: ["l1"] }] });
    await pipeline().induce(job());
    // Baseline: independently embed every record, including duplicates, then rank.
    const baseline = cases.map(([id, , vector]) => ({ id, score: cosineSimilarity([1, 0], [...vector]) }))
      .filter(item => item.score >= config.algorithm.l2Induction.recallCosine)
      .sort((a, b) => b.score - a.score || a.id.localeCompare(b.id)).slice(0, config.algorithm.l2Induction.recallTopK);
    const actual = JSON.parse(respond.mock.calls[0]![0][2].content).HISTORICAL_L2_CANDIDATES;
    expect(actual.map((item: { id: string }) => item.id)).toEqual(baseline.map(item => item.id));
    expect(embed.mock.calls.filter(call => call[1] === "document").flatMap(call => call[0])).toHaveLength(5);
  });

  it("models an empty recall set, admits negative-value L1, and commits only once", async () => {
    admit(); await pipeline().induce(job());
    const input = JSON.parse(respond.mock.calls[0]![0][2].content);
    expect(input.HISTORICAL_L2_CANDIDATES).toEqual([]);
    expect(input.L1_RECORDS[0].content).toBe("Export validation");
    expect(repos.memories.list({ memoryLayer: "L2" })).toHaveLength(1);
    expect(listL2Candidates(repos, { userId: "u", episodeId: "e" })).toHaveLength(0);
    await pipeline().induce(job());
    expect(respond).toHaveBeenCalledTimes(1);
    expect(repos.memories.list({ memoryLayer: "L2" })[0]!.info.status).toBe("candidate");
  });

  it.each([
    [undefined, "zh", "All natural-language answers MUST be in Simplified Chinese (zh-CN)."],
    [undefined, "en", "All natural-language answers MUST be in English."],
    ["en-US", "zh", "All natural-language answers MUST be in English."],
    ["zh-CN", "en", "All natural-language answers MUST be in Simplified Chinese (zh-CN)."],
    ["ja-JP", "en", "All natural-language answers MUST use the language, script, and regional conventions of BCP 47 locale ja-JP. Preserve JSON keys and machine identifiers."]
  ] as const)("uses original Memmy language steering (%s, dialogue %s)", async (language, dialogue, expected) => {
    config.language = language;
    const memory = row("l1");
    const trace = memory.properties.internal_info.trace as Record<string, unknown>;
    // Disagree with the summary and place Chinese beyond the packed user-text cap.
    trace.summary = dialogue === "zh" ? "English summary ".repeat(100) : "中文摘要".repeat(100);
    trace.userText = dialogue === "zh" ? "x".repeat(650) + "请核对合计与分项是否一致。".repeat(80) : "Verify the total against the component amounts.";
    trace.agentText = dialogue === "zh" ? "需要核对计量口径。".repeat(40) : "The total differs from the sum of its components.";
    trace.reflection = "RELATED";
    repos.memories.insert(memory);
    upsertL2Candidate(repos, { userId: "u", sourceMemoryId: "l1", route: "negative", at: AT });
    await pipeline().induce(job());
    const messages = respond.mock.calls[0]![0];
    expect(messages[1].content).toBe(expected);
    const packed = JSON.parse(messages[2].content).L1_RECORDS[0];
    expect(packed.user_text.length).toBeLessThanOrEqual(600);
    expect(packed.content).toBe(trace.summary);
  });

  it("revises legacy full content in place and resets evidence and lifecycle", async () => {
    admit(); const old = row("old", "L2"); repos.memories.insert(old);
    const other = row("other", "L2"); other.info.project_id = "other-project"; repos.memories.insert(other);
    respond.mockImplementation(async () => ({ operations: [{ operation: "revise", l1_ids: ["l1"], target_l2: { id: "old", version: 1 }, revised_l2: lesson }] }));
    await pipeline().induce(job());
    expect(l2ComparisonText(old)).toContain("Full verification");
    expect(embed.mock.calls.flatMap((call) => call[0]).join(" ")).toContain("Full exclusions");
    expect(JSON.parse(respond.mock.calls[0]![0][2].content).HISTORICAL_L2_CANDIDATES.map((target: { id: string }) => target.id)).toEqual(["old"]);
    expect(repos.memories.get("old")!.version).toBe(2);
    expect(repos.memories.get("old")!.properties.internal_info.policy).toMatchObject({
      content_revision: 2, status: "candidate", procedure: lesson.content, skill_eligible: false, successful_source_trace_ids: [] });
    expect(repos.runtime.listTracePolicyLinks({ l1MemoryId: "l1" })[0]!.relation).toBe("supports:r2");
  });

  it("keeps old content and candidates pending when revision vectors fail", async () => {
    admit(); repos.memories.insert(row("old", "L2"));
    respond.mockImplementation(async () => {
      embed.mockRejectedValue(new Error("embedding unavailable"));
      return { operations: [{ operation: "revise", l1_ids: ["l1"], target_l2: { id: "old", version: 1 }, revised_l2: lesson }] };
    });
    await expect(pipeline().induce(job())).rejects.toThrow("embedding unavailable");
    expect(repos.memories.get("old")!.version).toBe(1);
    expect(listL2Candidates(repos, { userId: "u", episodeId: "e" })).toHaveLength(1);
  });

  it("rejects a target changed while preparing revision vectors", async () => {
    admit(); repos.memories.insert(row("old", "L2"));
    respond.mockImplementation(async () => {
      embed.mockImplementationOnce(async (texts: string[]) => {
        const target = repos.memories.get("old")!;
        repos.memories.update({ ...target, memoryValue: "Concurrent edit" });
        return texts.map(() => [1, 0]);
      });
      return { operations: [{ operation: "revise", l1_ids: ["l1"], target_l2: { id: "old", version: 1 }, revised_l2: lesson }] };
    });
    await expect(pipeline().induce(job())).rejects.toThrow("target changed");
    expect(repos.memories.get("old")!.memoryValue).toBe("Concurrent edit");
    expect(listL2Candidates(repos, { userId: "u", episodeId: "e" })).toHaveLength(1);
  });

  it("rejects unchanged revisions rather than consuming the evidence", async () => {
    admit(); const old = row("old", "L2");
    (old.properties.internal_info.policy as Record<string, unknown>).lesson_type = "check";
    repos.memories.insert(old);
    respond.mockResolvedValue({ operations: [{ operation: "revise", l1_ids: ["l1"], target_l2: { id: "old", version: 1 },
      revised_l2: { type: "check", title: "Totals", applicability: "Export", content: "Full procedure including unrounded totals", verification: "Full verification", exclusions: "Full exclusions" } }] });
    await expect(pipeline().induce(job())).rejects.toThrow("unchanged content");
    expect(respond).toHaveBeenCalledTimes(3);
    expect(repos.memories.get("old")!.version).toBe(1);
  });

  it("bounds auxiliary evidence for both embedding and extraction without changing stored evidence", async () => {
    const memory = row("l1");
    const summary = "Complete summary " + "s".repeat(2_000) + " SUMMARY_TAIL";
    const trace = memory.properties.internal_info.trace as Record<string, unknown>;
    Object.assign(trace, { summary, userText: "u".repeat(250) + "USER_CORRECTION" + "u".repeat(5_000),
      agentText: "a".repeat(500) + "OBSERVED_RESULT" + "a".repeat(8_000),
      reflection: "r".repeat(4_000), tool_calls: Array.from({ length: 4 }, (_, i) => ({
        name: `tool-${i}`, input: { code: "i".repeat(50_000) }, output: "o".repeat(450_000) + "RAW_LOG_TAIL"
      })) });
    memory.memoryValue = "DUPLICATED_RAW_BODY" + "x".repeat(100_000);
    repos.memories.insert(memory);
    upsertL2Candidate(repos, { userId: "u", sourceMemoryId: "l1", route: "negative", at: AT,
      signal: { eventId: "event", route: "negative", text: "f".repeat(8_000) } });
    await pipeline().induce(job());
    const input = JSON.parse(respond.mock.calls[0]![0][2].content);
    const record = input.L1_RECORDS[0];
    expect(record.content).toBe(summary);
    expect(record.user_text).toHaveLength(600);
    expect(record.agent_text).toHaveLength(1_200);
    expect(record.user_text).toContain("USER_CORRECTION");
    expect(record.agent_text).toContain("OBSERVED_RESULT");
    expect(record.reflection).toHaveLength(300);
    expect(record.tool_calls.length).toBeLessThanOrEqual(600);
    expect(record.tool_calls).toContain("tool-2");
    expect(record.tool_calls).not.toContain("tool-3");
    expect(record.evidence_signals[0].text).toHaveLength(1_000);
    const transmitted = JSON.stringify([input, embed.mock.calls]);
    expect(transmitted).not.toContain("RAW_LOG_TAIL");
    expect(transmitted).not.toContain("DUPLICATED_RAW_BODY");
    expect(repos.memories.get("l1")!.memoryValue).toBe(memory.memoryValue);
    expect(repos.memories.get("l1")!.properties.internal_info.trace).toEqual(trace);
  });

  it("retains pending candidates on model failure, then confirms a forced rule fallback in place", async () => {
    admit(true); respond.mockRejectedValue(new Error("model unavailable"));
    await expect(pipeline().induce(job())).rejects.toThrow("model unavailable");
    const fallback = repos.memories.list({ memoryLayer: "L2" })[0]!;
    expect(fallback.info.extraction_status).toBe("pending_model");
    expect(listL2Candidates(repos, { userId: "u", episodeId: "e" })).toHaveLength(1);
    // The fallback has the opposite vector, so only the explicit recovery path can include it.
    embed.mockImplementation(async (texts: string[], role: string) => texts.map(() => role === "document" ? [-1, 0] : [1, 0]));
    respond.mockImplementation(async (messages) => {
      const input = JSON.parse(messages[2].content);
      expect(input.L1_RECORDS[0].evidence_signals[0]).not.toHaveProperty("fallback");
      expect(input.HISTORICAL_L2_CANDIDATES[0].id).toBe(fallback.id);
      return { operations: [{ operation: "support", l1_ids: ["l1"], target_l2: { id: fallback.id, version: fallback.version } }] };
    });
    await pipeline().induce(job());
    expect(repos.memories.list({ memoryLayer: "L2" })).toHaveLength(1);
    expect(repos.memories.get(fallback.id)!.info.generation_method).toBe("model_confirmed");
    expect(listL2Candidates(repos, { userId: "u", episodeId: "e" })).toHaveLength(0);
  });

  it.each(["transport", "invalid-contract", "embedding"])("recovers pending ordinary evidence after %s failure without fabricated fallback", async (failure) => {
    const source = row("l1");
    (source.properties.internal_info.trace as Record<string, unknown>).value = 1;
    repos.memories.insert(source);
    upsertL2Candidate(repos, { userId: "u", sourceMemoryId: source.id, route: "ordinary", at: AT });
    if (failure === "transport") respond.mockRejectedValue(new Error("provider unavailable"));
    if (failure === "invalid-contract") respond.mockResolvedValue({ operations: [{ operation: "ignore", l1_ids: ["unknown"] }] });
    if (failure === "embedding") embed.mockRejectedValue(new Error("embedding unavailable"));
    await expect(pipeline().induce(job())).rejects.toThrow();
    expect(respond).toHaveBeenCalledTimes(failure === "invalid-contract" ? 3 : failure === "embedding" ? 0 : 1);
    expect(repos.memories.list({ memoryLayer: "L2" })).toHaveLength(0);
    expect(listL2Candidates(repos, { userId: "u", episodeId: "e" })).toHaveLength(1);
    respond.mockResolvedValue({ operations: [{ operation: "create", l1_ids: ["l1"], new_l2: lesson }] });
    embed.mockImplementation(async (texts: string[]) => texts.map(() => [1, 0]));
    await pipeline().induce(job());
    expect(repos.memories.list({ memoryLayer: "L2" })).toHaveLength(1);
    expect(listL2Candidates(repos, { userId: "u", episodeId: "e" })).toHaveLength(0);
    await pipeline().induce(job());
    expect(repos.memories.list({ memoryLayer: "L2" })).toHaveLength(1);
  });

  it("rolls back L2 text, links and candidate consumption if dependent Skill scheduling fails", async () => {
    admit();
    repos.memories.insert(row("old", "L2"));
    respond.mockResolvedValue({ operations: [{ operation: "revise", l1_ids: ["l1"],
      target_l2: { id: "old", version: 1 }, revised_l2: lesson }] });
    await expect(pipeline(() => { throw new Error("dependent job enqueue failed"); }).induce(job()))
      .rejects.toThrow("dependent job enqueue failed");
    expect(repos.memories.get("old")).toMatchObject({ version: 1, memoryValue: row("old", "L2").memoryValue });
    expect(repos.runtime.listTracePolicyLinks({ l2MemoryId: "old", limit: 100 })).toHaveLength(0);
    expect(listL2Candidates(repos, { userId: "u", episodeId: "e" })).toHaveLength(1);
    await pipeline().induce(job());
    expect(repos.memories.get("old")!.info.content_revision).toBe(2);
    expect(listL2Candidates(repos, { userId: "u", episodeId: "e" })).toHaveLength(0);
  });

  it("keeps complete oversized evidence pending without calling the model", async () => {
    admit(); config.algorithm.l2Induction.maxInputChars = 1_000;
    await expect(pipeline().induce(job())).rejects.toThrow("exceed input budget");
    expect(respond).not.toHaveBeenCalled();
    expect(listL2Candidates(repos, { userId: "u", episodeId: "e" })).toHaveLength(1);
  });

  it("processes twelve candidates in batches of five, five and two with fresh L2 recall", async () => {
    const ids = Array.from({ length: 12 }, (_, i) => i === 0 ? "l1" : `l1-${i}`);
    for (const id of ids) {
      const memory = row(id);
      (memory.properties.internal_info.trace as Record<string, unknown>).summary = `Evidence from ${id}`;
      repos.memories.insert(memory);
      upsertL2Candidate(repos, { userId: "u", sourceMemoryId: id, route: "negative", at: AT });
    }
    const batches: string[][] = [];
    respond.mockImplementation(async (messages) => {
      const input = JSON.parse(messages[2].content);
      const sources = input.L1_RECORDS.map((record: { id: string }) => record.id);
      batches.push(sources);
      const queries = embed.mock.calls.filter((call) => call[1] === "query")
        .flatMap((call) => call[0]);
      // Retrieval of later L1 must wait until the current batch has committed its L2.
      expect(queries).toHaveLength(batches.flat().length);
      if (batches.length === 1) {
        expect(input.HISTORICAL_L2_CANDIDATES).toEqual([]);
        return { operations: [{ operation: "create", l1_ids: sources, new_l2: lesson }] };
      }
      expect(input.HISTORICAL_L2_CANDIDATES).toHaveLength(1);
      const target = input.HISTORICAL_L2_CANDIDATES[0];
      expect(target.version).toBe(repos.memories.get(target.id)!.version);
      return { operations: [{ operation: "support", l1_ids: sources,
        target_l2: { id: target.id, version: target.version } }] };
    });
    await pipeline().induce(job());
    expect(batches.map((batch) => batch.length)).toEqual([5, 5, 2]);
    expect(batches.flat().sort()).toEqual(ids.sort());
    expect(repos.memories.list({ memoryLayer: "L2" })).toHaveLength(1);
    expect(listL2Candidates(repos, { userId: "u", episodeId: "e" })).toHaveLength(0);
    expect(repos.runtime.listTracePolicyLinks({ limit: 100 })).toHaveLength(12);
  });

  it("resumes only the uncommitted batches after a later batch fails", async () => {
    for (let i = 0; i < 12; i++) {
      const id = i === 0 ? "l1" : `l1-${i}`;
      repos.memories.insert(row(id));
      upsertL2Candidate(repos, { userId: "u", sourceMemoryId: id, route: "negative", at: AT });
    }
    let committed: string[] = [];
    respond.mockImplementation(async (messages) => {
      const input = JSON.parse(messages[2].content);
      if (committed.length) throw new Error("second batch unavailable");
      committed = input.L1_RECORDS.map((record: { id: string }) => record.id);
      return { operations: [{ operation: "create", l1_ids: committed, new_l2: lesson }] };
    });
    await expect(pipeline().induce(job())).rejects.toThrow("second batch unavailable");
    expect(committed).toHaveLength(5);
    expect(repos.memories.list({ memoryLayer: "L2" })).toHaveLength(1);
    expect(listL2Candidates(repos, { userId: "u", episodeId: "e" })).toHaveLength(7);
    const resumed: string[][] = [];
    respond.mockImplementation(async (messages) => {
      const input = JSON.parse(messages[2].content);
      const sources = input.L1_RECORDS.map((record: { id: string }) => record.id);
      expect(sources.some((id: string) => committed.includes(id))).toBe(false);
      resumed.push(sources);
      const target = input.HISTORICAL_L2_CANDIDATES[0];
      return { operations: [{ operation: "support", l1_ids: sources,
        target_l2: { id: target.id, version: target.version } }] };
    });
    await pipeline().induce(job());
    expect(resumed.map((batch) => batch.length)).toEqual([5, 2]);
    expect(new Set([...committed, ...resumed.flat()]).size).toBe(12);
    expect(repos.memories.list({ memoryLayer: "L2" })).toHaveLength(1);
    expect(listL2Candidates(repos, { userId: "u", episodeId: "e" })).toHaveLength(0);
    expect(repos.runtime.listTracePolicyLinks({ limit: 100 })).toHaveLength(12);
  });

  it("splits only between whole L1 records and compares the next batch against freshly created L2", async () => {
    admit();
    const first = repos.memories.get("l1")!;
    (first.properties.internal_info.trace as Record<string, unknown>).summary = "a".repeat(22_000) + "FIRST_TAIL";
    repos.memories.update(first);
    const second = row("l1-b");
    (second.properties.internal_info.trace as Record<string, unknown>).summary = "b".repeat(22_000) + "SECOND_TAIL";
    repos.memories.insert(second);
    upsertL2Candidate(repos, { userId: "u", sourceMemoryId: "l1-b", route: "negative", at: AT });
    // Reserve a fixed evidence budget independently of the system prompt language.
    config.algorithm.l2Induction.maxInputChars = L2_EXTRACTION_SYSTEM_PROMPT.length + 25_000;
    let batches = 0;
    respond.mockImplementation(async (messages) => {
      const input = JSON.parse(messages[2].content);
      expect(input.L1_RECORDS).toHaveLength(1);
      const source = input.L1_RECORDS[0];
      expect(source.content).toContain(source.id === "l1" ? "FIRST_TAIL" : "SECOND_TAIL");
      if (batches++ === 0) {
        return { operations: [{ operation: "create", l1_ids: [source.id], new_l2: lesson }] };
      }
      expect(input.HISTORICAL_L2_CANDIDATES).toHaveLength(1);
      const target = input.HISTORICAL_L2_CANDIDATES[0];
      return { operations: [{ operation: "support", l1_ids: [source.id], target_l2: { id: target.id, version: target.version } }] };
    });
    await pipeline().induce(job());
    expect(respond).toHaveBeenCalledTimes(2);
    expect(repos.memories.list({ memoryLayer: "L2" })).toHaveLength(1);
    expect(listL2Candidates(repos, { userId: "u", episodeId: "e" })).toHaveLength(0);
  });

  it("rolls back model output if the L1 changes while the model is running", async () => {
    admit(); respond.mockImplementation(async () => {
      const source = repos.memories.get("l1")!;
      repos.memories.update({ ...source, memoryValue: "Edited evidence" });
      return { operations: [{ operation: "create", l1_ids: ["l1"], new_l2: lesson }] };
    });
    await expect(pipeline().induce(job())).rejects.toThrow("source changed");
    expect(repos.memories.list({ memoryLayer: "L2" })).toHaveLength(0);
    expect(listL2Candidates(repos, { userId: "u", episodeId: "e" })).toHaveLength(1);
  });

  it("keeps sources pending when no model is configured", async () => {
    admit(); configured = false; await expect(pipeline().induce(job())).rejects.toThrow("model unavailable");
    expect(respond).not.toHaveBeenCalled(); expect(embed).not.toHaveBeenCalled();
    expect(listL2Candidates(repos, { userId: "u", episodeId: "e" })).toHaveLength(1);
  });
});
