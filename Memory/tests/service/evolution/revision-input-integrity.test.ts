import { describe, expect, it } from "vitest";
import { episodeInputRevision } from "../../../src/service/evolution/episode-revision.js";
import { revisePolicyStatistics, withRevisionHistory } from "../../../src/service/evolution/revision-stats.js";
import type { Repositories } from "../../../src/storage/repositories.js";
import type { MemoryRow } from "../../../src/types.js";

describe("complete revision inputs", () => {
  it.each([1001, 10001])("notices a corrected late turn in an Episode with %i turns", count => {
    const turns = Array.from({ length: count }, (_, i) => ({ id: `turn-${i}`, query: "old" }));
    const repos = { runtime: { getEpisode: () => ({ status: "closed", meta: {}, l1MemoryIds: [], feedbackIds: [] }),
      listRawTurnsByEpisode: (_id: string, limit: number) => limit < 0 ? turns : turns.slice(0, limit) },
      memories: {} } as unknown as Repositories;
    const before = episodeInputRevision(repos, "e"); turns[count - 1]!.query = "corrected";
    expect(episodeInputRevision(repos, "e")).not.toBe(before);
  });
  it("does not hide corrections beyond a log serialization size limit", () => {
    const p = { id: "p", userId: "u", memoryLayer: "L2", memoryValue: "policy", tags: [], updatedAt: "2026-11-09", properties: { internal_info: { policy: { status: "active", gain: 0.8, support: 1 } } } } as unknown as MemoryRow;
    const evidence = Array.from({ length: 1100 }, (_, i) => ({ id: `trace-${i}`, episodeId: "e", value: 1 }));
    const parameters = { minSupport: 1, minGain: 0.02, archiveGain: -0.05, tauSoftmax: 0.5, gainEmaAlpha: 0.4 };
    const first = revisePolicyStatistics(p, { evidence, reference: evidence, parameters }, "e")!;
    const saved = withRevisionHistory({ ...p, properties: { internal_info: { memory_layer: "L2", policy: {
      gain: first.gain, support: first.support, status: first.status } } } }, "policy_revision_history", first.history);
    const corrected = evidence.map((t, i) => i === 1099 ? { ...t, value: 0.01 } : t);
    expect(revisePolicyStatistics(saved, { evidence: corrected, reference: corrected, parameters }, "e")).toBeDefined();
  });
});
