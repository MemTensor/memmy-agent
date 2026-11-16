import { afterEach, describe, expect, it, vi } from "vitest";
import { createMemoryServiceFixture, createBatchReflectionLlm, settleCaptureAssignments, assignedEpisodeId } from "../../fixtures/memory-service-fixture.js";
import { Repositories } from "../../../src/storage/repositories.js";

const fixture = createMemoryServiceFixture();
afterEach(() => { vi.restoreAllMocks(); fixture.cleanup(); });

async function harness() {
  const h = fixture.createTestService({ llm: createBatchReflectionLlm([]) });
  const captured = await h.service.completeSourceTurn({
    namespace: { source: "codex", profileId: "default", userId: "projection-user" },
    source: "codex", channel: "agent_source_scan", captureLegacyHistory: true,
    sourceTurn: { source: "codex", profileId: "default", conversationId: "projection-conversation", turnId: "turn-1",
      startedAt: "2000-01-01T10:00:00.000Z", completedAt: "2000-01-01T10:00:30.000Z",
      completionEvidence: "complete:1" },
    query: "Implement a transaction test.", answer: "The transaction test is complete."
  });
  expect(captured.status).toBe("stored");
  const result = captured.result!;
  await settleCaptureAssignments(h.service);
  result.episodeId = assignedEpisodeId(h.service, result);
  const repos = new Repositories(h.db.db);
  function memory(id: string, origin: unknown = "agent_source_scan", agentId = "codex", tags: string[] = [], deletedAt: string | null = null) {
    h.db.db.prepare(`INSERT INTO memories(id,timeline,user_id,memory_value,memory_layer,agent_id,tags_json,properties_json,
      deleted_at,created_at,updated_at) VALUES (?,?,'projection-user',?,'L1',?,?,?,?,?,?)`)
      .run(id, "2000-01-01", "Long synthetic conversation text. ".repeat(2048), agentId, JSON.stringify(tags),
        JSON.stringify({ internal_info: { capture_origin: origin, trace: { userText: "Synthetic private trace body. ".repeat(2048) } } }),
        deletedAt, "2000-01-01", "2000-01-01");
  }
  return { ...h, repos, result, memory };
}

