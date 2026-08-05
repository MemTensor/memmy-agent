import { afterEach, describe, expect, it } from "vitest";
import { createMemoryServiceFixture } from "../fixtures/memory-service-fixture.js";

const { cleanup, createTestService } = createMemoryServiceFixture();

afterEach(() => cleanup());

describe("candidate review workflow", () => {
  it("keeps AI conclusions resolving until approve, supports edit-approve and reject", () => {
    const { db, service } = createTestService();
    const namespace = { source: "codex", profileId: "default", userId: "review-user", projectId: "review-project", workspaceId: "review-workspace" };
    const first = service.addMemory({ namespace, layer: "L2", content: "Use the workspace namespace for every read.", source: "worker", deferProcessing: true });
    const second = service.addMemory({ namespace, layer: "Skill", content: "Run tests, then verify the result.", source: "worker", deferProcessing: true });
    for (const [memory, confidence] of [[first, 0.92], [second, 0.86]] as const) {
      db.db.prepare(`UPDATE memories
        SET status = 'resolving',
            info_json = json_set(info_json, '$.confidence', ?),
            properties_json = json_set(properties_json, '$.status', 'resolving')
        WHERE id = ?`).run(confidence, memory.id);
    }

    expect(service.reviewCandidates({ namespace }).items).toHaveLength(2);
    const approved = service.approveCandidate(first.id, { namespace, content: "Every memory read must include workspace namespace." });
    expect(approved).toMatchObject({ decision: "approved", status: "activated", layer: "L2" });
    const rejected = service.rejectCandidate(second.id, { namespace, reason: "procedure is incomplete" });
    expect(rejected).toMatchObject({ decision: "rejected", status: "archived", layer: "Skill" });
    expect(service.reviewCandidates({ namespace }).items).toHaveLength(0);
    expect(db.db.prepare("SELECT memory_value FROM memories WHERE id = ?").get(first.id)).toMatchObject({ memory_value: "Every memory read must include workspace namespace." });
  });

  it("bulk approves only high-confidence candidates", () => {
    const { db, service } = createTestService();
    const namespace = { source: "codex", profileId: "default", userId: "bulk-review-user", projectId: "bulk-review-project", workspaceId: "bulk-review-workspace" };
    const ids = [0.95, 0.55].map((confidence, index) => {
      const memory = service.addMemory({ namespace, layer: "L2", content: `Conclusion ${index}`, source: "worker", deferProcessing: true });
      db.db.prepare(`UPDATE memories SET status='resolving', info_json=json_set(info_json, '$.confidence', ?), properties_json=json_set(properties_json, '$.status', 'resolving') WHERE id=?`).run(confidence, memory.id);
      return memory.id;
    });
    expect(service.bulkApproveHighConfidenceCandidates({ namespace, minimumConfidence: 0.8 })).toMatchObject({ approved: 1, ids: [ids[0]] });
    expect(db.db.prepare("SELECT status FROM memories WHERE id = ?").get(ids[1])).toMatchObject({ status: "resolving" });
  });
});
