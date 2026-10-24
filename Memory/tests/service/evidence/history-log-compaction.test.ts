import { createHash } from "node:crypto";
import { afterEach, describe, expect, it } from "vitest";
import { DEFAULT_MEMMY_CONFIG, type LlmClient } from "../../../src/index.js";
import type { LlmCompletionOptions, LlmMessage } from "../../../src/model/types.js";
import { Repositories, type ChangeLogRecord } from "../../../src/storage/repositories.js";
import type { MemoryRow } from "../../../src/types.js";
import { isRecord } from "../../../src/utils/json.js";
import { observationMemoryState } from "../../../src/service/observation-memory-state.js";
import { createCapturingEmbedder, createMemoryServiceFixture, runWorkerRounds, runWorkerRoundsWithDueRetries } from "../../fixtures/memory-service-fixture.js";

const { createTestService, cleanup } = createMemoryServiceFixture();
afterEach(cleanup);
const namespace = { source: "memmy", profileId: "default", userId: "history-log-user" };
const fact = "Recording hardware purchase is awaiting approval.";
const semanticFact = "The hardware purchase approval had not been confirmed at the time observed.";
const raw = `${fact}\n${"RAW_HISTORY_CAPTURE_SENTINEL 窗口切换与界面原始记录。\n".repeat(36)}原始记录的最后一行。`;
const evidence = {
  action: "upsert" as const, source: "computer_history", namespace,
  sourceRecordId: "2026-10-09T10-00-00Z-10min-summary", revision: "2026-10-09T10:10:00.000Z",
  title: "Recording hardware procurement", summary: "Reviewing the procurement approval.", content: raw,
  startedAt: "2026-10-09T10:00:00.000Z", endedAt: "2026-10-09T10:10:00.000Z",
  provenance: { historyId: "2026-10-09T10-00-00Z-10min-summary", applications: ["com.TickTick.task.mac"] }
};
type Input = { aggregate: boolean; sources: Array<{ id: string; content: string }> };
function model(generate: (input: Input) => unknown = semantic): LlmClient {
  return { config: DEFAULT_MEMMY_CONFIG.summary, isConfigured: () => true,
    complete: async () => "", status: () => ({ provider: "test", configured: true, remote: false }),
    async completeJson<T extends Record<string, unknown>>(messages: LlmMessage[], options: LlmCompletionOptions) {
      if (options.operation !== "capture.observation_extract") return {} as T;
      return generate(JSON.parse(messages[1]!.content) as Input) as T;
    } };
}
function semantic(input: Input): unknown {
  const source = input.sources.find((item) => item.content.includes(fact) || item.content.includes(semanticFact))!;
  return { keep: true, title: "Hardware procurement approval", summary: semanticFact,
    items: [{ category: "blocker", text: semanticFact, source_memory_id: source.id,
      evidence_quote: source.content.includes(fact) ? fact : semanticFact }] };
}
function historySnapshots(changes: ChangeLogRecord[], memoryId: string): MemoryRow[] {
  return changes.filter((change) => change.memoryId === memoryId)
    .flatMap((change) => [change.before, change.after])
    .filter((snapshot): snapshot is MemoryRow => isRecord(snapshot) && snapshot.id === memoryId
      && isRecord(snapshot.properties) && isRecord(snapshot.properties.internal_info)
      && snapshot.properties.internal_info.memory_kind === "observed_activity");
}
function expectCompacted(snapshot: MemoryRow, source: string, omittedBody?: string): void {
  expect(snapshot.properties.internal_info.external_evidence).not.toHaveProperty("source_content");
  expect(snapshot.properties.internal_info.change_log_projection).toMatchObject({
    schema_version: 1, source_content_omitted: true,
    source_content_sha256: createHash("sha256").update(source, "utf8").digest("hex"),
    source_content_bytes: Buffer.byteLength(source, "utf8"),
    ...(omittedBody === undefined ? {} : { memory_value_omitted: true,
      memory_value_sha256: createHash("sha256").update(omittedBody, "utf8").digest("hex"),
      memory_value_bytes: Buffer.byteLength(omittedBody, "utf8") })
  });
  if (omittedBody !== undefined) expect(snapshot.memoryValue).toBe("");
}
function expectCurrentSource(memory: MemoryRow, source: string): void {
  expect(memory.properties.internal_info.external_evidence).toMatchObject({ source_content: source });
  expect(memory.properties.internal_info.change_log_projection).toBeUndefined();
}
function rawTextPaths(value: unknown, path = ""): string[] {
  if (typeof value === "string") return /RAW_(?:HISTORY|UPDATED|ROLLUP)_CAPTURE_SENTINEL/u.test(value) ? [path] : [];
  if (Array.isArray(value)) return value.flatMap((item, index) => rawTextPaths(item, `${path}[${index}]`));
  if (isRecord(value)) return Object.entries(value).flatMap(([key, item]) => rawTextPaths(item, `${path}.${key}`));
  return [];
}

