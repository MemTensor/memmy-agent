import { DEVICE_MEMORY_OWNER } from "../../src/service/namespace/memory-owner.js";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { MemoryDb } from "../../src/storage/db.js";
import { Repositories } from "../../src/storage/repositories.js";
import type { MemoryRow } from "../../src/types.js";
import {
  listL2Candidates,
  markL2CandidatesProcessed,
  upsertL2Candidate
} from "../../src/service/evolution/l2-candidate-service.js";

const AT = "2026-10-28T00:00:00.000Z";

function trace(id: string, userId = DEVICE_MEMORY_OWNER, episodeId = "episode-a"): MemoryRow {
  return {
    id, userId, timeline: AT, sessionId: "session-a", memoryLayer: "L1",
    memoryType: "LongTermMemory", status: "activated", visibility: "private",
    memoryValue: "A tool failed, and the user corrected the workflow.",
    tags: [], info: {}, version: 1, createdAt: AT, updatedAt: AT,
    properties: {
      internal_info: {
        memory_layer: "L1", memory_kind: "trace",
        trace: { episode_id: episodeId, userText: "Check the result before continuing.",
          agentText: "I will verify it.", summary: "A corrected workflow", value: -1, tool_calls: [] }
      }
    }
  };
}

describe("unified L2 candidate persistence", () => {
  let db: MemoryDb;
  let repos: Repositories;
  beforeEach(() => {
    db = new MemoryDb({ path: ":memory:" });
    repos = new Repositories(db.db);
  });
  afterEach(() => db?.close());

  it("keeps historical ownership authoritative instead of treating a device owner as a universal grant", () => {
    const historical = trace("legacy-source", "historical-owner");
    // Load an existing pre-device-owner record directly, rather than rewriting
    // the owner of a newly created row or changing the repository's owner policy.
    db.db.prepare(`INSERT INTO memories(id,user_id,timeline,memory_value,memory_layer,properties_json,status,created_at,updated_at)
      VALUES(?,?,?,?,?,?,?,?,?)`).run(historical.id, historical.userId, AT, historical.memoryValue, "L1",
      JSON.stringify(historical.properties), "activated", AT, AT);
    expect(upsertL2Candidate(repos, { sourceMemoryId: "legacy-source", userId: DEVICE_MEMORY_OWNER, route: "ordinary" })).toBeNull();
    expect(upsertL2Candidate(repos, { sourceMemoryId: "legacy-source", userId: "other-owner", route: "ordinary" })).toBeNull();
    const owned = upsertL2Candidate(repos, { sourceMemoryId: "legacy-source", userId: "historical-owner", route: "ordinary" });
    expect(owned).toMatchObject({ sourceMemoryId: "legacy-source", userId: "historical-owner" });
    expect(repos.memories.get("legacy-source")!.userId).toBe("historical-owner");
  });

  it("requires a live L1 in the requested user and Episode, without applying a value gate", () => {
    repos.memories.insert(trace("l1"));
    expect(upsertL2Candidate(repos, { sourceMemoryId: "missing", userId: DEVICE_MEMORY_OWNER, route: "feedback" })).toBeNull();
    expect(upsertL2Candidate(repos, { sourceMemoryId: "l1", userId: "user-b", route: "feedback" })).toBeNull();
    expect(upsertL2Candidate(repos, { sourceMemoryId: "l1", userId: DEVICE_MEMORY_OWNER, route: "feedback", episodeId: "other" })).toBeNull();
    expect(upsertL2Candidate(repos, { sourceMemoryId: "l1", userId: DEVICE_MEMORY_OWNER, route: "feedback" })?.sourceMemoryId).toBe("l1");
    expect(listL2Candidates(repos, { userId: "user-b", episodeId: "episode-a" })).toHaveLength(0);
    expect(listL2Candidates(repos, { userId: DEVICE_MEMORY_OWNER, episodeId: "other" })).toHaveLength(0);
    repos.memories.update({ ...repos.memories.get("l1")!, status: "deleted", deletedAt: AT });
    expect(listL2Candidates(repos, { userId: DEVICE_MEMORY_OWNER, episodeId: "episode-a" })).toHaveLength(0);
  });

  it("merges routes into one L1 candidate and keeps retry evidence after the former TTL", () => {
    repos.memories.insert(trace("l1"));
    const first = upsertL2Candidate(repos, { sourceMemoryId: "l1", userId: DEVICE_MEMORY_OWNER, route: "ordinary", at: AT })!;
    const merged = upsertL2Candidate(repos, { sourceMemoryId: "l1", userId: DEVICE_MEMORY_OWNER, route: "negative", at: AT,
      signal: { eventId: "failure-1", route: "negative", text: "Tool returned an error", confidenceCap: 0.35 } })!;
    expect(merged.id).toBe(first.id);
    expect(merged.routes).toEqual(["negative", "ordinary"]);
    expect(merged.signals).toHaveLength(1);
    expect(repos.runtime.pruneCandidatePool("2036-10-28T00:00:00.000Z")).toBe(0);
    expect(listL2Candidates(repos, { userId: DEVICE_MEMORY_OWNER, episodeId: "episode-a" })).toHaveLength(1);
  });

  it("does not reprocess repeated events or reward edits, but reopens changed signal evidence", () => {
    repos.memories.insert(trace("l1"));
    const input = { sourceMemoryId: "l1", userId: DEVICE_MEMORY_OWNER, route: "feedback" as const,
      signal: { eventId: "feedback-1", route: "feedback" as const, text: "Verify before publishing." }, at: AT };
    const first = upsertL2Candidate(repos, input)!;
    markL2CandidatesProcessed(repos, [first], [{ action: "ignore" }], AT);
    const memory = repos.memories.get("l1")!;
    (memory.properties.internal_info.trace as Record<string, unknown>).value = 100;
    repos.memories.update(memory);
    const replay = upsertL2Candidate(repos, input)!;
    expect(replay.status).toBe("promoted");
    expect(replay.sourceVersion).toBe(first.sourceVersion);
    const changed = upsertL2Candidate(repos, { ...input, signal: { ...input.signal, text: "Verify both permissions and published content." } })!;
    expect(changed.status).toBe("pending");
    expect(changed.sourceVersion).not.toBe(first.sourceVersion);
    expect(changed.signals).toHaveLength(1);
  });

  it("rejects a stale source snapshot atomically, including edits beyond long text prefixes", () => {
    repos.memories.insert(trace("l1-a"));
    const long = trace("l1-b");
    long.memoryValue = "a".repeat(25_000);
    repos.memories.insert(long);
    const a = upsertL2Candidate(repos, { sourceMemoryId: "l1-a", userId: DEVICE_MEMORY_OWNER, route: "ordinary" })!;
    const b = upsertL2Candidate(repos, { sourceMemoryId: "l1-b", userId: DEVICE_MEMORY_OWNER, route: "ordinary" })!;
    repos.memories.update({ ...repos.memories.get("l1-b")!, memoryValue: `${long.memoryValue} changed` });
    expect(() => markL2CandidatesProcessed(repos, [a, b], [], AT)).toThrow("changed during extraction");
    expect(repos.runtime.getUnifiedL2Candidate(a.id, a.userId)?.status).toBe("pending");
    expect(repos.runtime.getUnifiedL2Candidate(b.id, b.userId)?.status).toBe("pending");
    const refreshed = listL2Candidates(repos, { userId: DEVICE_MEMORY_OWNER, episodeId: "episode-a" });
    expect(refreshed.find((candidate) => candidate.id === b.id)?.sourceVersion).not.toBe(b.sourceVersion);
  });

  it("scrubs withdrawn candidate and snapshot text while preserving an operation tombstone", () => {
    repos.memories.insert(trace("l1"));
    const candidate = upsertL2Candidate(repos, { sourceMemoryId: "l1", userId: DEVICE_MEMORY_OWNER, route: "feedback" })!;
    repos.runtime.setKv("l2.extract.snapshot.v1:test", {
      status: "committed", scope: JSON.stringify([DEVICE_MEMORY_OWNER, null, "default"]),
      input: { L1_RECORDS: [{ id: "l1", content: "withdrawn text" }] },
      operations: [{ operation: "ignore", l1_ids: ["l1"] }]
    }, AT);
    repos.runtime.setKv("l2.extract.operation.v1:test", {
      operation: { operation: "create", l1_ids: ["l1"], new_l2: { content: "withdrawn text" } }, committedAt: AT
    }, AT);
    expect(repos.runtime.invalidateUnifiedL2Source("l1", "user-b", AT)).toEqual({ candidates: 0, snapshots: 0, operations: 0 });
    expect(repos.runtime.invalidateUnifiedL2Source("l1", DEVICE_MEMORY_OWNER, AT)).toEqual({ candidates: 1, snapshots: 1, operations: 1 });
    expect(repos.runtime.getUnifiedL2Candidate(candidate.id, DEVICE_MEMORY_OWNER)).toBeUndefined();
    expect(repos.runtime.getKv("l2.extract.snapshot.v1:test")?.value).toEqual({
      status: "committed", scope: JSON.stringify([DEVICE_MEMORY_OWNER, null, "default"]), sourceInvalidatedAt: AT
    });
    expect(repos.runtime.getKv("l2.extract.operation.v1:test")?.value).toEqual({ committedAt: AT, sourceInvalidatedAt: AT });
  });
});
