import { afterEach, describe, expect, it } from "vitest";
import type { MemoryRow } from "../../../src/types.js";
import { displayFieldsForMemory, observedActivitySummary } from "../../../src/service/read-model/display-fields.js";
import { detailFromMemory } from "../../../src/service/read-model/memory.js";
import { panelListItemFromMemory, panelSourceForMemory, panelSourceDistribution } from "../../../src/service/read-model/panel.js";
import { Repositories } from "../../../src/storage/repositories.js";
import { createMemoryServiceFixture } from "../../fixtures/memory-service-fixture.js";

const { cleanup, createTestService } = createMemoryServiceFixture();
afterEach(cleanup);

function observation(): MemoryRow {
  return {
    id: "observation_history",
    timeline: "2026-10-09T04:10:00Z",
    userId: "history-user",
    memoryType: "LongTermMemory",
    status: "activated",
    visibility: "private",
    memoryLayer: "L1",
    memoryValue: "# 采购录音设备\n\n## Memory summary\n\n采购任务仍包含审批状态和报销跟进。\n\n### Relevant prior context\n\n前文关联。\n\n## Recording summary\n\n操作回顾。",
    info: { title: "采购录音设备", summary: "# 采购录音设备", source: "memmy" },
    properties: { memory_type: "LongTermMemory", status: "activated", tags: [], info: {}, internal_info: {
      memory_layer: "L1",
      memory_kind: "observed_activity",
      title: "采购录音设备",
      summary: "# 采购录音设备",
      external_evidence: { source: "memmy", provenance: { historyId: "history-1" } },
    } },
    tags: [], contentHash: "hash", version: 1,
    createdAt: "2026-10-09T04:10:00Z", updatedAt: "2026-10-09T04:10:00Z", deletedAt: null,
  };
}

describe("History observation display compatibility", () => {
  it("uses the stored observation title and real Memory summary in list and detail", () => {
    const memory = observation();
    expect(displayFieldsForMemory(memory).generatedTitle).toBe("采购录音设备");
    expect(observedActivitySummary(memory)).toBe("采购任务仍包含审批状态和报销跟进。");
    const detail = detailFromMemory(memory);
    expect(detail.summary).toBe("采购任务仍包含审批状态和报销跟进。");
    expect(panelListItemFromMemory(detail, memory).summary).toBe(detail.summary);
    expect(detail.metadata.source).toBe("computer_history");
  });

  it("preserves a meaningful processed summary instead of reparsing source content", () => {
    const memory = observation();
    memory.info.summary = "整理后的采购约束和未确认事项。";
    expect(observedActivitySummary(memory)).toBe("整理后的采购约束和未确认事项。");
  });

  it("recognizes canonical History origin while leaving other passive sources independent", () => {
    const memory = observation();
    memory.properties.internal_info.external_evidence = { source: "computer_history" };
    expect(panelSourceForMemory(memory)).toBe("computer_history");
    memory.properties.internal_info.external_evidence = { source: "calendar_import" };
    memory.info.source = "calendar_import";
    expect(panelSourceForMemory(memory)).toBe("calendar_import");
  });

  it("exposes the skip reason for archived observations in the all-memory list", () => {
    const memory = observation();
    memory.status = "archived";
    memory.properties.internal_info.observation_memory = { schema_version: 1, status: "skipped", skip_reason: "Only repeated window switching." };
    const listed = panelListItemFromMemory(detailFromMemory(memory), memory);
    expect(listed.metadata).toMatchObject({ observationStatus: "skipped", observationSkipReason: "Only repeated window switching." });
  });

  it("keeps legacy History source distribution consistent with the displayed list source", () => {
    const { db } = createTestService();
    const repos = new Repositories(db.db);
    const history = observation();
    repos.memories.insert(history);
    const ordinary = observation();
    ordinary.id = "trace_ordinary";
    ordinary.properties.internal_info = { memory_layer: "L1", memory_kind: "trace" };
    repos.memories.insert(ordinary);
    expect(panelSourceDistribution(repos.memories.listStats())).toEqual([
      { source: "memmy", count: 2, percentage: 100 },
    ]);
    expect(panelSourceForMemory(history)).toBe("computer_history");
    expect(panelSourceForMemory(ordinary)).toBe("memmy");
  });
});
