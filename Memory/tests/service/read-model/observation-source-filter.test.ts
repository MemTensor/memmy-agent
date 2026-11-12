import { afterEach, describe, expect, it } from "vitest";
import { createMemoryServiceFixture } from "../../fixtures/memory-service-fixture.js";

const { cleanup, createTestService } = createMemoryServiceFixture();
afterEach(cleanup);

describe("History source filter", () => {
  it("keeps History provenance precise while including its records in the Memmy Agent filter", () => {
    const { service } = createTestService();
    const input = {
      action: "upsert" as const, namespace: { source: "memmy", profileId: "default", userId: "local-user" },
      revision: "2026-10-09T04:20:00.000Z", title: "Work context",
      content: "The purchase includes order approval and reimbursement steps.",
      startedAt: "2026-10-09T04:10:00.000Z", endedAt: "2026-10-09T04:20:00.000Z"
    };
    const canonical = service.syncExternalEvidence({ ...input, source: "computer_history", sourceRecordId: "canonical-history" });
    const legacy = service.syncExternalEvidence({ ...input, source: "memmy", sourceRecordId: "legacy-history",
      provenance: { historyId: "legacy-history" } });
    // Clipboard keeps its displayed producer and belongs to Other, even when Memmy owns its namespace.
    const unrelated = service.syncExternalEvidence({ ...input, source: "clipboard", sourceRecordId: "clipboard-context" });

    const history = service.panelItems({ layer: "L1", sourceAgent: "computer_history" });
    expect(history.items.map((item) => item.id).sort()).toEqual([canonical.id, legacy.id].sort());
    expect(history.items.every((item) => item.metadata?.source === "computer_history")).toBe(true);
    expect(service.panelItems({ layer: "L1", sourceAgent: "memmy-agent" }).items.map((item) => item.id).sort())
      .toEqual([canonical.id, legacy.id].sort());
    expect(service.panelItems({ layer: "L1", excludedSourceAgents: ["computer_history"] }).items.map((item) => item.id)).toEqual([unrelated.id]);
    expect(service.panelItems({ layer: "L1", excludedSourceAgents: ["memmy-agent"] }).items.map(item=>item.id)).toEqual([unrelated.id]);
  });
});
