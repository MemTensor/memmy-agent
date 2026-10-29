import { afterEach, describe, expect, it } from "vitest";
import { Repositories } from "../../src/storage/repositories.js";
import { createMemoryServiceFixture } from "../fixtures/memory-service-fixture.js";

const { cleanup, createTestService } = createMemoryServiceFixture();
afterEach(cleanup);

describe("processed History retrieval corpus", () => {
  it("searches the distilled memory without matching discarded raw screen text", () => {
    const { service, db } = createTestService();
    const id = service.syncExternalEvidence({
      action: "upsert", source: "computer_history", sourceRecordId: "corpus-window",
      title: "Worked on purchase approval", content: "INCIDENTAL_WINDOW_TITLE_QUIZ changed tabs and clicked around.",
      revision: "2026-10-09T04:20:00.000Z", startedAt: "2026-10-09T04:10:00.000Z", endedAt: "2026-10-09T04:20:00.000Z",
      namespace: { source: "memmy", profileId: "default", userId: "corpus-user" }
    }).id;
    const repos = new Repositories(db.db);
    const memory = repos.memories.get(id)!;
    const meaningful = "Purchase approval has an unresolved BUDGET_LIMIT constraint.";
    repos.memories.update({ ...memory, memoryValue: meaningful,
      info: { ...memory.info, title: "Purchase approval", summary: meaningful },
      properties: { ...memory.properties, internal_info: { ...memory.properties.internal_info,
        title: "Purchase approval", summary: meaningful,
        external_evidence: { source: "computer_history", source_content: memory.memoryValue },
        observation_memory: { schema_version: 1, status: "processed" } } } });

    expect(repos.memories.searchPatternIds(["INCIDENTAL_WINDOW_TITLE_QUIZ"]).map((hit) => hit.id)).not.toContain(id);
    expect(repos.memories.searchStructuralIds(["INCIDENTAL_WINDOW_TITLE_QUIZ"]).map((hit) => hit.id)).not.toContain(id);
    expect(repos.memories.searchPatternIds(["BUDGET_LIMIT"]).map((hit) => hit.id)).toContain(id);
    expect(repos.memories.searchFtsIds('"BUDGET_LIMIT"').map((hit) => hit.id)).toContain(id);
    expect(repos.memories.get(id)?.properties.internal_info.external_evidence).toMatchObject({ source_content: memory.memoryValue });
  });
});