describe("History change-log compaction", () => {
  it("compacts notification snapshots while extraction, embedding, source updates, retries and parent aggregation use intact current memory", async () => {
    let invalid = false;
    const inputs: Input[] = [], embedded: string[] = [];
    const { service, db } = createTestService({ config: { ...DEFAULT_MEMMY_CONFIG, language: "en-US" },
      embedder: createCapturingEmbedder(embedded), llm: model((input) => {
        inputs.push(input);
        return invalid ? { keep: true, title: "Invented result", summary: "A fabricated completion",
          items: [{ category: "progress", text: "A fabricated completion", source_memory_id: input.sources[0]!.id,
            evidence_quote: "This completion was never observed." }] } : semantic(input);
      }) });
    const synced = service.syncExternalEvidence(evidence);
    const repos = new Repositories(db.db);
    const pending = repos.memories.get(synced.id)!;
    expectCurrentSource(pending, raw);
    expect(pending.memoryValue).toBe(raw);
    expectCompacted(historySnapshots(repos.runtime.listChanges(undefined, 1000), synced.id).at(-1)!, raw, raw);
    await runWorkerRounds(service, 2);
    const processed = repos.memories.get(synced.id)!;
    expectCurrentSource(processed, raw);
    expect(processed.memoryValue).toContain(semanticFact);
    expect(repos.memories.hasVector(synced.id, "vec_summary")).toBe(true);
    const processedLog = historySnapshots(repos.runtime.listChanges(undefined, 1000), synced.id)
      .find((snapshot) => observationMemoryState(snapshot)?.status === "processed")!;
    expectCompacted(processedLog, raw);
    expect(processedLog.memoryValue).toBe(processed.memoryValue);
    expect(embedded.some((text) => text.includes(semanticFact))).toBe(true);
    expect(embedded.some((text) => text.includes("RAW_HISTORY_CAPTURE_SENTINEL"))).toBe(false);

    const rollupRaw = "RAW_ROLLUP_CAPTURE_SENTINEL Six hours of procurement activity.";
    const derived = service.syncExternalEvidence({ ...evidence,
      sourceRecordId: "2026-10-09T06-00-00Z-6h-summary", content: rollupRaw,
      parentSourceRecordIds: [evidence.sourceRecordId],
      provenance: { historyId: "2026-10-09T06-00-00Z-6h-summary" } });
    await runWorkerRounds(service, 2);
    const aggregation = inputs.find((input) => input.aggregate)!;
    expect(aggregation.sources.some((source) => source.id === synced.id && source.content.includes(semanticFact))).toBe(true);
    expect(aggregation.sources.filter((source) => source.id === synced.id).map((source) => source.content).join(""))
      .not.toContain("RAW_HISTORY_CAPTURE_SENTINEL");
    expectCurrentSource(repos.memories.get(derived.id)!, rollupRaw);
    expect(observationMemoryState(repos.memories.get(derived.id)!)?.status).toBe("processed");

    const cursor = repos.runtime.latestChangeSeq();
    const updatedRaw = `${raw}\nA new reimbursement constraint was observed. RAW_UPDATED_CAPTURE_SENTINEL`;
    invalid = true;
    service.syncExternalEvidence({ ...evidence, revision: "2026-10-09T10:20:00.000Z", content: updatedRaw });
    expectCurrentSource(repos.memories.get(synced.id)!, updatedRaw);
    expect(observationMemoryState(repos.memories.get(derived.id)!)?.status).toBe("pending");
    const updatedLogs = repos.runtime.listChanges(undefined, 1000, cursor);
    expect(updatedLogs.every((change) => change.seq > cursor)).toBe(true);
    const newPending = historySnapshots(updatedLogs, synced.id)
      .find((snapshot) => observationMemoryState(snapshot)?.status === "pending")!;
    expectCompacted(newPending, updatedRaw, updatedRaw);
    const priorSemantic = historySnapshots(updatedLogs, synced.id)
      .find((snapshot) => observationMemoryState(snapshot)?.status === "processed")!;
    expect(priorSemantic.memoryValue).toBe(processed.memoryValue);
    await runWorkerRoundsWithDueRetries(service, db, [synced.id], 3);
    expect(service.memoryProcessingStatus([synced.id]).items[0]).toMatchObject({ state: "failed", stage: "summary" });
    invalid = false;
    expect(service.retryMemoryProcessing(synced.id, { namespace }).job?.jobType).toBe("observation_extract");
    await service.runWorkerOnce(10, { targetMemoryIds: [synced.id] });
    await runWorkerRounds(service, 3);
    expect(service.memoryProcessingStatus([synced.id, derived.id]).items.map((item) => item.state)).toEqual(["ready", "ready"]);
    expectCurrentSource(repos.memories.get(synced.id)!, updatedRaw);
    expectCurrentSource(repos.memories.get(derived.id)!, rollupRaw);
    expect(repos.runtime.listChanges(undefined, 1000).flatMap((change) => rawTextPaths(change).map((path) => ({
      seq: change.seq, source: change.source, path
    })))).toEqual([]);
  });

  it.each(["JSON text", "decoded object"] as const)("exports and restores full current evidence and durable retries while compacting legacy bundle %s log snapshots", async (format) => {
    const first = createTestService({ llm: model((input) => ({ keep: true, title: "Ungrounded result", summary: "Unsupported completion",
      items: [{ category: "progress", text: "Unsupported completion", evidence_quote: "Not present in the source.", source_memory_id: input.sources[0]!.id }] })) });
    const source = first.service.syncExternalEvidence(evidence);
    await runWorkerRoundsWithDueRetries(first.service, first.db, [source.id], 3);
    expect(first.service.memoryProcessingStatus([source.id]).items[0]?.state).toBe("failed");
    const repos = new Repositories(first.db.db), current = repos.memories.get(source.id)!;
    const oldChange = repos.runtime.listChanges(undefined, 1000).find((change) => change.memoryId === source.id)!;
    // A pre-upgrade log still contains the full snapshot. Export must project it
    // without editing the source table or relying on a completed maintenance pass.
    const oldJson = JSON.stringify(current);
    first.db.db.prepare("UPDATE memory_change_log SET before_json = ?, after_json = ? WHERE seq = ?")
      .run(oldJson, oldJson, oldChange.seq);
    const full = first.service.exportBundle({ includeRawText: true });
    expect((full.tables.memories as Array<Record<string, unknown>>).find((row) => row.id === source.id))
      .toMatchObject({ memory_value: raw });
    const exportedCurrent = (full.tables.memories as Array<Record<string, unknown>>).find((row) => row.id === source.id)!;
    expect(JSON.parse(String(exportedCurrent.properties_json)).internal_info.external_evidence.source_content).toBe(raw);
    const exportedLogs = full.tables.memory_change_log as Array<Record<string, unknown>>;
    expect(JSON.stringify(exportedLogs)).not.toContain("RAW_HISTORY_CAPTURE_SENTINEL");
    expect((first.db.db.prepare("SELECT after_json FROM memory_change_log WHERE seq = ?").get(oldChange.seq) as { after_json: string }).after_json).toBe(oldJson);

    // Import an actual old bundle shape, not just the already compacted export.
    const legacyPayload = format === "decoded object" ? current : oldJson;
    const importedLogs = exportedLogs.map((row) => row.seq === oldChange.seq
      ? { ...row, before_json: legacyPayload, after_json: legacyPayload } : row);
    const restored = createTestService({ llm: model() });
    expect(restored.service.importBundle({ bundle: { ...full, tables: { ...full.tables, memory_change_log: importedLogs } } }).ok).toBe(true);
    const restoredRepos = new Repositories(restored.db.db), restoredCurrent = restoredRepos.memories.get(source.id)!;
    expectCurrentSource(restoredCurrent, raw);
    expect(restoredCurrent.memoryValue).toBe(raw);
    const restoredLogs = restoredRepos.runtime.listChanges(undefined, 1000);
    expect(restoredLogs.find((change) => change.seq === oldChange.seq)).toMatchObject({
      memoryId: oldChange.memoryId, namespaceId: oldChange.namespaceId, version: oldChange.version,
      source: oldChange.source, createdAt: oldChange.createdAt
    });
    expect(JSON.stringify(restoredLogs)).not.toContain("RAW_HISTORY_CAPTURE_SENTINEL");
    expect(restored.service.memoryProcessingStatus([source.id]).items[0]?.state).toBe("failed");
    expect(restored.service.retryMemoryProcessing(source.id, { namespace }).job?.jobType).toBe("observation_extract");
    await runWorkerRounds(restored.service, 2);
    expect(restored.service.memoryProcessingStatus([source.id]).items[0]?.state).toBe("ready");
    expectCurrentSource(restoredRepos.memories.get(source.id)!, raw);
    expect(restoredRepos.memories.get(source.id)?.memoryValue).toContain(semanticFact);
    expect(restoredRepos.memories.hasVector(source.id, "vec_summary")).toBe(true);
    expect(JSON.stringify(restoredRepos.runtime.listChanges(undefined, 1000))).not.toContain("RAW_HISTORY_CAPTURE_SENTINEL");
  });

  it("automatically compacts more than one batch of old snapshots without moving cursors or changing ordinary trace logs", async () => {
    const { service, db } = createTestService();
    const source = service.syncExternalEvidence(evidence);
    const repos = new Repositories(db.db), current = repos.memories.get(source.id)!;
    const session = service.openSession({ namespace: { ...namespace, source: "codex" } });
    const turn = service.completeTurn("ordinary-trace-log", { sessionId: session.sessionId,
      query: "TRACE_RAW_CONTENT_SENTINEL Keep the release review scoped.", answer: "The review stayed within that scope." });
    const trace = repos.memories.get(turn.l1MemoryId)!;
    const traceJson = JSON.stringify(trace);
    const traceSeq = repos.runtime.appendChange({ memoryId: trace.id, userId: trace.userId,
      kind: "trace", op: "updated", changeType: "update", before: trace, after: trace,
      source: "ordinary.trace", createdAt: evidence.revision });
    expect((db.db.prepare("SELECT before_json, after_json FROM memory_change_log WHERE seq = ?").get(traceSeq) as Record<string, unknown>))
      .toEqual({ before_json: traceJson, after_json: traceJson });
    const insert = db.db.prepare(`INSERT INTO memory_change_log
      (memory_id, namespace_id, kind, op, entity_id, user_id, change_type, version, before_json, after_json, source, created_at)
      VALUES (?, ?, 'observed_activity', 'updated', ?, ?, 'update', ?, ?, ?, 'legacy.history.snapshot', ?)`);
    const legacy = { ...current, properties: { ...current.properties, internal_info: { ...current.properties.internal_info,
      external_evidence: { ...(current.properties.internal_info.external_evidence as Record<string, unknown>), source: "memmy" } } } };
    const payload = JSON.stringify(legacy);
    for (let index = 0; index < 251; index++) insert.run(source.id, "preserve-full-namespace-id", source.id,
      namespace.userId, index + 1, payload, payload, evidence.revision);
    const metadataSql = "SELECT seq, memory_id, namespace_id, kind, op, entity_id, user_id, change_type, version, source, created_at FROM memory_change_log WHERE source = 'legacy.history.snapshot' ORDER BY seq";
    const originalMetadata = db.db.prepare(metadataSql).all() as Array<{ seq: number }>;
    const originalCurrent = JSON.stringify(repos.memories.get(source.id));
    const maxSeq = repos.runtime.latestChangeSeq();
    const cursor = originalMetadata[199]!.seq;
    const reloaded = new Repositories(db.db);
    expect((db.db.prepare("SELECT COUNT(*) AS n FROM memory_change_log WHERE source = 'legacy.history.snapshot' AND json_extract(after_json, '$.properties.internal_info.external_evidence.source_content') IS NOT NULL").get() as { n: number }).n).toBe(251);
    await expect.poll(() => (db.db.prepare("SELECT COUNT(*) AS n FROM memory_change_log WHERE source = 'legacy.history.snapshot' AND json_extract(after_json, '$.properties.internal_info.external_evidence.source_content') IS NOT NULL").get() as { n: number }).n).toBe(0);
    expect(db.db.prepare(metadataSql).all()).toEqual(originalMetadata);
    expect(reloaded.runtime.latestChangeSeq()).toBe(maxSeq);
    expect(reloaded.runtime.listChanges(undefined, 1000, cursor).map((change) => change.seq))
      .toEqual(originalMetadata.filter((row) => row.seq > cursor).map((row) => row.seq).reverse());
    expect(JSON.stringify(reloaded.memories.get(source.id))).toBe(originalCurrent);
    expectCurrentSource(reloaded.memories.get(source.id)!, raw);
    expect((db.db.prepare("SELECT before_json, after_json FROM memory_change_log WHERE seq = ?").get(traceSeq) as Record<string, unknown>))
      .toEqual({ before_json: traceJson, after_json: traceJson });
    expect(JSON.stringify(reloaded.memories.get(trace.id))).toBe(traceJson);
    const nextSeq = reloaded.runtime.appendChange({ memoryId: trace.id, userId: trace.userId,
      kind: "trace", op: "updated", changeType: "update", after: trace, source: "ordinary.trace", createdAt: evidence.revision });
    expect(nextSeq).toBe(maxSeq + 1);
  });
});