describe("episode title provenance uses metadata without memory/vector hydration", async () => {
  it.each([
    { name: "wholly historical", ids: ["history"], expected: "import" },
    { name: "mixed historical/current", ids: ["history", "current"], expected: "interactive" },
    { name: "current only", ids: ["current"], expected: "interactive" },
    { name: "unknown origin", ids: ["unknown"], expected: "interactive" },
    { name: "origin casing is not canonical", ids: ["uppercase"], expected: "interactive" },
    { name: "empty episode", ids: [], expected: "interactive" },
    { name: "missing memory", ids: ["history", "missing"], expected: "interactive" },
    { name: "soft-deleted memory", ids: ["history", "deleted"], expected: "interactive" },
    { name: "duplicate historical ids", ids: ["history", "history"], expected: "import" },
    { name: "duplicate current ids", ids: ["current", "current"], expected: "interactive" },
    { name: "onboarding agent", ids: ["history", "onboarding-agent"], expected: "interactive" },
    { name: "first report tag", ids: ["history", "first-report"], expected: "interactive" },
    { name: "onboarding report tag", ids: ["history", "onboarding-report"], expected: "interactive" },
    { name: "ordinary tag", ids: ["ordinary"], expected: "import" }
  ])("keeps $name semantics without loading bodies", async ({ ids, expected }) => {
    const h = await harness();
    h.memory("history"); h.memory("current", null); h.memory("unknown", "hook");
    h.memory("uppercase", "AGENT_SOURCE_SCAN"); h.memory("deleted", "agent_source_scan", "codex", [], "2020-01-01");
    h.memory("onboarding-agent", "agent_source_scan", "MeMmY-OnBoArDiNg");
    h.memory("first-report", "agent_source_scan", "codex", ["FiRsT-EnCoUnTeR-RePoRt"]);
    h.memory("onboarding-report", "agent_source_scan", "codex", ["ONBOARDING-REPORT"]);
    h.memory("ordinary", "agent_source_scan", "codex", ["database", "test"]);
    h.db.db.prepare("UPDATE episodes SET l1_memory_ids_json = ? WHERE id = ?").run(JSON.stringify(ids), h.result.episodeId);
    const memoryHydration = vi.spyOn(h.service["repos"].memories, "getMany");
    const vectorHydration = vi.spyOn(h.service["repos"].vectors, "getMany");
    const sql = vi.spyOn(h.db.db, "prepare");
    const queued = h.service["workerHandlers"].enqueueJob({ jobType: "episode_title", userId: "projection-user",
      sessionId: h.result.sessionId, episodeId: h.result.episodeId,
      payload: { stage: "final", captureOrigin: "agent_source_scan" } });
    expect(queued.queueLane).toBe(expected);
    expect(queued.payload.captureOrigin).toBe(expected === "import" ? "agent_source_scan" : undefined);
    expect(memoryHydration).not.toHaveBeenCalled();
    expect(vectorHydration).not.toHaveBeenCalled();
    expect(sql.mock.calls.map(call => call[0]).join("\n")).not.toMatch(/SELECT\s+\*\s+FROM\s+memories|FROM\s+memory_vector_entries/i);
  });

  it("does not hydrate a growing historical episode when refreshing a deduplicated provisional title", async () => {
    const h = await harness();
    const episode = h.repos.runtime.getEpisode(h.result.episodeId)!;
    h.db.db.prepare("UPDATE episodes SET l1_memory_ids_json = ? WHERE id = ?")
      .run(JSON.stringify(Array.from({ length: 2000 }, () => h.result.l1MemoryId)), episode.id);
    h.service["workerHandlers"].enqueueJob({ jobType: "episode_title", userId: episode.userId,
      sessionId: episode.sessionId, episodeId: episode.id, payload: { stage: "provisional" } });
    const original = h.db.db.prepare("SELECT id,enqueue_seq FROM evolution_jobs WHERE episode_id = ? AND job_type = 'episode_title'")
      .get(episode.id) as { id: string; enqueue_seq: number };
    const memoryHydration = vi.spyOn(h.service["repos"].memories, "getMany");
    const vectorHydration = vi.spyOn(h.service["repos"].vectors, "getMany");
    for (let index = 0; index < 3; index++) {
      const job = h.service["workerHandlers"].enqueueJob({ jobType: "episode_title", userId: episode.userId,
        sessionId: episode.sessionId, episodeId: episode.id, payload: { stage: "provisional" } });
      expect(job).toMatchObject({ id: original.id, enqueueSeq: original.enqueue_seq, queueLane: "import" });
    }
    expect(memoryHydration).not.toHaveBeenCalled();
    expect(vectorHydration).not.toHaveBeenCalled();
  });

  it("matches memory hydration for malformed legacy tags without treating an object as an onboarding tag list", async () => {
    const h = await harness();
    h.db.db.prepare("UPDATE memories SET tags_json = ? WHERE id = ?")
      .run(JSON.stringify({ label: "first-encounter-report" }), h.result.l1MemoryId);
    expect(h.repos.memories.getMany([h.result.l1MemoryId])[0]?.tags).not.toContain("first-encounter-report");
    expect(h.repos.memories.areAllHistoricalCaptureMemories([h.result.l1MemoryId])).toBe(true);
  });

  it.each(["info_json", "properties_json"] as const)("keeps report tags stored only in %s interactive", async column => {
    const h = await harness();
    h.db.db.prepare(`UPDATE memories SET ${column} = json_set(${column}, '$.tags', json(?)) WHERE id = ?`)
      .run(JSON.stringify(["FIRST-ENCOUNTER-REPORT"]), h.result.l1MemoryId);
    expect(h.repos.memories.getMany([h.result.l1MemoryId])[0]?.tags).toContain("FIRST-ENCOUNTER-REPORT");
    const hydration = vi.spyOn(h.service["repos"].memories, "getMany");
    const queued = h.service["workerHandlers"].enqueueJob({ jobType: "episode_title", userId: "projection-user",
      sessionId: h.result.sessionId, episodeId: h.result.episodeId, payload: { stage: "final" } });
    expect(queued.queueLane).toBe("interactive");
    expect(queued.payload.captureOrigin).toBeUndefined();
    expect(hydration).not.toHaveBeenCalled();
  });

  it("ignores a caller-supplied historical origin when the title has no verified episode", async () => {
    const h = await harness();
    const queued = h.service["workerHandlers"].enqueueJob({ jobType: "episode_title", userId: "projection-user",
      payload: { stage: "final", captureOrigin: "agent_source_scan" } });
    expect(queued.queueLane).toBe("interactive");
    expect(queued.payload.captureOrigin).toBeUndefined();
  });
});
